/**
 * Launch-plan helpers for the dsh-tui VS Code companion.
 *
 * Pure functions with no `vscode` import on purpose: they compute the exact
 * terminal launch options and environment, so they are unit-testable without
 * the VS Code API host.
 */

export interface LaunchEnvInput {
  /** Process environment to respect (e.g. process.env). */
  base?: Record<string, string | undefined>
  /** '' | 'zh' | 'en' — exported as DSH_TUI_LANG when non-empty. */
  lang?: string
  /** Inject $VISUAL when both $VISUAL and $EDITOR are unset. Default true. */
  injectEditor?: boolean
  /** Value exported as $VISUAL, default 'code -w'. */
  editorCommand?: string
  /** Override $DSH_HOME for the session ('' keeps the inherited value). */
  dshHome?: string
}

export function buildLaunchEnv(input: LaunchEnvInput): Record<string, string> {
  const base = input.base ?? {}
  const env: Record<string, string> = {}
  const lang = input.lang?.trim() ?? ''
  if (lang) {
    env.DSH_TUI_LANG = lang
  }
  const dshHome = input.dshHome?.trim() ?? ''
  if (dshHome) {
    env.DSH_HOME = dshHome
  }
  const wantsEditor = input.injectEditor !== false
  if (wantsEditor && !base.VISUAL && !base.EDITOR) {
    env.VISUAL = input.editorCommand?.trim() || 'code -w'
  }
  return env
}

export interface TerminalPlan {
  shellPath: string
  shellArgs: string[]
}

export interface PlanInput {
  resume: boolean
  extraArgs?: string[]
  /** Command name or absolute path that launches dsh-tui. Default 'dsh-tui'. */
  command?: string
  /** cmd.exe for the Windows composite launch; defaults to $ComSpec. */
  cmdExe?: string
  isWindows?: boolean
}

/** Quote one argument for a cmd.exe "/c <command line>" launch. */
export function quoteCmdArg(arg: string): string {
  if (arg.length === 0) return '""'
  if (/^[^\s"&|<>^()%!]*$/.test(arg)) return arg
  return '"' + arg.replace(/"/g, '""') + '"'
}

export function buildTerminalPlan(input: PlanInput): TerminalPlan {
  const command = input.command?.trim() || 'dsh-tui'
  const args = [...(input.resume ? ['--resume'] : []), ...(input.extraArgs ?? [])]
  if (input.isWindows) {
    // A bare 'dsh-tui' resolves to dsh-tui.cmd on PATH, and createTerminal
    // cannot spawn a .cmd directly — route through cmd.exe with one composite
    // command line (the same trick VS Code itself uses for custom shells).
    const cmdExe = input.cmdExe ?? process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'
    const cmdName = quoteCmdArg(command)
    const cmdline = [cmdName, ...args.map(quoteCmdArg)].join(' ')
    // Unquoted command (no spaces): pass the line verbatim to cmd /d /s /c.
    // Quoted command (spaces): the classic cmd pattern is to brace the whole
    // line in one extra pair of quotes so /s strips them and the inner quoted
    // executable is re-parsed:  cmd /s /c ""C:\Program Files\app.cmd" args"
    // (empirically verified through cmd.exe itself, see session.test.ts).
    const composite = cmdName === command ? cmdline : `"${cmdline}"`
    return { shellPath: cmdExe, shellArgs: ['/d', '/s', '/c', composite] }
  }
  return { shellPath: command, shellArgs: args }
}