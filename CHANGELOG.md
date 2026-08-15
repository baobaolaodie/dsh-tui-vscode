# Changelog

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

## 0.1.0 (2026)

- Initial Path A MVP (issue ccch1mneyyy/dsh-TUI#161):
  - integrated-terminal sessions with env injection, dedupe, `--resume`;
  - clickable file paths; `$VISUAL`/`$EDITOR` via `code -w`; status bar;
  - unit tests + real extension-host e2e (superseded by 0.2.0's panel model).