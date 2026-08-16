/**
 * The TUI panel — a SIDEBAR webview view (activity-bar container), matching
 * the official Claude Code extension's placement (claudeVSCodeSidebar).
 * Renders the PTY stream with xterm.js.
 *
 * Lifecycle mirrors dsh-tui's native foreground-process model: the session
 * runs as long as the panel holds it; it ends when you stop it (the ■ button,
 * double Ctrl+C inside the TUI, or the kill command) or when VS Code exits.
 * Hiding the view keeps the session alive; reopening reconnects to the live
 * stream (scrollback is not preserved across a full dispose).
 */
import * as vscode from 'vscode'
import { OscScanner } from './osc'
import { startPtySession, type PtyLaunchOptions, type PtySession } from './pty'
import { resolveLocalPath } from './paths'

export const PANEL_VIEW_TYPE = 'dsh-tui-vscode.session'

export interface SessionState {
  running: boolean
  pid?: number
  exitCode?: number
  /** True once the webview loaded and xterm initialized (ready message). */
  webviewReady: boolean
}

export class TuiPanel implements vscode.WebviewViewProvider {
  static readonly viewType = PANEL_VIEW_TYPE

  private view: vscode.WebviewView | undefined
  private session: PtySession | undefined
  private scanner = new OscScanner()
  private ready = false
  private readonly pending: string[] = []
  private exitCode: number | undefined
  private pid: number | undefined

  constructor(
    private readonly mediaUri: vscode.Uri,
    private readonly launchOptions: () => PtyLaunchOptions,
    private readonly onChange: () => void,
  ) {}

  getState(): SessionState {
    return {
      running: this.isRunning(),
      pid: this.pid,
      exitCode: this.exitCode,
      webviewReady: this.ready,
    }
  }

  isRunning(): boolean {
    return this.session !== undefined && this.exitCode === undefined
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.mediaUri],
    }
    webviewView.webview.html = this.renderHtml(webviewView.webview)
    webviewView.webview.onDidReceiveMessage(message => this.onMessage(message))
    webviewView.onDidDispose(() => {
      this.view = undefined
      this.ready = false
      this.pending.length = 0
    })
    // Auto-start a session when the panel opens (like Claude Code: open =
    // start talking). No buttons anywhere — stop via Ctrl+C in the TUI, the
    // kill command, or closing VS Code.
    this.ensureSession(false, this.launchOptions())
    this.postState()
  }

  /** Open the sidebar view and start a session (if none is running). */
  open(resume: boolean, options: PtyLaunchOptions): void {
    if (!this.view) {
      void vscode.commands.executeCommand(`${PANEL_VIEW_TYPE}.focus`)
    }
    this.ensureSession(resume, options)
    this.view?.show?.(true)
    this.onChange()
  }
  reveal(): void {
    if (!this.view) {
      void vscode.commands.executeCommand(`${PANEL_VIEW_TYPE}.focus`)
    }
    this.view?.show?.(true)
  }

  kill(): void {
    const session = this.session
    if (!session || this.exitCode !== undefined) return
    try {
      session.write('\x03')
    } catch {
      // already gone
    }
    setTimeout(() => {
      if (this.exitCode === undefined && this.session === session) {
        try {
          session.kill()
        } catch {
          // already gone
        }
      }
    }, 600)
  }

  postInput(data: string): void {
    this.session?.write(data)
  }

  /** Exposed for tests/scripts: deliver a webview-style message to the panel. */
  handleMessage(message: unknown): void {
    this.onMessage(message)
  }

  dispose(): void {
    try {
      this.session?.kill()
    } catch {
      // already gone
    }
    this.session = undefined
  }

  private ensureSession(resume: boolean, options: PtyLaunchOptions): void {
    if (this.isRunning()) return
    this.exitCode = undefined
    this.pid = undefined
    this.scanner = new OscScanner()
    this.session = startPtySession(options, 80, 24, {
      onData: chunk => this.onPtyData(chunk),
      onExit: code => {
        this.exitCode = code
        this.post({ type: 'exit', code })
        this.postState()
        this.onChange()
      },
    })
    this.pid = this.session.pid
    this.postState()
  }

  private onPtyData(chunk: string): void {
    const { clean, events } = this.scanner.scan(chunk)
    for (const event of events) {
      switch (event.kind) {
        case 'clipboard': {
          const payload = event.payload ?? ''
          if (payload.length > 2 && payload[1] === ';') {
            const text = Buffer.from(payload.slice(2), 'base64').toString('utf8')
            if (text) void vscode.env.clipboard.writeText(text)
          }
          break
        }
        case 'backgroundQuery':
          this.session?.write(backgroundResponse())
          break
        case 'title':
          break
      }
    }
    if (this.ready && this.view) {
      this.post({ type: 'data', data: clean })
    } else {
      this.pending.push(clean)
    }
  }

  private onMessage(message: unknown): void {
    const msg = message as
      | { type: 'ready'; cols: number; rows: number }
      | { type: 'input'; data: string }
      | { type: 'resize'; cols: number; rows: number }
      | { type: 'openPath'; path: string; line?: number; col?: number }
      | { type: 'command'; command: string }
      | undefined
    if (!msg) return
    switch (msg.type) {
      case 'ready':
        this.ready = true
        this.post({ type: 'resize', cols: msg.cols, rows: msg.rows })
        this.session?.resize(msg.cols, msg.rows)
        for (const data of this.pending) this.post({ type: 'data', data })
        this.pending.length = 0
        this.postState()
        break
      case 'input':
        this.session?.write(msg.data)
        break
      case 'resize':
        this.session?.resize(msg.cols, msg.rows)
        break
      case 'command':
        if (msg.command.startsWith('dsh-tui-vscode.')) {
          void vscode.commands.executeCommand(msg.command)
        }
        break
      case 'openPath': {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''
        const abs = resolveLocalPath(msg.path, { root })
        const uri = vscode.Uri.file(abs)
        const selection =
          msg.line !== undefined
            ? new vscode.Range(
                Math.max(0, msg.line - 1),
                Math.max(0, (msg.col ?? 1) - 1),
                Math.max(0, msg.line - 1),
                Math.max(0, (msg.col ?? 1) - 1),
              )
            : undefined
        void vscode.window.showTextDocument(uri, { preview: true, selection })
        break
      }
    }
  }

  private postState(): void {
    this.post({ type: 'state', ...this.getState() })
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message)
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.mediaUri, 'webview.js'))
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.mediaUri, 'webview.css'))
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ')
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
<div id="terminal"></div>
<script src="${scriptUri}"></script>
</body>
</html>`
  }
}

/** Answer the TUI's OSC 11 background query with the current theme color.
 *  The TUI accepts `#RRGGBB` (see src/ink/termio/osc.ts). */
function backgroundResponse(): string {
  const kind = vscode.window.activeColorTheme.kind
  const isLight =
    kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
  const hex = isLight ? 'ffffff' : '1e1e1e'
  return `\x1b]11;#${hex}\x07`
}