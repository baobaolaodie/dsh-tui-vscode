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
import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

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
    const shimLog = readFile(join(WS, 'fake-dsh-tui.js.shim-log'))
    const names = vscode.window.terminals.map(t => t.name).join(',')
    const wsFiles = readdirSync(WS).join(',')
    throw new Error(
      `env-out never written; terminals=[${names}] shimLog=${JSON.stringify(shimLog ?? '<none>')} ws=[${wsFiles}]`,
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