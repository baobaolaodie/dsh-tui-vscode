/**
 * Status-bar item for the dsh-tui session. Always visible while the extension
 * is active; clicking it opens the session panel.
 */
import * as vscode from 'vscode'

export class SessionStatusBar {
  private readonly item: vscode.StatusBarItem

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    this.item.text = '$(terminal) dsh-tui'
    this.item.command = 'dsh-tui-vscode.open'
    this.item.tooltip = 'dsh-tui — click to open the session panel'
    this.item.show()
  }

  update(running: boolean): void {
    this.item.tooltip = running
      ? 'dsh-tui session is running — click to open the panel'
      : 'No dsh-tui session — click to open the panel'
  }

  dispose(): void {
    this.item.dispose()
  }
}