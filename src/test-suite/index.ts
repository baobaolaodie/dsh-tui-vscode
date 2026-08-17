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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zstd from '@bokuweb/zstd-wasm'

const EXT_ID = 'baobaolaodie.dsh-tui-vscode'
const WS = join(__dirname, '..', '..', '.e2e-workspace')
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
async function makeE2eSession(
  home: string,
  group: string,
  id: string,
  events: Record<string, unknown>[],
): Promise<string> {
  const dir = join(home, 'sessions', group, id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.jsonl.zstd')
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

      await vscode.commands.executeCommand('dsh-tui-vscode.deleteSession', fakeItem)
      assert.equal(warnShown, true, 'delete must ask for confirmation')
      assert.ok(!existsSync(join(home, 'sessions', '--g--', 'cmd-1')), 'delete must remove the session dir')
    } finally {
      vscode.window.showInputBox = origInput
      vscode.window.showWarningMessage = origWarn
      if (savedHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedHome
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
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
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
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