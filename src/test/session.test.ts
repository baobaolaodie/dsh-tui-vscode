import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildLaunchEnv,
  buildTerminalPlan,
  resolveWindowsCommand,
  resolvePosixCommand,
  extractShimEntry,
} from '../session.js'

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
  const originalPath = process.env.PATH
  const emptyDir = mkdtempSync(join(tmpdir(), 'dsh-tui-empty-path-'))
  process.env.PATH = emptyDir // ensure no bare name accidentally resolves
  try {
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
  } finally {
    process.env.PATH = originalPath
    rmSync(emptyDir, { recursive: true, force: true })
  }
})

test('resolvePosixCommand resolves executable commands on PATH', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-posix-'))
  try {
    const cmd = join(dir, 'dsh-tui')
    writeFileSync(cmd, '#!/bin/sh\nexit 0\n')
    chmodSync(cmd, 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = dir
    try {
      assert.equal(resolvePosixCommand('dsh-tui'), cmd)
      // Non-executable or missing names stay unchanged.
      writeFileSync(join(dir, 'not-exec'), '#!/bin/sh\n')
      assert.equal(resolvePosixCommand('not-exec'), 'not-exec')
      assert.equal(resolvePosixCommand('missing-cmd'), 'missing-cmd')
    } finally {
      process.env.PATH = originalPath
    }
    assert.equal(resolvePosixCommand('/abs/bin/x'), '/abs/bin/x')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveWindowsCommand finds .cmd/.bat shims on PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-resolve-'))
  try {
    const shim = join(dir, 'dsh-tui.cmd')
    writeFileSync(shim, '@echo off\r\n')
    const originalPath = process.env.PATH
    process.env.PATH = dir
    try {
      const resolved = resolveWindowsCommand('dsh-tui')
      assert.equal(resolved, shim)
      // Bare .exe names without a shim stay unchanged (CreateProcess finds them).
      assert.equal(resolveWindowsCommand('node'), 'node')
    } finally {
      process.env.PATH = originalPath
    }
    // Path-like and explicit-extension commands pass through.
    assert.equal(resolveWindowsCommand('C:\\tools\\dsh-tui.cmd'), 'C:\\tools\\dsh-tui.cmd')
    assert.equal(resolveWindowsCommand('dsh-tui.exe'), 'dsh-tui.exe')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildTerminalPlan Windows resolves shims and passes args through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-plan-'))
  try {
    const shim = join(dir, 'dsh-tui.cmd')
    writeFileSync(shim, '@echo off\r\n')
    const originalPath = process.env.PATH
    process.env.PATH = dir
    try {
      assert.deepEqual(buildTerminalPlan({ resume: true, extraArgs: ['--lang', 'en'], isWindows: true }), {
        shellPath: shim,
        shellArgs: ['--resume', '--lang', 'en'],
      })
      // Absolute path commands pass through untouched.
      assert.deepEqual(
        buildTerminalPlan({ resume: false, command: 'C:\\Program Files\\dsh-tui.cmd', isWindows: true }),
        { shellPath: 'C:\\Program Files\\dsh-tui.cmd', shellArgs: [] },
      )
    } finally {
      process.env.PATH = originalPath
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildTerminalPlan Windows runs npm-style shims directly via node (no cmd wrapper)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-direct-'))
  try {
    const entry = join(dir, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'bin', 'dsh-tui.js')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '#!/usr/bin/env node\n')
    const shim = join(dir, 'dsh-tui.cmd')
    // The exact shape npm generates (incl. `title %COMSPEC%`).
    writeFileSync(
      shim,
      [
        '@ECHO off',
        ':start',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@deepseek-harness-tui\\dsh-tui\\bin\\dsh-tui.js" %*',
        '',
      ].join('\r\n'),
    )
    const fakeNode = join(dir, 'node.exe')
    writeFileSync(fakeNode, '')
    const originalPath = process.env.PATH
    process.env.PATH = dir
    try {
      assert.deepEqual(buildTerminalPlan({ resume: true, isWindows: true }), {
        shellPath: fakeNode,
        shellArgs: [entry, '--resume'],
      })
      assert.deepEqual(buildTerminalPlan({ resume: false, extraArgs: ['--lang', 'en'], isWindows: true }), {
        shellPath: fakeNode,
        shellArgs: [entry, '--lang', 'en'],
      })
    } finally {
      process.env.PATH = originalPath
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractShimEntry resolves %dp0% relative entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-extract-'))
  try {
    const entry = join(dir, 'node_modules', 'pkg', 'bin', 'cli.js')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '')
    const shim = join(dir, 'tool.cmd')
    writeFileSync(shim, `@ECHO off\r\n"node" "%dp0%\\node_modules\\pkg\\bin\\cli.js" %*\r\n`)
    assert.equal(extractShimEntry(shim), entry)
    // Absolute entry without %dp0%.
    const other = join(dir, 'other.js')
    writeFileSync(other, '')
    writeFileSync(shim, `@ECHO off\r\n"node" "${other}" %*\r\n`)
    assert.equal(extractShimEntry(shim), other)
    // No .js entry → undefined.
    writeFileSync(shim, '@ECHO off\r\nnot-a-shim\r\n')
    assert.equal(extractShimEntry(shim), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveWindowsCommand fallback keeps bare names when nothing matches', () => {
  const originalPath = process.env.PATH
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-empty-'))
  process.env.PATH = dir
  try {
    assert.equal(resolveWindowsCommand('dsh-tui'), 'dsh-tui')
    assert.ok(!existsSync(join(dir, 'dsh-tui.cmd')))
  } finally {
    process.env.PATH = originalPath
    rmSync(dir, { recursive: true, force: true })
  }
})