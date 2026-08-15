/**
 * Launch-plan helpers for the dsh-tui VS Code companion.
 *
 * Pure-ish functions with no `vscode` import on purpose: they compute the
 * exact PTY launch options and environment, so they are unit-testable without
 * the VS Code API host.
 */
import { existsSync } from 'node:fs'
import { delimiter, join, sep } from 'node:path'

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
  isWindows?: boolean
}

/**
 * Resolve a bare Windows command to an absolute .cmd/.bat path when such a
 * shim exists on PATH (e.g. `dsh-tui` → `…\dsh-tui.cmd`). Anything already
 * path-like or with an explicit extension is returned unchanged (bare .exe
 * names are found by CreateProcess itself).
 */
export function resolveWindowsCommand(command: string): string {
  if (command.includes(sep) || command.includes('/') || /\.(exe|cmd|bat)$/i.test(command)) {
    return command
  }
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const ext of ['.cmd', '.bat']) {
      const candidate = join(dir, command + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return command
}

export function buildTerminalPlan(input: PlanInput): TerminalPlan {
  const command = input.command?.trim() || 'dsh-tui'
  const args = [...(input.resume ? ['--resume'] : []), ...(input.extraArgs ?? [])]
  if (input.isWindows) {
    // Windows cannot CreateProcess a .cmd/.bat shim directly, and wrapping
    // cmd.exe ourselves breaks child stdin through ConPTY (verified
    // empirically). Instead resolve shims to absolute paths and let node-pty
    // wrap them internally — the same battle-tested path VS Code itself uses
    // for .cmd shells.
    return { shellPath: resolveWindowsCommand(command), shellArgs: args }
  }
  return { shellPath: command, shellArgs: args }
}