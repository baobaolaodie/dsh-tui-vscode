import * as vscode from 'vscode'
import { homedir } from 'node:os'
import { SessionsTreeProvider } from './sessions-view'
import { SessionStatusBar } from './status'
import { buildLaunchEnv } from './session'

const TERMINAL_NAME = 'dsh-tui'

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
  )

  function hasTerminal(): boolean {
    return vscode.window.terminals.some(t => t.name === TERMINAL_NAME)
  }
  const findTerminal = (): vscode.Terminal | undefined =>
    vscode.window.terminals.find(t => t.name === TERMINAL_NAME)

  const refreshState = (): void => status.update(hasTerminal())
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => refreshState()),
    vscode.window.onDidCloseTerminal(() => refreshState()),
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
      // Editor-area terminal, matching the official extension's location for
      // terminal sessions.
      location: vscode.TerminalLocation.Editor,
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
    const parts = [cfg.command.trim() || 'dsh-tui']
    if (resume) parts.push('--resume')
    for (const arg of cfg.extraArgs) parts.push(arg)

    const existing = findTerminal()
    if (resumeSession) {
      // A specific session needs DSH_TUI_RESUME_SESSION at terminal creation
      // time — recreate the terminal with the id in its environment.
      const env = buildEnv({
        DSH_TUI_RESUME_SESSION: resumeSession,
        DSH_CC_RESUME_SESSION: resumeSession,
      })
      if (existing) existing.dispose()
      const terminal = createTerminal(env)
      terminal.show()
      sendTextWhenReady(terminal, parts.join(' '))
      return
    }
    if (resume) {
      // Resume is an explicit launch intent: always start fresh.
      if (existing) existing.dispose()
      const terminal = createTerminal(buildEnv())
      terminal.show()
      sendTextWhenReady(terminal, parts.join(' '))
      return
    }
    if (existing) {
      // Dedupe: a dsh-tui terminal is already open — just focus it.
      existing.show()
      return
    }
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
    if (hasTerminal()) {
      findTerminal()?.show()
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