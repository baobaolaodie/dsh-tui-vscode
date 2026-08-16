/**
 * Sidebar session list (activity-bar container) — grouped by project, shaped
 * like the official Claude Code sessions sidebar: clean entries with a title
 * and a compact relative time. Clicking a session resumes it in a fresh
 * terminal on the Beside column.
 */
import * as vscode from 'vscode'
import { watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

interface ProjectNode {
  project: string
  sessions: SessionRecord[]
}

export class SessionsTreeProvider
  implements vscode.TreeDataProvider<SessionRecord | ProjectNode>
{
  private readonly onChange = new vscode.EventEmitter<
    SessionRecord | ProjectNode | undefined
  >()
  readonly onDidChangeTreeData = this.onChange.event
  private sessions: SessionRecord[] = []
  private watchers: FSWatcher[] = []
  private refreshTimer: NodeJS.Timeout | undefined

  refresh(): void {
    void this.reload()
  }

  /** Watch the DSH sessions tree so new sessions appear automatically. */
  startWatching(dshHome?: string): void {
    const root = join(
      dshHome?.trim() || process.env.DSH_HOME || join(homedir(), '.dsh'),
      'sessions',
    )
    const schedule = (): void => {
      if (this.refreshTimer) clearTimeout(this.refreshTimer)
      this.refreshTimer = setTimeout(() => this.refresh(), 500)
    }
    const addWatcher = (dir: string): void => {
      try {
        const w = watch(dir, { persistent: false }, schedule)
        this.watchers.push(w)
      } catch {
        // dir vanished — ignore
      }
    }
    addWatcher(root)
    // Watch group dirs too (Linux fs.watch is not recursive).
    try {
      const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
      for (const group of readdirSync(root)) {
        const p = join(root, group)
        try {
          if (statSync(p).isDirectory()) addWatcher(p)
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  dispose(): void {
    for (const w of this.watchers) {
      try {
        w.close()
      } catch {
        // already closed
      }
    }
    this.watchers = []
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
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

  getTreeItem(element: SessionRecord | ProjectNode): vscode.TreeItem {
    if ('sessions' in element) {
      const count = element.sessions.length
      const item = new vscode.TreeItem(
        `${element.project}（${count}）`,
        vscode.TreeItemCollapsibleState.Expanded,
      )
      item.contextValue = 'dshProject'
      return item
    }
    const title = element.title?.trim()
    const item = new vscode.TreeItem(
      title && title.length > 0 ? title : '未命名会话',
      vscode.TreeItemCollapsibleState.None,
    )
    const when = element.lastUsed ?? element.createdAt
    if (when !== undefined) {
      item.description = relativeTime(when)
    }
    item.tooltip = [title ?? '未命名会话', element.cwd ?? '', element.id].join('\n')
    item.command = {
      command: 'dsh-tui-vscode.resumeSession',
      title: '恢复会话',
      arguments: [element.id],
    }
    item.contextValue = 'dshSession'
    return item
  }

  getChildren(element?: SessionRecord | ProjectNode): Array<SessionRecord | ProjectNode> {
    if (!element) {
      // Group by project; most recently active project first.
      const groups = new Map<string, ProjectNode>()
      for (const s of this.sessions) {
        const key = s.project?.trim() || '未命名项目'
        const node = groups.get(key)
        if (node) {
          node.sessions.push(s)
        } else {
          groups.set(key, { project: key, sessions: [s] })
        }
      }
      return [...groups.values()].sort(
        (a, b) =>
          (b.sessions[0]?.lastUsed ?? b.sessions[0]?.createdAt ?? 0) -
          (a.sessions[0]?.lastUsed ?? a.sessions[0]?.createdAt ?? 0),
      )
    }
    if ('sessions' in element) {
      return element.sessions
    }
    return []
  }
}