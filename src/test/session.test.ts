import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLaunchEnv, buildTerminalPlan, quoteCmdArg } from '../session.js'

test('buildLaunchEnv sets DSH_TUI_LANG when lang provided', () => {
  // injectEditor is on by default, so VISUAL also appears unless disabled.
  assert.deepEqual(buildLaunchEnv({ lang: 'zh', injectEditor: false }), { DSH_TUI_LANG: 'zh' })
  assert.deepEqual(buildLaunchEnv({ lang: ' en ', injectEditor: false }), { DSH_TUI_LANG: 'en' })
  assert.deepEqual(buildLaunchEnv({ lang: '', injectEditor: false }), {})
  assert.deepEqual(buildLaunchEnv({ lang: 'zh' }), { DSH_TUI_LANG: 'zh', VISUAL: 'code -w' })
})

test('buildLaunchEnv injects VISUAL only when both VISUAL and EDITOR are unset', () => {
  assert.deepEqual(buildLaunchEnv({ base: {} }), { VISUAL: 'code -w' })
  assert.deepEqual(buildLaunchEnv({ base: { VISUAL: 'nvim' } }), {})
  assert.deepEqual(buildLaunchEnv({ base: { EDITOR: 'notepad' } }), {})
  assert.deepEqual(
    buildLaunchEnv({ base: {}, editorCommand: 'code --wait' }),
    { VISUAL: 'code --wait' },
  )
  assert.deepEqual(buildLaunchEnv({ base: {}, injectEditor: false }), {})
})

test('buildLaunchEnv merges with lang and respects base language var', () => {
  const env = buildLaunchEnv({ base: { LANGUAGE: 'en_US' }, lang: 'en' })
  assert.deepEqual(env, { DSH_TUI_LANG: 'en', VISUAL: 'code -w' })
})

test('buildLaunchEnv exports DSH_HOME only when dshHome is set', () => {
  assert.deepEqual(buildLaunchEnv({ dshHome: '', injectEditor: false }), {})
  assert.deepEqual(buildLaunchEnv({ dshHome: 'C:\\my-dsh', injectEditor: false }), {
    DSH_HOME: 'C:\\my-dsh',
  })
  assert.deepEqual(buildLaunchEnv({ dshHome: ' /data/dsh ', lang: 'en' }), {
    DSH_HOME: '/data/dsh',
    DSH_TUI_LANG: 'en',
    VISUAL: 'code -w',
  })
})

test('buildLaunchEnv dshHome overrides an inherited DSH_HOME', () => {
  const env = buildLaunchEnv({ base: { DSH_HOME: 'C:\\old' }, dshHome: 'C:\\new', injectEditor: false })
  assert.deepEqual(env, { DSH_HOME: 'C:\\new' })
})

test('buildTerminalPlan non-Windows uses the command directly', () => {
  assert.deepEqual(buildTerminalPlan({ resume: false }), { shellPath: 'dsh-tui', shellArgs: [] })
  assert.deepEqual(buildTerminalPlan({ resume: true }), {
    shellPath: 'dsh-tui',
    shellArgs: ['--resume'],
  })
  assert.deepEqual(buildTerminalPlan({ resume: true, extraArgs: ['--lang', 'en'] }), {
    shellPath: 'dsh-tui',
    shellArgs: ['--resume', '--lang', 'en'],
  })
  assert.deepEqual(buildTerminalPlan({ resume: false, command: '  ' }), {
    shellPath: 'dsh-tui',
    shellArgs: [],
  })
  assert.deepEqual(buildTerminalPlan({ resume: false, command: '/opt/bin/dsh-tui' }), {
    shellPath: '/opt/bin/dsh-tui',
    shellArgs: [],
  })
  // POSIX spawns through argv, so a spaced path needs no quoting.
  assert.deepEqual(buildTerminalPlan({ resume: false, command: '/opt/my tools/dsh-tui' }), {
    shellPath: '/opt/my tools/dsh-tui',
    shellArgs: [],
  })
})

test('buildTerminalPlan Windows routes .cmd shims through cmd.exe', () => {
  const plan = buildTerminalPlan({
    resume: true,
    extraArgs: ['--lang', 'en'],
    isWindows: true,
    cmdExe: 'C:\\Windows\\System32\\cmd.exe',
  })
  assert.equal(plan.shellPath, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(plan.shellArgs, ['/d', '/s', '/c', 'dsh-tui --resume --lang en'])
})

test('buildTerminalPlan Windows quotes a command path with spaces', () => {
  const plan = buildTerminalPlan({
    resume: false,
    command: 'C:\\Program Files\\dsh-tui.cmd',
    isWindows: true,
    cmdExe: 'cmd.exe',
  })
  // The classic cmd pattern: brace the quoted executable in an extra pair of
  // quotes so `cmd /d /s /c` strips the outer pair and re-parses the inner
  // one. Empirically verified by spawning cmd.exe directly with verbatim
  // (node-pty/ConPTY-style) argument joining — the same semantics VS Code's
  // terminal backend uses on Windows.
  assert.deepEqual(plan.shellArgs, ['/d', '/s', '/c', '""C:\\Program Files\\dsh-tui.cmd""'])
})

test('quoteCmdArg quotes only when needed', () => {
  assert.equal(quoteCmdArg('dsh-tui'), 'dsh-tui')
  assert.equal(quoteCmdArg(''), '""')
  assert.equal(quoteCmdArg('C:\\Program Files\\x.cmd'), '"C:\\Program Files\\x.cmd"')
  assert.equal(quoteCmdArg('a"b'), '"a""b"')
  assert.equal(quoteCmdArg('a&b'), '"a&b"')
  assert.equal(quoteCmdArg('a|b'), '"a|b"')
})