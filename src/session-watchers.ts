/**
 * Filesystem watcher set for the session roots — vscode-free, so the whole
 * lifecycle is unit-tested in src/test/session-watchers.test.ts.
 *
 * `fs.watch` is not recursive, so every root AND each of its group
 * directories is watched individually. A root that does not exist yet cannot
 * be watched; it is re-probed on a slow timer. A probe only stats/readdirs,
 * while re-listing sessions re-reads every log (~2 s on a real 585-session
 * home) — so probing must never trigger a listing by itself.
 */
import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

export interface SessionWatcherSetOptions {
  /** Called when a watched directory changes, or ONCE when a previously
   *  missing root appears (its already-present sessions need one listing). */
  onChange: () => void
  /** Retry interval for roots that do not exist yet (default 60 s). */
  retryMs?: number
  /** Watch factory seam for tests (defaults to `fs.watch`). */
  watchFn?: (dir: string, onChange: () => void) => FSWatcher
}

export class SessionWatcherSet {
  private readonly roots: readonly string[]
  private readonly watchers: FSWatcher[] = []
  private readonly watched = new Set<string>()
  private readonly onChange: () => void
  private readonly retryMs: number
  private readonly watchFn: (dir: string, onChange: () => void) => FSWatcher
  private retryTimer: NodeJS.Timeout | undefined
  private initialized = false

  constructor(roots: readonly string[], options: SessionWatcherSetOptions) {
    this.roots = [...roots]
    this.onChange = options.onChange
    this.retryMs = options.retryMs ?? 60_000
    this.watchFn =
      options.watchFn ?? ((dir, listener) => watch(dir, { persistent: false }, listener))
    this.update()
  }

  /** Watched directories (roots and group dirs), for tests/diagnostics. */
  watchedDirs(): string[] {
    return [...this.watched]
  }

  /**
   * (Re-)register watchers for every existing root and group directory, and
   * schedule a probe while a root is still missing. Idempotent; called at
   * startup and after every reload (new group dirs appear over time).
   */
  update(): void {
    const unwatchedBefore = this.roots.filter(root => !this.watched.has(root))
    for (const root of this.roots) {
      this.addWatcher(root)
      try {
        for (const group of readdirSync(root)) {
          const p = join(root, group)
          try {
            if (statSync(p).isDirectory()) this.addWatcher(p)
          } catch {
            // ignore unreadable entries
          }
        }
      } catch {
        // root absent — the probe timer retries
      }
    }
    // A root that appeared since the previous update has sessions that no
    // watcher event will announce — ask the caller to list exactly once. The
    // construction-time registration must not fire: startup lists anyway.
    if (this.initialized && unwatchedBefore.some(root => this.watched.has(root))) {
      this.onChange()
    }
    this.initialized = true
    this.scheduleProbeIfMissing()
  }

  /** Re-probe immediately (the retry timer's body; tests call it directly). */
  probe(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    this.update()
  }

  dispose(): void {
    for (const w of this.watchers) {
      try {
        w.close()
      } catch {
        // already closed
      }
    }
    this.watchers.length = 0
    this.watched.clear()
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
  }

  private addWatcher(dir: string): void {
    if (this.watched.has(dir)) return
    try {
      this.watchers.push(this.watchFn(dir, () => this.onChange()))
      this.watched.add(dir)
    } catch {
      // absent / vanished — the probe timer (or the next update) retries
    }
  }

  private scheduleProbeIfMissing(): void {
    const missing = this.roots.some(root => !this.watched.has(root))
    if (!missing || this.retryTimer !== undefined) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.update()
    }, this.retryMs)
  }
}
