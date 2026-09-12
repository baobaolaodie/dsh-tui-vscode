import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionWatcherSet } from '../session-watchers.js'

/** A watcher handle that never fires; callbacks are captured separately. */
function silentWatcher(): FSWatcher {
  return { close: () => undefined } as unknown as FSWatcher
}

/** Mirrors fs.watch: a directory that does not exist cannot be watched. */
function absentAwareWatcher(dir: string): FSWatcher {
  if (!existsSync(dir)) throw new Error('ENOENT: ' + dir)
  return silentWatcher()
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('session watchers: every root and its group directories are watched', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-watch-'))
  try {
    const rootA = join(base, 'a')
    const rootB = join(base, 'b', 'sessions')
    mkdirSync(join(rootA, '--g1--'), { recursive: true })
    mkdirSync(join(rootB, '--g2--'), { recursive: true })
    const watchCalls: string[] = []
    const set = new SessionWatcherSet([rootA, rootB], {
      onChange: () => undefined,
      watchFn: dir => {
        watchCalls.push(dir)
        return absentAwareWatcher(dir)
      },
    })
    const expected = [rootA, rootB, join(rootA, '--g1--'), join(rootB, '--g2--')].sort()
    assert.deepEqual(set.watchedDirs().sort(), expected)
    assert.deepEqual(watchCalls.sort(), expected)
    set.dispose()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('session watchers: a missing root triggers exactly one listing when it appears', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-watch-appear-'))
  try {
    const existing = join(base, 'existing')
    const missing = join(base, 'missing')
    mkdirSync(existing, { recursive: true })
    let changes = 0
    const set = new SessionWatcherSet([existing, missing], {
      onChange: () => {
        changes += 1
      },
      watchFn: dir => absentAwareWatcher(dir),
    })
    assert.equal(set.watchedDirs().includes(missing), false)
    // Registering the existing root at construction must not fire.
    assert.equal(changes, 0)
    // Probing while the root is still absent must NOT list sessions — the
    // removed regression scheduled a full reload on every probe.
    set.probe()
    set.probe()
    assert.equal(changes, 0)
    mkdirSync(join(missing, '--g--'), { recursive: true })
    set.probe()
    assert.equal(set.watchedDirs().includes(missing), true)
    assert.equal(set.watchedDirs().includes(join(missing, '--g--')), true)
    assert.equal(changes, 1)
    // Later probes must not fire again.
    set.probe()
    assert.equal(changes, 1)
    set.dispose()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('session watchers: update() picks up group directories created later', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-watch-group-'))
  try {
    const root = join(base, 'r')
    mkdirSync(root, { recursive: true })
    const set = new SessionWatcherSet([root], {
      onChange: () => undefined,
      watchFn: dir => absentAwareWatcher(dir),
    })
    assert.deepEqual(set.watchedDirs(), [root])
    mkdirSync(join(root, '--new-group--'))
    set.update()
    assert.equal(set.watchedDirs().includes(join(root, '--new-group--')), true)
    set.dispose()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('session watchers: filesystem callbacks report changes', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-watch-cb-'))
  try {
    const root = join(base, 'r')
    mkdirSync(root, { recursive: true })
    const listeners: Array<() => void> = []
    let changes = 0
    const set = new SessionWatcherSet([root], {
      onChange: () => {
        changes += 1
      },
      watchFn: (dir, listener) => {
        listeners.push(listener)
        return absentAwareWatcher(dir)
      },
    })
    listeners[0]!()
    assert.equal(changes, 1)
    set.dispose()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('session watchers: the retry timer probes a missing root', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-watch-timer-'))
  try {
    const missing = join(base, 'm')
    let changes = 0
    const set = new SessionWatcherSet([missing], {
      onChange: () => {
        changes += 1
      },
      retryMs: 25,
      watchFn: dir => absentAwareWatcher(dir),
    })
    mkdirSync(join(missing, '--g--'), { recursive: true })
    await sleep(250)
    assert.equal(set.watchedDirs().includes(missing), true)
    assert.equal(changes, 1)
    set.dispose()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('session watchers: dispose clears watchers and the pending probe', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-watch-dispose-'))
  try {
    const missing = join(base, 'm')
    let changes = 0
    const set = new SessionWatcherSet([missing], {
      onChange: () => {
        changes += 1
      },
      retryMs: 20,
      watchFn: dir => absentAwareWatcher(dir),
    })
    set.dispose()
    mkdirSync(missing, { recursive: true })
    await sleep(150)
    assert.equal(changes, 0)
    assert.deepEqual(set.watchedDirs(), [])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
