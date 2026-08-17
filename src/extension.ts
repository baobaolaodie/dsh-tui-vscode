import * as vscode from 'vscode'
import { homedir } from 'node:os'
import { SessionsTreeProvider } from './sessions-view'
import { SessionStatusBar } from './status'
import {
  appendSessionTitle,
  deleteSessionLog,
  ensureZstd,
  resetZstd,
  setSessionArchived,
  readWorkspaceMeta,
  listSessions,
} from './sessions'
import { buildLaunchEnv, resolveLaunchCommand, detectShellKind, formatLaunchPath } from './session'

const TERMINAL_NAME = 'DeepSeek'

/** Compact relative time, Claude Code style: 刚刚 / 12m / 3h / 2d. */
function relativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

interface Settings {
  command: string
  extraArgs: string[]
  lang: string
  injectEditor: boolean
  editorCommand: string
  dshHome: string
}

function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
  return {
    command: cfg.get<string>('command', 'dsh-tui'),
    extraArgs: cfg.get<string[]>('extraArgs', []),
    lang: cfg.get<string>('lang', ''),
    injectEditor: cfg.get<boolean>('injectEditor', true),
    editorCommand: cfg.get<string>('editorCommand', 'code -w'),
    dshHome: cfg.get<string>('dshHome', ''),
  }
}

export interface ExtensionApi {
  /** Send raw input into the dsh-tui terminal (used by tests/scripts). */
  sendInput(text: string): void
  /** True while a dsh-tui terminal exists. */
  hasTerminal(): boolean
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const status = new SessionStatusBar()
  context.subscriptions.push(status)

  // The sidebar (activity bar) hosts the SESSION LIST, shaped like the
  // official Claude Code sessions sidebar. The session itself runs in a REAL
  // VS Code integrated terminal (default shell — PowerShell on Windows),
  // exactly like the official extension: createTerminal({ name, location:
  // Editor/Beside, env, isTransient }) + run the CLI inside it.
  const sessionsTree = new SessionsTreeProvider()
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dsh-tui-vscode.sessions', sessionsTree),
    sessionsTree,
  )
  sessionsTree.startWatching(readSettings().dshHome)

  function hasTerminal(): boolean {
    return vscode.window.terminals.some(t => t.name === TERMINAL_NAME)
  }
  /** The most recently created DeepSeek terminal, if any. */
  const findTerminal = (): vscode.Terminal | undefined =>
    [...vscode.window.terminals].reverse().find(t => t.name === TERMINAL_NAME)

  const refreshState = (): void => status.update(hasTerminal())
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => refreshState()),
    vscode.window.onDidCloseTerminal(() => refreshState()),
    // The sidebar shows only the CURRENT workspace's sessions — re-filter
    // when the user opens/closes/switches workspace folders.
    vscode.workspace.onDidChangeWorkspaceFolders(() => sessionsTree.refresh()),
  )

  function buildEnv(extra: Record<string, string> = {}): Record<string, string> {
    const cfg = readSettings()
    return {
      ...buildLaunchEnv({
        base: process.env,
        lang: cfg.lang,
        injectEditor: cfg.injectEditor,
        editorCommand: cfg.editorCommand,
        dshHome: cfg.dshHome,
      }),
      ...extra,
    }
  }

  function createTerminal(env: Record<string, string>): vscode.Terminal {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir()
    return vscode.window.createTerminal({
      name: TERMINAL_NAME,
      cwd,
      env,
      iconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg'),
      // A NEW column beside the active one — like the official extension
      // (ViewColumn.Beside) — never taking over the user's current column.
      location: { viewColumn: vscode.ViewColumn.Beside },
      isTransient: true,
    })
  }

  /** Wait until the shell is ready to accept input (shell integration or a
   *  conservative fallback), then run the command. */
  function sendTextWhenReady(terminal: vscode.Terminal, command: string): void {
    const fallback = setTimeout(() => {
      try {
        terminal.sendText(command, true)
      } catch {
        // terminal already closed
      }
    }, 1200)
    const listener = vscode.window.onDidChangeTerminalShellIntegration(event => {
      if (event.terminal !== terminal) return
      clearTimeout(fallback)
      listener.dispose()
      try {
        terminal.sendText(command, true)
      } catch {
        // terminal already closed
      }
    })
    // Safety: drop the listener if shell integration never arrives.
    setTimeout(() => listener.dispose(), 15000)
  }

  function runCommand(resume: boolean, resumeSession?: string): void {
    const cfg = readSettings()
    const isWindows = process.platform === 'win32'
    const shellKind = detectShellKind(vscode.env.shell)
    const command = cfg.command.trim() || 'dsh-tui'
    // Resolve against the HOST PATH: the terminal shell's PATH may differ
    // (login shells rebuild it) — verified on Linux CI. The shell kind also
    // tells us whether a Windows path must be converted for Git Bash/WSL.
    const resolved = resolveLaunchCommand(command, isWindows, shellKind)
    const parts = [formatLaunchPath(resolved ?? command, shellKind, isWindows)]
    for (const arg of cfg.extraArgs) parts.push(arg)

    const existing = findTerminal()
    if (resumeSession) {
      // Resume a SPECIFIC session: the profile's cordis.patch.yml reads
      // DSH_TUI_RESUME_SESSION at boot — feed it through the terminal env
      // and run WITHOUT --resume (the launcher's --resume handler would
      // overwrite the env from ~/.dsh-tui/resume.txt).
      const env = buildEnv({
        DSH_TUI_RESUME_SESSION: resumeSession,
        DSH_CC_RESUME_SESSION: resumeSession,
      })
      const terminal = createTerminal(env)
      terminal.show()
      sendTextWhenReady(terminal, parts.join(' '))
      return
    }
    if (resume) {
      // Resume the LAST session: --resume reads ~/.dsh-tui/resume.txt.
      parts.push('--resume')
      const terminal = createTerminal(buildEnv())
      terminal.show()
      sendTextWhenReady(terminal, parts.join(' '))
      return
    }
    // Multiple concurrent sessions (like Claude Code): every click opens a
    // NEW terminal+session; existing sessions keep running in their own
    // terminals. `existing` is intentionally unused here.
    void existing
    const terminal = createTerminal(buildEnv())
    terminal.show()
    sendTextWhenReady(terminal, parts.join(' '))
  }

  const register = (id: string, fn: (...args: unknown[]) => void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  }
  register('dsh-tui-vscode.open', () => runCommand(false))
  register('dsh-tui-vscode.start', () => runCommand(false))
  register('dsh-tui-vscode.resume', () => runCommand(true))
  register('dsh-tui-vscode.focus', () => {
    const terminal = findTerminal()
    if (terminal) {
      terminal.show()
    } else {
      runCommand(false)
    }
  })
  register('dsh-tui-vscode.kill', () => {
    const terminal = findTerminal()
    if (terminal) {
      // Ctrl+C, like interrupting Claude Code with a keyboard interrupt.
      terminal.sendText('\u0003', false)
    }
  })
  register('dsh-tui-vscode.refreshSessions', () => {
    sessionsTree.refresh()
  })
  register('dsh-tui-vscode.resumeSession', (sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) return
    runCommand(true, sessionId)
  })
  /**
   * Session identity from a view/item/context command argument. Verified
   * against real VS Code clicks: the argument is the provider's ELEMENT
   * (the SessionRecord itself — id + file), not the rendered TreeItem.
   * TreeItem shapes (id/resourceUri, custom sessionId/sessionFile) are kept
   * as fallbacks for other VS Code versions.
   */
  const sessionIdentity = (item: unknown): { id: string; file: string } | undefined => {
    const it = item as
      | {
          id?: unknown
          file?: unknown
          resourceUri?: { fsPath?: unknown }
          sessionId?: unknown
          sessionFile?: unknown
        }
      | undefined
    if (!it) return undefined
    const id =
      typeof it.sessionId === 'string' ? it.sessionId : typeof it.id === 'string' ? it.id : undefined
    const file =
      typeof it.sessionFile === 'string'
        ? it.sessionFile
        : typeof it.file === 'string' // SessionRecord shape (real VS Code passes this)
          ? it.file
          : typeof it.resourceUri?.fsPath === 'string'
            ? it.resourceUri.fsPath
            : undefined
    return id !== undefined && file !== undefined ? { id, file } : undefined
  }

  register('dsh-tui-vscode.renameSession', async (item: unknown) => {
    const session = sessionIdentity(item)
    if (!session) return
    // The command may run before any list refresh initialized the wasm.
    await ensureZstd()
    const title = await vscode.window.showInputBox({
      prompt: `重命名会话 ${session.id.slice(0, 8)}…`,
      placeHolder: '输入新标题',
      ignoreFocusOut: true,
    })
    if (title === undefined) return // cancelled
    const trimmed = title.trim()
    if (!trimmed) return
    let result = appendSessionTitle(session.file, trimmed)
    if (result === 'unavailable') {
      // The wasm module instance can corrupt in a long-lived Electron host
      // (compress then emits non-frames). Reload it and retry once — the
      // first attempt verified its output and wrote nothing.
      resetZstd()
      await ensureZstd()
      result = appendSessionTitle(session.file, trimmed)
    }
    if (result === 'appended') {
      sessionsTree.refresh()
    } else {
      void vscode.window.showErrorMessage('重命名失败：会话日志不可写')
    }
  })
  register('dsh-tui-vscode.archiveSession', async (item: unknown) => {
    const session = sessionIdentity(item)
    if (!session) return
    // dsh-native archive: the session joins the workspace domain's archive
    // set (the same set the dsh web list reads) — hidden from the sidebar
    // while its log and accounting slot are retained, recoverable anytime.
    if (setSessionArchived(session.id, true) === 'ok') {
      sessionsTree.refresh()
    } else {
      void vscode.window.showErrorMessage('归档失败：无法写入会话域存储')
    }
  })
  register('dsh-tui-vscode.manageArchived', async () => {
    // List archived sessions (title + relative time); pick one, then choose
    // restore or permanent delete.
    const dshHome = sessionsTree.dshHomeForCommands()
    const archivedIds = readWorkspaceMeta(dshHome).archivedSessionIds
    if (archivedIds.length === 0) {
      void vscode.window.showInformationMessage('没有已归档的会话')
      return
    }
    const all = await listSessions(dshHome, {})
    const byId = new Map(all.map(s => [s.id, s]))
    const items: vscode.QuickPickItem[] = archivedIds.map(id => {
      const rec = byId.get(id)
      const when = rec?.lastUsed ?? rec?.createdAt
      return {
        label: rec?.title?.trim() || id.slice(0, 12),
        description: rec && when !== undefined ? relativeTime(when) : '日志缺失',
        detail: id,
      }
    })
    const picked = await vscode.window.showQuickPick(items, {
      title: '已归档会话',
      placeHolder: '选择会话',
      ignoreFocusOut: true,
    })
    if (!picked || !picked.detail) return
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(archive) 恢复会话', detail: '移回侧边栏，日志与位置原样保留' },
        { label: '$(trash) 彻底删除', detail: '永久移除该会话的日志目录，不可恢复' },
      ],
      { title: `会话：${picked.label}`, ignoreFocusOut: true },
    )
    if (!action) return
    if (action.label.includes('恢复')) {
      if (setSessionArchived(picked.detail, false) === 'ok') {
        sessionsTree.refresh()
        void vscode.window.showInformationMessage('会话已恢复')
      } else {
        void vscode.window.showErrorMessage('恢复失败：无法写入会话域存储')
      }
      return
    }
    const rec = byId.get(picked.detail)
    if (!rec) return
    const confirm = await vscode.window.showWarningMessage(
      `永久删除归档会话 ${picked.detail.slice(0, 8)}…？日志目录将被彻底移除，不可恢复。`,
      { modal: true },
      '永久删除',
    )
    if (confirm !== '永久删除') return
    if (deleteSessionLog(rec.file) === 'deleted') {
      // Drop the id from the archive set too (its log is gone).
      void setSessionArchived(picked.detail, false)
      sessionsTree.refresh()
    }
  })
  register('dsh-tui-vscode.deleteSession', async (item: unknown) => {
    const session = sessionIdentity(item)
    if (!session) return
    const answer = await vscode.window.showWarningMessage(
      `永久删除会话 ${session.id.slice(0, 8)}…？其日志目录将被彻底移除，此操作不可撤销。建议先归档。`,
      { modal: true },
      '永久删除',
    )
    if (answer !== '永久删除') return
    if (deleteSessionLog(session.file) === 'deleted') sessionsTree.refresh()
  })

  sessionsTree.refresh()
  refreshState()

  return {
    sendInput: text => {
      const terminal = findTerminal()
      if (terminal) terminal.sendText(text, false)
    },
    hasTerminal: () => hasTerminal(),
  }
}

export function deactivate(): void {
  // Terminals are owned by VS Code; nothing to tear down.
}