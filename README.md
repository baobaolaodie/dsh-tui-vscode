# dsh-tui-vscode

[English](#english) · [简体中文](#简体中文)

---

# 简体中文

**dsh-TUI 的 VS Code companion 扩展**：让 [`dsh-tui`](https://github.com/ccch1mneyyy/dsh-TUI)
跑在 VS Code **真实的集成终端**里（编辑器区新开一列，Windows 默认 PowerShell），
形态与 Claude Code 官方 VS Code 扩展的终端模式完全一致（`createTerminal` +
在终端内运行 CLI）。这是
[ccch1mneyyy/dsh-TUI#161](https://github.com/ccch1mneyyy/dsh-TUI/issues/161)
的实现，行为对齐官方扩展源码。

## 特性

- **真实终端，非模拟**：会话运行在 VS Code 集成终端（默认 shell = 你的
  PowerShell/bash），拥有终端的一切原生能力：shell 集成、原生 Ctrl+C、复制粘贴、
  字体主题跟随。没有 webview、没有 xterm、没有模拟层。
- **打开位置 = 另一侧**：在编辑器区**旁边新开一列**（`ViewColumn.Beside`），
  不占你正在看的列（同 Claude Code）。
- **入口**：活动栏鲸鱼图标 + 编辑器标签栏右侧鲸鱼按钮 + 命令面板
  （`dsh-tui: Start new session` 等）。
- **侧边栏会话列表**：活动栏 → 会话历史（标题 + 紧凑相对时间，同 Claude Code
  sessions 侧边栏）；点击条目在另一侧新终端**恢复该指定会话**。
- **一键启动/恢复**：`Start new session / 启动新会话`、
  `Resume last session / 恢复上次会话`（`--resume` 读 `~/.dsh-tui/resume.txt`）。
- **指定会话恢复**：通过 `DSH_TUI_RESUME_SESSION` 环境变量注入（dsh-tui profile
  的 `cordis.patch.yml` 在启动时读取），不传 `--resume`（启动器会覆盖 env）。
- **环境注入**：`DSH_TUI_LANG`、`$VISUAL`（未设置时自动导出 `code -w`）、可选
  `$DSH_HOME` 注入到终端环境。
- **自动启停**：打开 = 启动；关闭终端 = 进程结束；重复点击只聚焦（dedupe）。
- **状态栏**：有会话时显示 `DeepSeek` 状态项，点击聚焦终端。

## 前置条件

- VS Code ≥ 1.90
- 全局安装 DSH CLI 与 dsh-tui（首次启动还需要 `pnpm` 自动初始化 profile）：

  ```sh
  npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui
  ```

- 运行模型需要 `DEEPSEEK_API_KEY`（可放在终端环境或 dsh 配置里）。

## 安装

从源码构建并安装（本仓库暂未上架 Marketplace）：

```sh
npm install
npm run package        # 生成 dsh-tui-vscode-0.3.0.vsix
code --install-extension dsh-tui-vscode-0.3.0.vsix --force
# 或一步到位：npm run install:local
```

## 使用

1. 点击活动栏**鲸鱼图标**（或编辑器标签栏右侧鲸鱼按钮 / 命令面板
   `dsh-tui: Start new session`）；
2. **编辑器区另一侧**新开一个 **DeepSeek** 标签的集成终端（默认 shell =
   PowerShell），自动运行 `dsh-tui`；
3. 首次启动会自动初始化 `dsh-tui` profile（需要 pnpm）；
4. 侧边栏「会话历史」点任意条目 → 另一侧新终端**恢复该指定会话**；
5. 关闭终端 = 会话结束；TUI 内双击 `Ctrl+C` 退出。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dsh-tui-vscode.command` | `dsh-tui` | 启动命令（由终端 shell 按 PATH 解析） |
| `dsh-tui-vscode.extraArgs` | `[]` | 每次启动追加的 CLI 参数，如 `["--lang","en"]` |
| `dsh-tui-vscode.lang` | `""` | `""`/`zh`/`en`，写入 `DSH_TUI_LANG` |
| `dsh-tui-vscode.injectEditor` | `true` | 未设 `$VISUAL`/`$EDITOR` 时导出 `$VISUAL` |
| `dsh-tui-vscode.editorCommand` | `code -w` | 导出为 `$VISUAL` 的命令 |
| `dsh-tui-vscode.dshHome` | `""` | 覆盖会话的 `$DSH_HOME`（空 = 继承） |

## 工作原理

- **会话**：`vscode.window.createTerminal({ name: 'DeepSeek', cwd, env,
  iconPath, location: { viewColumn: Beside }, isTransient: true })`——与官方
  Claude Code 扩展的终端启动完全同构；shell 就绪（shell integration 或兜底
  延时）后发送启动命令。
- **恢复指定会话**：profile 的 `cordis.patch.yml` 在启动时读取
  `DSH_TUI_RESUME_SESSION` env（`sessionId: !!js process.env.DSH_TUI_RESUME_SESSION
  ?? ...`）；扩展把它注入终端环境并**不传 `--resume`**（启动器遇到 `--resume`
  会用 `~/.dsh-tui/resume.txt` 覆盖 env——已读源码确认）。
- **会话列表**：读取 `~/.dsh/sessions` 下 DSH 会话日志（zstd 解压），标题遵循
  TUI 契约（最后一条 `session/title` 事件优先，兜底首条用户消息）。
- **去重**：已存在 DeepSeek 终端时，`start` 只聚焦；`resume` 总是新建。

## 已知限制

- 会话内容即终端内容：滚动历史由 VS Code 终端管理（同 Claude Code 终端模式）。
- 指定会话恢复依赖 dsh-tui profile 的 `cordis.patch.yml`（0.6.1 及以上）。

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # 编译 + node --test（纯逻辑单测）
npm run test:e2e    # 真实扩展宿主测试（@vscode/test-electron；Linux 用 xvfb-run -a）
npm run package     # 编译 + 生成 .vsix
```

## 许可

MIT © 2026 baobaolaodie。dsh-tui 本体为 [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)（MIT）。

---

# English

A **VS Code companion extension for [`dsh-tui`](https://github.com/ccch1mneyyy/dsh-TUI)**:
the TUI runs in a REAL VS Code integrated terminal (new editor column, default
shell — PowerShell on Windows), exactly like the terminal mode of the official
Claude Code extension (`createTerminal` + run the CLI inside it). This is the
implementation for
[ccch1mneyyy/dsh-TUI#161](https://github.com/ccch1mneyyy/dsh-TUI/issues/161).

## Features

- **Real terminal, no emulation**: sessions run in the VS Code integrated
  terminal (your default shell — PowerShell/bash), with native shell
  integration, Ctrl+C, copy/paste, fonts and theme. No webview, no xterm.
- **Beside placement**: the terminal opens in a NEW column beside the active
  one (`ViewColumn.Beside`) — never taking over the column you are looking at
  (same as Claude Code).
- **Entries**: activity-bar whale icon + editor-title whale button + command
  palette (`dsh-tui: Start new session`, etc.).
- **Sidebar session list**: activity bar → session history (title + compact
  relative time, like the Claude Code sessions sidebar); clicking an entry
  resumes THAT session in a fresh terminal on the Beside column.
- **Resume last session**: `--resume` (reads `~/.dsh-tui/resume.txt`).
- **Resume a specific session**: injected via the `DSH_TUI_RESUME_SESSION`
  environment variable (the dsh-tui profile's `cordis.patch.yml` reads it at
  boot) — deliberately WITHOUT `--resume` (the launcher would overwrite the
  env from `resume.txt`; verified in `bin/dsh-tui.js`).
- **Env injection**: `DSH_TUI_LANG`, `$VISUAL` (`code -w` when unset), optional
  `$DSH_HOME` are passed to the terminal environment.
- **Auto start/stop**: open = start; close the terminal = the process ends;
  repeated opens just focus (dedupe).
- **Status bar**: a `DeepSeek` item appears while a session exists.

## Prerequisites

- VS Code ≥ 1.90
- Global DSH CLI + dsh-tui: `npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui`
- `DEEPSEEK_API_KEY` for running models.

## Install

Build from source (not yet on the Marketplace):

```sh
npm install
npm run package
code --install-extension dsh-tui-vscode-0.3.0.vsix --force
```

## Usage

1. Click the activity-bar **whale icon** (or the editor-title whale button, or
   `dsh-tui: Start new session` in the command palette);
2. A **DeepSeek** terminal opens in a NEW column beside your current one and
   runs `dsh-tui` automatically;
3. First run bootstraps the `dsh-tui` profile (needs pnpm);
4. Click any entry in the sidebar session list to resume THAT session in a
   fresh terminal;
5. Close the terminal to end the session; double `Ctrl+C` inside the TUI exits.

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `dsh-tui-vscode.command` | `dsh-tui` | Launch command (resolved by the shell via PATH) |
| `dsh-tui-vscode.extraArgs` | `[]` | Extra CLI args, e.g. `["--lang","en"]` |
| `dsh-tui-vscode.lang` | `""` | `""`/`zh`/`en`, exported as `DSH_TUI_LANG` |
| `dsh-tui-vscode.injectEditor` | `true` | Export `$VISUAL` when unset |
| `dsh-tui-vscode.editorCommand` | `code -w` | Value exported as `$VISUAL` |
| `dsh-tui-vscode.dshHome` | `""` | `$DSH_HOME` override (empty = inherit) |

## How it works

- **Session**: `vscode.window.createTerminal({ name: 'DeepSeek', cwd, env,
  iconPath, location: { viewColumn: Beside }, isTransient: true })` — the same
  shape as the official Claude Code extension's terminal launch; the command is
  sent once the shell is ready (shell integration or a fallback delay).
- **Resume a specific session**: the profile's `cordis.patch.yml` reads
  `DSH_TUI_RESUME_SESSION` at boot (`sessionId: !!js process.env.DSH_TUI_RESUME_SESSION
  ?? ...`); the extension injects it into the terminal env and runs WITHOUT
  `--resume` (the launcher would clobber the env from `resume.txt`).
- **Session list**: reads DSH session logs under `~/.dsh/sessions` (zstd),
  titles follow the TUI contract (last `session/title` event wins, falling back
  to the first user message).
- **Dedupe**: with an existing DeepSeek terminal, `start` just focuses it;
  `resume` always starts fresh.

## Known limitations

- Session content is terminal content: scrollback is managed by the VS Code
  terminal (same as Claude Code's terminal mode).
- Specific-session resume requires the dsh-tui profile's `cordis.patch.yml`
  (0.6.1+).

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
