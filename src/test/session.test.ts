import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveLaunchCommand, quoteLaunchPath } from '../session.js'

test('resolveLaunchCommand finds .cmd/.bat/.exe on Windows PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-launch-win-'))
  try {
    writeFileSync(join(dir, 'dsh-tui.cmd'), '@echo off\r\n')
    writeFileSync(join(dir, 'tool.exe'), '')
    const original = process.env.PATH
    process.env.PATH = dir
    try {
      assert.equal(resolveLaunchCommand('dsh-tui', true), join(dir, 'dsh-tui.cmd'))
      assert.equal(resolveLaunchCommand('tool', true), join(dir, 'tool.exe'))
      // Already path-like → left to the shell.
      assert.equal(resolveLaunchCommand('C:\\bin\\dsh-tui.cmd', true), undefined)
      assert.equal(resolveLaunchCommand('dsh-tui', false), undefined) // POSIX search doesn't match .cmd
    } finally {
      process.env.PATH = original
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveLaunchCommand finds executable files on POSIX PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-launch-posix-'))
  try {
    const exe = join(dir, 'dsh-tui')
    writeFileSync(exe, '#!/bin/sh\n')
    chmodSync(exe, 0o755)
    writeFileSync(join(dir, 'not-exec'), '')
    const original = process.env.PATH
    process.env.PATH = dir
    try {
      assert.equal(resolveLaunchCommand('dsh-tui', false), exe)
      // X_OK filtering is only meaningful on POSIX (Windows passes it for
      // any file); the real check runs on Linux CI.
      if (process.platform !== 'win32') {
        assert.equal(resolveLaunchCommand('not-exec', false), undefined)
      }
      assert.equal(resolveLaunchCommand('/usr/bin/dsh-tui', false), undefined)
      // Windows search doesn't match an extensionless file.
      assert.equal(resolveLaunchCommand('dsh-tui', true), undefined)
    } finally {
      process.env.PATH = original
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('quoteLaunchPath quotes only when needed', () => {
  assert.equal(quoteLaunchPath('/usr/local/bin/dsh-tui', false), '/usr/local/bin/dsh-tui')
  assert.equal(quoteLaunchPath("C:\\Program Files\\dsh-tui.cmd", true), "& 'C:\\Program Files\\dsh-tui.cmd'")
  assert.equal(quoteLaunchPath('/opt/my tools/dsh-tui', false), "'/opt/my tools/dsh-tui'")
})