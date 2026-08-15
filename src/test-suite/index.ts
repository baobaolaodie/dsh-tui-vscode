/**
 * Real-extension-host test suite for the Path B implementation.
 *
 * Exercises the extension exactly as a user would: activation, command
 * registration, opening the session panel, real PTY launch with env
 * injection (proven by the child process itself), webview readiness, input
 * round-trip webview→PTY, session dedupe, --resume, kill and the
 * path-open pipeline.
 */
import * as vscode from 'vscode'
import { strict as assert } from 'node:assert'
import { readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const EXT_ID = 'baobaolaodie.dsh-tui-vscode'
const PANEL_VIEW_TYPE = 'dsh-tui-vscode.session'
// out-test/test-suite -> repo root -> .e2e-workspace
const WS = join(__dirname, '..', '..', '.e2e-workspace')
const ENV_OUT = join(WS, 'env-out.txt')
const STDIN_OUT = join(WS, 'stdin-out.txt')
const EXITED = join(WS, 'exited.txt')

interface Api {
  postInput(data: string): void
  getState(): { running: boolean; pid?: number; exitCode?: number; webviewReady: boolean }
  postPanelMessage(message: unknown): void
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function poll<T>(fn: () => T | undefined, timeoutMs: number, intervalMs = 100): Promise<T> {
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

function panelTab(): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap(group => group.tabs)
    .find(tab => {
      if (!(tab.input instanceof vscode.TabInputWebview)) return false
      const viewType = tab.input.viewType
      // Newer VS Code versions expose the internal type with a
      // "mainThreadWebview-" prefix.
      return viewType === PANEL_VIEW_TYPE || viewType.endsWith(`-${PANEL_VIEW_TYPE}`)
    })
}

const tests: Array<[string, () => Promise<void>]> = []
function test(name: string, fn: () => Promise<void>): void {
  tests.push([name, fn])
}

test('extension activates and registers all commands', async () => {
  const ext = vscode.extensions.getExtension(EXT_ID)
  assert.ok(ext, `extension ${EXT_ID} not found`)
  await ext.activate()
  const cmds = await vscode.commands.getCommands(true)
  for (const id of [
    'dsh-tui-vscode.open',
    'dsh-tui-vscode.start',
    'dsh-tui-vscode.resume',
    'dsh-tui-vscode.focus',
    'dsh-tui-vscode.kill',
  ]) {
    assert.ok(cmds.includes(id), `command ${id} not registered`)
  }
})

test('start opens the panel and launches a PTY with env injection', async () => {
  const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
  // Bare command name: exercises the real user path — resolveWindowsCommand
  // finds the .cmd shim (PATH was injected in run()), node-pty wraps it.
  await cfg.update('command', 'fake-dsh-tui', vscode.ConfigurationTarget.Global)
  await cfg.update('extraArgs', [], vscode.ConfigurationTarget.Global)
  await cfg.update('lang', 'zh', vscode.ConfigurationTarget.Global)
  await cfg.update('dshHome', 'C:\\e2e-home', vscode.ConfigurationTarget.Global)

  delete process.env.VISUAL
  delete process.env.EDITOR
  rmSync(ENV_OUT, { force: true })

  // Diagnostic: what the extension will spawn, and whether a direct spawn in
  // this host actually executes (captures the pty output / exec error).
  try {
    const sessionMod = require('../session.js') as {
      buildTerminalPlan: (input: { resume: boolean; extraArgs: string[]; command: string; isWindows: boolean }) => {
        shellPath: string
        shellArgs: string[]
      }
    }
    const plan = sessionMod.buildTerminalPlan({
      resume: false,
      extraArgs: [],
      command: 'fake-dsh-tui',
      isWindows: process.platform === 'win32',
    })
    const pty = require('@lydell/node-pty') as {
      spawn: (
        file: string,
        args: string[],
        options: Record<string, unknown>,
      ) => { onData: (cb: (d: string) => void) => void; onExit: (cb: (r: { exitCode: number }) => void) => void; kill(): void }
    }
    let ptyOut = ''
    let exitCode: number | undefined
    const probe = pty.spawn(plan.shellPath, plan.shellArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: WS,
      env: process.env,
    })
    probe.onData(d => {
      ptyOut += d
    })
    probe.onExit(r => {
      exitCode = r.exitCode
    })
    await sleep(2500)
    probe.kill()
    console.log(
      `[e2e] DIAG plan=${JSON.stringify(plan)} exists=${readFile(plan.shellPath) !== undefined} exit=${exitCode} out=${JSON.stringify(ptyOut.slice(-300))}`,
    )
  } catch (error) {
    console.log(`[e2e] DIAG threw: ${String(error)}`)
  }

  await vscode.commands.executeCommand('dsh-tui-vscode.start')

  // The panel tab must exist (editor area, NOT the integrated terminal).
  const tab = await poll(() => (panelTab() ? true : undefined), 10000).catch(() => undefined)
  if (!tab) {
    const tabs = vscode.window.tabGroups.all.flatMap(group =>
      group.tabs.map(t =>
        t.input instanceof vscode.TabInputWebview
          ? `webview:${t.input.viewType}`
          : `other:${String(t.input).slice(0, 40)}`,
      ),
    )
    const api0 = (vscode.extensions.getExtension(EXT_ID)!.exports as Api).getState()
    throw new Error(`session panel tab missing; tabs=${JSON.stringify(tabs)} state=${JSON.stringify(api0)}`)
  }

  // Ground truth: the PTY child echoes its own environment.
  const text = await poll(() => {
    const content = readFile(ENV_OUT)
    return content?.includes('FAKE_LAUNCHER_RAN') ? content : undefined
  }, 15000).catch(() => undefined)
  if (!text) {
    const ext0 = vscode.extensions.getExtension(EXT_ID)!
    const state0 = (ext0.exports as Api).getState()
    const shimLog = readFile(join(WS, 'fake-dsh-tui.js.shim-log'))
    throw new Error(
      `env-out never written; files=${readdirSync(WS).join(',')} state=${JSON.stringify(state0)} envOut=${JSON.stringify(readFile(ENV_OUT) ?? '<missing>')} shimLog=${JSON.stringify(shimLog ?? '<none>')}`,
    )
  }
  const lines = text.trim().split(/\r?\n/).map(line => line.trim())
  assert.ok(lines.includes('VISUAL=code -w'), `VISUAL missing: ${lines.join(' | ')}`)
  assert.ok(lines.includes('DSH_TUI_LANG=zh'), `DSH_TUI_LANG missing: ${lines.join(' | ')}`)
  assert.ok(lines.includes('DSH_HOME=C:\\e2e-home'), `DSH_HOME missing: ${lines.join(' | ')}`)

  const ext = vscode.extensions.getExtension(EXT_ID)!
  const api = ext.exports as Api
  const state = api.getState()
  assert.equal(state.running, true, 'session should be running')
  assert.ok(state.pid !== undefined, 'session pid missing')
})

test('webview loads and xterm becomes ready', async () => {
  const ext = vscode.extensions.getExtension(EXT_ID)!
  const api = ext.exports as Api
  // The webview posts a 'ready' message after xterm initializes; receiving it
  // proves the full webview→host message channel.
  await poll(() => (api.getState().webviewReady ? true : undefined), 15000)
})

test('input round-trips into the PTY child', async () => {
  const ext = vscode.extensions.getExtension(EXT_ID)!
  const api = ext.exports as Api
  rmSync(STDIN_OUT, { force: true })
  // CRLF: the fake child runs in COOKED console mode (see DIAG notes).
  api.postInput('hello from e2e\r\n')
  await poll(() => {
    const text = readFile(STDIN_OUT)
    return text?.includes('hello from e2e') ? true : undefined
  }, 10000)
})

test('start dedupes the running session', async () => {
  const ext = vscode.extensions.getExtension(EXT_ID)!
  const api = ext.exports as Api
  const before = api.getState()
  await vscode.commands.executeCommand('dsh-tui-vscode.start')
  const after = api.getState()
  assert.equal(after.pid, before.pid, 'start must reuse the running session')
})

test('open-path message opens the file in the editor', async () => {
  const ext = vscode.extensions.getExtension(EXT_ID)!
  const api = ext.exports as Api
  const target = join(WS, 'hello.ts')
  api.postPanelMessage({ type: 'openPath', path: target, line: 2 })
  await poll(() => {
    const editor = vscode.window.activeTextEditor
    return editor && editor.document.uri.fsPath === target ? true : undefined
  }, 10000)
})

test('kill terminates the session; resume relaunches with --resume', async () => {
  const ext = vscode.extensions.getExtension(EXT_ID)!
  const api = ext.exports as Api
  rmSync(EXITED, { force: true })
  await vscode.commands.executeCommand('dsh-tui-vscode.kill')
  // Ctrl+C reaches the child (SIGINT handler writes the marker)…
  await poll(() => (readFile(EXITED) ? true : undefined), 15000, 200)
  // …then the PTY exit event propagates to the extension state.
  await poll(() => (api.getState().running ? undefined : true), 5000, 100)
  assert.equal(api.getState().running, false, 'session should be stopped after kill')

  rmSync(ENV_OUT, { force: true })
  await vscode.commands.executeCommand('dsh-tui-vscode.resume')
  await poll(() => {
    const text = readFile(ENV_OUT)
    return text?.includes('FAKE_LAUNCHER_RAN') ? text : undefined
  }, 15000)
  const lines = readFile(ENV_OUT)!
    .trim()
    .split(/\r?\n/)
    .map(line => line.trim())
  assert.ok(
    lines.some(line => line.startsWith('ARGS=') && line.includes('--resume')),
    `--resume missing: ${lines.join(' | ')}`,
  )
})

test('focus reveals the panel without restarting', async () => {
  const ext = vscode.extensions.getExtension(EXT_ID)!
  const api = ext.exports as Api
  const before = api.getState()
  await vscode.commands.executeCommand('dsh-tui-vscode.focus')
  const after = api.getState()
  assert.equal(after.pid, before.pid, 'focus must not restart the session')
})

export async function run(): Promise<void> {
  console.log(`[e2e] running ${tests.length} tests`)
  // Inject the fake launcher dir into PATH so the bare command
  // 'fake-dsh-tui' resolves to the shim for every session launch.
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
    await vscode.commands.executeCommand('dsh-tui-vscode.kill')
  }
}