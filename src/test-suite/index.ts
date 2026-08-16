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
const TERMINAL_NAME = 'dsh-tui'

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
    throw new Error('env-out never written by the fake launcher')
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

test('start dedupes the running terminal', async () => {
  const before = statSync(ENV_OUT).mtimeMs
  await vscode.commands.executeCommand('dsh-tui-vscode.start')
  await sleep(2500)
  // Same terminal, same child — env-out must not be rewritten.
  assert.equal(vscode.window.terminals.filter(t => t.name === TERMINAL_NAME).length, 1)
  assert.equal(statSync(ENV_OUT).mtimeMs, before, 'start must not relaunch the CLI')
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

test('resumeSession recreates the terminal with the session env', async () => {
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
  assert.ok(
    lines.some(line => line.startsWith('ARGS=') && line.includes('--resume')),
    `--resume missing: ${lines.join(' | ')}`,
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