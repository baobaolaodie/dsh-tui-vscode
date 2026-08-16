/**
 * Sidebar session list (activity-bar container) — shaped like the official
 * Claude Code sessions sidebar: clean entries with a title and a compact
 * relative time, no raw ids or long paths in the row. Clicking a session
 * resumes it in a fresh terminal on the Beside column.
 */
import * as vscode from 'vscode'
import { listSessions, type SessionRecord } from './sessions'

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

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionRecord> {
  private readonly onChange = new vscode.EventEmitter<SessionRecord | undefined>()
  readonly onDidChangeTreeData = this.onChange.event
  private sessions: SessionRecord[] = []

  refresh(): void {
    void this.reload()
  }

  private async reload(): Promise<void> {
    try {
      this.sessions = await listSessions()
    } catch (error) {
      this.sessions = []
      console.error('dsh-tui: failed to list sessions', error)
    }
    this.onChange.fire(undefined)
  }

  getTreeItem(element: SessionRecord): vscode.TreeItem {
    const title = element.title?.trim()
    const item = new vscode.TreeItem(
      title && title.length > 0 ? title : '未命名会话',
      vscode.TreeItemCollapsibleState.None,
    )
    if (element.createdAt !== undefined) {
      item.description = relativeTime(element.createdAt)
    }
    item.tooltip = [
      title ?? '未命名会话',
      element.cwd ?? '',
      element.id,
    ].join('\n')
    item.command = {
      command: 'dsh-tui-vscode.resumeSession',
      title: '恢复会话',
      arguments: [element.id],
    }
    item.contextValue = 'dshSession'
    return item
  }

  getChildren(): SessionRecord[] {
    return this.sessions
  }
}