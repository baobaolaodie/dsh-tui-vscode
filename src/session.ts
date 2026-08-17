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
 * Terminal shell families. `bash` covers MSYS2/Git Bash and other POSIX-like
 * shells; `cygwin` and `wsl` are separate because their drive mappings differ
 * (`/cygdrive/<drive>` and `/mnt/<drive>` respectively).
 */
export type ShellKind = 'powershell' | 'cmd' | 'bash' | 'cygwin' | 'wsl' | 'unknown'

/**
 * Detect the terminal shell family from VS Code's `env.shell` path or from a
 * `TerminalState.shell` value. The latter uses normalized names like 'bash',
 * 'gitbash', 'pwsh', 'cmd', and 'wsl', while the former is an absolute path.
 */
export function detectShellKind(shell: string | undefined): ShellKind {
  const value = (shell ?? '').trim().toLowerCase().replace(/\\/g, '/')
  const base = value.slice(value.lastIndexOf('/') + 1)
  if (!base) return 'unknown'
  if (base.includes('powershell') || base.includes('pwsh')) return 'powershell'
  if (base === 'cmd' || base.endsWith('.cmd') || base.endsWith('cmd.exe')) return 'cmd'
  if (base.includes('wsl')) return 'wsl'
  // C:\Windows\System32\bash.exe is the WSL bash launcher, not Git Bash.
  if (base === 'bash.exe' && value.includes('/windows/system32/')) return 'wsl'
  if (value.includes('cygwin')) return 'cygwin'
  if (
    base.includes('bash') ||
    base.includes('zsh') ||
    base.includes('fish') ||
    base.includes('ksh') ||
    base.includes('csh') ||
    base.includes('xonsh') ||
    base === 'sh' ||
    base.startsWith('sh.') ||
    base.includes('nu')
  ) {
    return 'bash'
  }
  return 'unknown'
}

const isBashLike = (kind: ShellKind): boolean =>
  kind === 'bash' || kind === 'cygwin' || kind === 'wsl'

/**
 * Convert a Windows absolute path (e.g. `C:\Users\...`) into a POSIX-style
 * path that a bash-like shell can execute. Git Bash/MSYS2 mount drive letters
 * at `/<drive>`, Cygwin mounts them at `/cygdrive/<drive>`, and WSL mounts
 * them at `/mnt/<drive>`.
 */
export function windowsPathToPosix(path: string, shellKind: ShellKind): string {
  const forward = path.replace(/\\/g, '/')
  const drive = /^([A-Za-z]):\/(.*)$/.exec(forward)
  if (drive) {
    const rest = drive[2]
    if (shellKind === 'wsl') return `/mnt/${drive[1].toLowerCase()}/${rest}`
    if (shellKind === 'cygwin') return `/cygdrive/${drive[1].toLowerCase()}/${rest}`
    return `/${drive[1].toLowerCase()}/${rest}`
  }
  if (forward.startsWith('//')) {
    // \\server\share → //server/share; Git Bash/MSYS2 can address it as /server/share.
    return shellKind === 'wsl' ? forward : `/${forward.slice(2)}`
  }
  return forward
}

/**
 * Resolve a bare command name to an absolute executable using the EXTENSION
 * HOST's PATH. The terminal shell's PATH is not trustworthy (login shells
 * rebuild it from profile scripts — verified on CI: an injected PATH dir
 * vanished from the shell), so the launch command is resolved here and sent
 * as an absolute path.
 *
 * On Windows, npm global packages install three shims for the same binary:
 * `.cmd` for cmd.exe, `.ps1` for PowerShell, and an extensionless shell
 * script for Cygwin/MSYS2. When the terminal is bash-like we therefore prefer
 * the extensionless shim; otherwise the existing `.cmd`/`.bat`/`.exe` search
 * applies.
 *
 * @returns The absolute path, or undefined when the command is already
 * path-like or cannot be resolved (the bare name is then sent as-is).
 */
export function resolveLaunchCommand(
  command: string,
  isWindows: boolean,
  shellKind?: ShellKind,
): string | undefined {
  if (command.includes('/') || (isWindows && command.includes('\\'))) {
    return undefined // already path-like — let the shell handle it
  }
  const kind = shellKind ?? (isWindows ? 'powershell' : 'bash')
  const pathEnv = process.env.PATH ?? ''
  const dirs = pathEnv.split(delimiter).filter(Boolean)

  if (isWindows && isBashLike(kind)) {
    // Prefer npm's extensionless bash shim over the .cmd/.bat/.exe shims.
    for (const dir of dirs) {
      const candidate = join(dir, command)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // not a usable candidate — keep looking
      }
    }
  }

  for (const dir of dirs) {
    if (isWindows) {
      const exts = isBashLike(kind) ? ['.exe', '.cmd', '.bat'] : ['.cmd', '.bat', '.exe']
      for (const ext of exts) {
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

/**
 * Format a resolved launch path for the actual terminal shell. On Windows
 * bash-like shells the Windows path must be converted to POSIX form before it
 * reaches the shell; otherwise `C:\Users\...` is mangled by bash into
 * `C:Users...` and reported as "command not found".
 */
export function formatLaunchPath(path: string, shellKind: ShellKind, isWindows: boolean): string {
  const display = isWindows && isBashLike(shellKind) ? windowsPathToPosix(path, shellKind) : path
  if (!display.includes(' ')) return display
  switch (shellKind) {
    case 'cmd':
      return `"${display}"`
    case 'powershell':
      return `& '${display}'`
    case 'bash':
    case 'cygwin':
    case 'wsl':
      return `'${display}'`
    default:
      return isWindows ? `& '${display}'` : `'${display}'`
  }
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