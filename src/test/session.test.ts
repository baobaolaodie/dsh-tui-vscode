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
  formatWorkspaceTargetArg,
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

// 回归锁：@引用 missing 的根治。TUI 会话 cwd 默认爬到 git
// 仓库根（上游 issue #96），而扩展相对化基准是 workspaceFolders[0]——子目录
// 工作区必然不一致 → TUI join(cwd) 找不到文件 → missing 黄条。修复 = 启动命令
// 尾部追加工作区根位置参数：launcher 拦截后设 DSH_TUI_WORKSPACE_TARGET，上游
// plugin.ts resolve(绝对路径) 短路直取 → 会话 cwd = 工作区根，与扩展基准强一致。
test('formatWorkspaceTargetArg appends the workspace root as a positional arg', () => {
  const wsRoot = 'D:\\repo\\sub'
  // 常规 shell：空格分隔的裸路径（launcher 用 cmd shellQuote 语义拦截）。
  assert.equal(formatWorkspaceTargetArg(wsRoot, 'powershell'), ` ${wsRoot}`)
  assert.equal(formatWorkspaceTargetArg('C:\\repo', 'cmd'), ' C:\\repo')
  assert.equal(formatWorkspaceTargetArg('/home/u/repo', 'bash'), ' /home/u/repo')
})

test('formatWorkspaceTargetArg quotes paths with spaces per shell family', () => {
  const spaced = 'C:\\My Repos\\sub'
  // PowerShell / bash-like: single-quote string form. The arg lands AFTER the
  // command (positional), so the & call operator must NOT prefix it — `& 'path'`
  // here is a second use of & and PowerShell rejects it (ParserError), or when
  // it IS first treats the path as a command to invoke (CommandNotFound).
  assert.equal(formatWorkspaceTargetArg(spaced, 'powershell'), ` '${spaced}'`)
  // Windows drive paths take the bash mount form (formatLaunchPath precedent).
  assert.equal(formatWorkspaceTargetArg('D:\\My Repo', 'bash'), " '/d/My Repo'")
  assert.equal(formatWorkspaceTargetArg('D:\\My Repo', 'wsl'), " '/mnt/d/My Repo'")
  // POSIX roots stay literal (windowsPathToPosix passes them through).
  assert.equal(formatWorkspaceTargetArg('/home/u/My Repo', 'bash'), " '/home/u/My Repo'")
  // cmd: double-quote form (leading space separates it from the command).
  assert.equal(formatWorkspaceTargetArg(spaced, 'cmd'), ` "${spaced}"`)
  // EVERY branch carries the leading separator — the caller appends the arg
  // to `parts.join(' ')`, so a bare quoted literal would glue it to the
  // previous token (`dsh-tui'C:\My Repos'`) and the launch would not resolve.
  for (const shell of ['powershell', 'bash', 'cygwin', 'wsl'] as const) {
    assert.ok(
      formatWorkspaceTargetArg(spaced, shell).startsWith(' '),
      `${shell}: quoted form must keep its leading separator`,
    )
  }
})

test('formatWorkspaceTargetArg converts space-free Windows roots for bash-like shells', () => {
  // Space-free roots used to skip windowsPathToPosix entirely: bash then ate
  // the backslashes and the launcher received `D:repo` — the same failure
  // class 0.6.1 fixed for the launch path itself.
  assert.equal(formatWorkspaceTargetArg('D:\\repo', 'bash'), ' /d/repo')
  assert.equal(formatWorkspaceTargetArg('D:\\repo', 'wsl'), ' /mnt/d/repo')
  // cmd / powershell keep the Windows form (their shells speak it natively).
  assert.equal(formatWorkspaceTargetArg('D:\\repo', 'powershell'), ' D:\\repo')
  assert.equal(formatWorkspaceTargetArg('D:\\repo', 'cmd'), ' D:\\repo')
})

test('the assembled launch command keeps the workspace target a separate token', () => {
  // The real assembly (extension.ts) is `parts.join(' ') + targetArg`; assert
  // on the assembled string — a fragment-level assertion cannot catch the
  // glued-token failure (no extra args: `dsh-tui'/path'`).
  const assemble = (parts: readonly string[], target: string): string => parts.join(' ') + target
  assert.equal(
    assemble(['dsh-tui'], formatWorkspaceTargetArg('C:\\My Repos', 'powershell')),
    "dsh-tui 'C:\\My Repos'",
  )
  assert.equal(assemble(['dsh-tui'], formatWorkspaceTargetArg('D:\\repo', 'bash')), 'dsh-tui /d/repo')
  assert.equal(
    assemble(['dsh-tui', '--resume'], formatWorkspaceTargetArg('C:\\My Repos', 'bash')),
    "dsh-tui --resume '/c/My Repos'",
  )
  assert.equal(assemble(['dsh-tui'], formatWorkspaceTargetArg(undefined, 'cmd')), 'dsh-tui')
})

test('formatWorkspaceTargetArg returns empty string when no workspace is open', () => {
  assert.equal(formatWorkspaceTargetArg(undefined, 'powershell'), '')
  assert.equal(formatWorkspaceTargetArg('', 'cmd'), '')
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