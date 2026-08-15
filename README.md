# dsh-tui-vscode

[English](#english) · [简体中文](#简体中文)

---

# 简体中文

**dsh-TUI 的 VS Code companion 扩展**：让 [`dsh-tui`](https://github.com/ccch1mneyyy/dsh-TUI)
以**完整终端 TUI 形态**跑进 VS Code 集成终端，而不是重造一个 Web 聊天面板。

这是 [ccch1mneyyy/dsh-TUI#161](https://github.com/ccch1mneyyy/dsh-TUI/issues/161)
的 **Path A（Terminal API）MVP** 实现，思路与 Claude Code 官方 VS Code 扩展同构：
CLI 承载在 IDE 集成终端里，编辑器侧做轻量加成。

## 特性

- **一键启动 / 恢复**：命令面板里 `dsh-tui: Start new session / 启动新会话` 与
  `dsh-tui: Resume last session / 恢复上次会话`（等价 `dsh-tui --resume`）。
- **终端去重**：同一名字的会话终端只开一个，重复启动只会聚焦已有会话。
- **文件路径可点**：终端输出里的 `C:\...`、`/...`、`~/...`、`./...` 路径（含
  `path:line[:col]`）在 VS Code 里可直接点开并跳转到行。
- **外部编辑器接入**：`$VISUAL`/`$EDITOR` 未设置时自动导出为 `code -w`，TUI 内
  `Ctrl+X` 编辑当前输入会直接在 VS Code 新标签页里打开。
- **会话状态栏**：左下角常驻 `dsh-tui` 状态项，点击聚焦/启动会话。
- **不触碰渲染链路**：扩展只负责"承载"，TUI 的 alt-screen、OSC 52、同步输出等
  行为由 dsh-tui 与 VS Code 集成终端（xterm.js）原样承担。

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
pnpm install
pnpm package          # 生成 dsh-tui-vscode-0.1.0.vsix
code --install-extension dsh-tui-vscode-0.1.0.vsix --force
# 或一步到位：pnpm install:local
```

## 使用

1. 命令面板（`Ctrl+Shift+P`）输入 `dsh-tui: Start new session / 启动新会话`；
2. 首次启动会自动初始化 `dsh-tui` profile（需要 pnpm，提示与 `dsh-tui` 命令一致）；
3. 会话跑在名为 `dsh-tui` 的集成终端里；窗口右下角的
   `$(terminal) dsh-tui` 状态项可随时点击聚焦；
4. 工具输出里的文件路径**按住 Ctrl 点击**（macOS 为 Cmd+点击）即可在编辑器打开；
5. 在 TUI 输入框按 `Ctrl+X` 会用 VS Code 编辑当前输入（`$VISUAL=code -w`）。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dsh-tui-vscode.command` | `dsh-tui` | 启动命令/可执行文件，可改为绝对路径 |
| `dsh-tui-vscode.extraArgs` | `[]` | 每次启动追加的 CLI 参数，如 `["--lang","en"]`（每项一个参数） |
| `dsh-tui-vscode.terminalName` | `dsh-tui` | 承载会话的终端名（用于去重；扩展重载后也会按此名收养既有会话） |
| `dsh-tui-vscode.lang` | `""` | `""`/`zh`/`en`，写入 `DSH_TUI_LANG` |
| `dsh-tui-vscode.injectEditor` | `true` | 未设 `$VISUAL`/`$EDITOR` 时导出 `$VISUAL` |
| `dsh-tui-vscode.editorCommand` | `code -w` | 导出为 `$VISUAL` 的命令 |
| `dsh-tui-vscode.dshHome` | `""` | 覆盖会话的 `$DSH_HOME`（空 = 继承 VS Code 进程的值，默认与 `dsh` 共享同一 home） |

## 工作原理

- 非 Windows：`createTerminal({ shellPath: 'dsh-tui', shellArgs: [...] })` 直接启动；
- Windows：`dsh-tui` 在 PATH 上是 `dsh-tui.cmd`，扩展经 `cmd.exe /d /s /c` 复合
  命令行启动（VS Code 自身对自定义 shell 的同一套做法）；
- `registerTerminalLinkProvider` 只对本扩展创建的终端提供路径链接；
- 环境变量（`DSH_TUI_LANG`、`$VISUAL`、可选的 `$DSH_HOME`）通过 `createTerminal`
  的 `env` 注入，不污染全局终端环境。

## 已知限制

- **Path A 受 VS Code 集成终端能力上限约束**：扩展键盘协议（modifyOtherKeys/
  win32-input-mode）、部分鼠标语义由内置终端决定；需要完全自定义渲染时走
  Path B（Webview + xterm.js + 真 PTY），本仓库当前不实现。
- 退出会话请照常双击 `Ctrl+C`；`dsh-tui: Terminate session` 会先发一次 Ctrl+C，
  稍后仍未退出则强制关闭终端。
- 路径链接对 `path:line[:col]` 解析为启发式规则（详见 `src/links.ts` 与单测），
  不保证覆盖所有输出格式。

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # 编译 + node --test（纯逻辑单测，无需 VS Code/DSH）
pnpm package     # 生成 .vsix
```

## 许可

MIT © 2026 baobaolaodie。dsh-tui 本体为 [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)（MIT）。

---

# English

A **VS Code companion extension for [`dsh-tui`](https://github.com/ccch1mneyyy/dsh-TUI)**:
run the real terminal TUI inside the VS Code integrated terminal instead of
wrapping a web chat panel.

This is the **Path A (Terminal API) MVP** for
[ccch1mneyyy/dsh-TUI#161](https://github.com/ccch1mneyyy/dsh-TUI/issues/161),
shaped like the official Claude Code VS Code extension: the CLI lives in the
IDE integrated terminal, with light editor-side enhancements.

## Features

- Start / resume (`dsh-tui --resume`) / focus / terminate from the command palette.
- One terminal per session name — starting again focuses the existing one.
- File paths in terminal output (Windows/POSIX/`~/`, with `path:line[:col]`)
  are clickable and open in the editor.
- When `$VISUAL`/`$EDITOR` are unset, exports `VISUAL=code -w` so the TUI's
  `Ctrl+X` input editor opens in VS Code.
- Status-bar item for the session.
- The TUI rendering pipeline is untouched — alt-screen, OSC 52, smooth output
  and friends behave exactly as in a standalone terminal.

## Prerequisites

- VS Code ≥ 1.90
- Global DSH CLI + dsh-tui: `npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui`
- `DEEPSEEK_API_KEY` for running models.

## Install

Build from source (not yet on the Marketplace):

```sh
pnpm install
pnpm package
code --install-extension dsh-tui-vscode-0.1.0.vsix --force
```

## Usage

- `dsh-tui: Start new session / 启动新会话` opens a `dsh-tui` integrated terminal.
- Ctrl-click file paths in terminal output to open them in the editor.
- `Ctrl+X` in the TUI input edits the current input in VS Code (`$VISUAL=code -w`).

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `dsh-tui-vscode.command` | `dsh-tui` | Launch command/executable, absolute paths allowed |
| `dsh-tui-vscode.extraArgs` | `[]` | Extra CLI args, e.g. `["--lang","en"]` (one argument per item) |
| `dsh-tui-vscode.terminalName` | `dsh-tui` | Hosting terminal name (dedupe key; existing sessions are adopted on reload) |
| `dsh-tui-vscode.lang` | `""` | `""`/`zh`/`en`, exported as `DSH_TUI_LANG` |
| `dsh-tui-vscode.injectEditor` | `true` | Export `$VISUAL` when unset |
| `dsh-tui-vscode.editorCommand` | `code -w` | Value exported as `$VISUAL` |
| `dsh-tui-vscode.dshHome` | `""` | `$DSH_HOME` override for the session (empty = inherit, sharing the same home as `dsh`) |

## How it works

- POSIX: `createTerminal({ shellPath: 'dsh-tui', shellArgs })` spawns directly.
- Windows: `dsh-tui` is a `.cmd` shim, so the extension launches it through
  `cmd.exe /d /s /c "<command> <args>"` (the same trick VS Code uses for custom
  shells; the quoted form for paths with spaces is verified against real
  `cmd.exe` with verbatim/ConPTY-style argument joining).
- On activation the extension adopts still-running sessions it created earlier
  (matched by terminal name or launch signature), so reloading VS Code keeps
  start/focus/kill consistent instead of spawning duplicates.
- `registerTerminalLinkProvider` only decorates terminals this extension created.
- Env vars (`DSH_TUI_LANG`, `$VISUAL`, optional `$DSH_HOME`) are injected
  per-terminal via `createTerminal`.

## Known limitations

- Path A is bounded by VS Code's integrated terminal (xterm.js): extended
  keyboard protocols and some mouse semantics are decided by the built-in
  terminal. Full custom rendering would need Path B (webview + xterm.js + real PTY),
  which this repo does not implement.
- Exit your session with the usual double `Ctrl+C`; `Terminate session` sends
  one Ctrl+C and force-disposes if still alive.
- Path detection is heuristic (see `src/links.ts` and its tests): Windows/POSIX
  absolute paths, `~/` and `./`/`../` prefixes, `path:line[:col]` suffixes,
  ANSI-stripped offsets, CJK sentence punctuation.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm package
```

## License

MIT © 2026 baobaolaodie. dsh-tui itself is [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) (MIT).