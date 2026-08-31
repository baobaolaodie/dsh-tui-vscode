/**
 * IDE selection channel — server side (extension host).
 *
 * The mirror of the upstream dsh-TUI client (`dsh-adapter/ide-channel.ts`):
 * a loopback WebSocket server that the TUI discovers either through the
 * spawn environment (env direct) or by scanning lock files (lock scan).
 *
 * Protocol contract (ADR-001 — changing it requires updating both ends):
 * - Lock file `<port>.lock` under `<lockRoot>/ide/` with JSON
 *   `{ port, token, workspaceFolders, pid }`.
 * - Handshake: the client's first frame is
 *   `{"method":"ide/hello","params":{"token"}}`; the server validates the
 *   token and silently accepts (no ack frame).
 * - Notifications: `{"method":"selection_changed","params":{path,
 *   startLine, endLine, isEmpty}}` — coordinates only (0-based), never text.
 * - Env keys: DSH_TUI_IDE_PORT / DSH_TUI_IDE_TOKEN.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import type { WebSocket as WsSocket } from 'ws'

/** Lock directory name under the data root — cross-repo contract. */
export const IDE_LOCK_DIR_NAME = 'ide'
/** Env var carrying this server's loopback port (spawn-injected). */
export const IDE_PORT_ENV = 'DSH_TUI_IDE_PORT'
/** Env var carrying this server's handshake token (spawn-injected). */
export const IDE_TOKEN_ENV = 'DSH_TUI_IDE_TOKEN'
/** Handshake method the client must send as its first message. */
const HELLO_METHOD = 'ide/hello'
/** Selection notification method broadcast to connected clients. */
export const SELECTION_METHOD = 'selection_changed'

/** Coordinate snapshot pushed over the wire — coordinates only, no text. */
export type SelectionBroadcast = {
  path: string
  /** 0-based first selected line. */
  startLine: number
  /** 0-based inclusive last selected line. */
  endLine: number
  isEmpty: boolean
}

/** Build the `<port>.lock` file name for one bound port. */
export function lockFileName(port: number): string {
  return `${port}.lock`
}

/** Build the lock payload — exactly these four fields, nothing else. */
export function buildLockPayload(lock: {
  port: number
  token: string
  workspaceFolders: string[]
  pid: number
}): { port: number; token: string; workspaceFolders: string[]; pid: number } {
  return { port: lock.port, token: lock.token, workspaceFolders: lock.workspaceFolders, pid: lock.pid }
}

/** Serialize one selection into the wire notification shape. */
export function buildSelectionChanged(selection: SelectionBroadcast): {
  method: typeof SELECTION_METHOD
  params: SelectionBroadcast
} {
  return { method: SELECTION_METHOD, params: selection }
}

/** Terminal env pair injected when the extension spawns the TUI itself. */
export function envForSession(config: { port: number; token: string }): Record<string, string> {
  return {
    [IDE_PORT_ENV]: String(config.port),
    [IDE_TOKEN_ENV]: config.token,
  }
}

export interface IdeServerOptions {
  /** Handshake token clients must present in `ide/hello`. */
  token: string
  /**
   * Root directory holding the lock dir. Defaults to `~/.dsh-tui`
   * (the upstream DATA_DIR layout); tests inject a temp dir so real user
   * state is never touched.
   */
  lockRoot?: string
  /** Absolute paths of open workspace roots, resolved lazily at start(). */
  workspaceFolders: () => string[]
}

/**
 * Loopback WS server advertising itself via lock files.
 *
 * Lifecycle: `start()` binds 127.0.0.1 on a random port and writes the lock;
 * calling `start()` again returns the same env without rebinding. `stop()`
 * removes the lock and closes the server; it is safe before start and twice
 * in a row. Every failure path throws only from `start()` — callers decide
 * how to degrade (extension.ts logs and continues).
 */
export class IdeServer {
  private readonly token: string
  private readonly lockRoot: string
  private readonly workspaceFolders: () => string[]
  private wss: WebSocketServer | null = null
  private sockets = new Set<WsSocket>()
  private env: Record<string, string> | null = null
  private lockPath: string | null = null

  constructor(options: IdeServerOptions) {
    this.token = options.token
    this.lockRoot = options.lockRoot ?? join(homedir(), '.dsh-tui')
    this.workspaceFolders = options.workspaceFolders
  }

  /** Bound port, or undefined while stopped. */
  get port(): number | undefined {
    return this.env === null ? undefined : Number(this.env[IDE_PORT_ENV])
  }

  /** True between a successful start() and stop(). */
  get running(): boolean {
    return this.wss !== null
  }

  /** Connected, handshake-authenticated client count (test/introspection seam). */
  get clientCount(): number {
    return this.sockets.size
  }

  /**
   * Bind a random loopback port and advertise it. Idempotent: a running
   * server returns its existing env instead of listening twice.
   */
  async start(): Promise<Record<string, string>> {
    if (this.env !== null) return this.env
    const port = await this.listen()
    this.env = envForSession({ port, token: this.token })
    try {
      this.writeLock(port)
    } catch (error) {
      // Half-bound server without a lock is an INVISIBLE instance: the TUI
      // can't discover it and the handle leaks the event loop. A failed
      // start must leave nothing behind (AC-7 failure semantics).
      await this.stop()
      throw error
    }
    return this.env
  }

  /**
   * The terminal env pair for spawn-injected sessions, or {} while the
   * server is not running (lock discovery remains available to the TUI).
   */
  envForTerminal(): Record<string, string> {
    return this.env ?? {}
  }

  /** Remove the lock and close the server. Safe in every state. */
  async stop(): Promise<void> {
    this.clearLock()
    this.env = null
    const wss = this.wss
    this.wss = null
    if (wss === null) return
    await new Promise<void>(resolve => {
      // ws calls back immediately when not listening — still resolve.
      wss.close(() => resolve())
      try {
        for (const socket of [...this.sockets]) socket.terminate()
      } catch {
        // Sockets already gone — closing the server is what matters.
      }
    })
    this.sockets.clear()
  }

  /**
   * Push one selection snapshot to every authenticated client.
   * @returns True when at least one client received the frame.
   */
  broadcastSelection(selection: SelectionBroadcast): boolean {
    if (this.sockets.size === 0) return false
    let delivered = false
    const frame = JSON.stringify(buildSelectionChanged(selection))
    for (const socket of [...this.sockets]) {
      try {
        if (socket.readyState !== socket.OPEN) continue
        socket.send(frame)
        delivered = true
      } catch {
        // A dying socket must never break the broadcast loop; drop it here,
        // its close/error handler will finish the cleanup.
        this.drop(socket)
      }
    }
    return delivered
  }

  private listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      // Loopback only: the selection channel must never leave the machine.
      const wss = new WebSocketServer({ host: '127.0.0.1', port }, () => {
        const address = wss.address()
        const bound = typeof address === 'object' && address !== null ? address.port : 0
        this.attach(wss)
        resolve(bound)
      })
      wss.once('error', error => {
        // Bind failure (EADDRINUSE etc.) must clean up the half-open server.
        try {
          wss.close()
        } catch {
          // Already closed — nothing left to do.
        }
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  private attach(wss: WebSocketServer): void {
    this.wss = wss
    wss.on('connection', socket => this.onConnection(socket))
    wss.on('error', () => {
      // Post-bind errors degrade silently: stop advertising and tear down.
      void this.stop()
    })
  }

  private onConnection(socket: WsSocket): void {
    let helloDone = false
    socket.on('message', raw => {
      if (helloDone) return
      let parsed: unknown
      try {
        parsed = JSON.parse(String(raw))
      } catch {
        socket.close()
        return
      }
      const record = parsed as { method?: unknown; params?: { token?: unknown } }
      const token =
        record !== null &&
        typeof record === 'object' &&
        record.method === HELLO_METHOD &&
        record.params !== null &&
        typeof record.params === 'object' &&
        typeof record.params.token === 'string'
          ? record.params.token
          : undefined
      if (token !== this.token) {
        // Wrong token: refuse quietly (no ack, just drop the connection).
        socket.close()
        return
      }
      helloDone = true
      this.sockets.add(socket)
      socket.on('close', () => this.drop(socket))
      socket.on('error', () => this.drop(socket))
    })
  }

  private drop(socket: WsSocket): void {
    this.sockets.delete(socket)
  }

  private writeLock(port: number): void {
    const dir = join(this.lockRoot, IDE_LOCK_DIR_NAME)
    mkdirSync(dir, { recursive: true })
    this.lockPath = join(dir, lockFileName(port))
    // Atomic write (maintainer review round 2, server side): write to a
    // sibling temp file then rename over the target. A TUI scanning
    // mid-write must never observe a half-written lock advertising a
    // port/token the server doesn't bound yet — rename is atomic on the
    // same filesystem, so either the old lock or the complete new one
    // is seen, never a partial JSON.
    const tmp = `${this.lockPath}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify(
        buildLockPayload({
          port,
          token: this.token,
          workspaceFolders: this.workspaceFolders(),
          pid: process.pid,
        }),
      ),
      'utf8',
    )
    renameSync(tmp, this.lockPath)
  }

  private clearLock(): void {
    const lockPath = this.lockPath
    this.lockPath = null
    if (lockPath === null) return
    try {
      rmSync(lockPath, { force: true })
    } catch {
      // A missing/unremovable lock must not block shutdown.
    }
  }
}
