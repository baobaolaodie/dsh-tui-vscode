<p align="center">
  <img src="media/readme/hero.png" width="100%" alt="dsh-tui-vscode — the DeepSeek Harness terminal running in a real VS Code terminal, in the column beside the editor" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.7.6-4D6BFE?style=flat" alt="Version 0.7.6" />
  <img src="https://img.shields.io/badge/VS_Code-%5E1.90.0-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="Requires VS Code 1.90 or newer" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-4D6BFE?style=flat" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="https://github.com/baobaolaodie/dsh-tui-vscode/actions/workflows/ci.yml"><img src="https://github.com/baobaolaodie/dsh-tui-vscode/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=baobaolaodie.dsh-tui-vscode"><img src="https://img.shields.io/badge/Marketplace-Install-4D6BFE?style=flat&logo=visualstudiocode&logoColor=white" alt="Install from the VS Code Marketplace" /></a>
  <a href="https://github.com/baobaolaodie/dsh-tui-vscode/releases"><img src="https://img.shields.io/github/v/release/baobaolaodie/dsh-tui-vscode?style=flat&color=4D6BFE" alt="Latest release" /></a>
  <a href="https://github.com/baobaolaodie/dsh-tui-vscode"><img src="https://img.shields.io/github/stars/baobaolaodie/dsh-tui-vscode?style=flat&color=4D6BFE" alt="GitHub stars" /></a>
</p>

<p align="center">
  <a href="README_ZH.md">简体中文</a>
</p>

---

**dsh-tui-vscode** runs [`dsh-tui`](https://github.com/ccch1mneyyy/dsh-TUI) inside a **real VS Code integrated terminal** — the same shape as the terminal mode of the official Claude Code VS Code extension (`createTerminal` plus running the CLI inside it). No webview, no xterm emulation: just your shell, your fonts, and the full TUI.

One click opens a **new column beside your editor**. Click again and you get another concurrent session; the first one keeps running. The sidebar lists the sessions of the workspace you have open, and clicking one resumes exactly that session.

## What it looks like

Click the whale in the editor title bar and a **DeepSeek** terminal opens on the Beside column, running dsh-tui in your shell — a real terminal, a real shell, the full TUI:

<p align="center">
  <img src="media/screenshot-deepseek-terminal.png" alt="A real VS Code window with the dsh-TUI terminal running in the column beside the editor" width="100%" />
</p>

Click again and you get another session in its own column; nothing is reused and nothing is killed for you. Here two of them run side by side, both showing dsh-tui v0.15.0:

<p align="center">
  <img src="media/readme/multi-session.png" alt="Two DeepSeek terminals running dsh-TUI side by side in separate editor columns" width="100%" />
</p>

The sidebar lists the sessions of the workspace you have open, with titles and relative times. One click resumes that session; hovering offers archive and rename, and right-click deletes permanently. (The session titles in this capture are pixelated — they name real work.)

<p align="center">
  <img src="media/readme/session-history.png" alt="The Session History sidebar listing the current workspace's sessions with relative times, and the archive and rename actions revealed on hover; the session titles are pixelated" width="374" />
</p>

## Install

**1 — Install the CLI and the TUI.** Both are npm packages; the first launch bootstraps the dsh-tui profile and needs [`pnpm`](https://pnpm.io/) on `PATH`:

```sh
npm install -g pnpm
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui
```

Node **^22.19 or >= 24** is required.

**2 — Install the extension.** Search `dsh-tui` in the Extensions view (`Ctrl+Shift+X`) and install **dsh-tui (VS Code)**, or open the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=baobaolaodie.dsh-tui-vscode). To build from source instead you need the `code` CLI on `PATH`:

```sh
git clone https://github.com/baobaolaodie/dsh-tui-vscode.git
cd dsh-tui-vscode
npm install
npm run install:local
```

**3 — Give it a model.** Either export `DEEPSEEK_API_KEY` before launching VS Code, or sign in from inside the TUI with `/auth login deepseek-account` (DSH 0.2.0-rc.1 and newer); other providers are reachable through `/provider` or `/auth`.

## Features

- **A real terminal, not an emulation** — sessions run in the VS Code integrated terminal with your default shell, so shell integration, Ctrl+C, copy/paste, fonts and theme all behave natively.
- **Beside by default** — a new column next to the one you are working in, never on top of it. `dsh-tui-vscode.terminalLocation` switches to the current column (`active`) or the bottom panel (`panel`).
- **As many concurrent sessions as you want** — each start opens a new terminal; nothing is reused and nothing is killed for you.
- **A session sidebar that knows your workspace** — titles, relative times, and one click to resume; hover to archive or rename, right-click to delete permanently.
- **Your selection, without copy-paste** — select code and it reaches the running TUI over the IDE selection channel, or press `Ctrl+Alt+K` to insert an explicit `@relative/path#L12-14` reference.
- **Start, resume, stop** — resume the last session or any session from the sidebar, and close a tab to end just that one.

## Compatibility

The extension is a thin companion; the features below live in dsh-tui itself, so each one has a minimum version there.

| Capability | Requires |
| --- | --- |
| The extension as a whole | VS Code **≥ 1.90.0**, `dsh` CLI and `dsh-tui` installed globally |
| `@path#L12-14` line ranges in mentions | dsh-tui **≥ 0.9.1** — older builds report the file as missing |
| Raster images in the terminal (`sixel`, `none`) | dsh-tui **≥ 0.10.0**; see [terminal images](#terminal-images) |
| Automatic selection context (IDE selection channel, protocol v2) | dsh-tui **≥ 0.11.0** |
| The extension-side half of both of the above | dsh-tui-vscode **≥ 0.7.5** — earlier versions never set `DSH_TUI_IMAGE_PROTOCOL` |

Beyond its minimum, dsh-tui is free to move: these two interfaces were re-checked against 0.15.0 and had not changed since the versions above.

## How it works

<p align="center">
  <img src="media/readme/how-it-works.png" width="100%" alt="Five steps: the whale button calls the extension host, which resolves dsh-tui against its own PATH and injects the environment, opens a real terminal beside the editor, runs dsh-tui in your shell, and lets the Session History view read the session logs back" />
</p>

- **Session = real terminal.** The extension only calls `createTerminal` and sends the launch command; the process, its signals, its scrollback and its clipboard are all the terminal's. The launch command is resolved to an absolute path against the **extension host's** PATH, because a login shell rebuilds `PATH` and cannot be trusted.
- **Specific-session resume goes through the environment.** The session id is exported as `DSH_TUI_RESUME_SESSION` and read at boot by the profile's `cordis.patch.yml`. `--resume` is deliberately *not* passed on that path — a bare `--resume` makes the launcher overwrite the variable from `~/.dsh-tui/resume.txt`.
- **The sidebar reads the logs, tolerantly.** Session logs are concatenated multi-frame zstd; the extension decodes them frame by frame from a bounded 64 KB head and 128 KB tail, and falls back through the log's `session/title` event, the dsh storage ledger, the first human prompt, and finally the working directory name.

## Commands

Command Palette entries are grouped under **`dsh-tui`**. Titles follow your VS Code display language.

| Command | What it does |
| --- | --- |
| `dsh-tui: Start new session` | Opens a new terminal and runs dsh-tui in it |
| `dsh-tui: Resume last session` | Runs dsh-tui with `--resume` (reads `~/.dsh-tui/resume.txt`) |
| `dsh-tui: Open dsh-TUI` | The editor-title-bar button; same as starting a session |
| `dsh-tui: Focus session panel` | Brings the most recent session terminal to the front, starting one if there is none |
| `dsh-tui: Resume session` | Resumes the session selected in the sidebar |
| `dsh-tui: Insert @-mention` | Puts the current file or selection into the running TUI's input |
| `dsh-tui: Terminate session` | Sends Ctrl+C to the most recent session terminal |
| `dsh-tui: Rename / Archive / Delete session permanently` | Session sidebar actions |
| `dsh-tui: Manage archived sessions` | Restores or permanently deletes archived sessions |
| `dsh-tui: Refresh sessions` | Re-reads the session list |

**Inserting a reference.** With editor focus, press `Ctrl+Alt+K` (`Cmd+Alt+K` on macOS) or use the editor context menu. You get `@relative/path#L12` for one line, `@relative/path#L12-14` for a range, and a bare relative path when nothing is selected; paths outside the workspace fall back to absolute ones. With no session terminal to type into, the reference goes to your clipboard instead. dsh-TUI slices the attachment to the line range at submit time rather than reading the whole file.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `dsh-tui-vscode.command` | `dsh-tui` | Launch command. Resolved against the extension host's PATH when possible; an unresolvable name is sent as typed. |
| `dsh-tui-vscode.extraArgs` | `[]` | Extra CLI arguments, e.g. `["--lang","en"]` |
| `dsh-tui-vscode.terminalLocation` | `editor` | `editor` (new column beside the active one) / `active` (current column) / `panel` (bottom panel) |
| `dsh-tui-vscode.lang` | `""` | `""` / `zh` / `en`, exported as `DSH_TUI_LANG` |
| `dsh-tui-vscode.imageProtocol` | `sixel` | What to export as `DSH_TUI_IMAGE_PROTOCOL`: `sixel`, `none`, or `auto` (removes the variable). See [terminal images](#terminal-images). |
| `dsh-tui-vscode.injectEditor` | `true` | Export `$VISUAL` when neither `$VISUAL` nor `$EDITOR` is set in the environment the extension host sees |
| `dsh-tui-vscode.editorCommand` | `code -w` | The value exported as `$VISUAL` |
| `dsh-tui-vscode.dshHome` | `""` | Override `$DSH_HOME` for sessions (empty inherits it) |
| `dsh-tui-vscode.autoInsertMention` | `true` | Push the editor selection to the running TUI (300 ms debounce) |

Sessions get more than these: `DSH_TUI_IMAGE_PROTOCOL` always, `DSH_TUI_IDE_PORT` and `DSH_TUI_IDE_TOKEN` while the selection channel is up, and `DSH_TUI_RESUME_SESSION` (plus `DSH_CC_RESUME_SESSION`) when resuming a specific session.

## Terminal images

The mascot artwork and image previews render as real raster images only when **all** of these hold:

1. **`terminal.integrated.enableImages` is `true`** (VS Code defaults to `false`). The extension offers a one-click "enable and reload" the first time a session starts without it, and never edits your settings without asking. If your workspace or folder settings pin the value, the extension will not fight them — you get manual instructions instead.
2. **`terminal.integrated.gpuAcceleration` leaves the WebGL renderer possible** — leave it at `auto` (the default) or set it to `on`. The image addon only attaches to the WebGL renderer, so `off` disables images no matter what else you change.
3. **dsh-tui is 0.10.0 or newer**, which is where `DSH_TUI_IMAGE_PROTOCOL` is understood. Older builds ignore the variable silently. On Windows, VS Code's own description adds that image protocols need ConPTY v2 or newer, which ships with Windows itself.

Enabling `enableImages` only affects a window that is reloaded afterwards, so **reload the window** after turning it on: the extension reads the value the window started with and keeps exporting `none` until then, which shows half-block character art instead of a blank image slot. While that is the case, each session start reminds you to reload.

`dsh-tui-vscode.imageProtocol` decides what is exported:

| Value | Exported | Behavior |
| --- | --- | --- |
| `sixel` (default) | `sixel` | Real raster images when the conditions above hold, half-block character art otherwise |
| `none` | `none` | Always half-block character art; the setup prompt is suppressed too |
| `auto` | *(removed)* | The variable is **removed** from the session environment and dsh-TUI decides for itself |

`auto` removes the variable rather than merely not setting it, because VS Code overlays this environment onto the one the terminal would otherwise inherit — a value from your shell profile would still reach dsh-tui and silently pin the protocol.

**Verified combination**: Windows 11 (10.0.26200) + VS Code 1.140.0 + dsh-TUI 0.15.0 — the extension's real-extension-host e2e suite passes here, including the guarded test that resumes a real dsh-tui session, alongside the terminal-launch, environment-injection, image-gate and IDE-channel assertions. Other platforms, remote setups and other VS Code versions are **unverified**; the character-art fallback keeps the worst case visible rather than blank. The long version of this — including why the gate is conservative and what remains unsolved — is in [docs/terminal-images.md](docs/terminal-images.md).

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `dsh-tui` is not found | It must be installed globally. Check `npm ls -g --depth=0`; set `dsh-tui-vscode.command` to an absolute path if your shell finds it but VS Code does not. |
| The TUI renders greyscale | Something exported `NO_COLOR` or `TERM=dumb` into the terminal environment. Launch VS Code from a normal shell. |
| `Ctrl+Alt+K` does nothing | opencode uses the same default. Rebind it in **Keyboard Shortcuts** (`Ctrl+K Ctrl+S`) by searching `dsh-tui` or `insertAtMention`; the context-menu and palette entries keep working either way. |
| `@` mentions say the file is missing | dsh-TUI is older than 0.9.1 and cannot parse `#L` ranges. Upgrade it. |
| Images show as block characters | `enableImages` is off, or the window was not reloaded after turning it on, or `gpuAcceleration` is `off`. See [terminal images](#terminal-images). |
| The sidebar is empty | Every session belongs to another workspace. Open the folder the sessions were started in. |
| The sidebar lists sessions from everywhere | No folder is open, so there is nothing to scope the list to. Open a folder. |
| No sessions at all after renaming | A running TUI does not see a new title until it re-reads the log; reopen the session. |
| A session I deleted is still on disk | Deleting removes the session directory. Archived sessions keep their logs; restore them with `dsh-tui: Manage archived sessions`. |

## UI language

The extension's own UI — command titles, view names, setting descriptions and runtime messages — follows your **VS Code display language** through the standard `package.nls*.json` plus `vscode.l10n` pipeline, with English as the default and an automatic fallback. For a Chinese UI, install the **Chinese (Simplified) Language Pack** and restart VS Code.

That is separate from `dsh-tui-vscode.lang`, which sets `DSH_TUI_LANG` and only affects the **TUI's** language.

## Development

```sh
npm run compile       # tsc -> out/
npm run typecheck     # tsc --noEmit
npm test              # node:test unit tests over the data layer
npm run test:e2e      # real extension host (@vscode/test-electron)
npm run package       # build the .vsix
```

TypeScript 5.6 compiled to CommonJS, with two runtime dependencies: `@bokuweb/zstd-wasm` for session-log decompression and `ws` for the loopback IDE channel server. CI runs the unit tests on Linux and Windows across Node 22 and 24, and the real extension host on Linux under xvfb.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout of the source tree, what CI enforces, and the release checklist.

## License

MIT © 2026 baobaolaodie. dsh-tui itself is [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI), also MIT.
