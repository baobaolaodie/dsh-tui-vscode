/**
 * Real-extension-host test suite (run via @vscode/test-electron).
 *
 * Exercises the extension exactly as a user would: activation, command
 * registration, launching a session terminal with env injection, dedupe,
 * --resume, the terminal-link provider (with a REAL Terminal object) and
 * kill/focus. The fake launcher script replaces `dsh-tui` so no DSH
 * installation or credentials are needed.
 */
import * as vscode from 'vscode'
import { strict as assert } from 'node:assert'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createTerminalLinkProvider } from '../terminal-links.js'
import type { FileLink } from '../links.js'

const EXT_ID = 'baobaolaodie.dsh-tui-vscode'
const TERM_NAME = 'dsh-tui'
// out-test/test-suite -> repo root -> .e2e-workspace
const WS = join(__dirname, '..', '..', '.e2e-workspace')
const ENV_OUT = join(WS, 'env-out.txt')

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

function tuiTerminals(): vscode.Terminal[] {
  return vscode.window.terminals.filter(terminal => {
    const opts = terminal.creationOptions as Readonly<{ name?: string }> | undefined
    return !!opts && opts.name === TERM_NAME
  })
}

/** Wait for the fake launcher to have written its real environment. */
async function readEnvOut(): Promise<string[]> {
  return (await poll(() => {
    try {
      return readFileSync(ENV_OUT, 'utf8')
    } catch {
      return undefined
    }
  }, 15000)).trim().split(/\r?\n/).map(line => line.trim())
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
    'dsh-tui-vscode.start',
    'dsh-tui-vscode.resume',
    'dsh-tui-vscode.focus',
    'dsh-tui-vscode.kill',
  ]) {
    assert.ok(cmds.includes(id), `command ${id} not registered`)
  }
})

test('start launches a session terminal with env injection', async () => {
  const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
  const launcher = join(WS, process.platform === 'win32' ? 'fake-dsh-tui.cmd' : 'fake-dsh-tui.sh')
  await cfg.update('command', launcher, vscode.ConfigurationTarget.Global)
  await cfg.update('lang', 'zh', vscode.ConfigurationTarget.Global)
  await cfg.update('dshHome', 'C:\\e2e-home', vscode.ConfigurationTarget.Global)

  // The injection logic intentionally respects an EXISTING $VISUAL/$EDITOR.
  // Simulate a plain user (neither set) so the inject path is exercised.
  console.log(
    `[e2e] host env before: VISUAL=${JSON.stringify(process.env.VISUAL)} EDITOR=${JSON.stringify(process.env.EDITOR)}`,
  )
  delete process.env.VISUAL
  delete process.env.EDITOR

  rmSync(ENV_OUT, { force: true })
  await vscode.commands.executeCommand('dsh-tui-vscode.start')
  assert.equal(tuiTerminals().length, 1, 'expected exactly one dsh-tui terminal')

  // Ground truth: the fake launcher echoes its OWN process environment.
  const lines = await readEnvOut()
  assert.ok(lines.includes('VISUAL=code -w'), `VISUAL missing: ${lines.join(' | ')}`)
  assert.ok(lines.includes('DSH_TUI_LANG=zh'), `DSH_TUI_LANG missing: ${lines.join(' | ')}`)
  assert.ok(lines.includes('DSH_HOME=C:\\e2e-home'), `DSH_HOME missing: ${lines.join(' | ')}`)
})

test('start dedupes the session terminal', async () => {
  await vscode.commands.executeCommand('dsh-tui-vscode.start')
  assert.equal(tuiTerminals().length, 1, 'start must reuse the existing terminal')
})

test('resume relaunches with --resume once the session is gone', async () => {
  for (const terminal of tuiTerminals()) terminal.dispose()
  await poll(() => tuiTerminals().length === 0, 5000)
  await sleep(400) // let onDidCloseTerminal settle inside the extension
  rmSync(ENV_OUT, { force: true })
  await vscode.commands.executeCommand('dsh-tui-vscode.resume')
  assert.equal(tuiTerminals().length, 1)
  // The fake launcher re-writes its env/args file on every launch.
  const lines = await readEnvOut()
  assert.ok(lines.some(l => l.includes('ARGS=') && l.includes('--resume')), `--resume missing: ${lines.join(' | ')}`)
})

test('link provider works against a real terminal', async () => {
  const terminal = tuiTerminals()[0]
  assert.ok(terminal, 'no session terminal to test against')
  const target = join(WS, 'hello.ts')

  let opened: FileLink | undefined
  const provider = createTerminalLinkProvider({
    isOwnTerminal: () => true,
    openPath: link => {
      opened = link
    },
  })
  const line = `see ${target}:2 more`
  const links = (await provider.provideTerminalLinks(
    { terminal, line } as vscode.TerminalLinkContext,
    new vscode.CancellationTokenSource().token,
  )) ?? []
  assert.equal(links.length, 1, 'expected one link')
  assert.equal(links[0].startIndex, 4, 'link must start after "see "')
  assert.equal(links[0].length, (target + ':2').length)
  assert.ok(links[0].tooltip?.startsWith(target))
  provider.handleTerminalLink(links[0])
  assert.equal(opened?.path, target)
  assert.equal(opened?.line, 2)

  // Non-owned terminals get no links at all.
  const stranger = createTerminalLinkProvider({ isOwnTerminal: () => false, openPath: () => {} })
  assert.equal(
    await stranger.provideTerminalLinks(
      { terminal, line } as vscode.TerminalLinkContext,
      new vscode.CancellationTokenSource().token,
    ),
    undefined,
  )
  // Plain prose yields an empty list.
  assert.deepEqual(
    await provider.provideTerminalLinks(
      { terminal, line: 'nothing to see here' } as vscode.TerminalLinkContext,
      new vscode.CancellationTokenSource().token,
    ),
    [],
  )
})

test('kill terminates the running session terminal', async () => {
  // Ensure a live session (fake launcher sleeps ~60s).
  await vscode.commands.executeCommand('dsh-tui-vscode.start')
  const terms = tuiTerminals()
  assert.equal(terms.length, 1)
  const target = terms[0]
  await vscode.commands.executeCommand('dsh-tui-vscode.kill')
  await poll(
    () => {
      const still = tuiTerminals().find(t => t === target)
      return still === undefined || still.exitStatus !== undefined ? true : undefined
    },
    8000,
    200,
  )
})

test('focus starts a session when none is running', async () => {
  const alive = tuiTerminals().filter(t => t.exitStatus === undefined)
  if (alive.length === 0) {
    await vscode.commands.executeCommand('dsh-tui-vscode.focus')
    assert.equal(tuiTerminals().length, 1, 'focus must start a session')
  }
})

export async function run(): Promise<void> {
  console.log(`[e2e] running ${tests.length} tests`)
  try {
    for (const [name, fn] of tests) {
      await fn()
      console.log(`[e2e] PASS ${name}`)
    }
    console.log(`[e2e] all ${tests.length} tests passed`)
  } finally {
    // Restore settings and clean up terminals so the run is idempotent.
    const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
    await cfg.update('command', 'dsh-tui', vscode.ConfigurationTarget.Global)
    await cfg.update('lang', '', vscode.ConfigurationTarget.Global)
    await cfg.update('dshHome', '', vscode.ConfigurationTarget.Global)
    for (const terminal of tuiTerminals()) terminal.dispose()
  }
}