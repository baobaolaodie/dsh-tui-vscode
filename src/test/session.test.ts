import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveLaunchCommand,
  quoteLaunchPath,
  detectShellKind,
  formatLaunchPath,
} from '../session.js'

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

test('resolveLaunchCommand prefers npm bash shim for bash-like Windows shells', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-launch-bash-win-'))
  try {
    writeFileSync(join(dir, 'dsh-tui'), '#!/bin/sh\n')
    writeFileSync(join(dir, 'dsh-tui.cmd'), '@echo off\r\n')
    writeFileSync(join(dir, 'dsh-tui.ps1'), '')
    const original = process.env.PATH
    process.env.PATH = dir
    try {
      assert.equal(resolveLaunchCommand('dsh-tui', true), join(dir, 'dsh-tui.cmd'))
      assert.equal(resolveLaunchCommand('dsh-tui', true, 'bash'), join(dir, 'dsh-tui'))
      assert.equal(resolveLaunchCommand('dsh-tui', true, 'cygwin'), join(dir, 'dsh-tui'))
      assert.equal(resolveLaunchCommand('dsh-tui', true, 'wsl'), join(dir, 'dsh-tui'))
      assert.equal(resolveLaunchCommand('dsh-tui', true, 'powershell'), join(dir, 'dsh-tui.cmd'))
    } finally {
      process.env.PATH = original
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectShellKind recognizes PowerShell, cmd, Git Bash, and WSL', () => {
  assert.equal(detectShellKind('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'powershell')
  assert.equal(detectShellKind('pwsh'), 'powershell')
  assert.equal(detectShellKind('C:\\Windows\\System32\\cmd.exe'), 'cmd')
  assert.equal(detectShellKind('C:\\Program Files\\Git\\bin\\bash.exe'), 'bash')
  assert.equal(detectShellKind('gitbash'), 'bash')
  assert.equal(detectShellKind('C:\\cygwin64\\bin\\bash.exe'), 'cygwin')
  assert.equal(detectShellKind('C:\\Windows\\System32\\wsl.exe'), 'wsl')
  assert.equal(detectShellKind('C:\\Windows\\System32\\bash.exe'), 'wsl')
  assert.equal(detectShellKind(undefined), 'unknown')
})

test('formatLaunchPath converts Windows paths for bash-like shells', () => {
  assert.equal(
    formatLaunchPath('C:\\Users\\admin\\AppData\\Roaming\\npm\\dsh-tui', 'bash', true),
    '/c/Users/admin/AppData/Roaming/npm/dsh-tui',
  )
  assert.equal(
    formatLaunchPath('C:\\Users\\admin\\AppData\\Roaming\\npm\\dsh-tui', 'cygwin', true),
    '/cygdrive/c/Users/admin/AppData/Roaming/npm/dsh-tui',
  )
  assert.equal(
    formatLaunchPath('C:\\Users\\admin\\AppData\\Roaming\\npm\\dsh-tui', 'wsl', true),
    '/mnt/c/Users/admin/AppData/Roaming/npm/dsh-tui',
  )
  assert.equal(
    formatLaunchPath('C:\\Program Files\\dsh-tui', 'bash', true),
    "'/c/Program Files/dsh-tui'",
  )
  assert.equal(
    formatLaunchPath('C:\\Program Files\\dsh-tui.cmd', 'powershell', true),
    "& 'C:\\Program Files\\dsh-tui.cmd'",
  )
  assert.equal(
    formatLaunchPath('C:\\Program Files\\dsh-tui.cmd', 'cmd', true),
    '"C:\\Program Files\\dsh-tui.cmd"',
  )
  assert.equal(formatLaunchPath('/usr/local/bin/dsh-tui', 'bash', false), '/usr/local/bin/dsh-tui')
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