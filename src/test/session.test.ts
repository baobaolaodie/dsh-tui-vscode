import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'
import {
  resolveLaunchCommand,
  quoteShellArg,
  detectShellKind,
  formatLaunchPath,
  createSendOnceGate,
  formatWorkspaceTargetArg,
  normalizeTerminalLocation,
  normalizeTerminalImageProtocol,
  resolveTerminalImageProtocol,
  resolveTerminalImageCapability,
  buildLaunchEnv,
  type TerminalImageProtocol,
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
// 真实 nu 拒绝执行的形态(实测该形态 exit=1)。
//
// 补的是哪个缺口(第三轮独立审查实测):把 isBashLike 放行 nu 后失败的只有本测试与
// `resolveLaunchCommand picks .cmd` 两条——后者只守着 resolveLaunchCommand 那条
// 路径,而 formatLaunchPath / formatWorkspaceTargetArg 这两处 isBashLike 门当时没
// 有任何断言。本测试补的正是这两处。
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

// 终端图像协议门禁(DESIGN D1/D2):宿主能力(terminal.integrated.enableImages)
// × 用户偏好(dsh-tui-vscode.imageProtocol) → 决定注入哪个 DSH_TUI_IMAGE_PROTOCOL。
// 核心不变量:没有渲染器时绝不走真图分支——那会得到"槽位全空"(既非图也非字符画),
// 是本 change 要根除的最差结果;'auto' 则是"交回 dsh-tui 自行判定"的退出路径,
// 必须**完全不注入该键**。
test('resolveTerminalImageProtocol gates the default sixel choice on the host capability', () => {
  // 默认偏好(不传 / 显式 'sixel')× 宿主能力两种取值 = AC-1 / AC-2
  for (const preference of [undefined, 'sixel'] as const) {
    assert.equal(resolveTerminalImageProtocol(preference, true), 'sixel', `preference=${preference} on`)
    assert.equal(resolveTerminalImageProtocol(preference, false), 'none', `preference=${preference} off`)
  }
  // 读不到该配置(undefined)按"没有渲染器"处理:宁可字符画,绝不空白
  assert.equal(resolveTerminalImageProtocol(undefined, undefined), 'none')
})

test('resolveTerminalImageProtocol lets an explicit none override the host capability (AC-3)', () => {
  assert.equal(resolveTerminalImageProtocol('none', true), 'none')
  assert.equal(resolveTerminalImageProtocol('none', false), 'none')
})

test('resolveTerminalImageProtocol yields nothing for auto (AC-4)', () => {
  assert.equal(resolveTerminalImageProtocol('auto', true), undefined)
  assert.equal(resolveTerminalImageProtocol('auto', false), undefined)
})

test('an unrecognized preference still lands on the capability gate', () => {
  // 取值来自用户 VS Code 配置(JSON),TS 的联合类型管不到运行时:未知值必须走
  // 与默认分支相同的安全出口——有能力 sixel / 无能力 none——绝不原样注入未知字符串。
  const unknown = 'kitty' as TerminalImageProtocol
  assert.equal(resolveTerminalImageProtocol(unknown, true), 'sixel')
  assert.equal(resolveTerminalImageProtocol(unknown, false), 'none')
})

test('buildLaunchEnv injects DSH_TUI_IMAGE_PROTOCOL per the host capability gate (AC-1 / AC-2)', () => {
  assert.equal(
    buildLaunchEnv({ lang: 'zh', imageProtocol: 'sixel', hostImagesEnabled: true }).DSH_TUI_IMAGE_PROTOCOL,
    'sixel',
  )
  assert.equal(
    buildLaunchEnv({ lang: 'zh', imageProtocol: 'sixel', hostImagesEnabled: false }).DSH_TUI_IMAGE_PROTOCOL,
    'none',
  )
  // 不传 imageProtocol 与显式 'sixel' 走同一条默认路径
  assert.equal(buildLaunchEnv({ hostImagesEnabled: true }).DSH_TUI_IMAGE_PROTOCOL, 'sixel')
  // 宿主能力未知(配置读取失败)同样退回 none
  assert.equal(buildLaunchEnv({}).DSH_TUI_IMAGE_PROTOCOL, 'none')
})

test('buildLaunchEnv keeps DSH_TUI_LANG untouched next to the new key (AC-6)', () => {
  const env = buildLaunchEnv({ base: {}, lang: 'zh', imageProtocol: 'sixel', hostImagesEnabled: true })
  assert.equal(env.DSH_TUI_LANG, 'zh')
  assert.equal(env.DSH_TUI_IMAGE_PROTOCOL, 'sixel')
  // 既有语义不变:lang 为空时不注入该键
  assert.ok(
    !Object.keys(buildLaunchEnv({ imageProtocol: 'sixel', hostImagesEnabled: true })).includes('DSH_TUI_LANG'),
  )
})

test('buildLaunchEnv keeps none when the user disabled images explicitly (AC-3)', () => {
  const env = buildLaunchEnv({ imageProtocol: 'none', hostImagesEnabled: true })
  assert.equal(env.DSH_TUI_IMAGE_PROTOCOL, 'none')
})

test('buildLaunchEnv never emits DSH_TUI_IMAGE_PROTOCOL for auto (AC-4)', () => {
  for (const hostImagesEnabled of [true, false]) {
    const env = buildLaunchEnv({ lang: 'zh', imageProtocol: 'auto', hostImagesEnabled })
    assert.ok(
      !Object.keys(env).includes('DSH_TUI_IMAGE_PROTOCOL'),
      `auto must not inject the key (hostImagesEnabled=${hostImagesEnabled}): ${JSON.stringify(env)}`,
    )
  }
  // extra 仍是 last-writer-wins 的显式覆盖通道(既有合并语义不变)
  assert.equal(
    buildLaunchEnv({ imageProtocol: 'auto', extra: { DSH_TUI_IMAGE_PROTOCOL: 'sixel' } })
      .DSH_TUI_IMAGE_PROTOCOL,
    'sixel',
  )
})

// F-3(REVIEW.md):门禁的输入必须是「本窗口启动时观察到的能力」,而不是配置布尔的
// 即时值。写完 terminal.integrated.enableImages 却不重载窗口时,本窗口里没有图像
// 渲染器,注入 sixel 会让 dsh-tui 擦掉半块字符画兜底 → 槽位永久空白——正是 US-3
// 要根除的现象。两条日常死路都收敛到 resolveTerminalImageCapability 这一个判定:
// ① 点「启用并重载窗口」后忽略二次重载提示;② 自己改 settings.json 但不重载。
test('resolveTerminalImageCapability only trusts a value observed at window start (F-3)', () => {
  // 启动时为假、此刻为真 =「写了设置但没重载」:不是能力,缺的是重载
  // (第三个观测是 gpuAcceleration:这里一律给 'auto',把本条聚焦在 enableImages 上)
  const pendingReload = resolveTerminalImageCapability(false, true, 'auto')
  assert.equal(pendingReload.hostImagesEnabled, false, 'pending reload must not count as a capability')
  assert.equal(pendingReload.offer, 'reloadWindow', 'pending reload must offer the reload')
  // 启动时为真且此刻仍为真 = 渲染器已随窗口加载:注入 sixel,不再打扰
  const effective = resolveTerminalImageCapability(true, true, 'auto')
  assert.equal(effective.hostImagesEnabled, true, 'a value present at window start is a capability')
  assert.equal(effective.offer, undefined, 'nothing left to offer once the renderer is loaded')
  // 此刻为假:走既有「启用并重载窗口」提示(用户选择 / 写失败后的重试路径)
  const off = resolveTerminalImageCapability(false, false, 'auto')
  assert.equal(off.hostImagesEnabled, false, 'an off setting is never a capability')
  assert.equal(off.offer, 'enableImages', 'an off setting offers the one-click enable')
  // 窗口运行期间被关掉:用户已明确不要图片,按「没有能力」处理(绝不空白)
  const turnedOff = resolveTerminalImageCapability(true, false, 'auto')
  assert.equal(turnedOff.hostImagesEnabled, false, 'a setting turned off mid-window is not a capability')
  assert.equal(turnedOff.offer, 'enableImages', 'turning it off falls back to the enable offer')
  // 读不到配置一律按「没有渲染器」处理
  const unreadable = resolveTerminalImageCapability(undefined, undefined, 'auto')
  assert.equal(unreadable.hostImagesEnabled, false, 'unreadable configuration is not a capability')
  assert.equal(unreadable.offer, 'enableImages', 'unreadable configuration keeps the enable offer')
})

// Sourcery ①:门禁此前只问「设置开了没」,而 VS Code 自己的定义写明 enableImages
// 「this will only work when terminal.integrated.gpuAcceleration is enabled」——
// gpuAcceleration 为 off(或旧版的 canvas 渲染器)时窗口建的是非 WebGL 渲染器,
// @xterm/addon-image 根本没有被加载,此时注入 sixel 必然又是空白槽位。故新增第三个
// 观测:只有 auto/on 才「可能」有 WebGL 渲染器,其余(含未知值/读不到)一律按
// 「没有渲染器」保守回退——字符画至少可见。
test('gpuAcceleration off/canvas removes the renderer the image addon needs (Sourcery ①)', () => {
  for (const gpuAcceleration of ['off', 'canvas'] as const) {
    const blocked = resolveTerminalImageCapability(true, true, gpuAcceleration)
    assert.equal(
      blocked.hostImagesEnabled,
      false,
      `gpuAcceleration=${gpuAcceleration} cannot load the image addon, so it is never a capability`,
    )
    // 没有任何一步能补上:写 enableImages 或重载窗口都不会让 addon 出现,所以不给引导
    assert.equal(
      blocked.offer,
      undefined,
      `gpuAcceleration=${gpuAcceleration} must not promise an enable/reload that cannot help`,
    )
    // 注入侧同一条出口:即使偏好是默认 sixel,也必须落 none(绝不空白)
    assert.equal(
      buildLaunchEnv({ imageProtocol: 'sixel', hostImagesEnabled: blocked.hostImagesEnabled })
        .DSH_TUI_IMAGE_PROTOCOL,
      'none',
      `gpuAcceleration=${gpuAcceleration} must fall back to the visible character art`,
    )
  }
  // auto(默认)/on:渲染器可能是 WebGL,保持既有行为不变
  for (const gpuAcceleration of ['auto', 'on'] as const) {
    const allowed = resolveTerminalImageCapability(true, true, gpuAcceleration)
    assert.equal(allowed.hostImagesEnabled, true, `gpuAcceleration=${gpuAcceleration} keeps the old behavior`)
    assert.equal(allowed.offer, undefined, `gpuAcceleration=${gpuAcceleration} has nothing to offer`)
  }
  // 读不到 / 未知取值同样按「没有渲染器」处理:宁可字符画,绝不空白
  for (const unreadable of [undefined, '', 'AUTO', 'webgl']) {
    const capability = resolveTerminalImageCapability(true, true, unreadable)
    assert.equal(
      capability.hostImagesEnabled,
      false,
      `an unreadable or unknown gpuAcceleration (${String(unreadable)}) is not a capability`,
    )
  }
})

test('an enableImages write that was never reloaded never reaches sixel (F-3)', () => {
  // 设置此刻为真(用户刚写入),而本窗口启动时为假(此后没有重载过)
  const capability = resolveTerminalImageCapability(false, true, 'auto')
  assert.equal(capability.hostImagesEnabled, false, 'a write without a reload is not a capability')
  // 门禁拿到的能力为假 → 即使配置为真也注入 none,绝不出现「注入 sixel 却无渲染器」
  assert.equal(
    buildLaunchEnv({ imageProtocol: 'sixel', hostImagesEnabled: capability.hostImagesEnabled })
      .DSH_TUI_IMAGE_PROTOCOL,
    'none',
  )
  // 默认偏好(不传 imageProtocol)走同一条出口
  assert.equal(
    buildLaunchEnv({ hostImagesEnabled: capability.hostImagesEnabled }).DSH_TUI_IMAGE_PROTOCOL,
    'none',
  )
})

// ---- F-5:枚举取值空间的绑定断言 ------------------------------------------
// 取值空间同形地写在三处(package.json 的 enum、session.ts 的 TerminalImageProtocol、
// extension.ts 的归一化白名单),REVIEW F-5 实测三者当前一致,却没有任何断言绑定:
// 将来加第四档(如上游修好 kitty 后加 kitty)时最可能的错法是只改 package.json——
// 设置界面出现新选项,运行期却被静默归一化回 sixel,CI 全绿。
// 下面把「类型」这一侧变成运行期可见的真源:Record<TerminalImageProtocol, true> 的
// 对象字面量必须**在编译期**穷尽该联合类型(少一个成员 → 缺少属性;多一个 → 多余
// 属性),再与 package.json 里实际声明的 enum / default 逐值比对。
const TERMINAL_IMAGE_PROTOCOLS: Record<TerminalImageProtocol, true> = {
  auto: true,
  sixel: true,
  none: true,
}

test('the package.json imageProtocol enum stays bound to TerminalImageProtocol (F-5)', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    contributes?: {
      configuration?: { properties?: Record<string, { enum?: string[]; default?: string }> }
    }
  }
  const declared = pkg.contributes?.configuration?.properties?.['dsh-tui-vscode.imageProtocol']
  const declaredEnum = declared?.enum ?? []
  assert.deepEqual(
    [...declaredEnum].sort(),
    Object.keys(TERMINAL_IMAGE_PROTOCOLS).sort(),
    'contributes.configuration enum must list exactly the TerminalImageProtocol values',
  )
  assert.ok(
    declaredEnum.includes(declared?.default ?? ''),
    `the declared default (${String(declared?.default)}) must be one of the enum values`,
  )
  // T-FIX-08 的 🟢 残留:归一化的兜底档(session.ts 里写死的 'sixel')与 package.json
  // 声明的 default 是同一决策的两处表达,前面几条只绑了「enum 的取值集合」和
  // 「default ∈ enum」——都不比较**哪一档是默认**。把 default 改成另一个合法档
  // (如 none)会全绿,而运行期遇到未知取值仍退到写死的那档。故未知值必须等于声明的
  // default;取不到 default 时先显式判负,不静默跳过。
  assert.ok(
    declared?.default,
    `package.json must declare a default for dsh-tui-vscode.imageProtocol (got ${String(declared?.default)})`,
  )
  assert.equal(
    normalizeTerminalImageProtocol('unknown-tier'),
    declared?.default,
    `an unknown tier must fall back to the declared default (${String(declared?.default)})`,
  )
})

// m-3:归一化是取值空间**唯一**的入口——设置可以是手写的 settings.json,也可能来自
// 未来加了档而运行期还没跟上的版本,所以未知值必须落安全档 sixel(再由能力门禁决定
// 注入与否,见 resolveTerminalImageProtocol),绝不把未知字符串原样送进启动路径。
test('normalizeTerminalImageProtocol keeps every known tier and defaults anything else to sixel (m-3)', () => {
  for (const known of ['auto', 'sixel', 'none'] as const) {
    assert.equal(normalizeTerminalImageProtocol(known), known, `the known tier ${known} must survive unchanged`)
  }
  // 空值 / 上游有而本扩展没有的档(kitty) / 大小写不同(设置是枚举选择器,只有精确值
  // 才算已知)一律落 sixel——这与 resolveTerminalImageProtocol 的未知值出口同档。
  for (const unknown of [undefined, '', 'kitty', 'AUTO']) {
    assert.equal(normalizeTerminalImageProtocol(unknown), 'sixel', `${String(unknown)} must fall back to sixel`)
  }
})

// ---- F-8 / F-9:extension.ts 接线的结构护栏 -------------------------------
// extension.ts 在模块顶层 import 'vscode',`npm test` 无法 require 它(REVIEW F-2/T5
// 记录的覆盖缺口),其接线因此没有行为级单测。下面两条断言把源码**当数据**读入
// (与 ci.yml 的键集扫描、TEST.md 为 AC-5 记的 grep「结构担保」同形),用仓库既有的
// typescript 编译器解析成 AST 再检查——比按行/按缩进的正则更抗格式变动,锚点找不到
// 时会显式失败而不是静默放行。
const SESSION_START_FUNCTIONS = ['runCommand', 'buildEnv', 'createTerminal']

const extensionSourcePath = join(__dirname, '..', '..', 'src', 'extension.ts')
const extensionFile = ts.createSourceFile(
  extensionSourcePath,
  readFileSync(extensionSourcePath, 'utf8'),
  ts.ScriptTarget.Latest,
  true, // setParentNodes:下面的拒绝处理器判定要看调用点的父链
)

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
}

/** 文件里所有 `function <name>()` 声明的名字(护栏锚点自检用)。 */
function declaredFunctionNames(file: ts.SourceFile): string[] {
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) names.push(node.name.text)
    node.forEachChild(visit)
  }
  visit(file)
  return names
}

/** 所有 `readSettings()` 调用,附上包住它的函数声明名(不在任何函数里则为 undefined)。 */
function settingsReads(file: ts.SourceFile): Array<{ fn: string | undefined; line: number }> {
  const reads: Array<{ fn: string | undefined; line: number }> = []
  const visit = (node: ts.Node, fn: string | undefined): void => {
    const scope = ts.isFunctionDeclaration(node) && node.name ? node.name.text : fn
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'readSettings'
    ) {
      reads.push({ fn: scope, line: lineOf(file, node) })
    }
    node.forEachChild(child => visit(child, scope))
  }
  visit(file, undefined)
  return reads
}

/** 所有 `context.globalState.update(...)` 调用。 */
function globalStateUpdates(file: ts.SourceFile): ts.CallExpression[] {
  const updates: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression
      if (
        callee.name.text === 'update' &&
        ts.isPropertyAccessExpression(callee.expression) &&
        callee.expression.name.text === 'globalState'
      ) {
        updates.push(node)
      }
    }
    node.forEachChild(visit)
  }
  visit(file)
  return updates
}

/** 拒绝是否被接住:交给 async 调用方(await),或链了 .catch() / .then(...)。 */
function rejectionObserved(call: ts.CallExpression): boolean {
  if (ts.isAwaitExpression(call.parent)) return true
  const chained = call.parent
  if (!ts.isPropertyAccessExpression(chained) || chained.expression !== call) return false
  if (chained.name.text !== 'catch' && chained.name.text !== 'then') return false
  return ts.isCallExpression(chained.parent)
}

// REVIEW F-8:runCommand → buildEnv → createTerminal 原本各调一次 readSettings(),
// 一次会话启动读三遍配置,且提示与门禁可能落在两个不同快照上;REQUIREMENT 的非功能
// 承诺是「零额外 IO——只读一次 VS Code 配置」。收敛成一次读取并向下传参后,这条断言
// 把承诺钉住:三个接线函数里**有且只有一次**读取。
test('a session start reads the VS Code configuration exactly once (F-8)', () => {
  const declared = declaredFunctionNames(extensionFile)
  assert.deepEqual(
    SESSION_START_FUNCTIONS.filter(name => declared.includes(name)),
    SESSION_START_FUNCTIONS,
    `guard anchors moved or renamed in ${extensionSourcePath}`,
  )
  const startReads = settingsReads(extensionFile).filter(
    read => read.fn !== undefined && SESSION_START_FUNCTIONS.includes(read.fn),
  )
  assert.equal(
    startReads.length,
    1,
    `a session start must read the settings once, got ${startReads.length}: ` +
      startReads.map(read => `${read.fn}():${read.line}`).join(', '),
  )
})

// REVIEW F-9:resetImageSetupPrompt 把 globalState.update 的 promise 直接 void 掉、
// 没有 catch——写失败会产生未处理 rejection,而它恰好落在「已放弃本次提示、准备下次
// 重试」的关键路径上。规则:被 void 的 globalState.update 必须自带拒绝处理器
// (await 的那次交给调用方的 .catch,不算)。
test('every fire-and-forget globalState write carries a rejection handler (F-9)', () => {
  const updates = globalStateUpdates(extensionFile)
  assert.ok(
    updates.length >= 2,
    `guard found ${updates.length} globalState.update call site(s) in ${extensionSourcePath}`,
  )
  const unhandled = updates.filter(update => !rejectionObserved(update))
  assert.deepEqual(
    unhandled.map(update => `${extensionSourcePath}:${lineOf(extensionFile, update)}`),
    [],
    "a void'ed globalState.update must chain .catch() / .then(undefined, ...)",
  )
})

// ---- m-3:取值空间第三处同形的收口护栏 -------------------------------------
// REVIEW m-3:F-5 把「类型 × package.json enum」绑在了一起,但 extension.ts 还自带过
// 一份 normalizeImageProtocol 白名单——取值空间的**第三处同形**,且当时没有任何断言
// 绑定。将来加第四档(例如上游修好 kitty)时最省事的错法仍是「只改 package.json +
// 类型」:设置界面冒出新选项,运行期被静默归一化回 sixel,F-5 那两条断言全绿。
// 本任务把白名单下沉为 session.ts 的 normalizeTerminalImageProtocol(与真源同文件),
// 下面两条结构断言把「下沉」钉成不变量:
//   ① session.ts 里该函数拼出的字符串字面量集合 == TERMINAL_IMAGE_PROTOCOLS 键集
//      ——加档而不改归一化 ⇒ 红;
//   ② extension.ts 不再出现任何协议取值字面量、且确实从 './session' 引入归一化
//      ——白名单以任何名字回流 ⇒ 红。
const sessionSourcePath = join(__dirname, '..', '..', 'src', 'session.ts')
const sessionFile = ts.createSourceFile(
  sessionSourcePath,
  readFileSync(sessionSourcePath, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
)

/** 文件里第一个名为 name 的函数声明(护栏锚点找不到时返回 undefined,由断言显式判负)。 */
function findFunction(file: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  let hit: ts.FunctionDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (hit === undefined && ts.isFunctionDeclaration(node) && node.name?.text === name) hit = node
    node.forEachChild(visit)
  }
  visit(file)
  return hit
}

/** node 子树里出现的字符串字面量文本值(去重、排序)。 */
function stringLiteralsIn(node: ts.Node): string[] {
  const found = new Set<string>()
  const visit = (current: ts.Node): void => {
    if (ts.isStringLiteral(current)) found.add(current.text)
    current.forEachChild(visit)
  }
  visit(node)
  return [...found].sort()
}

/** `import { a, b as c } from '<specifier>'` 里实际引入的名字(b 记的是本地名 c)。 */
function importedNames(file: ts.SourceFile, specifier: string): string[] {
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text === specifier) {
        const bindings = node.importClause?.namedBindings
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) names.push(element.name.text)
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(file)
  return names
}

test('session.ts binds the imageProtocol normalizer to the TerminalImageProtocol values (m-3)', () => {
  const normalizer = findFunction(sessionFile, 'normalizeTerminalImageProtocol')
  if (normalizer === undefined) {
    assert.fail(`${sessionSourcePath} must declare normalizeTerminalImageProtocol (REVIEW m-3)`)
  }
  assert.deepEqual(
    stringLiteralsIn(normalizer),
    Object.keys(TERMINAL_IMAGE_PROTOCOLS).sort(),
    'the normalizer must spell out exactly the TerminalImageProtocol values, or a new tier is silently unreachable',
  )
})

test('extension.ts carries no second imageProtocol value space (m-3)', () => {
  const protocolValues = Object.keys(TERMINAL_IMAGE_PROTOCOLS)
  // ① 白名单无论叫什么都得逐个拼出取值:只要出现协议取值字面量,就是第四处同形的苗头
  assert.deepEqual(
    stringLiteralsIn(extensionFile).filter(literal => protocolValues.includes(literal)),
    [],
    `${extensionSourcePath} must not spell out imageProtocol values; call the session.ts normalizer instead`,
  )
  // ② 删掉白名单不等于接上了真源:读设置的那一处必须真的引到它
  assert.ok(
    importedNames(extensionFile, './session').includes('normalizeTerminalImageProtocol'),
    `${extensionSourcePath} must import normalizeTerminalImageProtocol from './session'`,
  )
})
