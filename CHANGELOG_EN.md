# Changelog

All notable changes to this project are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/). Versions are recorded in git tags and this document.

## Unreleased

### Added

- **Configurable terminal placement**: new `dsh-tui-vscode.terminalLocation` (`editor`/`active`/`panel`, default `editor`) — `editor` keeps the historical behavior (a new column beside the active one in the central editor area), `active` reuses the current editor column, and `panel` opens in the bottom panel next to ordinary terminals; the setting applies to the next launched session.

### Changed

- **Relative-path case matching now follows the platform**: paths used to be lowercased unconditionally before comparison (the comment claimed it existed for Windows drive/directory case drift), which on a case-sensitive filesystem made `/work/Repo/a.ts` look like a file inside a `/work/repo` workspace — producing a relative reference that points at a different file. Case is now folded only on Windows / macOS, matching upstream dsh-TUI's rule.

### Fixed

- **Path escaping in the launch command and `@` mentions**: shell metacharacters in a workspace or launch path (`;` `&` `|` `$`, embedded quotes, and the `,` / `=` that cmd.exe splits command names on) were not escaped — the condition was "contains a space", so `/tmp/repo;id` reached the shell as two commands, and a Windows path containing a comma (e.g. an account name with one) was truncated by cmd with "not recognized as an internal or external command". Paths are now quoted and escaped per target shell; ordinary paths keep their existing output.
- **Oversized selections are no longer pushed unbounded**: the selection text sent to dsh-tui had no upper limit, so selecting a tens-of-MB file whole pushed the entire editor buffer. Now capped at 200k characters (above the TUI's own 50k limit, so it can still render its truncation marker). Measured: a 2 MB frame still arrives intact with the connection alive — so this cap is a bandwidth/memory guard, not a defence against a dropped link.
- **Disabling `autoInsertMention` now clears the selection on the dsh-tui side**: disabling used to only stop pushing, leaving the snapshot dsh-tui already held to be attached to the next message. An empty-selection notification is now pushed on disable, and any pending debounced push is cancelled first — it would otherwise push a non-empty selection right after the empty one.
- **IDE server stop race**: `start()` is async; if the extension deactivated before it settled, `stop()` returned early because the internal handle did not exist yet, leaving an unowned server behind. Deactivation now issues a **synchronous stop first** (clearing the lock happens in `stop()`'s synchronous section, and the host may exit right after dispose without draining the microtask queue) and stops once more after startup settles.

## [0.7.0] - 2026-09-21

> via PR [#19](https://github.com/baobaolaodie/dsh-tui-vscode/pull/19)

> ⚠️ **Version gate**: the `#L` line-range syntax requires a **dsh-TUI build that includes upstream #537** (that syntax is now implemented and merged upstream), and the IDE selection channel requires a dsh-TUI that includes **upstream #562 (the merge this extension's pushes are consumed by)**. Against an older dsh-TUI, `@` mentions will report the file as missing (the new syntax cannot be parsed) — upgrade dsh-TUI before upgrading this extension.

### Added

- **IDE selection channel (extension-side server)**: on activation the extension starts a loopback WebSocket server (`ws`) on a random `127.0.0.1` port with token handshake; session terminals automatically receive the `DSH_TUI_IDE_PORT` / `DSH_TUI_IDE_TOKEN` environment variables (env-direct discovery), and the server also advertises itself via a lock file (`~/.dsh-tui/ide/<port>.lock`, JSON `{port, token, workspaceFolders, pid}`) so manually launched dsh-tui instances can find it (lock scan). The handshake is protocol v2: `ide/hello` (token + protocolVersion) → `ide/hello_ack` (protocolVersion + workspaceFolders). Selection changes are pushed after a 300 ms debounce as `selection_changed` notifications (`{path, startLine, endLine, isEmpty, text, documentVersion}`, 0-based; `text` is the editor buffer's own selection text, unsaved edits included) — dsh-TUI attaches it verbatim as an `<attached-file … selection>` block instead of reading a possibly-stale disk copy; line ranges are normalized to an inclusive end. Server startup failure degrades silently (everything else keeps working); deactivation clears the lock and listeners.
- **e2e coverage for the IDE selection channel**: two new real-extension-host e2e tests — server lifecycle (terminal env injection consistent with the lock advertisement, plus an isolated instance with an injected temp lockRoot verifying the idempotent write/clear lock lifecycle) and WS client round-trip (lock discovery → protocol-v2 handshake with `hello_ack` consumed → receives `selection_changed` carrying coordinates, editor text and the document version).

### Changed

- **`@` mention output format migration: relative path + `#L` line range**: the output of `insertAtMention` and the automatic selection mention changes from `@absolute/path Lstart-end` (space-separated plain-text hint, unparsed by old dsh-tui) to **`@relative/path#Lstart-end`** (relativized against the extension terminal cwd = VS Code workspace root; single line `#L12`, multi-line `#L12-14`, bare path when nothing is selected; `@"path"#L…` for paths with whitespace; outside the workspace it falls back to a forward-slash absolute path still carrying `#L`). This syntax is parsed natively by upstream dsh-TUI from #537 on, and the submit-time attachment is sliced to the line range.
- **autoInsertMention upgraded to push semantics (on by default)**: with `autoInsertMention` enabled, selections are no longer typed into the running input box (which hijacks it) — they are pushed as coordinates to the running dsh-tui over the IDE selection channel (no input-box takeover; context attaches at submit time; clearing the selection pushes an `isEmpty` notification so the badge and pending attach clear immediately); when the channel is unavailable (server down / not connected) it falls back to the previous typing behavior. On by default.

### Fixed

## [0.6.6] - 2026-09-12

> via PRs [#15](https://github.com/baobaolaodie/dsh-tui-vscode/pull/15) / [#16](https://github.com/baobaolaodie/dsh-tui-vscode/pull/16) / 经 PR #15、#16 合并

### Added

- **Title/cwd fallback now reads the DSH 0.1.5 per-session ledger**: `rows.title` / `rows.titleInput.first` / `identity.cwd` from `storages/session_projcache/sessions/<id>.json` back up logs without a title or cwd (lazy — one read only when needed; the first-input fallback is capped at 80 chars like the log's first-message title; the legacy `session_projcache.json` stays as fallback).

### Changed

### Fixed

- **Multi-root follow-ups**: the delete command and the sidebar file watchers now cover `$DSH_TUI_SESSION_ROOT` and `~/.dsh-tui/sessions`; generation selection falls back to a valid lower generation when the highest name is not a regular file; a blank header cwd is treated as missing so the ledger fallback still runs; session roots that do not exist yet are re-probed on a 60 s timer so they get watched once created; the delete path verifies the target is a canonical session-log name at the exact `<root>/<group>/<session>` depth (defense in depth); `$DSH_TUI_SESSION_ROOT` still outranks an explicit dshHome pin (matching how dsh-tui itself resolves its write root); the delete/archive commands resolve roots through the configured `dshHome`, which now also takes effect live (no window reload needed); the setting description typo "绝对值路径" is corrected to "绝对路径".

- **Sidebar now reads DSH 0.1.5 Session V3 logs**: log files are matched by generation (`session.jsonl` / `session.v3.jsonl`, optionally `.zstd`, newest generation winning) and session roots are scanned in the order `$DSH_TUI_SESSION_ROOT` → `<dshHome>/sessions` → `~/.dsh-tui/sessions` — fixes sessions created after upgrading to dsh 0.1.5 disappearing from the sidebar.

## [0.6.5] - 2026-09-12

> via PR [#14](https://github.com/baobaolaodie/dsh-tui-vscode/pull/14) / 经 PR #14 合并

### Added

### Changed

- **Docs and package tidy-up**: tightened wording in the design doc, README, and setting descriptions; `docs/` is no longer bundled into the extension package, reducing the published size.

### Fixed

## [0.6.4] - 2026-08-22

> via PR [#12](https://github.com/baobaolaodie/dsh-tui-vscode/pull/12) / 经 PR #12 合并

### Added

### Changed

### Fixed

- **Exactly-once session launch command**: `sendTextWhenReady` now carries a sent flag — previously, when shell integration activated late (slow PowerShell profile) or fired again after the 1.2 s fallback had already sent the launch command, the command was typed a second time into the running dsh-tui input box and submitted by its trailing Enter (reproduced in the wild); whichever readiness signal wins, the loser path is now a no-op.

## [0.6.3] - 2026-08-19

> via PR [#10](https://github.com/baobaolaodie/dsh-tui-vscode/pull/10) / 经 PR #10 合并

### Added

- **Experimental auto @-mention on selection (off by default)**: new setting `dsh-tui-vscode.autoInsertMention` (default `false`). When enabled, selecting code in the editor auto-inserts `@absolute/path Lstart-end` into the running dsh-tui input box (300 ms debounce, only when a session is running, deduped per selection, silently ignored otherwise). This is the dsh-tui degraded approximation, decoupled from upstream dsh-TUI issue #359 (relative paths + #L ranges) and upgraded once the upstream patch lands.
- **Keybinding-conflict note**: README now documents how to rebind the default `Ctrl+Alt+K` (macOS `Cmd+Alt+K`) when it collides with extensions like opencode ("Keyboard Shortcuts" `Ctrl+K Ctrl+S`); context-menu / command-palette entries are unaffected.

### Changed

### Fixed

## [0.6.2] - 2026-08-18

> via PR [#7](https://github.com/baobaolaodie/dsh-tui-vscode/pull/7)

### Added

- **Insert @-mention command (reference selected code into the input box)**: new `dsh-tui-vscode.insertAtMention` with default shortcut `Ctrl+Alt+K` (macOS `Cmd+Alt+K`, when editor has focus), also available from the Command Palette / editor context menu — it inserts the current file or selection as `@absolute/path Lstart-end` into the running dsh-tui input box (forward-slash absolute path, independent of the dsh-tui session cwd; `@absolute/path` alone references the whole file when nothing is selected; the `@` mention attaches the file's content on submit and the range is a space-separated plain-text hint — dsh-tui does not support `#L` line-range syntax); with no running session it falls back to copying to the clipboard. Based on the official Claude Code extension's `insertAtMention` and adapted for dsh-tui.

### Changed

### Fixed

## [0.6.1] - 2026-08-17

> via PR [#3](https://github.com/baobaolaodie/dsh-tui-vscode/pull/3)

### Added

### Changed

### Fixed

- **Fixed launching under non-PowerShell Windows terminals (Git Bash etc.)**: npm global installs create both a `.cmd` shim and an extensionless bash shim on Windows; the extension previously sent the Windows absolute path of `dsh-tui.cmd` directly to bash, which swallowed the backslashes and reported `C:Users...: command not found`. The launch path now respects the terminal shell: bash/MSYS/Cygwin/WSL prefer npm's bash shim and convert the path to POSIX form (`/c/...`, `/cygdrive/c/...`, `/mnt/c/...`) before sending; PowerShell/CMD keep the existing `.cmd/.exe` resolution.

## [0.6.0] - 2026-08-17

> via PR [#1](https://github.com/baobaolaodie/dsh-tui-vscode/pull/1)

### Added

- **Rename/delete sessions from the sidebar**: hover/right-click an entry to rename (appends a `session/title` zstd frame, `seq` continued — the same contract as the dsh-TUI `/resume` picker; non-zstd legacy logs are refused, never corrupted) or delete (realpath containment check so a symlink cannot steer the removal outside the sessions root; modal confirmation before deleting).
- **dsh-native archiving**: the hover "Archive" button adds a session to the workspace domain's archive set (`archivedSessionIds` in `storages/workspace.json` — the same source the dsh web list reads): the session disappears from every grouping surface while its log and accounting slot are retained, restorable anytime; the "Manage archived sessions" command (QuickPick) restores or permanently deletes; the list filters archived sessions by default (web-consistent). Delete moved behind the right-click menu as "Delete permanently" (destructive actions stay off the hover buttons).

### Changed

### Fixed

- **Fixed empty sidebar session list**: the `dshHome` config default `""` was passed into the data layer and not treated as absent (`??` does not handle empty strings), so the sessions root resolved to the relative path `sessions` and the list was always empty — root resolution now treats empty and unset identically, with a regression test.
- **Fixed unresponsive right-click rename/delete**: `view/item/context` menu commands receive the selected TreeItem as their first argument, not command arguments — the session id/log path now ride on the TreeItem and are read back by the commands.
- **Watch newly created group directories**: a group directory that appears after activation (first session in a brand-new working directory) was not in the fs.watch list, so the list did not auto-refresh while the session ran — watchers are now synced idempotently after every reload.
- **Fixed rename/delete doing nothing in real VS Code**: ① view/item/context commands receive the TreeItem — session identity now rides on the STANDARD fields (`id`/`resourceUri`) with the custom properties kept as fallback; ② the delete containment check is case-insensitive on Windows (`vscode.Uri.file(...).fsPath` lowercases the drive letter, so a case-sensitive prefix test refused every delete); ③ the `@bokuweb/zstd-wasm` module corrupts in long-lived Electron hosts (compress emits all-zero frames, or frames with a valid magic whose content does not decompress) — added: module resolution through a `getZstd()` indirection, round-trip verification of every compressed frame (a corrupt frame is never written), corruption detection + module reload retry (both listing and rename paths), and an explicit error instead of silent failure.
- **Test-suite hardening (maximal coverage)**: 4 new e2e chain tests — full command chain (dialog stubbing + temp sessions + both TreeItem argument shapes), full tree-view chain (workspace filter / empty / subagent verified in the real extension host), watcher auto-refresh for a new group directory, and rename recovery from a corrupt wasm state (honest SKIP when healthy); new unit tests for empty-string dshHome fallback, delete containment case folding, and frame verification.

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

- **Switched to REAL integrated terminals (aligned with the official Claude Code terminal mode)**:
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
