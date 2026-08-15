# dsh-tui-vscode

[English](#english) · [简体中文](#简体中文)

---

# 简体中文

**dsh-TUI 的 VS Code companion 扩展（Path B）**：让 [`dsh-tui`](https://github.com/ccch1mneyyy/dsh-TUI)
跑在 VS Code **独立会话面板**里——活动栏 `dsh-tui` 图标 + 编辑器区面板，面板内用
**xterm.js + 真实 PTY（ConPTY）** 渲染完整 TUI，**彻底脱离底部集成终端**。这是
[ccch1mneyyy/dsh-TUI#161](https://github.com/ccch1mneyyy/dsh-TUI/issues/161)
的 Path B 实现，形态对齐 Claude Code 官方 VS Code 扩展。

## 特性

- **活动栏入口**：左侧活动栏 `dsh-tui` 图标 → 侧边栏「会话控制」视图（启动/恢复/
  聚焦/终止按钮 + 运行状态）；点击「打开会话面板」在编辑器区打开 TUI 面板。
- **独立会话面板**：xterm.js 渲染完整 dsh-tui——alt-screen、鼠标（滚轮/拖选）、
  OSC 52 剪贴板、OSC 8 链接、同步输出，均由扩展自己的 webview 承载。
- **真实 PTY**：node-pty（Windows 走 ConPTY）持有 dsh-tui 进程；`TERM=xterm-256color`、
  正确的尺寸联动（面板缩放自动 resize）。
- **一键启动/恢复**：`dsh-tui: Start new session / 启动新会话` 与
  `dsh-tui: Resume last session / 恢复上次会话`（`--resume`）。
- **会话持续**：关闭面板不终止会话；重新打开面板即回到实时流（历史滚动区不保留）。
- **文件路径可点**：输出中的 `C:\...`、`/...`、`~/...`、`./...` 路径（含
  `path:line[:col]`）点击直接在编辑器打开。
- **外部编辑器接入**：`$VISUAL`/`$EDITOR` 未设置时自动导出 `code -w`，TUI 内
  `Ctrl+X` 直接进 VS Code 编辑。
- **OSC 宿主协作**：OSC 52 剪贴板写入 VS Code 剪贴板；OSC 11 背景查询按当前主题
  应答（TUI 自动选浅/深色）；OSC 0 标题同步到面板标题。
- **状态栏**：底部状态栏 `dsh-tui` 项点击打开面板。

## 前置条件

- VS Code ≥ 1.90
- 全局安装 DSH CLI 与 dsh-tui（首次启动还需要 `pnpm` 自动初始化 profile）：

  ```sh
  npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui
  ```

- 运行模型需要 `DEEPSEEK_API_KEY`（可放在终端环境或 dsh 配置里）。

## 安装

从源码构建并安装（推荐，本仓库暂未上架 Marketplace）：

```sh
npm install
npm run package        # 生成 dsh-tui-vscode-0.2.0.vsix（内含 node-pty 二进制）
code --install-extension dsh-tui-vscode-0.2.0.vsix --force
# 或一步到位：npm run install:local
```

## 使用

1. 点击左侧活动栏的 `dsh-tui` 图标，或命令面板（`Ctrl+Shift+P`）输入
   `dsh-tui: Start new session / 启动新会话`；
2. 会话面板在**编辑器区**打开（不是底部终端），dsh-tui 全屏 TUI 渲染在其中；
3. 首次启动会自动初始化 `dsh-tui` profile（需要 pnpm，提示与 `dsh-tui` 命令一致）；
4. 输出里的文件路径**按住 Ctrl/Cmd 点击**在编辑器打开；
5. TUI 里 `Ctrl+X` 用 VS Code 编辑当前输入（`$VISUAL=code -w`）；
6. 关闭面板 = 会话后台继续；重新打开面板回到实时流；「终止会话」或 TUI 内
   双击 `Ctrl+C` 结束进程。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dsh-tui-vscode.command` | `dsh-tui` | 启动命令/可执行文件（Windows 上自动解析 `.cmd/.bat` shim，POSIX 上按 PATH 解析为绝对路径） |
| `dsh-tui-vscode.extraArgs` | `[]` | 每次启动追加的 CLI 参数，如 `["--lang","en"]`（每项一个参数） |
| `dsh-tui-vscode.lang` | `""` | `""`/`zh`/`en`，写入 `DSH_TUI_LANG` |
| `dsh-tui-vscode.injectEditor` | `true` | 未设 `$VISUAL`/`$EDITOR` 时导出 `$VISUAL` |
| `dsh-tui-vscode.editorCommand` | `code -w` | 导出为 `$VISUAL` 的命令 |
| `dsh-tui-vscode.dshHome` | `""` | 覆盖会话的 `$DSH_HOME`（空 = 继承 VS Code 进程的值，默认与 `dsh` 共享同一 home） |

## 工作原理

- **PTY**：node-pty（Windows 用 ConPTY，Linux/macOS 用 forkpty）直接持有
  `dsh-tui` 进程；Windows 的 `.cmd` shim 解析为绝对路径后交给 node-pty 内部
  包裹（自包 `cmd /c` 会吞子进程 stdin，已实测定位）；POSIX 上按 PATH 解析
  为绝对可执行文件。
- **渲染**：webview 内 xterm.js（fit 插件自适应尺寸、web-links 插件处理
  `path:line[:col]` 链接）；宿主把 PTY 输出经 OSC 扫描器（剪贴板/背景查询/
  标题）清洗后推给 webview，webview 的按键/粘贴/缩放回传 PTY。
- **会话模型**：单会话；`retainContextWhenHidden` 保持面板隐藏时的渲染；
  面板被关闭时进程继续运行，重开即重连实时流。
- **环境注入**：`DSH_TUI_LANG`、`$VISUAL`、可选 `$DSH_HOME` 通过 PTY env 注入。

## 已知限制

- **关闭面板后滚动历史不保留**（重连只显示新输出）；隐藏面板则完整保留
  （`retainContextWhenHidden`）。
- 单会话模型：新启动会复用正在运行的会话。
- xterm.js 能力即面板能力上限：扩展键盘协议、DEC 2026 等由 xterm.js 决定；
  需要更完整协议支持时可在此 webview 上扩展（Path B 的优势是渲染完全自主）。
- 打包的 vsix 含当前构建平台的 node-pty 二进制（Windows 构建 = Windows 可用；
  其他平台请在该平台构建或等待多平台发布）。

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit（含 webview）
npm test            # 编译 + node --test（纯逻辑单测）
npm run test:e2e    # 真实 VS Code 扩展宿主测试（@vscode/test-electron；Linux 用 xvfb-run -a）
npm run package     # webview 打包 + 编译 + 生成 .vsix
```

## 许可

MIT © 2026 baobaolaodie。dsh-tui 本体为 [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)（MIT）。

---

# English

A **Path B companion extension for [`dsh-tui`](https://github.com/ccch1mneyyy/dsh-TUI)**:
the TUI runs in its own VS Code session panel — activity-bar entry + an
editor-area panel rendering the full terminal UI with **xterm.js + a real PTY
(ConPTY)**, completely independent of the integrated terminal. This is the
Path B implementation for
[ccch1mneyyy/dsh-TUI#161](https://github.com/ccch1mneyyy/dsh-TUI/issues/161),
shaped like the official Claude Code VS Code extension.

## Features

- Activity-bar `dsh-tui` icon → sidebar "会话控制" view (start / resume / focus /
  kill buttons + status); "打开会话面板" opens the TUI panel in the editor area.
- The session panel renders the full dsh-tui: alt-screen, mouse, OSC 52
  clipboard (host-handled), OSC 8 links, synchronized output.
- Real PTY via node-pty (ConPTY on Windows); `TERM=xterm-256color`; panel
  resize propagates to the PTY.
- One-click start / resume (`--resume`); session survives closing the panel
  (reopen reconnects to the live stream; hidden panels keep full rendering).
- Clickable file paths (`path:line[:col]`) open in the editor.
- `$VISUAL`/`$EDITOR` → `code -w` when unset; OSC 11 background query answered
  with the current theme; OSC 0 title syncs to the panel title.
- Status-bar item opens the panel.

## Prerequisites

- VS Code ≥ 1.90
- Global DSH CLI + dsh-tui: `npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui`
- `DEEPSEEK_API_KEY` for running models.

## Install

Build from source (not yet on the Marketplace):

```sh
npm install
npm run package
code --install-extension dsh-tui-vscode-0.2.0.vsix --force
```

## Usage

- Click the activity-bar `dsh-tui` icon, or run `dsh-tui: Start new session / 启动新会话`.
- The session opens in an **editor-area panel** (not the integrated terminal).
- Ctrl/Cmd-click file paths in the output to open them in the editor.
- Closing the panel keeps the session running; reopen to reconnect.

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `dsh-tui-vscode.command` | `dsh-tui` | Launch command/executable (Windows `.cmd/.bat` shims and POSIX PATH entries are resolved to absolute paths) |
| `dsh-tui-vscode.extraArgs` | `[]` | Extra CLI args, e.g. `["--lang","en"]` (one argument per item) |
| `dsh-tui-vscode.lang` | `""` | `""`/`zh`/`en`, exported as `DSH_TUI_LANG` |
| `dsh-tui-vscode.injectEditor` | `true` | Export `$VISUAL` when unset |
| `dsh-tui-vscode.editorCommand` | `code -w` | Value exported as `$VISUAL` |
| `dsh-tui-vscode.dshHome` | `""` | `$DSH_HOME` override (empty = inherit) |

## How it works

- node-pty (ConPTY on Windows, forkpty elsewhere) owns the dsh-tui process;
  `.cmd/.bat` shims are resolved to absolute paths and wrapped by node-pty
  internally (self-wrapping `cmd /c` breaks child stdin — verified
  empirically); POSIX commands are PATH-resolved to absolute executables.
- The webview renders xterm.js (fit + web-links addons); the host cleans the
  PTY stream through an OSC scanner (clipboard / background query / title)
  before forwarding; key input, paste and resize flow back to the PTY.
- Single-session model; `retainContextWhenHidden` keeps rendering while
  hidden; closing the panel keeps the process alive and reopening reconnects.

## Known limitations

- Scrollback is not preserved when the panel tab is closed (hidden panels
  keep everything via `retainContextWhenHidden`).
- Single session at a time.
- Capabilities are bounded by xterm.js (keyboard protocol, DEC 2026, etc.);
  Path B keeps rendering fully under our control for future extensions.
- The packaged vsix contains the node-pty binary for the platform it was
  built on.

## Development

```sh
npm install
npm run typecheck
npm test
npm run test:e2e   # real extension-host tests (xvfb-run -a on Linux)
npm run package
```

## License

MIT © 2026 baobaolaodie. dsh-tui itself is [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) (MIT).