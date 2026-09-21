/**
 * IDE selection channel — server side (extension host).
 *
 * The mirror of the upstream dsh-TUI client (`dsh-adapter/ide-channel.ts`):
 * a loopback WebSocket server that the TUI discovers either through the
 * spawn environment (env direct) or by scanning lock files (lock scan).
 *
 * Protocol contract (ADR-001 — changing it requires updating both ends):
 * - Lock file `<port>.lock` under `<lockRoot>/ide/` with JSON
 *   `{ port, token, workspaceFolders, pid }` (directory 0700, file 0600).
 * - Handshake (protocol version 2): the client's first frame is
 *   `{"method":"ide/hello","params":{"token","protocolVersion"}}`; the
 *   server validates the token and answers
 *   `{"method":"ide/hello_ack","params":{"protocolVersion",
 *   "workspaceFolders"}}` — a wrong token gets no ack, the socket is
 *   dropped (the TUI treats open-without-ack as "not authenticated" and
 *   moves on to its next candidate).
 * - Notifications: `{"method":"selection_changed","params":{path,
 *   startLine, endLine, isEmpty, text, documentVersion}}` — coordinates are
 *   0-based and `text` is the editor buffer's own selection text (unsaved
 *   edits included); the TUI attaches it verbatim.
 * - Env keys: DSH_TUI_IDE_PORT / DSH_TUI_IDE_TOKEN.
 */

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
/** Ack method the server answers a valid hello with (protocol 2). */
const HELLO_ACK_METHOD = 'ide/hello_ack'
/** Wire protocol this server speaks; hello_ack carries it to the client. */
export const IDE_PROTOCOL_VERSION = 2
/** Selection notification method broadcast to connected clients. */
export const SELECTION_METHOD = 'selection_changed'

/** Snapshot pushed over the wire: coordinates plus the editor buffer's own
 *  selection text — the TUI attaches exactly what the user saw (unsaved
 *  edits included) instead of reading a possibly-stale disk copy. */
export type SelectionBroadcast = {
  path: string
  /** 0-based first selected line. */
  startLine: number
  /** 0-based inclusive last selected line. */
  endLine: number
  isEmpty: boolean
  /** The editor's own text for the selection ('' when isEmpty). */
  text: string
  /** The editor document version the text came from. */
  documentVersion: number
}

/**
 * 把编辑器选区归一化为 0-based **含端** 行区间——协议契约的唯一口径。
 *
 * VS Code 的 `selection.end` 是「最后一个被选中字符之后」的位置:当选区收在
 * 下一行行首(列 0)——整行选区最典型的三种手势 Shift+Down / 三击选整行 /
 * 拖到左边距——`end.line` 比最后一个被覆盖的行大 1(且 `getText()` 会带上
 * 那一行的换行符)。`SelectionBroadcast`、上游 @-mention 的 `#L起-止` 与
 * dsh-tui 的徽标/磁盘回退都按「含端」消费,直接推原始 `end.line` 会让 footer
 * 徽标比实际附加的正文多算一行(徽标说 4 行、transcript 指示行说 3 行)。
 * 归一化收在推送源头,消费端不必知道 VS Code 的 end 语义。
 */
export function selectionLineRange(selection: {
  start: { line: number, character: number }
  end: { line: number, character: number }
}): { startLine: number, endLine: number } {
  const startLine = selection.start.line
  const { line, character } = selection.end
  return {
    startLine,
    // 空选区 start === end,`line > startLine` 恒假 → 原样返回。
    endLine: character === 0 && line > startLine ? line - 1 : line,
  }
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
      // start must leave nothing behind (failed-start semantics).
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
      const record = parsed as { method?: unknown; params?: { token?: unknown; protocolVersion?: unknown } }
      const params =
        record !== null &&
        typeof record === 'object' &&
        record.method === HELLO_METHOD &&
        record.params !== null &&
        typeof record.params === 'object'
          ? record.params
          : undefined
      const token = typeof params?.token === 'string' ? params.token : undefined
      const protocolVersion = typeof params?.protocolVersion === 'number' ? params.protocolVersion : undefined
      if (token !== this.token || protocolVersion !== IDE_PROTOCOL_VERSION) {
        // Wrong token OR unsupported/absent protocol version: refuse quietly —
        // no ack, just drop the connection. The client treats open-without-ack
        // as "not authenticated" and moves on to its next candidate; acking a
        // mismatched client would hand it a protocol it cannot speak.
        socket.close()
        return
      }
      helloDone = true
      // Protocol 2: answer the handshake so the client knows the token was
      // accepted AND which workspaces this server covers (the TUI connects
      // only on a valid ack — an open socket alone proves nothing).
      try {
        socket.send(JSON.stringify({
          method: HELLO_ACK_METHOD,
          params: { protocolVersion: IDE_PROTOCOL_VERSION, workspaceFolders: this.workspaceFolders() },
        }))
      } catch {
        // A socket that cannot take the ack is as good as rejected.
        this.drop(socket)
        socket.terminate()
        return
      }
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
    // 0700/0600 (maintainer review round 3): the lock carries the handshake
    // token — a local process reading it can impersonate this IDE and push
    // selections (and thus file content) into dsh-tui sessions. Owner-only
    // permissions are a cheap fence; Windows ignores the modes harmlessly.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // mkdirSync's mode applies ONLY when the directory is created: a dir left
    // behind by an older build (or a first run under a permissive umask)
    // keeps its old bits, so the advertised 0700 was never enforced for it.
    // Tighten explicitly; POSIX only (Windows ignores mode bits harmlessly).
    if (process.platform !== 'win32') {
      try {
        chmodSync(dir, 0o700)
      } catch {
        // Best effort — the token itself still rides in a 0600 lock file.
      }
    }
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
      // encoding 与 mode 必须同在一个 options 对象里:Node 的 writeFileSync
      // 只接受 (file, data, options),多传一个参数 TS 直接报 TS2554。
      { encoding: 'utf8', mode: 0o600 },
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
