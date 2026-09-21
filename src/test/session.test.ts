import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveLaunchCommand,
  quoteShellArg,
  detectShellKind,
  formatLaunchPath,
  createSendOnceGate,
  formatWorkspaceTargetArg,
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

// 回归锁(issue #25):Nushell 不是 bash——它的单引号字符串既不支持转义、也不能
// 内含单引号,所以 POSIX 那套拼法在它这里无效;更关键的是 Windows 下会被
// windowsPathToPosix 改写成 `/c/Users/...` 形态,真实 nu 拒绝执行。原先
// `detectShellKind` 用 `base.includes('nu')` 把 nu 吞进 bash,上述两条就都发生了。
test('detectShellKind recognizes Nushell as its own kind (issue #25)', () => {
  assert.equal(detectShellKind('nu'), 'nu')
  assert.equal(detectShellKind('nu.exe'), 'nu')
  assert.equal(detectShellKind('C:\\tools\\nu.exe'), 'nu')
  assert.equal(detectShellKind('/usr/bin/nu'), 'nu')
  assert.equal(detectShellKind('nushell'), 'nu')
  // 精确匹配:旧实现 base.includes('nu') 会把任何含 "nu" 的名字算进 bash 家族
  assert.equal(detectShellKind('nushell-wrapper'), 'unknown')
  // **顺序相关**(CodeRabbit review):cygwin 那条测的是**整条路径**
  // (`value.includes('cygwin')`),nu 的检查必须排在它之前,否则一个名字完全正确的
  // C:\cygwin64\bin\nu.exe 会被报成 cygwin。
  assert.equal(detectShellKind('C:\\cygwin64\\bin\\nu.exe'), 'nu')
  assert.equal(detectShellKind('C:\\cygwin64\\bin\\nushell.exe'), 'nu')
  // wsl 那条测的是 **basename**(`base.includes('wsl')`,而 base 在这里是 nu.exe),
  // 对 nu 的名字天然不命中——这两条**不锁顺序**,只锁「装在别的目录下依然是 nu」。
  assert.equal(detectShellKind('C:\\wsl\\bin\\nu.exe'), 'nu')
  assert.equal(detectShellKind('C:\\wsl\\bin\\nushell.exe'), 'nu')
})

// Nushell 不能进 isBashLike,但**后果不是**「解析到无扩展名 shim」——npm 总是同时
// 写 `dsh-tui` / `dsh-tui.cmd` / `dsh-tui.ps1`,而 nu 会自己补扩展名,有 `.cmd`
// 兄弟时无扩展名形态照样能跑(第二轮独立审查用真实 nu 实测)。**真正的破坏来自
// windowsPathToPosix**:把 `C:\Users\...` 改写成 `/c/Users/...`,那个 nu 才拒绝。
// 这一条与下面那条 Windows 形态测试共同守住「nu 不被 POSIX 改写」这个不变量。
test('resolveLaunchCommand picks .cmd for Nushell on Windows (issue #25)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-launch-nu-'))
  try {
    writeFileSync(join(dir, 'dsh-tui'), '#!/bin/sh\n')
    writeFileSync(join(dir, 'dsh-tui.cmd'), '@echo off\r\n')
    const original = process.env.PATH
    process.env.PATH = dir
    try {
      assert.equal(resolveLaunchCommand('dsh-tui', true, 'nu'), join(dir, 'dsh-tui.cmd'))
      // 对照:bash-like 仍优先无扩展名 shim
      assert.equal(resolveLaunchCommand('dsh-tui', true, 'bash'), join(dir, 'dsh-tui'))
    } finally {
      process.env.PATH = original
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Nushell launch path always carries the ^ sigil (issue #25)', () => {
  // 命令位:无论值是否需要引用都加 `^`。这不是「否则必然失败」——Nushell 的 `^`
  // 做的是同名消歧,裸写的普通命令名同样能跑;无条件加是因为与内建撞名的可能性
  // 无法在拼串时判定,而多一个 `^` 没有代价。
  assert.equal(formatLaunchPath('/usr/bin/dsh-tui', 'nu', false), '^/usr/bin/dsh-tui')
  assert.equal(
    formatLaunchPath('/opt/my tools/dsh-tui', 'nu', false),
    "^r#'/opt/my tools/dsh-tui'#",
  )
})

test('Nushell quoting uses raw strings, not POSIX splicing (issue #25)', () => {
  // Nushell 的单引号字符串不能内含单引号,也没有 '\'' 拼接;raw string 原样保真
  assert.equal(quoteShellArg("/opt/it's/dsh-tui", 'nu'), "r#'/opt/it's/dsh-tui'#")
  assert.equal(quoteShellArg('/opt/my tools/dsh-tui', 'nu'), "r#'/opt/my tools/dsh-tui'#")
  // 含 '# 序列时加长分隔符,避免字面量提前闭合
  assert.equal(quoteShellArg("/opt/a'#b", 'nu'), "r##'/opt/a'#b'##")
  // 参数位:引用但不加 ^(位置参数不是命令)
  assert.equal(formatWorkspaceTargetArg('/opt/my tools', 'nu'), " r#'/opt/my tools'#")
})

// issue #25 的**真正不变量**:nu 的路径不做 POSIX 改写。若有人把 nu 归进
// isBashLike,windowsPathToPosix 会把 `C:\Users\...` 变成 `/c/Users/...`,而那正是
// 真实 nu 拒绝执行的形态。此前所有 nu 用例都用 POSIX 路径 + isWindows=false,这一
// 层完全没有覆盖——第二轮独立审查指出:这样的回归会让 128 条测试全绿,而 Windows
// 的 nu 用户(本 PR 的目标人群)全坏。
test('Nushell paths are never rewritten to POSIX form on Windows (issue #25)', () => {
  assert.equal(
    formatLaunchPath('C:\\Users\\u\\AppData\\Roaming\\npm\\dsh-tui.cmd', 'nu', true),
    '^C:\\Users\\u\\AppData\\Roaming\\npm\\dsh-tui.cmd',
  )
  assert.equal(formatWorkspaceTargetArg('D:\\My Repos', 'nu'), " r#'D:\\My Repos'#")
  // 对照:bash-like 确实会改写(既有行为,不受本 PR 影响)
  assert.equal(
    formatLaunchPath('C:\\Users\\u\\AppData\\Roaming\\npm\\dsh-tui', 'bash', true),
    '/c/Users/u/AppData/Roaming/npm/dsh-tui',
  )
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

// 回归锁(issue #21 第 1 条):路径里的 shell 元字符必须被引用并转义。
// 旧实现以「是否含空格」为加引号的判据,/tmp/repo;id 会作为两条命令抵达
// shell(id 被单独执行);内嵌引号还能提前闭合字面量。
test('paths with shell metacharacters are quoted and escaped (issue #21)', () => {
  // 分号/& 在安全集之外 → 必须引用,哪怕没有空格
  assert.equal(formatWorkspaceTargetArg('/tmp/repo;id', 'bash'), " '/tmp/repo;id'")
  assert.equal(formatWorkspaceTargetArg('/tmp/repo&calc', 'powershell'), " '/tmp/repo&calc'")
  assert.equal(formatWorkspaceTargetArg('C:\\repo&calc', 'cmd'), ' "C:\\repo&calc"')
  // 内嵌引号按 shell 各自转义,不能提前闭合
  assert.equal(formatWorkspaceTargetArg("/tmp/it's", 'bash'), " '/tmp/it'\\''s'")
  assert.equal(formatWorkspaceTargetArg("/tmp/it's", 'powershell'), " '/tmp/it''s'")
  assert.equal(formatWorkspaceTargetArg('C:\\it"s', 'cmd'), ' "C:\\it""s"')
  // 普通路径不受影响:安全集内的字符不加引号(既有行为不变)
  assert.equal(formatWorkspaceTargetArg('/tmp/repo', 'bash'), ' /tmp/repo')
  assert.equal(formatWorkspaceTargetArg('D:\\repo', 'powershell'), ' D:\\repo')
})

test('formatLaunchPath escapes metacharacters too', () => {
  assert.equal(formatLaunchPath('/tmp/dsh-tui;id', 'bash', false), "'/tmp/dsh-tui;id'")
  assert.equal(formatLaunchPath('/tmp/dsh-tui$HOME', 'bash', false), "'/tmp/dsh-tui$HOME'")
  // 安全集内 → 不加引号(既有断言在这条路径上不受影响)
  assert.equal(formatLaunchPath('/usr/local/bin/dsh-tui', 'bash', false), '/usr/local/bin/dsh-tui')
})

test('quoteShellArg escapes each shell’s own quote character', () => {
  assert.equal(quoteShellArg("a'b", 'bash'), `'a'\\''b'`)
  assert.equal(quoteShellArg("a'b", 'powershell'), `'a''b'`)
  assert.equal(quoteShellArg('a"b', 'cmd'), '"a""b"')
  assert.equal(quoteShellArg('plain', 'bash'), "'plain'")
})

// 回归锁(独立审查实测):`,` 与 `=` 看着像普通路径标点,却是 cmd.exe 的命令名
// 分词符——白名单化时漏掉的恰恰是这两个。真机对照:`C:\work\a,b\...` 被 cmd
// 从逗号处截断,报「不是内部或外部命令」;`a+b` 等对照组正常。触发场景很现实:
// Windows 账号名带逗号(C:\Users\Doe, John\AppData\Roaming\npm\...)。
test('cmd command-name metacharacters force quoting (issue #21 review)', () => {
  assert.equal(
    formatLaunchPath('C:\\work\\a,b\\dsh-tui.cmd', 'cmd', true),
    '"C:\\work\\a,b\\dsh-tui.cmd"',
  )
  assert.equal(
    formatLaunchPath('C:\\work\\a=b\\dsh-tui.cmd', 'cmd', true),
    '"C:\\work\\a=b\\dsh-tui.cmd"',
  )
  assert.equal(
    formatLaunchPath('C:\\work\\a,b\\dsh-tui.cmd', 'powershell', true),
    "& 'C:\\work\\a,b\\dsh-tui.cmd'",
  )
})

// 回归锁(Sourcery):POSIX 文件名可以含 `\`,而 bash 把它当转义符吃掉
// (/tmp/foo\bar → /tmp/foobar)。Windows 路径不受影响——windowsPathToPosix
// 在抵达 shell 之前就已经把它换成 `/` 了。
test('a literal backslash is never safe unquoted for bash-like shells', () => {
  assert.equal(formatLaunchPath('/tmp/foo\\bar', 'bash', false), "'/tmp/foo\\bar'")
  assert.equal(formatLaunchPath('/tmp/foo\\bar', 'wsl', false), "'/tmp/foo\\bar'")
  // Windows + bash-like:转换后已无反斜杠,仍走不加引号的快路径
  assert.equal(formatLaunchPath('D:\\repo\\dsh-tui', 'bash', true), '/d/repo/dsh-tui')
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
