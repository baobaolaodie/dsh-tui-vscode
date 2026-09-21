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

interface Api {
  sendInput(text: string): void
  hasTerminal(): boolean
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
      return '永久删除'
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
      const seenB = await poll(() => {
        const c = provider.getChildren(undefined)
        const ids = c.flatMap(n => (n as { sessions: { id: string }[] }).sessions.map(s => s.id))
        return ids.includes('b') ? true : undefined
      }, 10000)
      assert.equal(seenB, true, 'new-group session must appear without manual refresh')
    } finally {
      provider.dispose()
    }
  } finally {
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
    vscode.window.showWarningMessage = (async () => '永久删除') as typeof vscode.window.showWarningMessage
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
        return arr.find(i => String((i as { label?: string }).label ?? '').includes('恢复'))
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
      vscode.window.showWarningMessage = (async () => '永久删除') as typeof vscode.window.showWarningMessage
      picks = 0
      vscode.window.showQuickPick = (async (items: unknown) => {
        picks += 1
        const arr = items as unknown[]
        if (picks === 1) return arr[0]
        return arr.find(i => String((i as { label?: string }).label ?? '').includes('彻底删除'))
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
      assert.ok(infoShown?.includes('已复制'), `fallback must inform the user, got ${infoShown}`)
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
      assert.ok(infoShown?.includes('已复制'), `fallback must inform the user, got ${infoShown}`)
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

export async function run(): Promise<void> {
  console.log(`[e2e] running ${tests.length} tests`)
  // Inject the fake launcher dir into PATH so the bare command
  // 'fake-dsh-tui' resolves to the shim in the terminal's shell.
  const originalPath = process.env.PATH ?? ''
  process.env.PATH = WS + (process.platform === 'win32' ? ';' : ':') + originalPath
  try {
    for (const [name, fn] of tests) {
      await fn()
      console.log(`[e2e] PASS ${name}`)
    }
    console.log(`[e2e] all ${tests.length} tests passed`)
  } finally {
    process.env.PATH = originalPath
    const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
    await cfg.update('command', 'dsh-tui', vscode.ConfigurationTarget.Global)
    await cfg.update('extraArgs', [], vscode.ConfigurationTarget.Global)
    await cfg.update('lang', '', vscode.ConfigurationTarget.Global)
    await cfg.update('dshHome', '', vscode.ConfigurationTarget.Global)
  }
}