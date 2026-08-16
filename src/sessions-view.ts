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
import { listSessions, sessionLabel, type SessionRecord } from './sessions'

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

/**
 * A session row as the tree hands it to view/item/context menu commands.
 * VS Code passes the SELECTED TreeItem as the command's first argument —
 * it carries no session fields of its own, so the record's id and log path
 * ride along as extra properties (read back by renameSession/deleteSession).
 */
export interface SessionTreeItem extends vscode.TreeItem {
  sessionId?: string
  sessionFile?: string
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
  private watchedDirs = new Set<string>()
  private refreshTimer: NodeJS.Timeout | undefined
  private dshHome: string | undefined
  private sessionsRoot: string | undefined

  refresh(): void {
    void this.reload()
  }

  /** Debounced reload, shared by every fs.watch callback. */
  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => this.refresh(), 500)
  }

  /** Watch the DSH sessions tree so new sessions appear automatically. */
  startWatching(dshHome?: string): void {
    this.dshHome = dshHome
    this.sessionsRoot = join(
      dshHome?.trim() || process.env.DSH_HOME || join(homedir(), '.dsh'),
      'sessions',
    )
    this.syncWatchers()
  }

  /**
   * Idempotently watch the sessions root and every group directory under it.
   * Called at startup AND after every reload: a group directory created
   * after activation (a session launched in a brand-new working directory)
   * is not covered by the root watcher (fs.watch is not recursive), so each
   * reload picks up newly appeared groups.
   */
  private syncWatchers(): void {
    if (this.sessionsRoot === undefined) return
    const addWatcher = (dir: string): void => {
      if (this.watchedDirs.has(dir)) return
      try {
        const w = watch(dir, { persistent: false }, () => this.scheduleRefresh())
        this.watchers.push(w)
        this.watchedDirs.add(dir)
      } catch {
        // dir vanished — ignore
      }
    }
    addWatcher(this.sessionsRoot)
    try {
      const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
      for (const group of readdirSync(this.sessionsRoot)) {
        const p = join(this.sessionsRoot, group)
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
    this.watchedDirs.clear()
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
  }

  private async reload(): Promise<void> {
    try {
      // The sidebar mirrors the dsh browser's default view: sessions of the
      // CURRENT workspace(s) only, boot-only sessions (no human prompt) and
      // delegated sub-agent runs folded away. No workspace open → no sessions
      // to attribute, so the welcome view greets instead.
      const workspaceDirs = (vscode.workspace.workspaceFolders ?? []).map(
        f => f.uri.fsPath,
      )
      this.sessions = await listSessions(this.dshHome, {
        workspaceDirs,
        hideEmpty: true,
        hideSubagents: true,
      })
      // Pick up group directories created since the last pass (fs.watch on
      // the root is not recursive) so their log writes keep refreshing.
      this.syncWatchers()
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
    // Label chain (pure, tested in sessions.test.ts): display title →
    // working-directory basename → generic placeholder — a titled list
    // beats one full of 未命名会话.
    const label = sessionLabel(element)
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None) as SessionTreeItem
    // Context-menu commands receive this TreeItem, not command.arguments —
    // carry the record identity on the item itself.
    item.sessionId = element.id
    item.sessionFile = element.file
    const when = element.lastUsed ?? element.createdAt
    if (when !== undefined) {
      item.description = relativeTime(when)
    }
    item.tooltip = [element.title?.trim() ?? label, element.cwd ?? '', element.id].join('\n')
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