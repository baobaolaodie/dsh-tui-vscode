import * as vscode from 'vscode'

/**
 * Status-bar item for the dsh-tui session. Always visible while the extension
 * is active; clicking it focuses the session terminal (or starts one).
 */
export class SessionStatusBar {
  private readonly item: vscode.StatusBarItem

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    this.item.text = '$(terminal) dsh-tui'
    this.item.command = 'dsh-tui-vscode.focus'
    this.item.tooltip = 'No dsh-tui session — click to start one'
    this.item.show()
  }

  update(active: boolean): void {
    this.item.tooltip = active
      ? 'dsh-tui session is running — click to focus'
      : 'No dsh-tui session — click to start one'
  }

  dispose(): void {
    this.item.dispose()
  }
}