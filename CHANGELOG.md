# Changelog

## 0.5.0 (2026)

- **多会话并存（对齐 Claude Code）**：每次点击「启动新会话」/鲸鱼按钮都**新开
  一个 DeepSeek 终端 + 会话**，不再聚焦旧会话；旧会话在自己的终端里继续运行；
  「聚焦」与「终止」作用于最近创建的终端；关闭任一终端只结束该会话。

## 0.4.1 (2026)

- **会话标题对齐 Web**：读取 dsh-storage 账本（`~/.dsh/storages/session_projcache.json`
  的 `rows.title.val`，Web 会话列表的标题来源）——Web 有标题而扩展显示
  "未命名会话"的问题修复；标题优先级：日志 `session/title` 事件 → storage 标题
  → 首条用户消息。

## 0.4.0 (2026)

- **会话历史重做（按项目分组）**：
  - 侧边栏改为**树形列表：项目组（cwd 短名 + 会话数）→ 会话条目**，直接看出
    每个会话属于哪个项目；项目按最近活跃排序；
  - 条目 = 标题（最后 `session/title` 事件 → 首条用户消息 → "未命名会话"）
    + 紧凑相对时间；完整路径/ID 进 tooltip；
  - 组内按**最近使用**（`~/.dsh-tui/last-used.json`，TUI `/resume` 同款 MRU）
    排序，缺失按创建时间；
  - **解析宽容化**：无 `session` 头的日志（空日志/格式差异）仍生成条目
    （id 取会话目录、项目取组目录解码、时间取文件 mtime）——此前被过滤的
    会话现在全部可见；
  - **自动刷新**：监听 `~/.dsh/sessions` 变化（含各项目组目录），新会话
    出现即刷新；终端开/关与手动刷新保留；
  - 修复组目录解码：驱动器冒号也被编码为 `-`，解码补回（
    `--C-Users-...--` → `C:\Users\...`）；连字符项目名解码有损为已知限制。

## 0.3.0 (2026)

- **改为真实集成终端（对齐 Claude Code 官方终端模式源码）**：
  - 删除全部 webview/PTY 基础设施（node-pty、xterm、esbuild、OSC、webview
    面板）——vsix 从 3.7MB 缩至 327KB；
  - `createTerminal({ name: 'DeepSeek', location: { viewColumn: Beside },
    env, iconPath, isTransient })` + shell 就绪后运行 CLI——与官方扩展同构；
  - 打开位置 = 编辑器区**另一侧**新列；终端标签带鲸鱼图标、标题 DeepSeek；
  - 侧边栏改为**会话历史列表**（标题 + 紧凑相对时间，同 Claude Code sessions
    侧边栏）；点击条目恢复指定会话。
- **修复指定会话恢复**（读启动器源码定位）：`--resume` 会被启动器用
  `~/.dsh-tui/resume.txt` 覆盖 env → 改为 `DSH_TUI_RESUME_SESSION` env 直通
  （profile 的 cordis.patch.yml 启动时读取），不传 `--resume`；
- **真实恢复验证**：e2e 新增受保护的真实 dsh-tui 恢复测试（恢复后不新建会话
  = 成功），8/8 全过；
- 会话列表 zstd 初始化修复（此前列表恒为空）；
- 自动启停：关终端 = 停进程；重复打开只聚焦。

## 0.2.0 (2026)

- **Path B 重做（Claude Code 官方同款形态）**：
  - 活动栏 `dsh-tui` 图标 + 侧边栏「会话控制」视图；
  - 编辑器区独立面板，xterm.js 渲染完整 TUI——**彻底脱离底部集成终端**；
  - node-pty（Windows ConPTY）真实 PTY；`.cmd/.bat`/POSIX PATH 解析为绝对路径
    后交 node-pty 内部包裹（自包 cmd /c 会吞子进程 stdin，已实测定位）；
  - OSC 宿主协作：52 剪贴板、11 背景查询应答、0/1/2 标题、8 超链接保留；
  - 路径链接：webview web-links + `path:line[:col]` 匹配；
  - 依赖切 npm（vsce 才能把 node-pty 打进 vsix）；webview 用 esbuild 打包；
  - e2e 重写为面板/PTY 形态：8 用例在真实扩展宿主通过（Windows 本地 +
    Linux CI xvfb），含 .cmd shim 输入回环、--resume、kill、open-path。
  - **注**：0.2.0 的面板形态经用户实测后被 0.3.0 的真实终端形态取代。

## 0.1.0 (2026)

- Initial Path A MVP (issue ccch1mneyyy/dsh-TUI#161):
  - integrated-terminal sessions with env injection, dedupe, `--resume`;
  - clickable file paths; `$VISUAL`/`$EDITOR` via `code -w`; status bar;
  - unit tests + real extension-host e2e (superseded by 0.2.0's panel model).
