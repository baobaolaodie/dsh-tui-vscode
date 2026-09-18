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
  createSendOnceGate,
  normalizeTerminalLocation,
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

// 回归锁:createSendOnceGate 防「双发启动命令」。实测场景:shell integration
// 晚于 1.2s 回退到达(慢 PowerShell profile)或再次触发时,旧实现把启动命令
// 第二次敲进已运行的 dsh-tui 输入框并被尾随回车提交。
test('send-once gate delivers exactly once no matter how many signals fire', () => {
  let deliveries = 0
  const gate = createSendOnceGate(() => {
    deliveries += 1
  })
  gate.trySend() // fallback wins the race
  gate.trySend() // late shell-integration event — must be a no-op
  gate.trySend()
  assert.equal(deliveries, 1)
  assert.equal(gate.sent, true)
})

test('send-once gate: integration-first suppresses the later fallback', () => {
  let deliveries = 0
  const gate = createSendOnceGate(() => {
    deliveries += 1
  })
  gate.trySend() // integration arrives first
  gate.trySend() // fallback timer fires afterwards — must be a no-op
  assert.equal(deliveries, 1)
})

test('send-once gate: throwing deliver still counts as sent (no resurrect)', () => {
  let attempts = 0
  const gate = createSendOnceGate(() => {
    attempts += 1
    throw new Error('terminal closed')
  })
  gate.trySend()
  gate.trySend()
  assert.equal(attempts, 1, 'failed delivery must not be retried by late signals')
  assert.equal(gate.sent, true)
})

// 终端位置归一化:editor(默认,历史行为)/active/panel;空值、未知值、
// 大小写/空白差异一律安全回退到 editor,保证配置打错也不影响启动路径。
test('normalizeTerminalLocation maps the setting to a placement kind', () => {
  assert.equal(normalizeTerminalLocation(undefined), 'editor')
  assert.equal(normalizeTerminalLocation(''), 'editor')
  assert.equal(normalizeTerminalLocation('editor'), 'editor')
  assert.equal(normalizeTerminalLocation('active'), 'active')
  assert.equal(normalizeTerminalLocation('panel'), 'panel')
  assert.equal(normalizeTerminalLocation(' PANEL '), 'panel') // trim + case-insensitive
  assert.equal(normalizeTerminalLocation('beside'), 'editor') // unknown → safe default
})