# Changelog

All notable changes to this project are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/). Versions are recorded in git tags and this document.

## Unreleased

### Added

- **Rename/delete sessions from the sidebar**: hover/right-click an entry to rename (appends a `session/title` zstd frame, `seq` continued — the same contract as the dsh-TUI `/resume` picker; non-zstd legacy logs are refused, never corrupted) or delete (realpath containment check so a symlink cannot steer the removal outside the sessions root; modal confirmation before deleting).

### Changed

### Fixed

- **Fixed empty sidebar session list**: the `dshHome` config default `""` was passed into the data layer and not treated as absent (`??` does not handle empty strings), so the sessions root resolved to the relative path `sessions` and the list was always empty — root resolution now treats empty and unset identically, with a regression test.
- **Fixed unresponsive right-click rename/delete**: `view/item/context` menu commands receive the selected TreeItem as their first argument, not command arguments — the session id/log path now ride on the TreeItem and are read back by the commands.
- **Watch newly created group directories**: a group directory that appears after activation (first session in a brand-new working directory) was not in the fs.watch list, so the list did not auto-refresh while the session ran — watchers are now synced idempotently after every reload.

- **Fixed multi-frame zstd session-log decoding**: persisted logs are chains of zstd frames (one per durable flush); the previous whole-buffer decompress failed on large (multi-frame) logs (code -70), so CONDUCTED sessions showed as "untitled" in the sidebar and lost their working-directory grouping. Frames are now walked structurally (RFC 8878) and decompressed one by one, tolerantly skipping torn frames (with tail re-sync) — titles and cwd are fully recovered.
- **Sidebar now shows only the current VS Code workspace's sessions**: reuses dsh-TUI's `sessionCwdMatches` ownership semantics (exact + workspace subdirectories; HOME / drive-root / UNC-root container boundaries match exactly only; parent-directory sessions never leak in), union over multi-root workspaces, empty list when no workspace is open.
- **Boot-only sessions and sub-agent runs are hidden**: sessions with no human prompt (`hasPrompt=false`, same as the dsh browser) and delegated runs with header `origin: 'subagent'` no longer appear; the title fallback chain now ends at first human prompt → working-directory basename.
- **Performance: session listing now uses bounded window reads** (64 KB head + 128 KB tail, modeled on dsh-TUI's frames.ts) — only the two ends of each log are read; sessions filtered out by workspace/empty/subagent never pay for the tail read. On this machine's 101-session corpus the full refresh dropped from 1714 ms to 524 ms (233 ms filtered).

## [0.5.1] - 2026-08-16

> direct-push, no PR / 直推提交，无关联 PR

- **Fixed stale Marketplace-page README**: the vsix uploaded for v0.5.0 contained a pre-publish README ("暂未上架 Marketplace") — republished so the Marketplace page matches the repository (extension-panel install first);
- **chore**: cleaned up a Path-B-era leftover — removed the deleted `src/webview` entry from `tsconfig.json` excludes.

## [0.5.0] - 2026-08-16

> direct-push (pre-branch-protection), no PR / 直推提交（分支保护启用前），无关联 PR

- **Published to the VS Code Marketplace**: v0.5.0 released via the web upload (the official "manual publish" path); installable directly from the extension panel;
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
