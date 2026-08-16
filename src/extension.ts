import * as vscode from 'vscode'
import { homedir } from 'node:os'
import { TuiPanel } from './panel'
import { SessionStatusBar } from './status'
import type { PtyLaunchOptions } from './pty'

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
  /** Write raw input into the running session's PTY (used by tests/scripts). */
  postInput(data: string): void
  getState(): { running: boolean; pid?: number; exitCode?: number; webviewReady: boolean }
  /** Deliver a webview-style message to the session panel (used by tests). */
  postPanelMessage(message: unknown): void
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media')
  const status = new SessionStatusBar()
  context.subscriptions.push(status)

  const launchOptions = (resume: boolean): PtyLaunchOptions => {
    const cfg = readSettings()
    return {
      resume,
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir(),
      command: cfg.command,
      extraArgs: cfg.extraArgs,
      lang: cfg.lang,
      injectEditor: cfg.injectEditor,
      editorCommand: cfg.editorCommand,
      dshHome: cfg.dshHome,
    }
  }

  // The session panel is a SIDEBAR webview view (activity-bar container),
  // mirroring the official Claude Code extension's placement. Opening the
  // view auto-starts the session (no buttons in the panel).
  const panel = new TuiPanel(mediaUri, () => launchOptions(false), refreshState)
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(TuiPanel.viewType, panel))

  function refreshState(): void {
    status.update(panel.getState().running)
  }

  const register = (id: string, fn: () => void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  }
  register('dsh-tui-vscode.open', () => {
    panel.open(false, launchOptions(false))
  })
  register('dsh-tui-vscode.start', () => {
    panel.open(false, launchOptions(false))
  })
  register('dsh-tui-vscode.resume', () => {
    panel.open(true, launchOptions(true))
  })
  register('dsh-tui-vscode.focus', () => {
    if (panel.isRunning()) {
      panel.reveal()
    } else {
      panel.open(false, launchOptions(false))
    }
    refreshState()
  })
  register('dsh-tui-vscode.kill', () => {
    panel.kill()
    refreshState()
  })

  refreshState()

  return {
    postInput: data => panel.postInput(data),
    getState: () => panel.getState(),
    postPanelMessage: message => panel.handleMessage(message),
  }
}

export function deactivate(): void {
  // The PTY child dies with the extension host; nothing else to tear down.
}