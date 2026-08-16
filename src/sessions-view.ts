/**
 * Sidebar session list (activity-bar container) — shaped like the official
 * Claude Code sessions sidebar: a list of past sessions with a title and
 * relative time. Clicking a session resumes it in the editor-area panel.
 */
import * as vscode from 'vscode'
import { listSessions, type SessionRecord } from './sessions'

function relativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
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
    const item = new vscode.TreeItem(
      element.title?.trim() || element.id.slice(0, 12),
      vscode.TreeItemCollapsibleState.None,
    )
    const parts: string[] = []
    if (element.createdAt !== undefined) parts.push(relativeTime(element.createdAt))
    if (element.cwd) parts.push(element.cwd)
    item.description = parts.join(' · ')
    item.tooltip = `${element.title ?? element.id}\n${element.cwd ?? ''}`
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