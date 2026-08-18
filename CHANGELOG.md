# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。版本记录在 git tag 与本文件中。

## Unreleased

### Added

- **插入 @文件引用命令（引用选中代码到输入框）**：新增 `dsh-tui-vscode.insertAtMention`，默认快捷键 `Ctrl+Alt+K`（macOS `Cmd+Alt+K`，编辑器聚焦时），也可从命令面板/编辑器右键触发——把当前文件或选中代码以 `@绝对路径 L起-止` 形式插入运行中的 dsh-tui 输入框（正斜杠绝对路径,与 dsh-tui 会话 cwd 无关；未选中仅为 `@绝对路径` 引用整个文件；`@` 引用提交时自动附加文件内容，行区间为空格分隔的纯文本提示——dsh-tui 不支持 `#L` 行区间语法）；无运行会话时回退为复制到剪贴板。以 Claude Code 官方扩展 `insertAtMention` 为基准并做了 dsh-tui 适配。

### Changed

### Fixed

## [0.6.1] - 2026-08-17

> 经 PR [#3](https://github.com/baobaolaodie/dsh-tui-vscode/pull/3) 合并 / via PR #3

### Added

### Changed

### Fixed

- **修复 Windows 非 PowerShell 终端（Git Bash 等）启动失败**：npm 全局安装会在 Windows 上同时生成 `.cmd` 与无扩展名 bash shim；扩展原先把 `dsh-tui.cmd` 的 Windows 绝对路径直接发给 bash，反斜杠被吞成 `C:Users...: command not found`。现在按终端 shell 类型区分：Git Bash/MSYS/Cygwin/WSL 优先解析 npm 的 bash shim 并把路径转成 POSIX 形式（`/c/...`、`/cygdrive/c/...`、`/mnt/c/...`）后发送，PowerShell/CMD 保持原有 `.cmd/.exe` 解析。

## [0.6.0] - 2026-08-17

> 经 PR [#1](https://github.com/baobaolaodie/dsh-tui-vscode/pull/1) 合并 / via PR #1

### Added

- **侧边栏右键重命名/删除会话**：条目上悬停/右键可重命名（向日志追加 `session/title` zstd 帧，`seq` 续接，与 dsh-TUI `/resume` 选择器同一契约；非 zstd 旧日志拒绝追加不损坏）或删除（真实路径 containment 校验，符号链接无法把删除引到会话根之外；删除前模态确认）。
- **dsh 原生归档**：侧边栏悬停「归档」按钮把会话加入 dsh workspace 域的归档集合（`storages/workspace.json` 的 `archivedSessionIds`——与 dsh web 列表同源）：会话从所有分组表面隐藏，日志与记账槽位保留，随时可恢复；「管理已归档会话」命令（QuickPick）可恢复或彻底删除；列表默认过滤归档会话（与 web 一致）。删除改为右键「永久删除」（危险操作不放在悬停按钮）。

### Changed

### Fixed

- **修复侧边栏空列表**：`dshHome` 配置默认值 `""` 传入数据层后未回退（`??` 不处理空串），导致会话根解析成相对路径 `sessions`、列表恒为空——统一为"空串与未设置等价"的解析，并补回归测试。
- **修复右键重命名/删除无响应**：`view/item/context` 菜单命令收到的首参是选中 TreeItem 而非命令参数——会话 id/日志路径改由 TreeItem 携带，命令从其上读取。
- **补监听新组目录**：激活后新出现的组目录（新位置首次会话）不在 fs.watch 列表内，会话进行中列表不自动刷新——每次加载后幂等补监听。
- **修复重命名/删除在真实 VS Code 中无效**：① 右键菜单命令收到的参数是 TreeItem——会话身份改挂标准字段（`id`/`resourceUri`）并保留自定义字段兜底；② 删除的路径 containment 校验在 Windows 上改为大小写不敏感（`vscode.Uri.file(...).fsPath` 会把盘符规范化为小写，大小写敏感比较会拒绝一切删除）；③ `@bokuweb/zstd-wasm` 模块在长生命周期 Electron 宿主中会损坏（压缩输出全 0 或"魔数正确但内容不可解"的帧）——新增：模块经 `getZstd()` 间接层解析、压缩输出 round-trip 验证（坏帧绝不写入）、损坏检测 + 模块重载重试（列表与重命名双路径）、失败时明确报错而非静默。
- **测试集扩充（极致测试）**：e2e 新增 4 项真实链路测试——右键命令全链路（对话框打桩 + 临时会话 + TreeItem 参数两种形态）、树视图全链路（工作区过滤/空会话/子代理在真实扩展宿主中验证）、watcher 新组目录自动刷新、wasm 损坏时重命名恢复（健康时诚实 SKIP）；单测新增空串 dshHome 回退、删除 containment 大小写、压缩帧验证等用例。

- **修复多帧 zstd 会话日志解码失败**：持久化日志是"每次 flush 追加一个 zstd 帧"的串联链，原实现对整文件单次解压——大日志（多帧）解压失败（code -70），导致**进行过对话的会话在侧边栏显示"未命名会话"且丢失工作目录分组**。改为按 RFC 8878 结构式拆帧、逐帧解压、容错跳过坏帧（含尾帧重同步），标题/工作目录全部恢复。
- **侧边栏只展示当前 VS Code 工作区会话**：沿用 dsh-TUI 的 `sessionCwdMatches` 归属语义（精确 + 工作区子目录；home/盘根/UNC 根为容器边界仅精确匹配；父目录会话不混入），多根工作区取并集，未打开工作区显示空列表。
- **隐藏空会话与子代理运行**：仅含启动事件、无真人消息的会话（`hasPrompt=false`，与 dsh 浏览器一致）及 header `origin: 'subagent'` 的派遣运行不再出现在列表中；标题兜底改为首条真人消息 → 工作目录名。
- **性能：会话列表改为有界窗口读取**（64KB 头 + 128KB 尾，仿 dsh-TUI frames.ts）——只读日志两端，中间内容不触碰；被工作区/空会话/子代理过滤掉的日志只读头不读尾。本机 101 会话全量刷新 1714ms → 524ms，带过滤 233ms。

## [0.5.1] - 2026-08-16

> 直推提交，无关联 PR / direct-push, no PR

- **修复 Marketplace 页面 README 过期**：v0.5.0 上传的 vsix 内含发布前 README（「暂未上架 Marketplace」）——重新打包发布，Marketplace 页面与仓库同步为「扩展面板安装优先」；
- **chore**: 清理 Path B 时代残留——`tsconfig.json` 移除已删除的 `src/webview` exclude。

## [0.5.0] - 2026-08-16

> 直推提交（分支保护启用前），无关联 PR / direct-push (pre-branch-protection), no PR

- **上架 VS Code Marketplace**：v0.5.0 经网页上传正式发布（官方"手动发布"路径），扩展面板可直接搜索安装；
- **多会话并存（对齐 Claude Code）**：每次点击「启动新会话」/鲸鱼按钮都**新开一个 DeepSeek 终端 + 会话**，不再聚焦旧会话；旧会话在自己的终端里继续运行；「聚焦」与「终止」作用于最近创建的终端；关闭任一终端只结束该会话。

## [0.4.1] - 2026-08-16

> 直推提交（分支保护启用前），无关联 PR / direct-push (pre-branch-protection), no PR

- **会话标题对齐 Web**：读取 dsh-storage 账本（`~/.dsh/storages/session_projcache.json` 的 `rows.title.val`，Web 会话列表的标题来源）——Web 有标题而扩展显示 "未命名会话"的问题修复；标题优先级：日志 `session/title` 事件 → storage 标题 → 首条用户消息。

## [0.4.0] - 2026-08-16

> 直推提交（分支保护启用前），无关联 PR / direct-push (pre-branch-protection), no PR

- **会话历史重做（按项目分组）**：
  - 侧边栏改为**树形列表：项目组（cwd 短名 + 会话数）→ 会话条目**，直接看出每个会话属于哪个项目；项目按最近活跃排序；
  - 条目 = 标题（最后 `session/title` 事件 → 首条用户消息 → "未命名会话"）+ 紧凑相对时间；完整路径/ID 进 tooltip；
  - 组内按**最近使用**（`~/.dsh-tui/last-used.json`，TUI `/resume` 同款 MRU）排序，缺失按创建时间；
  - **解析宽容化**：无 `session` 头的日志（空日志/格式差异）仍生成条目（id 取会话目录、项目取组目录解码、时间取文件 mtime）——此前被过滤的会话现在全部可见；
  - **自动刷新**：监听 `~/.dsh/sessions` 变化（含各项目组目录），新会话出现即刷新；终端开/关与手动刷新保留；
  - 修复组目录解码：驱动器冒号也被编码为 `-`，解码补回（`--C-Users-...--` → `C:\Users\...`）；连字符项目名解码有损为已知限制。

## [0.3.0] - 2026-08-16

> 直推提交（分支保护启用前），无关联 PR / direct-push (pre-branch-protection), no PR

- **改为真实集成终端（对齐 Claude Code 官方终端模式源码）**：
  - 删除全部 webview/PTY 基础设施（node-pty、xterm、esbuild、OSC、webview 面板）——vsix 从 3.7MB 缩至 327KB；
  - `createTerminal({ name: 'DeepSeek', location: { viewColumn: Beside }, env, iconPath, isTransient })` + shell 就绪后运行 CLI——与官方扩展同构；
  - 打开位置 = 编辑器区**另一侧**新列；终端标签带鲸鱼图标、标题 DeepSeek；
  - 侧边栏改为**会话历史列表**（标题 + 紧凑相对时间，同 Claude Code sessions 侧边栏）；点击条目恢复指定会话。
- **修复指定会话恢复**（读启动器源码定位）：`--resume` 会被启动器用 `~/.dsh-tui/resume.txt` 覆盖 env → 改为 `DSH_TUI_RESUME_SESSION` env 直通（profile 的 cordis.patch.yml 启动时读取），不传 `--resume`；
- **真实恢复验证**：e2e 新增受保护的真实 dsh-tui 恢复测试（恢复后不新建会话 = 成功），8/8 全过；
- 会话列表 zstd 初始化修复（此前列表恒为空）；
- 自动启停：关终端 = 停进程；重复打开只聚焦。

## [0.2.0] - 2026-08-16

> 直推提交（分支保护启用前），无关联 PR / direct-push (pre-branch-protection), no PR

- **Path B 重做（Claude Code 官方同款形态）**：
  - 活动栏 `dsh-tui` 图标 + 侧边栏「会话控制」视图；
  - 编辑器区独立面板，xterm.js 渲染完整 TUI——**彻底脱离底部集成终端**；
  - node-pty（Windows ConPTY）真实 PTY；`.cmd/.bat`/POSIX PATH 解析为绝对路径后交 node-pty 内部包裹（自包 cmd /c 会吞子进程 stdin，已实测定位）；
  - OSC 宿主协作：52 剪贴板、11 背景查询应答、0/1/2 标题、8 超链接保留；
  - 路径链接：webview web-links + `path:line[:col]` 匹配；
  - 依赖切 npm（vsce 才能把 node-pty 打进 vsix）；webview 用 esbuild 打包；
  - e2e 重写为面板/PTY 形态：8 用例在真实扩展宿主通过（Windows 本地 + Linux CI xvfb），含 .cmd shim 输入回环、--resume、kill、open-path。
  - **注**：0.2.0 的面板形态经用户实测后被 0.3.0 的真实终端形态取代。

## [0.1.0] - 2026-08-16

> 直推提交（分支保护启用前），无关联 PR / direct-push (pre-branch-protection), no PR

- Initial Path A MVP (issue ccch1mneyyy/dsh-TUI#161):
  - integrated-terminal sessions with env injection, dedupe, `--resume`;
  - clickable file paths; `$VISUAL`/`$EDITOR` via `code -w`; status bar;
  - unit tests + real extension-host e2e (superseded by 0.2.0's panel model).
