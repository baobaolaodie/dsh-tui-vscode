/**
 * E2E suite for the dsh-tui VS Code companion (terminal-based).
 *
 * The session runs in a REAL VS Code integrated terminal (the user's default
 * shell — PowerShell on Windows), exactly like the official Claude Code
 * extension: createTerminal + run the CLI inside it. These tests drive the
 * same commands a user would.
 */
import * as vscode from 'vscode'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import * as zstd from '@bokuweb/zstd-wasm'

/** Selection payloads use forward-slash paths (the wire contract). */
const normalizeWsPath = (fsPath: string): string => fsPath.replace(/\\/g, '/')
/** Case-folded comparison form for cwd assertions (Windows drive letters). */
const normalize = (p: string): string => normalizeWsPath(p).replace(/\/+$/, '').toLowerCase()

const EXT_ID = 'baobaolaodie.dsh-tui-vscode'
// The suite workspace lives INSIDE the throwaway git parent run-tests.ts
// creates (`.e2e-git-parent/.e2e-workspace`): it must be a SUBDIRECTORY of a
// real repository so the git-crawl vs opened-root shape can be reproduced.
// A stale top-level `.e2e-workspace` from an older layout used to satisfy this
// path on dev machines while CI (clean checkout) failed with ENOENT.
const WS = join(__dirname, '..', '..', '.e2e-git-parent', '.e2e-workspace')
const ENV_OUT = join(WS, 'env-out.txt')
const STDIN_OUT = join(WS, 'stdin-out.txt')
const EXITED = join(WS, 'exited.txt')
const TERMINAL_NAME = 'DeepSeek'

// ---- l10n expectations (T04 / ADR-005) -------------------------------------
// The e2e suite runs OUTSIDE the extension under test, so `vscode.l10n.t`
// called here would resolve the HOST's bundle, never this extension's
// (L-003). Expected UI strings are read from the same resources the product
// ships: `l10n/bundle.l10n.json` (English identity fallback) overlaid by
// `l10n/bundle.l10n.<locale>.json` (display-language override).
const REPO_ROOT = join(__dirname, '..', '..') // out-test/test-suite -> repo root

const bundleCache = new Map<string, Record<string, string>>()

/** English fallback + `<locale>` override for the given locale, cached. */
function bundleFor(locale: string): Record<string, string> {
  const cached = bundleCache.get(locale)
  if (cached) return cached
  const bundle = JSON.parse(
    readFileSync(join(REPO_ROOT, 'l10n', 'bundle.l10n.json'), 'utf8'),
  ) as Record<string, string>
  if (locale && locale !== 'en') {
    const localized = join(REPO_ROOT, 'l10n', `bundle.l10n.${locale}.json`)
    if (existsSync(localized)) {
      Object.assign(bundle, JSON.parse(readFileSync(localized, 'utf8')) as Record<string, string>)
    }
  }
  bundleCache.set(locale, bundle)
  return bundle
}

/** `vscode.l10n.t`-shaped lookup: `{0}` args + current display language. */
function t(key: string, ...args: Array<string | number>): string {
  const template = bundleFor(vscode.env.language)[key]
  assert.ok(template !== undefined, `missing l10n bundle key: ${key}`)
  return template.replace(
    /\{(\d+)\}/g,
    (_match: string, index: string) => String(args[Number(index)] ?? ''),
  )
}

interface Api {
  sendInput(text: string): void
  hasTerminal(): boolean
  /** E2E seam on the extension side — see `ExtensionApi` in src/extension.ts. */
  seedImageSetupPrompted(shown: boolean): Thenable<void>
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function poll<T>(fn: () => T | undefined, timeoutMs: number, intervalMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = fn()
    if (value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error('poll timeout')
    await sleep(intervalMs)
  }
}

function readFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

const findTuiTerminal = (): vscode.Terminal | undefined =>
  vscode.window.terminals.find(t => t.name === TERMINAL_NAME)

async function configureFakeLauncher(): Promise<void> {
  // Ensure $VISUAL injection triggers (neither var set in the host).
  delete process.env.VISUAL
  delete process.env.EDITOR
  const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
  await cfg.update('command', 'fake-dsh-tui', vscode.ConfigurationTarget.Global)
  await cfg.update('extraArgs', [], vscode.ConfigurationTarget.Global)
  await cfg.update('lang', 'zh', vscode.ConfigurationTarget.Global)
  await cfg.update('dshHome', 'C:\\e2e-home', vscode.ConfigurationTarget.Global)
}

/**
 * Put the fake launcher's directory FIRST on the HOST's PATH while `run`
 * executes. The extension resolves the configured command against that PATH
 * (session.ts `resolveLaunchCommand` — the terminal shell rebuilds PATH, so it
 * is not trusted), which is what makes the bare `fake-dsh-tui` resolve.
 */
async function withFakeLauncherOnPath<T>(run: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH ?? ''
  process.env.PATH = WS + (process.platform === 'win32' ? ';' : ':') + originalPath
  try {
    return await run()
  } finally {
    process.env.PATH = originalPath
  }
}

const tests: Array<[string, () => Promise<void>]> = []
function test(name: string, fn: () => Promise<void>): void {
  tests.push([name, fn])
}

test('extension activates and registers all commands', async () => {
  const ext = vscode.extensions.getExtension(EXT_ID)
  assert.ok(ext, `extension ${EXT_ID} not found`)
  await ext!.activate()
  const cmds = await vscode.commands.getCommands(true)
  for (const id of [
    'dsh-tui-vscode.open',
    'dsh-tui-vscode.start',
    'dsh-tui-vscode.resume',
    'dsh-tui-vscode.focus',
    'dsh-tui-vscode.kill',
    'dsh-tui-vscode.insertAtMention',
    'dsh-tui-vscode.resumeSession',
    'dsh-tui-vscode.renameSession',
    'dsh-tui-vscode.deleteSession',
    'dsh-tui-vscode.refreshSessions',
  ]) {
    assert.ok(cmds.includes(id), `command ${id} not registered`)
  }
})

test('start opens a REAL terminal and launches the CLI with env injection', async () => {
  await configureFakeLauncher()
  rmSync(ENV_OUT, { force: true })
  rmSync(STDIN_OUT, { force: true })

  await vscode.commands.executeCommand('dsh-tui-vscode.start')

  // A real VS Code integrated terminal must exist (not a webview panel).
  await poll(() => (findTuiTerminal() ? true : undefined), 10000)

  // The child echoes its environment (env injection via createTerminal env).
  const text = await poll(() => {
    const content = readFile(ENV_OUT)
    return content?.includes('FAKE_LAUNCHER_RAN') ? content : undefined
  }, 20000).catch(() => undefined)
  if (!text) {
    // Probe whether the shell is alive and what it sees: write $PATH and the
    // command lookup result to files we can read back.
    const diagPath = join(WS, 'diag-path.txt')
    const diagType = join(WS, 'diag-type.txt')
    rmSync(diagPath, { force: true })
    rmSync(diagType, { force: true })
    const terminal = findTuiTerminal()
    try {
      terminal?.sendText(`echo "PATH=$PATH" > "${diagPath}"`, true)
      terminal?.sendText(`type fake-dsh-tui > "${diagType}" 2>&1; true`, true)
    } catch {
      // terminal gone
    }
    await poll(() => (readFile(diagPath) ? true : undefined), 8000).catch(() => undefined)
    await poll(() => (readFile(diagType) ? true : undefined), 8000).catch(() => undefined)
    const shimLog = readFile(join(WS, 'fake-dsh-tui.js.shim-log'))
    const names = vscode.window.terminals.map(t => t.name).join(',')
    const wsFiles = readdirSync(WS).join(',')
    throw new Error(
      `env-out never written; terminals=[${names}] shimLog=${JSON.stringify(shimLog ?? '<none>')} diagPath=${JSON.stringify(readFile(diagPath) ?? '<none>')} diagType=${JSON.stringify(readFile(diagType) ?? '<none>')} ws=[${wsFiles}]`,
    )
  }
  const lines = text.trim().split(/\r?\n/).map(line => line.trim())
  assert.ok(lines.includes('VISUAL=code -w'), `VISUAL missing: ${lines.join(' | ')}`)
  assert.ok(lines.includes('DSH_TUI_LANG=zh'), `DSH_TUI_LANG missing: ${lines.join(' | ')}`)
  assert.ok(lines.includes('DSH_HOME=C:\\e2e-home'), `DSH_HOME missing: ${lines.join(' | ')}`)
  assert.ok(lines.includes('RESUME_SESSION='), `RESUME_SESSION should be empty: ${lines.join(' | ')}`)
})

test('terminal input reaches the child', async () => {
  const api = (vscode.extensions.getExtension(EXT_ID)!.exports as Api)
  rmSync(STDIN_OUT, { force: true })
  // Cooked console mode: complete the line with Enter (\r).
  api.sendInput('hello from e2e\r')
  await poll(() => {
    const content = readFile(STDIN_OUT)
    return content?.includes('hello from e2e') ? content : undefined
  }, 10000)
})

test('start opens multiple concurrent sessions', async () => {
  await configureFakeLauncher()
  rmSync(ENV_OUT, { force: true })
  await vscode.commands.executeCommand('dsh-tui-vscode.start')
  await poll(() => (readFile(ENV_OUT)?.includes('FAKE_LAUNCHER_RAN') ? true : undefined), 20000)
  const firstMtime = statSync(ENV_OUT).mtimeMs
  // A second click opens ANOTHER terminal+session (Claude Code behavior);
  // the new child writes env-out again.
  await vscode.commands.executeCommand('dsh-tui-vscode.start')
  await poll(() => (statSync(ENV_OUT).mtimeMs > firstMtime ? true : undefined), 20000)
  const count = vscode.window.terminals.filter(t => t.name === TERMINAL_NAME).length
  assert.ok(count >= 2, `expected >=2 DeepSeek terminals, got ${count}`)
})

test('kill sends Ctrl+C to the child', async () => {
  await configureFakeLauncher()
  rmSync(EXITED, { force: true })
  await vscode.commands.executeCommand('dsh-tui-vscode.kill')
  // Ctrl+C in the real terminal → SIGINT → the fake launcher writes the marker.
  await poll(() => (readFile(EXITED) ? true : undefined), 10000)
})

test('resume relaunches with --resume', async () => {
  await configureFakeLauncher()
  rmSync(ENV_OUT, { force: true })
  await vscode.commands.executeCommand('dsh-tui-vscode.resume')
  const text = await poll(() => {
    const content = readFile(ENV_OUT)
    return content?.includes('FAKE_LAUNCHER_RAN') ? content : undefined
  }, 20000)
  const lines = text!.trim().split(/\r?\n/).map(line => line.trim())
  assert.ok(
    lines.some(line => line.startsWith('ARGS=') && line.includes('--resume')),
    `--resume missing: ${lines.join(' | ')}`,
  )
})

test('resumeSession recreates the terminal with the session env (no --resume)', async () => {
  await configureFakeLauncher()
  rmSync(ENV_OUT, { force: true })
  await vscode.commands.executeCommand('dsh-tui-vscode.resumeSession', 'sess-42')
  const text = await poll(() => {
    const content = readFile(ENV_OUT)
    return content?.includes('FAKE_LAUNCHER_RAN') ? content : undefined
  }, 20000)
  const lines = text!.trim().split(/\r?\n/).map(line => line.trim())
  assert.ok(
    lines.includes('RESUME_SESSION=sess-42'),
    `RESUME_SESSION missing: ${lines.join(' | ')}`,
  )
  // The env IS the resume channel; --resume would make the launcher
  // overwrite it from ~/.dsh-tui/resume.txt (verified in bin/dsh-tui.js).
  assert.ok(
    !lines.some(line => line.startsWith('ARGS=') && line.includes('--resume')),
    `--resume must NOT be passed for a specific session: ${lines.join(' | ')}`,
  )
})

test('resumeSession resumes a REAL session (guarded)', async () => {
  // Only meaningful where the real dsh-tui/dsh are installed and DSH
  // session data exists (the user's machine); skipped elsewhere.
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  const { existsSync, readdirSync, statSync } = await import('node:fs')
  const sessionsRoot = join(homedir(), '.dsh', 'sessions')
  let realId: string | undefined
  try {
    for (const group of readdirSync(sessionsRoot)) {
      for (const entry of readdirSync(join(sessionsRoot, group))) {
        const dir = join(sessionsRoot, group, entry)
        if (statSync(dir).isDirectory() && existsSync(join(dir, 'session.jsonl.zstd'))) {
          realId = entry
          break
        }
      }
      if (realId) break
    }
  } catch {
    realId = undefined
  }
  if (!realId) {
    console.log('[e2e] SKIP real-resume: no DSH sessions found')
    return
  }
  const countSessions = (): number => {
    let n = 0
    for (const group of readdirSync(sessionsRoot)) {
      const g = join(sessionsRoot, group)
      if (!statSync(g).isDirectory()) continue
      for (const e of readdirSync(g)) if (statSync(join(g, e)).isDirectory()) n++
    }
    return n
  }

  await configureFakeLauncher()
  const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
  await cfg.update('command', 'dsh-tui', vscode.ConfigurationTarget.Global)
  await cfg.update('extraArgs', [], vscode.ConfigurationTarget.Global)
  await cfg.update('dshHome', '', vscode.ConfigurationTarget.Global)

  // Observable (verified against the real launcher): a SUCCESSFUL resume
  // does NOT create a new session; a failed resume falls through to a fresh
  // session (randomUUID) → a new session dir appears.
  const before = countSessions()
  await vscode.commands.executeCommand('dsh-tui-vscode.resumeSession', realId)
  await sleep(35000)
  const after = countSessions()
  // Stop the real session in the terminal (best effort).
  await vscode.commands.executeCommand('dsh-tui-vscode.kill')
  assert.equal(
    after,
    before,
    `resume of ${realId} failed: a fresh session was created (${before} -> ${after})`,
  )
})

/**
 * Write one real (zstd-compressed) session log under a temporary DSH home.
 * The wasm compress module can corrupt in the Electron host (outputs
 * non-frame bytes) — a fresh module load + init recovers, so a failed
 * frame is retried exactly like the product's rename path does.
 */
/** Compress `events` into a round-trip-verified zstd frame and write it. */
async function writeE2eLog(file: string, events: Record<string, unknown>[]): Promise<void> {
  const payload = Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  // Round-trip verification: a corrupt module can emit a frame with a valid
  // magic whose content does not decompress — only frames that decompress
  // back to the exact payload are usable.
  const frameOf = (mod: typeof zstd): Buffer | undefined => {
    try {
      const out = Buffer.from(mod.compress(payload, 3))
      if (out.length < 4 || out.readUInt32LE(0) !== 0xfd2fb528) return undefined
      return Buffer.from(mod.decompress(out)).equals(payload) ? out : undefined
    } catch {
      return undefined
    }
  }
  let frame = frameOf(zstd)
  if (frame === undefined) {
    for (const key of Object.keys(require.cache)) {
      if (key.includes('@bokuweb') && key.includes('zstd-wasm')) delete require.cache[key]
    }
    const fresh = require('@bokuweb/zstd-wasm') as typeof zstd
    await fresh.init()
    frame = frameOf(fresh)
  }
  if (frame === undefined) throw new Error('cannot produce a zstd frame in this host')
  writeFileSync(file, frame)
}

/** Write one real session log under `<home>/sessions/<group>/<id>/`. */
async function makeE2eSession(
  home: string,
  group: string,
  id: string,
  events: Record<string, unknown>[],
): Promise<string> {
  const dir = join(home, 'sessions', group, id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.jsonl.zstd')
  await writeE2eLog(file, events)
  return file
}

/**
 * Write one real session log DIRECTLY under a sessions ROOT (the directory
 * holding the group dirs) - used for the DSH_TUI_SESSION_ROOT override - with
 * a chosen generation filename (Session V3 by default).
 */
async function makeE2eSessionAtRoot(
  sessionsRoot: string,
  group: string,
  id: string,
  events: Record<string, unknown>[],
  fileName = 'session.v3.jsonl.zstd',
): Promise<string> {
  const dir = join(sessionsRoot, group, id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, fileName)
  await writeE2eLog(file, events)
  return file
}

const headerEvent = (id: string, cwd: string, createdAt: number): Record<string, unknown> => ({
  type: 'session', version: 0, id, cwd, createdAt,
})
const userEvent = (text: string): Record<string, unknown> => ({
  type: 'user/message', seq: 0, data: { content: [{ type: 'text', text }] },
})

test('renameSession/deleteSession act on the TreeItem-provided session (full command chain)', async () => {
  const sessionsMod = await import('../sessions.js') as typeof import('../sessions.js')
  await sessionsMod.ensureZstd()
  const home = mkdtempSync(join(tmpdir(), 'dsh-e2e-cmd-'))
  try {
    const logFile = await makeE2eSession(home, '--g--', 'cmd-1', [
      headerEvent('cmd-1', '/w', 1),
      userEvent('命令链路会话'),
    ])
    // Verified against real VS Code clicks: view/item/context commands
    // receive the provider's ELEMENT (the SessionRecord — id + file), not
    // the rendered TreeItem. Build the argument in that exact shape.
    const fakeItem: Record<string, unknown> = {
      id: 'cmd-1',
      title: '命令链路会话',
      eventTitle: undefined,
      cwd: '/w',
      project: 'w',
      origin: undefined,
      parent: undefined,
      hasPrompt: true,
      createdAt: 1,
      file: logFile,
      lastUsed: undefined,
    }

    // Patch dialogs so the command chain runs headless (restored below).
    const origInput = vscode.window.showInputBox
    const origWarn = vscode.window.showWarningMessage
    let inputShown = false
    let warnShown = false
    vscode.window.showInputBox = (async () => {
      inputShown = true
      return 'e2e-新标题'
    }) as typeof vscode.window.showInputBox
    vscode.window.showWarningMessage = (async () => {
      warnShown = true
      return t('Delete permanently')
    }) as typeof vscode.window.showWarningMessage

    // deleteSessionLog resolves the sessions root from $DSH_HOME — point it
    // at the temp home for this test (restored below).
    const savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      await vscode.commands.executeCommand('dsh-tui-vscode.renameSession', fakeItem)
      assert.equal(inputShown, true, 'rename must prompt for a title')
      const rec = sessionsMod.readSessionRecord(logFile)
      assert.equal(rec?.title, 'e2e-新标题', 'rename must append the title frame (last wins)')

      // A SECOND argument carrying identity only in the TreeItem shape
      // (id + resourceUri, the getTreeItem fallback for other VS Code
      // versions) must still work.
      const customItem = new vscode.TreeItem('x')
      customItem.id = 'cmd-1'
      customItem.resourceUri = vscode.Uri.file(logFile)
      vscode.window.showInputBox = (async () => {
        inputShown = true
        return 'e2e-自定义字段标题'
      }) as typeof vscode.window.showInputBox
      await vscode.commands.executeCommand('dsh-tui-vscode.renameSession', customItem)
      assert.equal(sessionsMod.readSessionRecord(logFile)?.title, 'e2e-自定义字段标题')

      // deleteSession resolves the session root through the tree's configured
      // dshHome. Keep it UNPINNED ('' — the original contract) so the command
      // falls back to $DSH_HOME, which this test points at the temp home; a
      // pinned temp home would leave the global tree watching a dir we delete.
      // The pinned-home path is covered by the dedicated e2e below.
      const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
      const savedCfgHome = cfg.get<string>('dshHome', '')
      await cfg.update('dshHome', '', vscode.ConfigurationTarget.Global)
      await sleep(300)
      try {
        await vscode.commands.executeCommand('dsh-tui-vscode.deleteSession', fakeItem)
        assert.equal(warnShown, true, 'delete must ask for confirmation')
        assert.ok(!existsSync(join(home, 'sessions', '--g--', 'cmd-1')), 'delete must remove the session dir')
      } finally {
        await cfg.update('dshHome', savedCfgHome, vscode.ConfigurationTarget.Global)
        await sleep(200)
      }
    } finally {
      vscode.window.showInputBox = origInput
      vscode.window.showWarningMessage = origWarn
      if (savedHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedHome
    }
  } finally {
    // The global tree briefly watched this temp home (config dshHome change);
    // Windows may hold the directory handle a little longer than the close.
    await rmTempDir(home)
  }
})

test('SessionsTreeProvider shows only current-workspace, non-empty, non-subagent sessions (full view chain)', async () => {
  const { SessionsTreeProvider } = await import('../sessions-view.js') as typeof import('../sessions-view.js')
  const home = mkdtempSync(join(tmpdir(), 'dsh-e2e-tree-'))
  try {
    const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath
    await makeE2eSession(home, '--g1--', 'a', [headerEvent('a', ws, 300), userEvent('工作区内')])
    await makeE2eSession(home, '--g1--', 'b', [headerEvent('b', join(ws, 'sub'), 200), userEvent('工作区子目录')])
    await makeE2eSession(home, '--g2--', 'c', [headerEvent('c', join(ws, '..', 'elsewhere'), 400), userEvent('别处')])
    await makeE2eSession(home, '--g1--', 'd', [headerEvent('d', ws, 100)])
    await makeE2eSession(home, '--g1--', 'e', [
      { ...headerEvent('e', ws, 50), origin: 'subagent', parentSession: 'a' },
      userEvent('派遣消息'),
    ])

    const provider = new SessionsTreeProvider()
    provider.startWatching(home)
    provider.refresh()
    try {
      // reload() is async — poll the tree until it settles.
      const children = await poll(() => {
        const c = provider.getChildren(undefined)
        return c.length > 0 ? c : undefined
      }, 8000)
      const ids = children.flatMap(n => (n as { sessions: { id: string }[] }).sessions.map(s => s.id))
      assert.deepEqual(ids, ['a', 'b'], 'only in-workspace, non-empty, non-subagent sessions, newest first')
    } finally {
      provider.dispose()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('SessionsTreeProvider auto-refreshes when a session appears in a NEW group dir', async () => {
  const { SessionsTreeProvider } = await import('../sessions-view.js') as typeof import('../sessions-view.js')
  const home = mkdtempSync(join(tmpdir(), 'dsh-e2e-watch-'))
  // Watcher-recording seam: `src/session-watchers.ts` resolves `fs.watch` at
  // call time, so this wrapper observes every live watcher the provider opens.
  // It only records and delegates — the provider behaves exactly as shipped.
  // What it buys is the assertion below that the NEW group dir really got a
  // watcher, which is what stops the polling accelerator from turning this
  // case into "refresh() finds it anyway" (REVIEW m-5).
  const fsMod = require('node:fs') as { watch: (...args: unknown[]) => unknown }
  const realWatch = fsMod.watch
  const watcherDirs: string[] = []
  fsMod.watch = (...args: unknown[]): unknown => {
    const watcher = realWatch(...args)
    watcherDirs.push(String(args[0]))
    return watcher
  }
  try {
    const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath
    await makeE2eSession(home, '--g1--', 'a', [headerEvent('a', ws, 300), userEvent('先有会话')])
    const provider = new SessionsTreeProvider()
    provider.startWatching(home)
    provider.refresh()
    try {
      const seenA = await poll(() => {
        const c = provider.getChildren(undefined)
        const ids = c.flatMap(n => (n as { sessions: { id: string }[] }).sessions.map(s => s.id))
        return ids.includes('a') ? true : undefined
      }, 8000)
      assert.equal(seenA, true, 'initial session must appear')

      // A brand-new group directory + session appears AFTER activation —
      // fs.watch on the root is not recursive; the provider must pick the
      // new group up and refresh WITHOUT any manual command.
      await makeE2eSession(home, '--g-new--', 'b', [headerEvent('b', ws, 200), userEvent('新组新会话')])
      // Poll + event acceleration (REVIEW m-5). A directory that does not
      // exist yet cannot be watched, so the new group dir's watcher only
      // arrives with the reload that follows the 500 ms debounce; a log
      // written before that reload is announced by no watcher at all, and an
      // event-only wait then strands here until the timeout — that is the m-5
      // false red. Driving the very reload the debounce would have driven
      // makes a missed event a slower pass instead of a red suite.
      const seenB = await poll(() => {
        provider.refresh()
        return treeSessionIds(provider.getChildren(undefined)).includes('b') ? true : undefined
      }, 10000)
      assert.equal(seenB, true, 'new-group session must appear without manual refresh')
      // ...and the accelerator must not stand in for a provider that watches
      // nothing: by the time the tree shows the session, its reload has seen
      // `--g-new--` and must have opened a live watcher on it. Pinning that
      // leaves the auto-refresh wiring — not the poll — as what this case
      // guards (the watcher-event -> debounced reload leg is covered by the
      // sibling probe-timer case and src/test/session-watchers.test.ts).
      const newGroup = join(home, 'sessions', '--g-new--')
      assert.ok(
        watcherDirs.some(dir => normalize(dir) === normalize(newGroup)),
        `provider must watch the new group dir; watcher dirs: ${JSON.stringify(watcherDirs)}`,
      )
    } finally {
      provider.dispose()
    }
  } finally {
    fsMod.watch = realWatch
    rmSync(home, { recursive: true, force: true })
  }
})

const headerEventV3 = (id: string, cwd: string, createdAt: number): Record<string, unknown> => ({
  type: 'session', version: 3, id, cwd, createdAt, isSeeded: false,
})

/** Per-session ledger (DSH 0.1.5): generated title. */
function writeE2eLedger(home: string, id: string, title: string): void {
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({ version: 7, record: { rows: { title: { val: title } } } }),
  )
}

/** Per-session ledger (DSH 0.1.5): first-input text fallback. */
function writeE2eLedgerInput(home: string, id: string, text: string): void {
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({ version: 7, record: { rows: { titleInput: { val: { first: { text } } } } } }),
  )
}

/** Session ids of every project group the tree currently shows. */
function treeSessionIds(children: unknown[]): string[] {
  return children.flatMap(node =>
    ((node as { sessions?: Array<{ id: string }> }).sessions ?? []).map(s => s.id),
  )
}

/** Session records of every project group the tree currently shows. */
function treeRecords(children: unknown[]): Array<{ id: string; title?: string }> {
  return children.flatMap(
    node => (node as { sessions?: Array<{ id: string; title?: string }> }).sessions ?? [],
  )
}

/** Windows may hold a directory handle briefly after watchers close. */
async function rmTempDir(dir: string): Promise<void> {
  // Node retries EBUSY/ENOTEMPTY/EPERM internally; Windows watcher handles can
  // outlive close() briefly, so give it up to ~6 s.
  rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 })
}

test('SessionsTreeProvider discovers sessions from DSH_TUI_SESSION_ROOT and the pinned dshHome', async () => {
  const { SessionsTreeProvider } = await import('../sessions-view.js') as typeof import('../sessions-view.js')
  const isoRoot = mkdtempSync(join(tmpdir(), 'dsh-e2e-iso-'))
  const pinned = mkdtempSync(join(tmpdir(), 'dsh-e2e-pin-'))
  const savedEnv = process.env.DSH_TUI_SESSION_ROOT
  const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath
  const provider = new SessionsTreeProvider()
  try {
    await makeE2eSessionAtRoot(isoRoot, '--g1--', 'env-a', [
      headerEventV3('env-a', ws, 300),
      userEvent('env 根会话'),
    ])
    await makeE2eSession(pinned, '--g1--', 'pin-b', [headerEvent('pin-b', ws, 200), userEvent('配置根会话')])
    process.env.DSH_TUI_SESSION_ROOT = isoRoot
    provider.startWatching(pinned)
    provider.refresh()
    const ids = await poll(() => {
      const found = treeSessionIds(provider.getChildren(undefined))
      return found.length >= 2 ? found : undefined
    }, 8000)
    assert.deepEqual([...ids].sort(), ['env-a', 'pin-b'], 'both the env root and the pinned home must be listed')
  } finally {
    provider.dispose()
    if (savedEnv === undefined) delete process.env.DSH_TUI_SESSION_ROOT
    else process.env.DSH_TUI_SESSION_ROOT = savedEnv
    await rmTempDir(isoRoot)
    await rmTempDir(pinned)
  }
})

test('SessionsTreeProvider uses the per-session ledger for titles (label path, 80-char cap)', async () => {
  const { SessionsTreeProvider } = await import('../sessions-view.js') as typeof import('../sessions-view.js')
  const home = mkdtempSync(join(tmpdir(), 'dsh-e2e-ledger-'))
  const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath
  const provider = new SessionsTreeProvider()
  try {
    // V3 logs with a first message but NO `session/title`: the ledger supplies
    // the title, outranking the first-message fallback.
    await makeE2eSessionAtRoot(join(home, 'sessions'), '--g--', 'led-1', [
      headerEventV3('led-1', ws, 300),
      userEvent('首条消息'),
    ])
    writeE2eLedger(home, 'led-1', '账本标题')
    await makeE2eSessionAtRoot(join(home, 'sessions'), '--g--', 'led-2', [
      headerEventV3('led-2', ws, 200),
      userEvent('首条消息'),
    ])
    writeE2eLedgerInput(home, 'led-2', 'B'.repeat(500))
    provider.startWatching(home)
    provider.refresh()
    const records = await poll(() => {
      const found = treeRecords(provider.getChildren(undefined))
      return found.length >= 2 ? found : undefined
    }, 8000)
    const byId = new Map(records.map(r => [r.id, r]))
    const labelOf = (id: string): string => {
      const item = provider.getTreeItem(byId.get(id) as never)
      return typeof item.label === 'string' ? item.label : (item.label?.label ?? '')
    }
    assert.equal(labelOf('led-1'), '账本标题', 'ledger title must win over the first message')
    assert.equal(labelOf('led-2'), 'B'.repeat(80), 'raw first-input fallback must be capped at 80 chars')
  } finally {
    provider.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('deleteSession removes sessions from the configured dshHome and the env root', async () => {
  const { SessionsTreeProvider } = await import('../sessions-view.js') as typeof import('../sessions-view.js')
  const home = mkdtempSync(join(tmpdir(), 'dsh-e2e-delhome-'))
  const isoRoot = mkdtempSync(join(tmpdir(), 'dsh-e2e-deliso-'))
  const savedEnv = process.env.DSH_TUI_SESSION_ROOT
  const savedWarn = vscode.window.showWarningMessage
  const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath
  const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
  const savedCfgHome = cfg.get<string>('dshHome', '')
  const provider = new SessionsTreeProvider()
  try {
    await makeE2eSession(home, '--g--', 'del-pin', [headerEvent('del-pin', ws, 200), userEvent('配置根待删')])
    await makeE2eSessionAtRoot(isoRoot, '--g--', 'del-env', [
      headerEventV3('del-env', ws, 100),
      userEvent('env 根待删'),
    ])
    process.env.DSH_TUI_SESSION_ROOT = isoRoot
    await cfg.update('dshHome', home, vscode.ConfigurationTarget.Global)
    // The config-change listener re-points the global tree asynchronously.
    await sleep(300)
    // Headless confirmation (restored below).
    vscode.window.showWarningMessage = (async () => t('Delete permanently')) as typeof vscode.window.showWarningMessage
    provider.startWatching(home)
    provider.refresh()
    const records = await poll(() => {
      const found = treeRecords(provider.getChildren(undefined))
      return found.length >= 2 ? found : undefined
    }, 8000)
    const byId = new Map(records.map(r => [r.id, r]))
    await vscode.commands.executeCommand('dsh-tui-vscode.deleteSession', byId.get('del-pin'))
    assert.ok(!existsSync(join(home, 'sessions', '--g--', 'del-pin')), 'delete must honor the configured dshHome')
    await vscode.commands.executeCommand('dsh-tui-vscode.deleteSession', byId.get('del-env'))
    assert.ok(!existsSync(join(isoRoot, '--g--', 'del-env')), 'delete must honor the env session root')
  } finally {
    vscode.window.showWarningMessage = savedWarn
    provider.dispose()
    if (savedEnv === undefined) delete process.env.DSH_TUI_SESSION_ROOT
    else process.env.DSH_TUI_SESSION_ROOT = savedEnv
    // Re-point the GLOBAL tree AFTER restoring the env so its watcher set no
    // longer holds the temp env root (startWatching disposes the old set).
    await cfg.update('dshHome', savedCfgHome, vscode.ConfigurationTarget.Global)
    await sleep(500)
    await rmTempDir(home)
    await rmTempDir(isoRoot)
  }
})

test('SessionsTreeProvider registers a session root that appears after startup (probe timer)', async () => {
  const { SessionsTreeProvider } = await import('../sessions-view.js') as typeof import('../sessions-view.js')
  const home = mkdtempSync(join(tmpdir(), 'dsh-e2e-probe-home-'))
  const parent = mkdtempSync(join(tmpdir(), 'dsh-e2e-probe-'))
  const lateRoot = join(parent, 'late-root')
  const savedEnv = process.env.DSH_TUI_SESSION_ROOT
  const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath
  const provider = new SessionsTreeProvider({ retryMs: 50 })
  try {
    await makeE2eSession(home, '--g--', 'early', [headerEvent('early', ws, 100), userEvent('先有会话')])
    process.env.DSH_TUI_SESSION_ROOT = lateRoot
    provider.startWatching(home)
    provider.refresh()
    await poll(() => (treeSessionIds(provider.getChildren(undefined)).includes('early') ? true : undefined), 8000)
    // The env root did not exist at startup: the probe timer must discover it
    // and refresh exactly enough for the new session to show up.
    await makeE2eSessionAtRoot(lateRoot, '--g--', 'late', [headerEventV3('late', ws, 200), userEvent('后到会话')])
    const seen = await poll(
      () => (treeSessionIds(provider.getChildren(undefined)).includes('late') ? true : undefined),
      10000,
    )
    assert.equal(seen, true, 'a root created after startup must be watched without a manual refresh')
  } finally {
    provider.dispose()
    if (savedEnv === undefined) delete process.env.DSH_TUI_SESSION_ROOT
    else process.env.DSH_TUI_SESSION_ROOT = savedEnv
    await rmTempDir(home)
    await rmTempDir(parent)
  }
})

test('archiveSession archives via the dsh web archive set; manageArchived restores', async () => {
  const sessionsMod = await import('../sessions.js') as typeof import('../sessions.js')
  const home = mkdtempSync(join(tmpdir(), 'dsh-e2e-arch-'))
  try {
    const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath
    const logFile = await makeE2eSession(home, '--g--', 'arch-1', [
      headerEvent('arch-1', ws, 1),
      userEvent('待归档'),
    ])
    // A workspace domain with an empty archive set (dsh web's own source).
    const storages = join(home, 'storages')
    mkdirSync(storages, { recursive: true })
    writeFileSync(
      join(storages, 'workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
        tables: { workspaces: {} },
      }, null, 2) + '\n',
    )
    const savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    // Unpinned ('' — original contract): the archive commands fall back to
    // $DSH_HOME, so the temp home is never watched by the global tree.
    const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
    const savedCfgHome = cfg.get<string>('dshHome', '')
    await cfg.update('dshHome', '', vscode.ConfigurationTarget.Global)
    await sleep(300)
    try {
      // Real argument shape: the SessionRecord element.
      const item: Record<string, unknown> = { id: 'arch-1', file: logFile, title: '待归档', hasPrompt: true, createdAt: 1, cwd: ws }
      await vscode.commands.executeCommand('dsh-tui-vscode.archiveSession', item)
      assert.deepEqual(sessionsMod.readWorkspaceMeta(home).archivedSessionIds, ['arch-1'])
      const hidden = await sessionsMod.listSessions(home, { workspaceDirs: [ws], hideArchived: true })
      assert.ok(!hidden.some(s => s.id === 'arch-1'), 'archived session must be hidden')

      // manageArchived: pick the archived session, then the restore action.
      const origPick = vscode.window.showQuickPick
      let picks = 0
      vscode.window.showQuickPick = (async (items: unknown) => {
        picks += 1
        const arr = items as unknown[]
        if (picks === 1) return arr[0]
        return arr.find(i => String((i as { label?: string }).label ?? '').includes(t('Restore session')))
      }) as typeof vscode.window.showQuickPick
      try {
        await vscode.commands.executeCommand('dsh-tui-vscode.manageArchived')
      } finally {
        vscode.window.showQuickPick = origPick
      }
      assert.deepEqual(sessionsMod.readWorkspaceMeta(home).archivedSessionIds, [], 'restore must clear the archive set')
      const visible = await sessionsMod.listSessions(home, { workspaceDirs: [ws], hideArchived: true })
      assert.ok(visible.some(s => s.id === 'arch-1'), 'restored session must be visible again')

      // Permanent-delete path inside manageArchived: archive again, pick
      // "permanently delete" → the log dir AND the archive entry go away.
      await vscode.commands.executeCommand('dsh-tui-vscode.archiveSession', item)
      assert.ok(sessionsMod.readWorkspaceMeta(home).archivedSessionIds.includes('arch-1'))
      const origWarn = vscode.window.showWarningMessage
      vscode.window.showWarningMessage = (async () => t('Delete permanently')) as typeof vscode.window.showWarningMessage
      picks = 0
      vscode.window.showQuickPick = (async (items: unknown) => {
        picks += 1
        const arr = items as unknown[]
        if (picks === 1) return arr[0]
        return arr.find(i => String((i as { label?: string }).label ?? '').includes(t('Delete permanently')))
      }) as typeof vscode.window.showQuickPick
      try {
        await vscode.commands.executeCommand('dsh-tui-vscode.manageArchived')
      } finally {
        vscode.window.showQuickPick = origPick
        vscode.window.showWarningMessage = origWarn
      }
      assert.ok(!existsSync(logFile), 'permanent delete must remove the session log dir')
      assert.deepEqual(sessionsMod.readWorkspaceMeta(home).archivedSessionIds, [], 'archive entry must be cleared with the log')
    } finally {
      if (savedHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedHome
      await cfg.update('dshHome', savedCfgHome, vscode.ConfigurationTarget.Global)
      await sleep(200)
    }
  } finally {
    await rmTempDir(home)
  }
})

test('renameSession recovers from a corrupt wasm compress state (reset + retry)', async () => {
  // By this point in the suite the Electron host has usually corrupted the
  // wasm compress module (observed: compress emits non-frame bytes). If it
  // is still healthy this test has nothing to exercise and skips honestly;
  // when corrupted, the command's resetZstd + retry must still rename.
  const sessionsMod = await import('../sessions.js') as typeof import('../sessions.js')
  const probe = Buffer.from(zstd.compress(Buffer.from('probe', 'utf8'), 3))
  if (probe.length >= 4 && probe.readUInt32LE(0) === 0xfd2fb528) {
    console.log('[e2e] SKIP recover test: wasm compress still healthy in this host')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'dsh-e2e-recover-'))
  try {
    const logFile = await makeE2eSession(home, '--g--', 'r-1', [
      headerEvent('r-1', '/w', 1),
      userEvent('重试会话'),
    ])
    const origInput = vscode.window.showInputBox
    vscode.window.showInputBox = (async () => '重试后的标题') as typeof vscode.window.showInputBox
    try {
      const item: Record<string, unknown> = {
        id: 'r-1',
        file: logFile,
        title: '重试会话',
        hasPrompt: true,
        createdAt: 1,
        cwd: '/w',
      }
      await vscode.commands.executeCommand('dsh-tui-vscode.renameSession', item)
      const rec = sessionsMod.readSessionRecord(logFile)
      assert.equal(rec?.title, '重试后的标题', 'reset + retry must still append the title frame')
    } finally {
      vscode.window.showInputBox = origInput
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('insertAtMention copies @-mention to clipboard when no session is running', async () => {
  // Force the no-terminal fallback: dispose every DeepSeek terminal.
  for (const t of [...vscode.window.terminals]) if (t.name === TERMINAL_NAME) t.dispose()
  await poll(() => (findTuiTerminal() ? undefined : true), 8000)

  const file = join(WS, 'e2e-insert.ts')
  writeFileSync(file, 'line0\nline1\nline2\nline3\nline4\n')
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    const editor = await vscode.window.showTextDocument(doc)
    // Multi-line selection: lines 1..3 (0-based) → #L2-4 (1-based).
    editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(3, 5))
    const { normalizeMentionPath, relativeToWorkspace } = await import('../at-mention.js') as typeof import('../at-mention.js')
    // 新契约：工作区内相对路径 + #L 行区间（相对化基准 = 扩展终端 cwd =
    // 工作区根；根外兜底归一化绝对路径）。期望值按同一规格独立拼装，不经
    // buildAtMention 自身（避免同义反复）。
    const wsRoot = vscode.workspace.workspaceFolders![0]!.uri.fsPath
    const expected =
      '@' + relativeToWorkspace(normalizeMentionPath(editor.document.uri.fsPath), wsRoot) + '#L2-4'

    const origInfo = vscode.window.showInformationMessage
    let infoShown: string | undefined
    vscode.window.showInformationMessage = (async (message: string) => {
      infoShown = String(message)
    }) as typeof vscode.window.showInformationMessage

    // Environmental pre-flight: a Windows session can have its system
    // clipboard locked by another process (observed live: EVERY OpenClipboard
    // fails, even from PowerShell). The extension's clipboard.writeText
    // resolves even then (Electron swallows the error), so an OS-level outage
    // must not fail the product assertions below. Probe the round-trip first;
    // when the OS clipboard is unavailable, verify the command path honestly
    // and SKIP the content comparison — same honesty rule as the
    // wasm-recover test above (never a silent pass).
    let clipboardHealthy = false
    const PROBE = 'dsh-e2e-clipboard-probe'
    await vscode.env.clipboard.writeText(PROBE)
    clipboardHealthy = (await vscode.env.clipboard.readText()) === PROBE

    try {
      await vscode.commands.executeCommand('dsh-tui-vscode.insertAtMention')
      assert.ok(
        infoShown?.includes(t('Copied {0}. Paste it into the dsh-tui input box', expected)),
        `fallback must inform the user, got ${infoShown}`,
      )
      if (!clipboardHealthy) {
        // OS 剪贴板被锁时诚实跳过内容比对（写入发生与否由上一行的「已复制」
        // 消息断言锁定；健康环境下下方仍做短轮询内容断言）。
        console.log(
          '[e2e] SKIP clipboard content assertion: system clipboard unavailable (OS-level lock)',
        )
        return
      }
      // Windows 剪贴板服务偶发延迟：writeText 已解析但立即 readText 可能拿到空
      // 串（宿主级抖动，与产品无关）——给读取侧一个短轮询窗口。
      let clip: string | undefined
      for (let waited = 0; waited < 5000 && clip === undefined; waited += 200) {
        const content = await vscode.env.clipboard.readText()
        if (content === expected) clip = content
        else await sleep(200)
      }
      assert.equal(clip, expected)
    } finally {
      vscode.window.showInformationMessage = origInfo
    }
  } finally {
    rmSync(file, { force: true })
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }
})

test('insertAtMention types the @-mention into the running session input', async () => {
  await configureFakeLauncher()
  rmSync(ENV_OUT, { force: true }) // fresh readiness signal — not a stale one from an earlier test
  rmSync(STDIN_OUT, { force: true })
  await vscode.commands.executeCommand('dsh-tui-vscode.start')
  await poll(() => (readFile(ENV_OUT)?.includes('FAKE_LAUNCHER_RAN') ? true : undefined), 20000)
  // Belt and braces: let the fake child attach to stdin before we type.
  await sleep(750)

  const file = join(WS, 'e2e-insert.ts')
  writeFileSync(file, 'line0\nline1\nline2\nline3\n')
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    const editor = await vscode.window.showTextDocument(doc)
    editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(2, 5))
    const { normalizeMentionPath, relativeToWorkspace } = await import('../at-mention.js') as typeof import('../at-mention.js')
    // 新契约：工作区内相对路径 + #L 行区间；相对化基准 = 工作区根。
    const wsRoot = vscode.workspace.workspaceFolders![0]!.uri.fsPath
    const expected =
      '@' + relativeToWorkspace(normalizeMentionPath(editor.document.uri.fsPath), wsRoot) + '#L2-3'

    await vscode.commands.executeCommand('dsh-tui-vscode.insertAtMention')
    // insertAtMention types the mention WITHOUT a trailing newline (it stays
    // in the TUI input, like the official insertAtMention). Complete the line
    // the way the user pressing Enter would, then read it back from the child.
    ;(vscode.extensions.getExtension(EXT_ID)!.exports as Api).sendInput('\r')
    await poll(() => {
      const content = readFile(STDIN_OUT)
      return content?.includes(expected) ? true : undefined
    }, 10000)
  } finally {
    rmSync(file, { force: true })
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }
})

test('autoInsertMention (experimental) auto-types the mention on selection change', async () => {
  await configureFakeLauncher()
  const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
  await cfg.update('autoInsertMention', true, vscode.ConfigurationTarget.Global)
  try {
    // Give the config-change handler time to arm the selection listener.
    await sleep(400)
    rmSync(ENV_OUT, { force: true })
    rmSync(STDIN_OUT, { force: true })
    await vscode.commands.executeCommand('dsh-tui-vscode.start')
    await poll(() => (readFile(ENV_OUT)?.includes('FAKE_LAUNCHER_RAN') ? true : undefined), 20000)
    await sleep(750)

    const file = join(WS, 'e2e-auto-insert.ts')
    writeFileSync(file, 'line0\nline1\nline2\nline3\n')
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
      const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false })
      // A real selection change (non-empty) after arming — this is what the
      // user "selecting code" produces; must auto-type after the debounce.
      editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(2, 5))
      const { normalizeMentionPath, relativeToWorkspace } = await import('../at-mention.js') as typeof import('../at-mention.js')
      // 新契约：工作区内相对路径 + #L 行区间；相对化基准 = 工作区根。
      const wsRoot = vscode.workspace.workspaceFolders![0]!.uri.fsPath
      const expected =
        '@' + relativeToWorkspace(normalizeMentionPath(editor.document.uri.fsPath), wsRoot) + '#L1-3'

      // Auto-inject fires after the 300ms debounce, WITHOUT any Enter — the
      // mention stays in the dsh-tui input (exactly like manual insertAtMention:
      // the user completes the question, then presses Enter). To observe it on
      // the child's stdin, wait for the debounced inject to land in the terminal
      // buffer, THEN simulate the Enter the user would press.
      await sleep(700) // > 300ms debounce + terminal round-trip
      ;(vscode.extensions.getExtension(EXT_ID)!.exports as Api).sendInput('\r')
      let seen = false
      try {
        await poll(() => {
          const content = readFile(STDIN_OUT)
          return content?.includes(expected) ? true : undefined
        }, 10000)
        seen = true
      } finally {
        if (!seen) {
          const stdin = readFile(STDIN_OUT) ?? '<empty>'
          console.log(`[e2e] auto-insert diagnostic: expected=[${expected}] stdin=[${stdin.slice(0, 200)}] terminals=[${vscode.window.terminals.map(t => t.name).join(',')}]`)
        }
      }
      assert.ok(seen, 'auto mention reached the running session input after user Enter')
    } finally {
      rmSync(file, { force: true })
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    }
  } finally {
    await cfg.update('autoInsertMention', false, vscode.ConfigurationTarget.Global)
  }
})

test('insertAtMention relativizes against the opened workspace root, not the git crawl root (subdirectory workspace)', async () => {
  // The suite workspace now lives INSIDE a git repository (see
  // run-tests.ts) — exactly the shape that used to break @mentions. The TUI
  // crawls to the git root for its session cwd (upstream issue #96), so a
  // mention relativized against the git PARENT instead of the opened
  // subdirectory resolved to "missing" after submit. The extension must keep
  // using workspaceFolders[0] as its baseline; the launch command pins the
  // TUI's cwd to the same root.
  const parent = join(WS, '..')
  if (!existsSync(join(parent, '.git'))) {
    console.log('[e2e] SKIP subdirectory-workspace: suite workspace is not inside a git repo (git init failed at setup)')
    return
  }
  // Force the no-terminal fallback: dispose every DeepSeek terminal.
  for (const t of [...vscode.window.terminals]) if (t.name === TERMINAL_NAME) t.dispose()
  await poll(() => (findTuiTerminal() ? undefined : true), 8000)

  const file = join(WS, 'e2e-subdir-insert.ts')
  writeFileSync(file, 'line0\nline1\nline2\nline3\nline4\n')
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    const editor = await vscode.window.showTextDocument(doc)
    editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(3, 5))
    // 期望值必须走生产同款函数：这里手写的 replace 是大小写敏感的，而 WS 来自
    // __dirname、wsRoot 来自 workspaceFolders，两者的大小写可能不一致 → Windows
    // 上会因环境原因假失败（issue #21 第 6 条）。
    const { relativeToWorkspace } =
      await import('../at-mention.js') as typeof import('../at-mention.js')
    const wsRoot = vscode.workspace.workspaceFolders![0]!.uri.fsPath
    const expected = '@' + relativeToWorkspace(file, wsRoot) + '#L2-4'
    // The regression switch: a mention relativized against the GIT PARENT
    // (the crawl root the TUI used to land on) carries that directory in its
    // path — this form must NOT be produced anymore.
    const wrongBaselineForm = '@' + normalizeWsPath(file).replace(normalizeWsPath(parent) + '/', '')

    const origInfo = vscode.window.showInformationMessage
    let infoShown: string | undefined
    vscode.window.showInformationMessage = (async (message: string) => {
      infoShown = String(message)
    }) as typeof vscode.window.showInformationMessage

    let clipboardHealthy = false
    const PROBE = 'dsh-e2e-clipboard-probe-2'
    await vscode.env.clipboard.writeText(PROBE)
    clipboardHealthy = (await vscode.env.clipboard.readText()) === PROBE

    try {
      await vscode.commands.executeCommand('dsh-tui-vscode.insertAtMention')
      assert.ok(
        infoShown?.includes(t('Copied {0}. Paste it into the dsh-tui input box', expected)),
        `fallback must inform the user, got ${infoShown}`,
      )
      if (!clipboardHealthy) {
        console.log(
          '[e2e] SKIP clipboard content assertion: system clipboard unavailable (OS-level lock)',
        )
        return
      }
      let clip: string | undefined
      for (let waited = 0; waited < 5000 && clip === undefined; waited += 200) {
        const content = await vscode.env.clipboard.readText()
        if (content === expected) clip = content
        else await sleep(200)
      }
      assert.equal(clip, expected, `mention must be relative to the OPENED workspace root (${wsRoot})`)
      assert.notEqual(clip, wrongBaselineForm, 'mention must NOT be relative to the git parent (crawl-root regression)')
      // The opened root IS the subdirectory, not the git parent — mirror of
      // upstream gitWorktreeRoot; guarded by the .git existsSync SKIP above.
      assert.notEqual(
        normalize(wsRoot),
        normalize(parent),
        'precondition broken: the workspace folder must be the SUBDIRECTORY',
      )
    } finally {
      vscode.window.showInformationMessage = origInfo
    }
  } finally {
    rmSync(file, { force: true })
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }
})

test('launch command carries the workspace root positional arg (DSH_TUI_WORKSPACE_TARGET chain)', async () => {
  // Missing-@mention fix, extension-side half of the contract: the launch
  // command must END with the opened workspace root as a positional argument.
  // The REAL launcher (bin/dsh-tui.js) intercepts it into
  // DSH_TUI_WORKSPACE_TARGET → the TUI pins its session cwd to that root
  // (absolute paths short-circuit workspace resolution), so the @mention
  // relativization baseline agrees with this extension's. The fake launcher
  // does NOT intercept — the arg lands verbatim in ARGS=, which is exactly
  // the seam pinned here; the interception half is upstream behavior covered
  // by the upstream verifier.
  await configureFakeLauncher()
  rmSync(ENV_OUT, { force: true })
  await vscode.commands.executeCommand('dsh-tui-vscode.start')
  const text = await poll(() => {
    const content = readFile(ENV_OUT)
    return content?.includes('FAKE_LAUNCHER_RAN') ? content : undefined
  }, 20000)
  const wsRoot = normalize(vscode.workspace.workspaceFolders![0]!.uri.fsPath)
  const lines = text!.trim().split(/\r?\n/).map(line => line.trim())
  assert.ok(
    lines.some(line => {
      if (!line.startsWith('ARGS=')) return false
      return normalize(line.slice('ARGS='.length)).endsWith(wsRoot)
    }),
    `launch command must end with the opened workspace root: ${lines.join(' | ')}`,
  )
})

// ---- IDE selection channel (e2e) ------------------------------------------
// The extension host runs a REAL IdeServer (extension.ts activates it). The
// two tests below observe that live instance through its public seams — the
// terminal env pair and the lock file under an injected temp lockRoot. The
// production lock lives under ~/.dsh-tui/ide (the real default root); the
// suite only ever READS the activation server's lock and never writes there
// (its own probe instances inject a temp lockRoot — test isolation).

/**
 * The IdeServer started by activate() in THIS extension-host instance. Tests
 * import the real class but never start their own production-root server:
 * they observe the one the extension owns via its protocol helpers.
 */
async function loadIdeModule(): Promise<typeof import('../ide/server.js')> {
  return (await import('../ide/server.js')) as typeof import('../ide/server.js')
}

interface ProdLock {
  port: number
  token: string
  workspaceFolders: string[]
  pid: number
}

/** Parse one `<port>.lock` payload; undefined when unreadable/incomplete. */
const readProdLock = (): ProdLock | undefined => {
  const dir = join(homedir(), '.dsh-tui', 'ide')
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.lock')) continue
      const raw = readFile(join(dir, name))
      if (!raw) continue
      const parsed = JSON.parse(raw) as Partial<ProdLock>
      if (
        typeof parsed.port === 'number' &&
        typeof parsed.token === 'string' &&
        Array.isArray(parsed.workspaceFolders) &&
        typeof parsed.pid === 'number'
      ) {
        // 锁必须属于**本扩展宿主进程**：生产 lock 目录是真实的
        // ~/.dsh-tui/ide/，同一个工作区在别的 VS Code 窗口里打开时，那边的
        // 扩展也会写一份 workspaceFolders 匹配的锁——只按工作区匹配会读到别人
        // 的 port/token（issue #21 第 7 条）。e2e 代码与扩展同处一个扩展宿主
        // 进程，所以 process.pid 才是权威判据。
        if (parsed.pid !== process.pid) continue
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''
        const normalize = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
        if (parsed.workspaceFolders.some(f => normalize(f) === normalize(ws))) {
          return parsed as ProdLock
        }
      }
    }
  } catch {
    // no lock dir yet — the activation server has not finished starting
  }
  return undefined
}

/**
 * Wait until the ACTIVATION-time IdeServer has bound its socket and written
 * its lock. activate() fires `start()` without awaiting it, so a session
 * launched immediately after activation would race the bind and spawn with
 * an empty envForTerminal() — exactly what a real user cannot hit (window
 * open → first click is seconds apart) but an e2e command chain can. The
 * resolved lock doubles as the authoritative discovery source for the tests.
 */
async function waitForProductionLock(timeoutMs = 10000): Promise<ProdLock> {
  const lock = await poll(() => readProdLock(), timeoutMs, 100)
  assert.ok(lock, 'activation-time IdeServer never wrote its lock under ~/.dsh-tui/ide')
  return lock!
}

test('IDE channel: session terminals carry DSH_TUI_IDE_PORT/TOKEN; lock lifecycle holds', async () => {
  const { IDE_PORT_ENV, IDE_TOKEN_ENV } = await loadIdeModule()
  await configureFakeLauncher()
  // Server-ready gate FIRST: once the lock exists, activate()'s async
  // start() has resolved and envForTerminal() carries the real pair — the
  // terminal spawned below must then receive it (the strong assertion here).
  const prod = await waitForProductionLock()
  rmSync(ENV_OUT, { force: true })
  await vscode.commands.executeCommand('dsh-tui-vscode.start')
  // A real DeepSeek terminal must exist...
  await poll(() => (findTuiTerminal() ? true : undefined), 10000)
  // ...and the extension must have handed it the IDE channel env pair. The
  // fake launcher echoes only its fixed key list (VISUAL/LANG/HOME/... — see
  // run-tests.ts) so the pair is asserted on terminal.creationOptions.env:
  // exactly what VS Code received from createTerminal. The VALUES must match
  // the lock advertisement (same server, same discovery identity).
  await poll(() => (readFile(ENV_OUT)?.includes('FAKE_LAUNCHER_RAN') ? true : undefined), 20000)
  const term = findTuiTerminal()!
  const env = (term.creationOptions as { env?: Record<string, string> }).env ?? {}
  assert.ok(
    env[IDE_PORT_ENV],
    `DSH_TUI_IDE_PORT missing from terminal creationOptions.env: keys=${Object.keys(env).join(',')}`,
  )
  assert.ok(env[IDE_TOKEN_ENV], 'DSH_TUI_IDE_TOKEN missing from terminal creationOptions.env')
  assert.equal(env[IDE_PORT_ENV], String(prod.port), 'env port must match the lock advertisement')
  assert.equal(env[IDE_TOKEN_ENV], prod.token, 'env token must match the lock advertisement')

  // Lock discovery seam: the SAME class with an INJECTED temp lockRoot walks
  // the identical writeLock/clearLock path in isolation — the production
  // lockRoot itself is never written by the suite (test isolation).
  const { IdeServer } = await loadIdeModule()
  const lockRoot = mkdtempSync(join(tmpdir(), 'dsh-e2e-ide-lock-'))
  try {
    const probe = new IdeServer({
      token: 'e2e-lock-probe',
      lockRoot,
      workspaceFolders: () =>
        (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
    })
    const probeEnv = await probe.start()
    const probePort = Number(probeEnv[IDE_PORT_ENV])
    const lockPath = join(lockRoot, 'ide', `${probePort}.lock`)
    assert.ok(existsSync(lockPath), `lock must exist at ${lockPath}`)
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      port: number
      token: string
      workspaceFolders: string[]
      pid: number
    }
    assert.equal(lock.port, probePort)
    assert.equal(lock.token, 'e2e-lock-probe')
    assert.deepEqual(lock.workspaceFolders, [vscode.workspace.workspaceFolders![0]!.uri.fsPath])
    assert.ok(Number.isSafeInteger(lock.pid))
    // Exactly these four fields — coordinates/text never leak into the lock.
    assert.deepEqual(
      Object.keys(lock).sort(),
      ['pid', 'port', 'token', 'workspaceFolders'],
    )
    await probe.stop()
    assert.ok(!existsSync(lockPath), 'stop must remove the lock')
  } finally {
    rmSync(lockRoot, { recursive: true, force: true })
  }
})

test('IDE channel: a WS client completes the v2 handshake and receives selection_changed (coordinates + editor text)', async () => {
  const { SELECTION_METHOD, IDE_PROTOCOL_VERSION } = await loadIdeModule()
  await configureFakeLauncher()
  // Server-ready gate: the lock is the authoritative discovery source (the
  // lock-scan discovery path) — its port/token ARE the live server's identity.
  const prod = await waitForProductionLock()

  // Connect like the upstream TUI client does: loopback WS + ide/hello token
  // handshake, discovered through the lock file exactly as a manually
  // launched dsh-tui would (no env shortcut).
  const WebSocket = (await import('ws')).WebSocket
  const socket = new WebSocket(`ws://127.0.0.1:${prod.port}`)
  await new Promise<void>((resolve, reject) => {
    socket.on('open', resolve)
    socket.on('error', reject)
  })
  try {
    // Protocol 2: the token travels WITH the protocol version, and the server
    // answers `ide/hello_ack` only after validating the pair. The ACK is
    // consumed here (never pushed into `received`) so the notification log
    // below holds selection_changed frames only — the v1 client assumed a
    // silent accept and would read the ACK as its first notification.
    const received: Array<Record<string, unknown>> = []
    const ack = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.on('message', raw => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>
        if (frame.method === 'ide/hello_ack') resolve(frame)
        else received.push(frame)
      })
      socket.on('error', reject)
    })
    socket.send(JSON.stringify({
      method: 'ide/hello',
      params: { token: prod.token, protocolVersion: IDE_PROTOCOL_VERSION },
    }))
    const ackFrame = await ack
    assert.deepEqual(ackFrame.params, {
      protocolVersion: IDE_PROTOCOL_VERSION,
      workspaceFolders: [vscode.workspace.workspaceFolders![0]!.uri.fsPath],
    })

    // Trigger the REAL product path: a selection change in an editor, armed
    // via autoInsertMention (the listener is always registered; the config
    // gates the callback). The debounced callback broadcasts coordinates over
    // this very server.
    const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
    await cfg.update('autoInsertMention', true, vscode.ConfigurationTarget.Global)
    try {
      const file = join(WS, 'e2e-ide-select.ts')
      writeFileSync(file, 'line0\nline1\nline2\nline3\nline4\n')
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
        const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false })
        editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(3, 5))

        // Expected payload: coordinates PLUS the editor's own selection text
        // (protocol 2 — the buffer content the user saw, unsaved edits
        // included, not a disk read) and the document version it came from.
        const expectedParams = {
          path: normalizeWsPath(file),
          startLine: 1,
          endLine: 3,
          isEmpty: false,
          text: 'line1\nline2\nline3',
          documentVersion: doc.version,
        }
        await poll(() => (received.length > 0 ? true : undefined), 10000)
        assert.equal(received.length, 1, `exactly one notification expected, got ${JSON.stringify(received)}`)
        assert.equal(received[0].method, SELECTION_METHOD)
        assert.deepEqual(received[0].params, expectedParams)
        // 协议 v2 键集合契约：坐标 + 文本 + 文档版本，且不得有其它键
        // （与单测同一断言）。
        assert.deepEqual(
          Object.keys(received[0].params as Record<string, unknown>).sort(),
          ['documentVersion', 'endLine', 'isEmpty', 'path', 'startLine', 'text'],
        )
        // 清空选区 → 必须广播一次 isEmpty:true，TUI 才能清掉徽标/停止附加。
        // (曾经只发非空——TUI 侧 selection 快照永不失效，徽标残留 + 再发送
        //  仍带旧索引。扩展侧补上这枚「清除」通知。)
        const receivedLenAfterSelect = received.length
        editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0))
        await poll(() => (received.length > receivedLenAfterSelect ? true : undefined), 10000)
        const cleared = received[received.length - 1] as Record<string, unknown>
        assert.equal(cleared.method, SELECTION_METHOD)
        assert.deepEqual(cleared.params, {
          path: normalizeWsPath(file),
          startLine: 1,
          endLine: 1,
          isEmpty: true,
          text: '',
          documentVersion: doc.version,
        })
        // ── 禁用 autoInsertMention：补推 isEmpty + 撤销已排定的防抖推送 ──
        // 这两条行为只存在于 extension.ts 的 onDidChangeConfiguration，单测覆盖
        // 不到（不 import vscode），因此必须在这里锁住（issue #21 第 2 条）。
        await cfg.update('autoInsertMention', true, vscode.ConfigurationTarget.Global)
        const beforeDisable = received.length
        // 制造「选区刚变化、300ms 防抖尚未到点」的状态，随即禁用：若那颗定时器
        // 没被撤销，它会在 isEmpty 之后补推一帧**非空**选区，把刚清掉的快照装回
        // TUI —— 正是 CodeRabbit 与独立审查各自指出的那个竞态。
        editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(2, 0))
        await cfg.update('autoInsertMention', false, vscode.ConfigurationTarget.Global)
        // 跨过防抖窗口，让「若未撤销就会发生」的补推充分暴露
        await new Promise(resolve => setTimeout(resolve, 700))
        const afterDisable = received.slice(beforeDisable) as Array<Record<string, unknown>>
        assert.ok(afterDisable.length > 0, '禁用配置后必须补推一帧 isEmpty')
        const isEmptyOf = (f: Record<string, unknown>): unknown =>
          (f.params as Record<string, unknown> | undefined)?.isEmpty
        const lastFrame = afterDisable[afterDisable.length - 1]!
        assert.equal(isEmptyOf(lastFrame), true,
          `禁用后最后一帧必须是 isEmpty，实收序列 ${JSON.stringify(afterDisable.map(isEmptyOf))}`)
        const firstEmpty = afterDisable.findIndex(f => isEmptyOf(f) === true)
        const nonEmptyAfter = afterDisable.slice(firstEmpty + 1).filter(f => isEmptyOf(f) !== true)
        assert.equal(nonEmptyAfter.length, 0,
          `isEmpty 之后仍出现非空帧（定时器未被撤销）：${JSON.stringify(nonEmptyAfter)}`)
      } finally {
        rmSync(file, { force: true })
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      }
    } finally {
      await cfg.update('autoInsertMention', false, vscode.ConfigurationTarget.Global)
    }
  } finally {
    socket.close()
  }
})

// ---- T04 zh-cn language-pack subset ----------------------------------------
// ADR-005 / L-003: a repo-local fake language pack must go through one cold
// registration launch before `--locale=zh-cn` changes `vscode.env.language`
// and loads the extension bundle. run-tests.ts drives both launches; this
// entry runs only the localized assertions on the hot (second) launch.
//
// The strings asserted below come from REAL product code paths (command
// handlers and their dialogs). `vscode.l10n.t` is never called from this test
// context — it would resolve the host's bundle, not the extension's (L-003).
async function runZhCnSubset(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXT_ID)
  assert.ok(ext, `extension ${EXT_ID} not found`)
  await ext!.activate()
  assert.equal(
    vscode.env.language,
    'zh-cn',
    'the hot launch must observe the registered zh-cn language pack',
  )
  console.log(`[e2e] zh-cn hot launch: vscode.env.language=${vscode.env.language}`)

  await checkZhFocusHint()
  await checkZhEmptyArchiveHint()
  await checkZhRenameDialog()
  await checkZhDeleteDialog()

  console.log(
    `[e2e] zh-cn subset verified ${zhSampledKeys.length} localized strings: ${zhSampledKeys.join(' | ')}`,
  )
}

/** Keys sampled by the zh-cn subset; each must be overridden by the zh bundle. */
const zhSampledKeys: string[] = []

/**
 * `t(key)` plus the guard that zh-cn really overrides it: without this guard,
 * comparing product UI to `t(key)` could pass vacuously through the English
 * identity fallback.
 */
function expectZh(key: string, ...args: Array<string | number>): string {
  const en = bundleFor('en')
  assert.ok(key in en, `key missing from the English identity bundle: ${key}`)
  assert.notEqual(bundleFor('zh-cn')[key], en[key], `zh-cn bundle must override: ${key}`)
  zhSampledKeys.push(key)
  return t(key, ...args)
}

/** Replace one `vscode.window` dialog method while `run` executes, then restore. */
async function withDialogStub(
  method: 'showInformationMessage' | 'showInputBox' | 'showWarningMessage',
  stub: unknown,
  run: () => Thenable<unknown>,
): Promise<void> {
  const win = vscode.window as unknown as Record<string, unknown>
  const original = win[method]
  win[method] = stub
  try {
    await run()
  } finally {
    win[method] = original
  }
}

/** Session identity for the zh-cn dialogs; never read (both dialogs cancel). */
const ZH_FAKE_ITEM = { id: 'zh-1', file: join(tmpdir(), 'dsh-e2e-zh-missing.jsonl.zstd') }

/** insertAtMention with no editor → the localized fallback information message. */
async function checkZhFocusHint(): Promise<void> {
  const messages: string[] = []
  await withDialogStub(
    'showInformationMessage',
    async (message: string) => { messages.push(String(message)) },
    async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.commands.executeCommand('dsh-tui-vscode.insertAtMention')
    },
  )
  assert.equal(
    messages[0],
    expectZh('Focus an editor first, then insert an @file reference'),
    'insertAtMention without an editor must show the localized hint',
  )
}

/** manageArchived with an empty archive set → the localized empty message. */
async function checkZhEmptyArchiveHint(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-e2e-zh-'))
  const savedHome = process.env.DSH_HOME
  const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
  const savedCfgHome = cfg.get<string>('dshHome', '')
  const messages: string[] = []
  try {
    process.env.DSH_HOME = home
    await cfg.update('dshHome', '', vscode.ConfigurationTarget.Global)
    await sleep(300) // the config-change listener re-points the global tree
    await withDialogStub(
      'showInformationMessage',
      async (message: string) => { messages.push(String(message)) },
      () => vscode.commands.executeCommand('dsh-tui-vscode.manageArchived'),
    )
    assert.equal(
      messages[0],
      expectZh('No archived sessions'),
      'manageArchived with no archived sessions must show the localized empty message',
    )
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    await cfg.update('dshHome', savedCfgHome, vscode.ConfigurationTarget.Global)
    await rmTempDir(home)
  }
}

/** renameSession dialog → the localized prompt and placeholder. */
async function checkZhRenameDialog(): Promise<void> {
  let options: vscode.InputBoxOptions | undefined
  await withDialogStub(
    'showInputBox',
    async (boxOptions?: vscode.InputBoxOptions) => {
      options = boxOptions
      return undefined // cancelled — this subset never writes
    },
    () => vscode.commands.executeCommand('dsh-tui-vscode.renameSession', ZH_FAKE_ITEM),
  )
  assert.equal(options?.prompt, expectZh('Rename session {0}…', 'zh-1'), 'rename prompt must be localized')
  assert.equal(options?.placeHolder, expectZh('Enter a new title'), 'rename placeholder must be localized')
}

/** deleteSession confirmation dialog → the localized warning body. */
async function checkZhDeleteDialog(): Promise<void> {
  let body: unknown
  await withDialogStub(
    'showWarningMessage',
    async (...args: unknown[]) => {
      body = args[0]
      return undefined // cancelled — nothing is deleted
    },
    () => vscode.commands.executeCommand('dsh-tui-vscode.deleteSession', ZH_FAKE_ITEM),
  )
  assert.equal(
    body,
    expectZh(
      'Permanently delete session {0}…? Its log directory will be removed and this cannot be undone. Consider archiving it first.',
      'zh-1',
    ),
    'delete confirmation must be localized',
  )
}

// ---- Terminal-image protocol subsets (T-FIX-02) -----------------------------
// REVIEW F-2: the image-capability orchestration had NO in-repo coverage. F-3
// made the host capability a function of TWO observations — the value of
// `terminal.integrated.enableImages` when THIS window started (the snapshot
// extension.ts takes once in activate()) and its live value (session.ts
// `resolveTerminalImageCapability`) — so neither half can be exercised in the
// main suite host, which always starts with the setting off:
//   * a window that started off can never reach `sixel`, however the setting
//     is written inside it (that IS F-3's fix), and
//   * a window that started on cannot produce the "written, not reloaded"
//     offer at all (the capability is already satisfied).
// run-tests.ts therefore launches one dedicated host per window-start state,
// each with its own wiped `--user-data-dir`, and routes here through
// DSH_E2E_IMAGE_MODE.
//
// The one-time offer is per window as well (extension.ts marks it in
// globalState BEFORE awaiting the notification), which is why the AC-5 offer
// assertions live in the ON host: its first start has nothing to offer — a
// window that really loaded the renderer is never nagged — so the window's one
// offer slot is still free for them.

/** The env lines the fake launcher wrote for the `start` we just issued. */
async function launchedEnvLines(): Promise<string[]> {
  const text = await poll(() => {
    const content = readFile(ENV_OUT)
    return content?.includes('FAKE_LAUNCHER_RAN') ? content : undefined
  }, 20000)
  return text.trim().split(/\r?\n/).map(line => line.trim())
}

/** Issue `start` and return the env the fake launcher reports for it. */
async function startAndReadEnv(): Promise<string[]> {
  rmSync(ENV_OUT, { force: true })
  await vscode.commands.executeCommand('dsh-tui-vscode.start')
  return launchedEnvLines()
}

/** True when the child received `DSH_TUI_IMAGE_PROTOCOL=<value>`. */
const injectedImageProtocol = (lines: string[], value: string): boolean =>
  lines.includes(`DSH_TUI_IMAGE_PROTOCOL=${value}`)

/** The LIVE `terminal.integrated.enableImages` value (fresh read each call). */
const readEnableImages = (): boolean =>
  vscode.workspace.getConfiguration('terminal.integrated').get<boolean>('enableImages', false)

/**
 * (c1) `imageProtocol: none` means "character art is what I want": the setup
 * offer must not appear, and it must not consume the window's one-time prompt
 * marker either — the marker is written BEFORE the notification is awaited, so
 * a prompt the user never wanted would silently take the promised retry away
 * (Sourcery ⑤).
 *
 * The non-consumption half is asserted by a later leg: a `none` that DID consume
 * the one-time marker would leave the window on `asked`, and
 * `checkDefeatedWriteReportsFailure` would then see nothing instead of the
 * one-click enable offer (the clean-click leg above hands the slot it consumed
 * back again, so this window still has one to give). Runs in the state that
 * would normally offer it (setting off, no reload pending).
 */
async function checkNonePreferenceSuppressesOffer(
  images: vscode.WorkspaceConfiguration,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
  const silent: string[] = []
  let launched: string[] = []
  try {
    await cfg.update('imageProtocol', 'none', vscode.ConfigurationTarget.Global)
    await withDialogStub(
      'showInformationMessage',
      async (message: string) => { silent.push(String(message)) },
      async () => { launched = await startAndReadEnv() },
    )
    assert.equal(
      silent.length,
      0,
      `an explicit none must not be asked to enable images: ${silent.join(' | ')}`,
    )
    assert.ok(
      injectedImageProtocol(launched, 'none'),
      `an explicit none must still reach the session as a protocol value; got: ${launched.join(' | ')}`,
    )
  } finally {
    await cfg.update('imageProtocol', undefined, vscode.ConfigurationTarget.Global)
  }
  console.log('[e2e] PASS images: an explicit none preference suppresses the setup offer')
}

/**
 * (c2) The same click on a profile with NOTHING overriding the setting must
 * report SUCCESS — and success here is the whole user-visible path, not "the
 * `update()` promise resolved": `terminal.integrated.enableImages` really turns
 * on, the manual failure copy does NOT appear, and the reload offer (the only
 * thing that can load the renderer) DOES appear — with its `Reload Window`
 * action, which is what the user needs to finish the job.
 *
 * This is the leg the suite was missing when v0.7.5 shipped: (c0) below pins the
 * DEFEATED write, and (b) pins "nothing is written before the click", but no leg
 * asserted the ordinary outcome. The product's verdict was a read of the
 * effective value taken immediately after `update()` resolved — and the
 * configuration model reaches this extension host asynchronously, so on a clean
 * profile that read can still see the old `false` and send every successful
 * click down the failure path. The stale read is a race, so this leg asserts the
 * OUTCOME the user sees (no failure copy, reload offer shown) rather than any
 * timing that produced it.
 *
 * Runs FIRST of the offer legs on the wiped profile: nothing has written a
 * workspace/folder override yet, so this is the cleanest state the click can
 * see — and it consumes the window's one free offer slot. The `finally` hands
 * that slot back (the e2e seam clears the window's own memory, the extension API
 * the persisted entry) so the legs below still get their offer.
 */
async function checkCleanEnableClickSucceeds(
  api: Api,
  images: vscode.WorkspaceConfiguration,
): Promise<void> {
  const enableAction = t('Enable and Reload Window')
  const offer = t('Terminal images need VS Code image rendering, but terminal.integrated.enableImages is off, so dsh-tui shows block characters instead of real images. The setting takes effect only after a window reload, and reloading closes running dsh-tui terminals.')
  const messages: string[] = []
  const actions: string[][] = []
  try {
    // The scenario is "a profile with nothing overriding the setting". A run
    // killed inside the defeated-write leg below can leave ITS fixture — a
    // workspace-level `false` — in the workspace's settings.json, so clear that
    // scope instead of inheriting a crashed run's state: a stale fixture would
    // otherwise turn this leg into a confusing, unrelated red.
    await images.update('enableImages', undefined, vscode.ConfigurationTarget.Workspace)
    await poll(
      () => (images.inspect<boolean>('enableImages')?.workspaceValue === undefined ? true : undefined),
      10000,
    )
    await withDialogStub(
      'showInformationMessage',
      async (message: string, ...items: string[]) => {
        messages.push(String(message))
        actions.push(items.map(String))
        // Accept the enable offer; leave the reload offer unanswered — pressing
        // its "Reload Window" action would reload the host mid-suite.
        return String(message) === offer ? enableAction : undefined
      },
      async () => { await startAndReadEnv() },
    )
    assert.equal(messages[0], offer, 'the leg must start from the one-click enable offer')
    // The verdict is the SECOND message: either the reload offer (the write took
    // effect) or the manual copy (it could not).
    await poll(() => (messages.length >= 2 ? messages : undefined), 15000)
    assert.equal(messages.length, 2, `exactly two messages expected, got ${messages.length}: ${messages.join(' | ')}`)
    assert.ok(
      !messages.includes(
        t('Could not enable terminal image rendering automatically. Set terminal.integrated.enableImages to true in Settings and reload the window. Reloading closes all running dsh-tui terminals; without a reload the setting does not take effect.'),
      ),
      `nothing overrides the write on this profile, so the manual failure copy must not appear; got: ${messages.join(' | ')}`,
    )
    assert.equal(
      messages[1],
      t('Image rendering is enabled, but the setting takes effect only after a window reload. Reloading closes all running dsh-tui terminals; their sessions stay in the sidebar and can be resumed.'),
      'a successful enable must ask for the reload that makes the write take effect',
    )
    assert.ok(
      actions[1].includes(t('Reload Window')),
      `the reload offer must carry the Reload Window action; got: ${JSON.stringify(actions[1])}`,
    )
    // The user-visible fact: the setting really is on now. Polled, because the
    // configuration model is pushed to this extension host asynchronously —
    // which is exactly the race the product's verdict must not depend on, and
    // the reason this assertion is about the OUTCOME, not about one read.
    await poll(() => (readEnableImages() === true ? true : undefined), 10000)
    assert.equal(
      images.inspect<boolean>('enableImages')?.globalValue,
      true,
      'the click must have written the setting to the Global scope',
    )
  } finally {
    await images.update('enableImages', undefined, vscode.ConfigurationTarget.Global)
    // Give the window its offer slot back before the legs below run.
    await api.seedImageSetupPrompted(false)
  }
  console.log('[e2e] PASS images: a clean click enables the setting and offers the reload')
}

/**
 * (c0) A settings write that `Global` accepts but a higher-precedence override
 * still defeats must be reported as FAILURE (Sourcery ③).
 *
 * `terminal.integrated.enableImages` has window scope, so a workspace or folder
 * override wins over the Global write `enableHostImages` performs. Treating the
 * resolved `update()` as success would offer the reload, mark the one-time
 * prompt as answered and leave image rendering disabled with no further offer;
 * an explicit `false` in a higher scope is instead what the verdict looks for
 * BEFORE writing (so this profile is not written to at all) and it takes the
 * existing failure path: the manual instructions are shown, the prompt marker is
 * reset so a later start may retry, and no reload is offered for something that
 * would not take effect.
 *
 * Must run before the reload-explanation legs, and after the clean-click leg
 * above has handed the window's offer slot back: it needs the one-click enable
 * offer (not the reload explanation) to reach the click path, and the retry leg
 * below depends on the marker state this failure leaves behind.
 */
async function checkDefeatedWriteReportsFailure(
  api: Api,
  images: vscode.WorkspaceConfiguration,
): Promise<void> {
  const enableAction = t('Enable and Reload Window')
  const offer = t('Terminal images need VS Code image rendering, but terminal.integrated.enableImages is off, so dsh-tui shows block characters instead of real images. The setting takes effect only after a window reload, and reloading closes running dsh-tui terminals.')
  const messages: string[] = []
  try {
    // The override stays in place for the whole body: the effective value must
    // remain false while the retry leg observes the state this failure leaves.
    await images.update('enableImages', false, vscode.ConfigurationTarget.Workspace)
    // The scenario's PRECONDITION, not a timeout around the product's verdict:
    // the extension judges the override by inspecting the scopes, and the
    // configuration model reaches the extension host asynchronously — so wait
    // until the override this leg just wrote is really there before clicking.
    await poll(
      () => (images.inspect<boolean>('enableImages')?.workspaceValue === false ? true : undefined),
      10000,
    )
    // Same kind of precondition for the "nothing was written" assertion below:
    // the Global value the clean-click leg wrote must be gone again, so an empty
    // Global scope after this click can only mean this click wrote nothing.
    await poll(
      () => (images.inspect<boolean>('enableImages')?.globalValue === undefined ? true : undefined),
      10000,
    )
    await withDialogStub(
      'showInformationMessage',
      async (message: string) => {
        messages.push(String(message))
        // Accept the enable offer; let the failure message pass through
        // unanswered (`applyImageSetupChoice` shows it without awaiting).
        return String(message) === offer ? enableAction : undefined
      },
      async () => { await startAndReadEnv() },
    )
    assert.equal(messages[0], offer, 'the leg must start from the one-click enable offer')
    // The click rules on the override by inspecting the scopes BEFORE writing,
    // and the failure copy is shown without awaiting — so the verdict arrives
    // one turn later.
    await poll(() => (messages.length >= 2 ? messages : undefined), 15000)
    assert.equal(messages.length, 2, `exactly two messages expected, got ${messages.length}: ${messages.join(' | ')}`)
    assert.equal(
      messages[1],
      t('Could not enable terminal image rendering automatically. Set terminal.integrated.enableImages to true in Settings and reload the window. Reloading closes all running dsh-tui terminals; without a reload the setting does not take effect.'),
      'a write that a higher-priority override defeats must take the manual path, not offer a reload that cannot help',
    )
    assert.equal(
      readEnableImages(),
      false,
      'the override must still pin the effective value to false — that is the state the verdict has to detect',
    )
    assert.equal(
      images.inspect<boolean>('enableImages')?.globalValue,
      undefined,
      'a defeated write must not be performed at all: the verdict comes before the update(), not after a read of what it did',
    )
    // (Sourcery ⑥) The failure promised a retry, and the persisted marker that
    // retry has to survive may still be there: clearing it is fire-and-forget,
    // so a delayed or rejected `globalState.update` leaves exactly this state.
    // Plant the stale marker and assert the retry still goes out — the window's
    // own memory must be authoritative for a promise it just made.
    await sleep(300) // let the fire-and-forget clear settle; a later clear can only remove the staleness
    await api.seedImageSetupPrompted(true)
    const retry: string[] = []
    await withDialogStub(
      'showInformationMessage',
      async (message: string) => {
        retry.push(String(message))
        return t('Not Now')
      },
      async () => { await startAndReadEnv() },
    )
    assert.deepEqual(
      retry,
      [offer],
      `a stale persistent prompt marker must not silence the promised retry; got: ${retry.join(' | ')}`,
    )
  } finally {
    await images.update('enableImages', undefined, vscode.ConfigurationTarget.Workspace)
  }
  console.log('[e2e] PASS images: a write defeated by a higher-priority override reports failure')
}

/**
 * (a0) The reload explanation describes a state THIS window is in, so it must
 * survive a profile that already answered the one-time prompt in an EARLIER
 * window: the setting really is on, this window really has no renderer, and
 * without the explanation the user is left with unexplained block characters
 * (REVIEW M-2). A wiped `--user-data-dir` cannot carry that history in, so the
 * persistent marker is seeded first — the exact globalState state a previously
 * prompted profile is in, which is the one dimension the other legs cannot
 * reach (they all start from an empty globalState). Runs FIRST: the later legs
 * then run under a realistically "already prompted" profile.
 */
async function checkPromptedProfileStillExplainsReload(
  api: Api,
  images: vscode.WorkspaceConfiguration,
): Promise<void> {
  await api.seedImageSetupPrompted(true)
  await images.update('enableImages', true, vscode.ConfigurationTarget.Global)
  const offers: string[] = []
  let written: string[] = []
  await withDialogStub(
    'showInformationMessage',
    async (message: string) => { offers.push(String(message)) },
    async () => { written = await startAndReadEnv() },
  )
  assert.ok(
    injectedImageProtocol(written, 'none'),
    `an unreloaded enableImages write must keep the injection on none even on a previously prompted profile (F-3); got: ${written.join(' | ')}`,
  )
  assert.equal(
    offers.length,
    1,
    `the reload explanation must not be suppressed by the cross-window prompt marker (M-2); got ${offers.length}: ${offers.join(' | ')}`,
  )
  assert.equal(
    offers[0],
    t('Image rendering is enabled, but the setting takes effect only after a window reload. Reloading closes all running dsh-tui terminals; their sessions stay in the sidebar and can be resumed.'),
    'a previously prompted profile must still be told that the reload is what is missing',
  )
  console.log('[e2e] PASS images: a previously prompted profile is still told to reload')
}

/**
 * (a2) A write the window never reloaded must not upgrade the capability: the
 * injection stays `none` — asking for `sixel` here is precisely REVIEW F-3's
 * permanent-blank state — and the user is offered the reload instead. Must run
 * FIRST in this window: the offer is one per window, and this is the start that
 * reaches the `reloadWindow` branch.
 */
async function checkInWindowWriteStaysNone(
  images: vscode.WorkspaceConfiguration,
): Promise<void> {
  await images.update('enableImages', true, vscode.ConfigurationTarget.Global)
  const offers: string[] = []
  let written: string[] = []
  await withDialogStub(
    'showInformationMessage',
    async (message: string) => { offers.push(String(message)) },
    async () => { written = await startAndReadEnv() },
  )
  assert.ok(
    injectedImageProtocol(written, 'none'),
    `an enableImages write this window never reloaded must keep the injection on none (F-3); got: ${written.join(' | ')}`,
  )
  assert.equal(offers.length, 1, `exactly one offer expected, got ${offers.length}: ${offers.join(' | ')}`)
  assert.equal(
    offers[0],
    t('Image rendering is enabled, but the setting takes effect only after a window reload. Reloading closes all running dsh-tui terminals; their sessions stay in the sidebar and can be resumed.'),
    'the offer must ask for the window reload',
  )
  console.log('[e2e] PASS images: an in-window enableImages write stays on none and offers the reload')
}

/** (a1) With the setting off, the injection is `none`. */
async function checkOffInjectsNone(images: vscode.WorkspaceConfiguration): Promise<void> {
  await images.update('enableImages', undefined, vscode.ConfigurationTarget.Global)
  const silent: string[] = []
  let off: string[] = []
  await withDialogStub(
    'showInformationMessage',
    async (message: string) => { silent.push(String(message)) },
    async () => { off = await startAndReadEnv() },
  )
  assert.ok(
    injectedImageProtocol(off, 'none'),
    `enableImages off must inject none; got: ${off.join(' | ')}`,
  )
  assert.equal(silent.length, 0, `the one-time offer must not come back: ${silent.join(' | ')}`)
  console.log('[e2e] PASS images: enableImages off injects none')
}

/**
 * (d) `imageProtocol: auto` must DELETE an inherited `DSH_TUI_IMAGE_PROTOCOL`
 * instead of merely not writing it: `createTerminal` overlays the env onto the
 * one the terminal would inherit, so an omitted key leaves whatever the VS Code
 * process (or a profile) exported visible to dsh-tui — which would silently
 * pin a protocol the user asked to auto-detect (Sourcery ②).
 *
 * The inherited fixture is planted by run-tests.ts (`DSH_TUI_IMAGE_PROTOCOL=kitty`
 * in the launched process env), and the fake launcher reports whatever the child
 * actually received — so `DSH_TUI_IMAGE_PROTOCOL=` (empty) is the delete and a
 * surviving `kitty` is the leak.
 */
async function checkAutoRemovesInheritedProtocol(): Promise<void> {
  assert.equal(
    process.env.DSH_TUI_IMAGE_PROTOCOL,
    'kitty',
    'this host must inherit the foreign DSH_TUI_IMAGE_PROTOCOL fixture — run-tests.ts sets it for image hosts',
  )
  const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
  const silent: string[] = []
  let auto: string[] = []
  try {
    await cfg.update('imageProtocol', 'auto', vscode.ConfigurationTarget.Global)
    await withDialogStub(
      'showInformationMessage',
      async (message: string) => { silent.push(String(message)) },
      async () => { auto = await startAndReadEnv() },
    )
    assert.ok(
      auto.includes('DSH_TUI_IMAGE_PROTOCOL='),
      `the launcher must still report the key; got: ${auto.join(' | ')}`,
    )
    assert.ok(
      !auto.includes('DSH_TUI_IMAGE_PROTOCOL=kitty'),
      `auto must remove the value inherited from the VS Code process, not leave it in place; got: ${auto.join(' | ')}`,
    )
  } finally {
    await cfg.update('imageProtocol', undefined, vscode.ConfigurationTarget.Global)
  }
  assert.equal(silent.length, 0, `auto has nothing to offer: ${silent.join(' | ')}`)
  console.log('[e2e] PASS images: auto removes the inherited DSH_TUI_IMAGE_PROTOCOL value')
}

/**
 * A leg (c0 + a0 + a1 + a2) plus the auto-delete leg (d), host
 * `DSH_E2E_IMAGE_MODE=images-off`: the window started with
 * `terminal.integrated.enableImages` off, which run-tests.ts guarantees by
 * launching against a wiped `--user-data-dir` (no settings.json).
 */
async function runImagesOffSubset(): Promise<void> {
  // Activate FIRST: the window-start snapshot is taken in activate(), and this
  // subset writes the setting in-window — a late activation would read that
  // write and never exercise the "started off" state at all.
  const ext = vscode.extensions.getExtension(EXT_ID)
  assert.ok(ext, `extension ${EXT_ID} not found`)
  await ext!.activate()
  assert.notEqual(
    readEnableImages(),
    true,
    'this host must start with terminal.integrated.enableImages off — run-tests.ts must launch it with a wiped --user-data-dir',
  )
  await configureFakeLauncher()
  const api = vscode.extensions.getExtension(EXT_ID)!.exports as Api
  const images = vscode.workspace.getConfiguration('terminal.integrated')
  try {
    // First, on the profile nothing has written to yet — and before it is marked
    // as prompted: this leg needs a clean click AND the window's one free offer
    // slot, and it hands that slot back in its finally so the `none` leg's
    // non-consumption is still witnessed by the failure leg (③) reaching the
    // click path.
    await checkCleanEnableClickSucceeds(api, images)
    await checkNonePreferenceSuppressesOffer(images)
    await checkDefeatedWriteReportsFailure(api, images)
    await checkPromptedProfileStillExplainsReload(api, images)
    await checkInWindowWriteStaysNone(images)
    await checkOffInjectsNone(images)
    // Last: it changes `dsh-tui-vscode.imageProtocol`, not the enableImages
    // state the legs above depend on.
    await checkAutoRemovesInheritedProtocol()
  } finally {
    // Leave no setting — and no prompt marker — behind for a rerun against a
    // surviving profile.
    await images.update('enableImages', undefined, vscode.ConfigurationTarget.Global)
    await api.seedImageSetupPrompted(false)
  }
}

/** (B) The end-to-end positive leg: only this window state may inject `sixel`. */
async function checkEnabledWindowInjectsSixel(): Promise<void> {
  const nagged: string[] = []
  let on: string[] = []
  await withDialogStub(
    'showInformationMessage',
    async (message: string) => { nagged.push(String(message)) },
    async () => { on = await startAndReadEnv() },
  )
  assert.ok(
    injectedImageProtocol(on, 'sixel'),
    `a window that started with images enabled must inject sixel; got: ${on.join(' | ')}`,
  )
  assert.equal(nagged.length, 0, `nothing to offer in this window: ${nagged.join(' | ')}`)
  console.log('[e2e] PASS images: a window that started with images enabled injects sixel')
}

/**
 * (b) The one-time offer appears exactly once and writes nothing before the
 * click. Turning the setting off in-window is what produces the offer here —
 * the same `enableImages` branch a window that started off would take.
 */
async function checkOfferOnceWithoutWrite(
  images: vscode.WorkspaceConfiguration,
): Promise<void> {
  await images.update('enableImages', false, vscode.ConfigurationTarget.Global)
  const offers: string[] = []
  let enabledAtOffer: boolean | undefined
  let off: string[] = []
  await withDialogStub(
    'showInformationMessage',
    async (message: string) => {
      offers.push(String(message))
      enabledAtOffer = readEnableImages()
      // "Not Now": the user declines, so nothing may be written.
      return t('Not Now')
    },
    async () => { off = await startAndReadEnv() },
  )
  assert.equal(offers.length, 1, `the offer must appear exactly once, got ${offers.length}: ${offers.join(' | ')}`)
  assert.equal(
    offers[0],
    t('Terminal images need VS Code image rendering, but terminal.integrated.enableImages is off, so dsh-tui shows block characters instead of real images. The setting takes effect only after a window reload, and reloading closes running dsh-tui terminals.'),
    'the offer must name the setting it wants to turn on',
  )
  assert.equal(enabledAtOffer, false, 'the setting must still be untouched while the offer is on screen')
  assert.equal(readEnableImages(), false, 'answering Not Now must not write the setting')
  assert.ok(
    injectedImageProtocol(off, 'none'),
    `a setting that is off must inject none; got: ${off.join(' | ')}`,
  )
  console.log('[e2e] PASS images: the offer appears once and writes nothing before the click')
}

/** (c) "Not Now" is remembered: the next start does not offer again. */
async function checkNotNowRemembered(): Promise<void> {
  const again: string[] = []
  await withDialogStub(
    'showInformationMessage',
    async (message: string) => { again.push(String(message)) },
    async () => { await startAndReadEnv() },
  )
  assert.equal(again.length, 0, `the offer must not come back after Not Now: ${again.join(' | ')}`)
  console.log('[e2e] PASS images: answering Not Now stops the offer')
}

/**
 * A leg (b + c) and the B leg, host `DSH_E2E_IMAGE_MODE=images-on`: the window
 * started with `terminal.integrated.enableImages` already true, which
 * run-tests.ts guarantees by pre-writing the profile's settings.json.
 *
 * The AC-5 offer assertions live in THIS host because the offer is one per
 * window and this window's first start has nothing to offer (a window that
 * really loaded the renderer is never nagged) — so its offer slot is still free.
 */
async function runImagesOnSubset(): Promise<void> {
  // Activate FIRST: activate() is where the window-start snapshot is taken, and
  // the preset must be what it sees (run-tests.ts writes it before launching).
  const ext = vscode.extensions.getExtension(EXT_ID)
  assert.ok(ext, `extension ${EXT_ID} not found`)
  await ext!.activate()
  assert.equal(
    readEnableImages(),
    true,
    'this host must start with terminal.integrated.enableImages preset to true — run-tests.ts writes its settings.json',
  )
  await configureFakeLauncher()
  const images = vscode.workspace.getConfiguration('terminal.integrated')
  try {
    await checkEnabledWindowInjectsSixel()
    await checkOfferOnceWithoutWrite(images)
    await checkNotNowRemembered()
  } finally {
    await images.update('enableImages', undefined, vscode.ConfigurationTarget.Global)
  }
}

export async function run(): Promise<void> {
  const l10nMode = process.env.DSH_E2E_L10N_MODE
  if (l10nMode === 'warmup') {
    // ADR-005 launch A: VS Code scans/registers the fake language pack while
    // it starts; assert nothing here — launch B observes the hot state.
    console.log('[e2e] zh-cn warm-up launch: language-pack registration only')
    return
  }
  if (l10nMode === 'zh-cn') {
    await runZhCnSubset()
    console.log('[e2e] zh-cn subset passed')
    return
  }
  // Terminal-image hosts (T-FIX-02): one dedicated host per window-start state
  // of `terminal.integrated.enableImages` — see the subsets above.
  const imageMode = process.env.DSH_E2E_IMAGE_MODE
  if (imageMode !== undefined && imageMode !== '') {
    if (imageMode !== 'images-off' && imageMode !== 'images-on') {
      // Falling through on a typo would run the MAIN suite in an image host and
      // still look green — coverage that silently does not exist, which is the
      // exact failure this task exists to remove (REVIEW F-2). Fail loudly.
      throw new Error(`unknown DSH_E2E_IMAGE_MODE: ${imageMode}`)
    }
    await withFakeLauncherOnPath(async () => {
      if (imageMode === 'images-off') await runImagesOffSubset()
      else await runImagesOnSubset()
    })
    console.log(`[e2e] ${imageMode} subset passed`)
    return
  }

  console.log(`[e2e] running ${tests.length} tests`)
  try {
    // Inject the fake launcher dir into PATH so the bare command
    // 'fake-dsh-tui' resolves when the extension looks it up.
    await withFakeLauncherOnPath(async () => {
      for (const [name, fn] of tests) {
        await fn()
        console.log(`[e2e] PASS ${name}`)
      }
      console.log(`[e2e] all ${tests.length} tests passed`)
    })
  } finally {
    const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
    await cfg.update('command', 'dsh-tui', vscode.ConfigurationTarget.Global)
    await cfg.update('extraArgs', [], vscode.ConfigurationTarget.Global)
    await cfg.update('lang', '', vscode.ConfigurationTarget.Global)
    await cfg.update('dshHome', '', vscode.ConfigurationTarget.Global)
  }
}