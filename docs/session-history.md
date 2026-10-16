<div align="right">

English · [简体中文](session-history_ZH.md)

</div>

# Session History — where the list comes from

The sidebar is the extension's most involved piece: it reads another program's on-disk state and has to stay correct while that program keeps writing to it. This note records the sources, the tolerances, and the one place where the implementation and the intent disagree.

## Where sessions live

The root is resolved in this order:

1. `$DSH_TUI_SESSION_ROOT`, if set — it outranks everything, including the `dshHome` setting.
2. `<dshHome>/sessions`, where `dshHome` comes from the `dsh-tui-vscode.dshHome` setting, then `$DSH_HOME`, then `~/.dsh`.
3. `~/.dsh-tui/sessions`, the legacy location.

Inside a group directory each session is a directory of its own. The log file is generation-tagged: `session.jsonl`, `session.jsonl.zstd`, or `session.v<N>.jsonl[.zstd]`. DSH 0.2.0-rc.2 writes format version 4, so the current artifact is `session.v4.jsonl.zstd` — a detail only worth knowing because the matcher picks the newest generation rather than a fixed name.

## Reading a log tolerantly

Logs are **concatenated multi-frame zstd**: the TUI appends one frame per durable flush, so decompressing the whole buffer at once fails or truncates. The extension walks the RFC 8878 frame structure frame by frame, locating boundaries without decompressing, and recovers from damage three ways: a mid-file bad frame resynchronises on the zstd magic, an end-of-file frame is anchored from the EOF, and the tail frames — which carry the newest title — are never dropped.

Reads are **bounded**: a 64 KB head (capped at 128 frames) and a 128 KB tail. The middle of the file is never read, so a 15 MB log costs about 192 KB of I/O. The tail is only fetched for sessions that survive filtering. Non-zstd logs (older gzip or plain formats) fall back to a whole-file read.

## Titles

The title comes from the first source that yields one:

1. The log's own `session/title` event — last one wins.
2. The dsh storage ledger. Since DSH 0.1.5 the primary form is per session at `storages/session_projcache/sessions/<id>.json` (`rows.title.val`, then `rows.titleInput.val.first.text`); the older flat `storages/session_projcache.json` (`tables.sessions[<id>].rows.title.val`) is the fallback. The web session list reads the same ledger.
3. The first human prompt, from `user/message` or `agent/inbox/spliced` where `source.kind === 'user'`.
4. The working-directory basename.
5. The localised "Untitled session" placeholder.

Renaming appends a `session/title` frame with `seq = maxSeq + 1`. Append-only keeps concurrent TUI writes safe, at the cost of a running TUI not seeing the new title until it re-reads the log. Logs that already carry a bare title row written by an older build are upgraded in place with an atomic replace instead, because appending more rows would not repair them.

## What the list shows

Filtering matches the dsh web list's default view:

- **Current workspace only.** A session belongs to the workspace if its cwd matches a workspace root exactly or sits below it. Container directories — `$HOME`, a drive root, a UNC root — only match exactly, so opening `$HOME` does not sweep in every session underneath. Multi-root workspaces take the union.
- **No boot-only sessions.** A session with no human prompt is hidden, which is what `hideEmpty` means. An unreadable or unknown log is never hidden on that basis: unknown means "keep".
- **No delegated sub-agent runs** (`origin: 'subagent'`).
- **No archived sessions.** Archive state lives in `storages/workspace.json` under `global.archivedSessionIds` — the same set the dsh web list uses. Archiving edits only that set; the log stays on disk and the session is restorable at any time.

Within a group, sessions sort by last-used time from `~/.dsh-tui/last-used.json`, then by creation time descending. A session with no last-used entry sorts below every session that has one.

The tree refreshes on directory changes with a 500 ms debounce. `fs.watch` is not recursive, so each reload also re-watches group directories that appeared since the last pass.

## The gap between intent and implementation

The provider's own comment says that with no workspace open there is nothing to attribute sessions to, so the welcome view greets instead. The data layer disagrees: it treats an empty `workspaceDirs` array as "no filter", and the provider passes exactly that when no folder is open.

So a window with no folder open lists **every** session under the DSH home rather than none, and the start/resume welcome view never appears. The README documents this actual behaviour; the comment describes the intended one, and the fix belongs in its own change.
