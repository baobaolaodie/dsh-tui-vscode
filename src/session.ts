/**
 * Environment helpers for the dsh-tui VS Code companion.
 *
 * Pure function with no `vscode` import on purpose: it computes the extra
 * environment for the session terminal, so it is unit-testable without the
 * VS Code API host.
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