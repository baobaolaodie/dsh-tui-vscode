# Changelog

All notable changes to this project are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/). Versions are recorded in git tags and this document.

## Unreleased

### Added

- **Published to the VS Code Marketplace**: v0.5.0 released via the web upload (the official "manual publish" path); installable directly from the extension panel.

### Changed

### Fixed

## [0.5.0] - 2026-08-16

> direct-push (pre-branch-protection), no PR / 直推提交（分支保护启用前），无关联 PR

- **Multiple concurrent sessions (aligned with Claude Code)**: every "Start new session" / whale-button click opens a NEW DeepSeek terminal + session instead of focusing the old one; older sessions keep running in their own terminals; "Focus" and "Terminate" act on the most recently created terminal; closing a terminal ends only that session.

## [0.4.1] - 2026-08-16

> direct-push (pre-branch-protection), no PR / 直推提交（分支保护启用前），无关联 PR

- **Session titles aligned with the web**: reads the dsh-storage ledger (`~/.dsh/storages/session_projcache.json` `rows.title.val` — the web session list's title source) — sessions titled in the web no longer show as "未命名会话"; title precedence: log `session/title` event → storage title → first user message.

## [0.4.0] - 2026-08-16

> direct-push (pre-branch-protection), no PR / 直推提交（分支保护启用前），无关联 PR

- **Session history rebuilt (grouped by project)**:
  - Sidebar becomes a TREE: project groups (cwd short name + session count) → session entries, so it is obvious which project each session belongs to; projects sorted by most recent activity;
  - Entry = title (last `session/title` event → first user message → "未命名会话") + compact relative time; full path/ID in the tooltip;
  - Within a group, sorted by last-used (`~/.dsh-tui/last-used.json`, the same MRU the TUI `/resume` uses), falling back to creation time;
  - **Tolerant parsing**: logs without a `session` header (empty logs/format differences) still yield entries (id from the session dir, project from the group-dir decode, time from the file mtime) — previously filtered sessions are now all visible;
  - **Auto-refresh**: watches `~/.dsh/sessions` changes (including each project group dir); new sessions appear immediately; terminal open/close and the manual refresh button also trigger a refresh;
  - Fixed group-dir decoding: the drive colon is also encoded as `-` and is now restored (`--C-Users-...--` → `C:\Users\...`); hyphenated project names decode lossily — a known limitation.

## [0.3.0] - 2026-08-16

> direct-push (pre-branch-protection), no PR / 直推提交（分支保护启用前），无关联 PR

- **Switched to REAL integrated terminals (aligned with the official Claude Code terminal-mode source)**:
  - Removed all webview/PTY infrastructure (node-pty, xterm, esbuild, OSC, webview panel) — the vsix shrank from 3.7MB to 327KB;
  - `createTerminal({ name: 'DeepSeek', location: { viewColumn: Beside }, env, iconPath, isTransient })` + run the CLI once the shell is ready — same shape as the official extension;
  - Beside placement: a new column beside the editor; terminal tab carries the whale icon and the DeepSeek title;
  - Sidebar becomes a session-history list (title + compact relative time, like the Claude Code sessions sidebar); clicking an entry resumes that session.
- **Fixed specific-session resume** (located by reading the launcher source): `--resume` makes the launcher overwrite the env from `~/.dsh-tui/resume.txt` → switched to the `DSH_TUI_RESUME_SESSION` env channel (read at boot by the profile's cordis.patch.yml), without `--resume`;
- **Real resume verification**: e2e adds a guarded REAL dsh-tui resume test (a successful resume creates no new session), 8/8 green;
- Fixed session-list zstd initialization (the list used to be always empty);
- Auto start/stop: closing the terminal stops the process; repeated opens just focus.

## [0.2.0] - 2026-08-16

> direct-push (pre-branch-protection), no PR / 直推提交（分支保护启用前），无关联 PR

- **Path B rebuild (official-Claude-Code-shaped)**:
  - Activity-bar `dsh-tui` icon + sidebar "会话控制" view;
  - Editor-area panel rendering the full TUI with xterm.js — fully detached from the integrated terminal;
  - node-pty (ConPTY on Windows) real PTY; `.cmd/.bat`/POSIX PATH resolved to absolute paths and wrapped by node-pty internally (self-wrapping `cmd /c` swallows child stdin — verified empirically);
  - OSC host collaboration: 52 clipboard, 11 background-query answer, 0/1/2 titles, 8 hyperlinks preserved;
  - Path links: webview web-links + `path:line[:col]` matching;
  - Switched to npm (vsce needs it to bundle node-pty into the vsix); webview bundled with esbuild;
  - e2e rewritten for the panel/PTY shape: 8 cases pass in a real extension host (Windows locally + Linux CI xvfb), incl. .cmd shim input round-trip, --resume, kill, open-path.
  - **Note**: the 0.2.0 panel shape was superseded by 0.3.0's real-terminal shape after user testing.

## [0.1.0] - 2026-08-16

> direct-push (pre-branch-protection), no PR / 直推提交（分支保护启用前），无关联 PR

- Initial Path A MVP (issue ccch1mneyyy/dsh-TUI#161):
  - integrated-terminal sessions with env injection, dedupe, `--resume`;
  - clickable file paths; `$VISUAL`/`$EDITOR` via `code -w`; status bar;
  - unit tests + real extension-host e2e (superseded by 0.2.0's panel model).
