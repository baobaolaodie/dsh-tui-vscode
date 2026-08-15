/**
 * Sidebar control view (activity bar → "会话控制"): session buttons and
 * status, plus a settings shortcut. The TUI itself renders in the editor-area
 * panel (TuiPanel); this view is the lightweight companion face.
 */
import * as vscode from 'vscode'
import type { SessionState } from './panel'

export class ControlViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'dsh-tui-vscode.control'

  private view: vscode.WebviewView | undefined

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = { enableScripts: true }
    webviewView.webview.html = this.renderHtml()
    webviewView.webview.onDidReceiveMessage(message => {
      const msg = message as { type?: string; command?: string } | undefined
      if (!msg?.type) return
      if (msg.type === 'command' && msg.command) {
        void vscode.commands.executeCommand(msg.command)
      } else if (msg.type === 'settings') {
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:baobaolaodie.dsh-tui-vscode',
        )
      }
    })
  }

  updateState(state: SessionState): void {
    this.view?.webview.postMessage({ type: 'state', ...state })
  }

  private renderHtml(): string {
    const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { padding: 8px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  h3 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; opacity: .7; }
  button {
    display: block; width: 100%; margin: 4px 0; padding: 6px 8px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; border-radius: 3px; cursor: pointer; text-align: left;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #status { margin: 8px 0; font-size: 12px; }
  .running { color: #4ec9b0; }
  .stopped { color: var(--vscode-disabledForeground); }
  a { cursor: pointer; color: var(--vscode-textLink-foreground); font-size: 12px; }
</style>
</head>
<body>
  <h3>dsh-tui 会话</h3>
  <div id="status" class="stopped">未运行</div>
  <button data-cmd="dsh-tui-vscode.open">打开会话面板</button>
  <button data-cmd="dsh-tui-vscode.start">启动新会话</button>
  <button data-cmd="dsh-tui-vscode.resume">恢复上次会话</button>
  <button data-cmd="dsh-tui-vscode.focus">聚焦面板</button>
  <button data-cmd="dsh-tui-vscode.kill">终止会话</button>
  <a id="settings">扩展设置…</a>
<script>
(function () {
  const vscode = acquireVsCodeApi()
  for (const btn of document.querySelectorAll('button[data-cmd]')) {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'command', command: btn.dataset.cmd }))
  }
  document.getElementById('settings').addEventListener('click', () => vscode.postMessage({ type: 'settings' }))
  window.addEventListener('message', event => {
    const msg = event.data
    if (!msg || msg.type !== 'state') return
    const el = document.getElementById('status')
    if (msg.running) { el.textContent = '运行中' + (msg.pid ? ' (PID ' + msg.pid + ')' : ''); el.className = 'running' }
    else if (msg.exitCode !== undefined && msg.exitCode !== null) { el.textContent = '已退出 (code ' + msg.exitCode + ')'; el.className = 'stopped' }
    else { el.textContent = '未运行'; el.className = 'stopped' }
  })
})()
</script>
</body>
</html>`
  }
}