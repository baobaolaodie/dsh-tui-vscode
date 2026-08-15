/**
 * PTY session manager (Path B).
 *
 * Owns the real pseudo-terminal running dsh-tui and translates its byte
 * stream for the webview panel. Uses @lydell/node-pty (ConPTY on Windows),
 * the same architecture as the VS Code integrated terminal.
 */
import { spawn, type IPty } from '@lydell/node-pty'
import { buildLaunchEnv, buildTerminalPlan } from './session'

export interface PtyLaunchOptions {
  resume: boolean
  cwd: string
  command: string
  extraArgs: string[]
  lang: string
  injectEditor: boolean
  editorCommand: string
  dshHome: string
}

export interface PtySession {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface PtySessionHandlers {
  onData(data: string): void
  onExit(code: number | undefined): void
}

export function startPtySession(
  opts: PtyLaunchOptions,
  cols: number,
  rows: number,
  handlers: PtySessionHandlers,
): PtySession {
  const env = buildLaunchEnv({
    base: process.env,
    lang: opts.lang,
    injectEditor: opts.injectEditor,
    editorCommand: opts.editorCommand,
    dshHome: opts.dshHome,
  })
  const plan = buildTerminalPlan({
    resume: opts.resume,
    extraArgs: opts.extraArgs,
    command: opts.command,
    isWindows: process.platform === 'win32',
  })
  const proc: IPty = spawn(plan.shellPath, plan.shellArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: opts.cwd,
    env: { ...process.env, ...env },
  })
  proc.onData(data => handlers.onData(data))
  proc.onExit(({ exitCode }) => handlers.onExit(exitCode))
  return {
    get pid() {
      return proc.pid
    },
    write: data => proc.write(data),
    resize: (c, r) => {
      try {
        proc.resize(c, r)
      } catch {
        // already closed
      }
    },
    kill: () => {
      try {
        proc.kill()
      } catch {
        // already closed
      }
    },
  }
}