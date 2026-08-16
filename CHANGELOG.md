# Changelog

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
