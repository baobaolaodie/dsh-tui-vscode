/**
 * Environment and launch helpers for the dsh-tui VS Code companion.
 *
 * Pure functions with no `vscode` import on purpose: they compute the extra
 * environment and the resolved launch command for the session terminal, so
 * they are unit-testable without the VS Code API host.
 */
import { existsSync, statSync, accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Resolve a bare command name to an absolute executable using the EXTENSION
 * HOST's PATH. The terminal shell's PATH is not trustworthy (login shells
 * rebuild it from profile scripts — verified on CI: an injected PATH dir
 * vanished from the shell), so the launch command is resolved here and sent
 * as an absolute path.
 *
 * @returns The absolute path, or undefined when the command is already
 * path-like or cannot be resolved (the bare name is then sent as-is).
 */
export function resolveLaunchCommand(command: string, isWindows: boolean): string | undefined {
  if (command.includes('/') || (isWindows && command.includes('\\'))) {
    return undefined // already path-like — let the shell handle it
  }
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    if (isWindows) {
      for (const ext of ['.cmd', '.bat', '.exe']) {
        const candidate = join(dir, command + ext)
        if (existsSync(candidate)) return candidate
      }
    } else {
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
  }
  return undefined
}

/** Quote a resolved path for the terminal shell when it contains spaces. */
export function quoteLaunchPath(path: string, isWindows: boolean): string {
  if (!path.includes(' ')) return path
  return isWindows ? `& '${path}'` : `'${path}'`
}
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