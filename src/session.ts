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

/**
 * Characters that are unambiguous in EVERY shell we target. Everything else
 * forces quoting.
 *
 * Testing "contains a space" is NOT enough (issue #21): `/tmp/repo;id` reached
 * the shell as two commands. But an allow-list has to be conservative in the
 * other direction too — `,` and `=` look like ordinary path punctuation and
 * are exactly that on POSIX, yet cmd.exe splits command names on `,`, `;` and
 * `=`, and PowerShell reads `,` as the array operator. Leaving them here made
 * `C:\Users\Doe, John\...\dsh-tui.cmd` fail with "not recognized as an
 * internal or external command" (verified on a real cmd).
 *
 * `\` stays because Windows paths are made of it and `windowsPathToPosix`
 * removes it before a bash-like shell ever sees the value; see
 * {@link isSafeUnquoted} for the one case that still needs guarding.
 */
const SAFE_UNQUOTED = /^[A-Za-z0-9_\-./\\:@+]+$/

/**
 * Whether `value` can go to `shellKind` without quoting. Beyond the shared
 * allow-list, bash-like shells treat a backslash as an escape character, so a
 * literal one must be quoted — that only happens on a POSIX host (on Windows
 * the path is converted first), where a filename containing `\` is legal but
 * vanishingly rare.
 */
function isSafeUnquoted(value: string, shellKind: ShellKind): boolean {
  if (!SAFE_UNQUOTED.test(value)) return false
  if (isBashLike(shellKind) && value.includes('\\')) return false
  return true
}

/**
 * Quote a value for the target shell, escaping that shell's own quote
 * character so the literal cannot be closed early. Every path interpolated
 * into a launch command goes through here.
 */
export function quoteShellArg(value: string, shellKind: ShellKind): string {
  switch (shellKind) {
    case 'cmd':
      // cmd.exe: "" inside a quoted string is one literal ".
      return `"${value.replace(/"/g, '""')}"`
    case 'bash':
    case 'cygwin':
    case 'wsl':
      // POSIX: close, escaped quote, reopen — ' becomes '\''
      return `'${value.replace(/'/g, "'\\''")}'`
    default:
      // PowerShell (and unknown): '' inside a single-quoted string is one '.
      // Doubling is also accepted by cmd's parser and harmless for the paths
      // that carry no quote at all, so it is a safe default.
      return `'${value.replace(/'/g, "''")}'`
  }
}

/**
 * Format a resolved launch path for the actual terminal shell. On Windows
 * bash-like shells the Windows path must be converted to POSIX form before it
 * reaches the shell; otherwise `C:\Users\...` is mangled by bash into
 * `C:Users...` and reported as "command not found".
 */
export function formatLaunchPath(path: string, shellKind: ShellKind, isWindows: boolean): string {
  const display = isWindows && isBashLike(shellKind) ? windowsPathToPosix(path, shellKind) : path
  // Quote on anything outside the safe set, not merely on spaces: the path
  // also has to survive `;`, `&` and friends (issue #21).
  if (isSafeUnquoted(display, shellKind)) return display
  const quoted = quoteShellArg(display, shellKind)
  switch (shellKind) {
    case 'cmd':
    case 'bash':
    case 'cygwin':
    case 'wsl':
      return quoted
    case 'powershell':
      return `& ${quoted}`
    default:
      // `&` is the call operator; only a Windows default shell needs it.
      return isWindows ? `& ${quoted}` : quoted
  }
}

/**
 * The trailing positional argument of the launch command: the opened
 * workspace root, so the dsh-tui launcher can pin the session cwd to the
 * SAME root this extension relativizes @mentions against.
 *
 * Why: the TUI's default session cwd crawls up to the nearest git worktree
 * root (upstream issue #96), while mention relativization uses
 * `workspaceFolders[0]` — in a subdirectory workspace of a git repo the two
 * diverge and every submitted `@relative#L…` lands as "missing". Appending
 * the workspace root makes the launcher set DSH_TUI_WORKSPACE_TARGET → the
 * plugin resolves it directly (absolute paths short-circuit) → session cwd
 * === extension baseline.
 *
 * Quoting follows formatLaunchPath's per-shell conventions (the launcher's
 * arg scanner treats a quoted path with spaces as one token); an empty/absent
 * root yields '' so callers append nothing. Pure — unit-tested without VS Code.
 */
export function formatWorkspaceTargetArg(
  workspaceRoot: string | undefined,
  shellKind: ShellKind,
): string {
  const root = workspaceRoot?.trim() ?? ''
  if (root === '') return ''
  // Convert BEFORE the space check (formatLaunchPath precedent): a Windows
  // root on a bash-like shell must reach the shell in POSIX form whether or
  // not it contains spaces — bash turns `D:\repo` into `D:repo`. The helper
  // passes POSIX roots through untouched, so this is safe on every host.
  const display = isBashLike(shellKind) ? windowsPathToPosix(root, shellKind) : root
  // EVERY branch carries its own leading separator: the caller appends this
  // string to `parts.join(' ')` verbatim (extension.ts), so a branch that
  // returns a bare quoted literal glues the target to the previous token —
  // `dsh-tui'D:\my repo'` (no extra args) or `--resume'D:\my repo'` — and the
  // launcher is never found / never receives the root.
  if (isSafeUnquoted(display, shellKind)) return ` ${display}`
  // A single-quoted literal, never `& '…'`: this arg trails the command, so a
  // leading & is a second use of the call operator → ParserError; as the first
  // token it would invoke the path as a command. quoteShellArg returns the
  // per-shell quoted form, and the leading space keeps it a separate token.
  return ` ${quoteShellArg(display, shellKind)}`
}

/**
 * Where a new dsh-tui session terminal opens:
 * - `editor` — the central editor area, in a NEW column beside the active
 *   one (ViewColumn.Beside; the historical default);
 * - `active` — the currently active editor column (ViewColumn.Active);
 * - `panel`  — the bottom panel, next to ordinary terminals.
 */
export type TerminalLocationKind = 'editor' | 'active' | 'panel'

/**
 * Normalize the `dsh-tui-vscode.terminalLocation` setting. Empty, unknown,
 * or differently-cased values fall back to 'editor' so a mistyped setting
 * can never break the launch path.
 */
export function normalizeTerminalLocation(value: string | undefined): TerminalLocationKind {
  const v = (value ?? '').trim().toLowerCase()
  if (v === 'active' || v === 'panel') return v
  return 'editor'
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
  /**
   * Extra key/values merged over the computed env — last writer wins. The
   * extension injects its IDE selection channel pair (DSH_TUI_IDE_PORT /
   * DSH_TUI_IDE_TOKEN) here; keeping it generic avoids coupling the pure
   * helper to that protocol.
   */
  extra?: Record<string, string>
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
  return { ...env, ...input.extra }
}

/**
 * 启动竞态的幂等发送门:shell integration 与保守回退都在等待投递启动命令,
 * 二者可能任一先到,也可能先后都触发(integration 晚到/在 1.2s 回退已发送后
 * 再次触发——实测发生过:启动命令被第二次敲进已运行的 dsh-tui 输入框并被
 * 尾随回车提交)。无论时序如何,命令必须恰好送达一次,败者路径变 no-op。
 * 从 extension.ts 抽出为纯逻辑(无 vscode import),让「双发回归」可被单测锁死。
 */
export interface SendOnceGate {
  /** 在某条就绪信号上调用——每扇门至多投递一次。 */
  trySend(): void
  /** 是否已经投递过(含投递时目标已关闭的情形)。 */
  readonly sent: boolean
}

export function createSendOnceGate(deliver: () => void): SendOnceGate {
  let sent = false
  return {
    get sent(): boolean {
      return sent
    },
    trySend(): void {
      if (sent) return
      sent = true
      try {
        deliver()
      } catch {
        // 竞态途中终端已关闭也计为已投递,防止迟到的信号复活投递。
      }
    },
  }
}