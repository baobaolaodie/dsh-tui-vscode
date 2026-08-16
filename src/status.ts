/**
 * Status-bar item for the dsh-tui session. Hidden when no session is running
 * so the extension adds no permanent global UI clutter; clicking it opens the
 * session panel.
 */
import * as vscode from 'vscode'

export class SessionStatusBar {
  private readonly item: vscode.StatusBarItem

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    this.item.text = '$(terminal) dsh-tui'
    this.item.command = 'dsh-tui-vscode.open'
    this.item.tooltip = 'dsh-tui — click to open the session panel'
  }

  update(running: boolean): void {
    if (running) {
      this.item.tooltip = 'dsh-tui session is running — click to open the panel'
      this.item.show()
    } else {
      this.item.hide()
    }
  }

  dispose(): void {
    this.item.dispose()
  }
}