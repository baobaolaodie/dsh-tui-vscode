import * as vscode from 'vscode'
import { homedir } from 'node:os'
import { SessionsTreeProvider } from './sessions-view'
import { SessionStatusBar } from './status'
import { appendSessionTitle, deleteSessionLog } from './sessions'
import { buildLaunchEnv, resolveLaunchCommand, quoteLaunchPath } from './session'

const TERMINAL_NAME = 'DeepSeek'

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
    const command = cfg.command.trim() || 'dsh-tui'
    // Resolve against the HOST PATH: the terminal shell's PATH may differ
    // (login shells rebuild it) — verified on Linux CI.
    const resolved = resolveLaunchCommand(command, isWindows)
    const parts = resolved ? [quoteLaunchPath(resolved, isWindows)] : [command]
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
  register('dsh-tui-vscode.renameSession', async (sessionId: unknown, file: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId || typeof file !== 'string' || !file) return
    const title = await vscode.window.showInputBox({
      prompt: `重命名会话 ${sessionId.slice(0, 8)}…`,
      placeHolder: '输入新标题',
      ignoreFocusOut: true,
    })
    if (title === undefined) return // cancelled
    const trimmed = title.trim()
    if (!trimmed) return
    if (appendSessionTitle(file, trimmed) === 'appended') sessionsTree.refresh()
  })
  register('dsh-tui-vscode.deleteSession', async (sessionId: unknown, file: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId || typeof file !== 'string' || !file) return
    const answer = await vscode.window.showWarningMessage(
      `删除会话 ${sessionId.slice(0, 8)}…？其日志目录将被永久移除，此操作不可撤销。`,
      { modal: true },
      '删除',
    )
    if (answer !== '删除') return
    if (deleteSessionLog(file) === 'deleted') sessionsTree.refresh()
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