/**
 * Launch-plan helpers for the dsh-tui VS Code companion.
 *
 * Pure-ish functions with no `vscode` import on purpose: they compute the
 * exact PTY launch options and environment, so they are unit-testable without
 * the VS Code API host.
 */
import { existsSync, statSync, accessSync, constants, readFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'

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

/**
 * Resolve a bare POSIX command to an absolute executable path on PATH.
 * node-pty's POSIX backend does NOT PATH-resolve bare names itself (verified
 * empirically: exec fails with ENOENT), so the extension must.
 */
export function resolvePosixCommand(command: string): string {
  if (command.includes('/')) return command
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, command)
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK)
        return candidate
      }
    } catch {
      // not a usable candidate — keep looking
    }
  }
  return command
}

export function buildTerminalPlan(input: PlanInput): TerminalPlan {
  const command = input.command?.trim() || 'dsh-tui'
  const args = [...(input.resume ? ['--resume'] : []), ...(input.extraArgs ?? [])]
  if (input.isWindows) {
    // Run npm-style .cmd/.bat shims DIRECTLY as `node <entry.js>` — no
    // cmd.exe wrapper in the process tree (Claude Code spawns the CLI the
    // same way). Falls back to the shim path (node-pty wraps it internally)
    // when the shim has no recognizable node entry.
    const direct = resolveDirectWindowsCommand(command)
    if (direct) {
      return { shellPath: resolveNodeExecutable(), shellArgs: [direct, ...args] }
    }
    return { shellPath: resolveWindowsCommand(command), shellArgs: args }
  }
  // node-pty on POSIX does not PATH-resolve bare names (verified on CI:
  // exec fails with ENOENT), so resolve to an absolute path here.
  return { shellPath: resolvePosixCommand(command), shellArgs: args }
}

/**
 * Resolve node.exe to an absolute path (node-pty's Windows backend cannot
 * spawn bare names — verified empirically). Falls back to the extension
 * host's own node.
 */
export function resolveNodeExecutable(): string {
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, 'node.exe')
    if (existsSync(candidate)) return candidate
  }
  return process.execPath
}

/**
 * Extract the node entry script a npm-style .cmd/.bat shim forwards to, and
 * return it as an absolute path. npm shims contain a line like
 * `"%_prog%"  "%dp0%\node_modules\<pkg>\bin\cli.js" %*`.
 */
export function extractShimEntry(shimPath: string): string | undefined {
  let content: string
  try {
    content = readFileSync(shimPath, 'utf8')
  } catch {
    return undefined
  }
  const m = /"(%dp0%\\)?([^"]+\.js)"/i.exec(content)
  if (!m) return undefined
  const expanded = m[1] ? join(dirname(shimPath), m[2]) : m[2]
  const abs = isAbsolute(expanded) ? expanded : resolve(dirname(shimPath), expanded)
  return existsSync(abs) ? abs : undefined
}

function resolveDirectWindowsCommand(command: string): string | undefined {
  const shim = resolveWindowsCommand(command)
  if (!/\.(cmd|bat)$/i.test(shim)) return undefined
  return extractShimEntry(shim)
}