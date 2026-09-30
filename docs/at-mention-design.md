<div align="right">

[简体中文](at-mention-design_ZH.md)

</div>

# @-mention Design Note (dsh-tui-vscode.insertAtMention)

> **Historical snapshot (0.6.2–0.6.3).** This note describes the extension's pre-0.7.0 behavior: `dsh-tui-vscode.autoInsertMention` defaulting to `false`, the forward-slash absolute path plus the space-separated `L` line hint, and no IDE selection channel. For the current behavior see [README.md](../README.md) / [README_ZH.md](../README_ZH.md) and [CHANGELOG.md](../CHANGELOG.md) / [CHANGELOG_ZH.md](../CHANGELOG_ZH.md).
>
> It records "referencing selected code / a whole file into the dsh-TUI input box", the mechanism on the dsh-TUI side, and the alignment gaps with the official Claude Code extension plus the future patch plan. issue #6 · PR #7.

## 1. Background

- issue #6: a shortcut that "references" the selected code (or the whole file when nothing is selected) into the dsh-TUI input box.
- Baseline: the official Claude Code VS Code extension's `insertAtMention` (the official one inserts `@path#Lx-y`).
- Hard constraint: dsh-TUI is **a terminal program running in a real PTY** (the DeepSeek Harness TUI); it has no webview and none of the official extension's "native panel + selection context" capability. The only input channel between the extension and it is `terminal.sendText` (typing into the PTY).

## 2. dsh-TUI's @-mention mechanism (why the extension uses absolute paths)

dsh-TUI is **centered on "the session's own working directory `state.cwd`"**, ships with its own `dsh-fs-local` FS service, and **is not aware of the VS Code workspace**. `@` mentions are expanded **at submit time** (not at input time):

```
deliverUserText(text) → expandMentions(mentionFs, state.cwd, text)
```

Key resolution in `expandMentions(src/dsh-adapter/channel.ts)`:

```ts
const absolute = isAbsolute(mention.path) ? mention.path : join(cwd, mention.path)
```

- **Relative paths** → resolved as `join(cwd, mention.path)` against the session's `state.cwd`: `dsh-fs-local` treats `cwd` as the **resolution default, not a boundary** — a `..` segment can escape it, so **referencing a path outside cwd does not require an absolute path**;
- **Absolute paths** → `isAbsolute(mention.path)` skips the join entirely and is independent of cwd; the source comment says it verbatim: *"absolute paths pass through untouched"*;
- **Resolution outcome** → a mention is attached only when resolution succeeds **and** the target exists (`stat`); a resolution or `stat` failure goes into `missing` → yellow bar "reference not found" (the original text is still sent as-is);
- Attachment model: your original text is always the first text block (the bubble shows the original text); each successfully resolved mention then **appends** one more block — text → `<attached-file path="…">`, images → an image block, directories → a list.
- **No line-range capability**: `@path#L12-14` is treated as the filename as a whole → it always raises "reference not found".
- **Input-channel limitation**: the PTY reads key by key in raw mode; if injected text contains `\n`/`\r`, ConPTY treats it as a "whole-line pipe" and **submits directly** (bypassing the input box), so injection must be single-line and must **never auto-press Enter**.

## 3. Current implementation (final shape after adaptation)

- `@` path = **forward-slash absolute path**: `editor.document.uri.fsPath` → `normalizeMentionPath()` (backslashes → `/`), guaranteeing independence from the session cwd / drive letter / separator.
- Output shapes:
  - no selection: `@D:/repo/src/a.ts`
  - single line: `@D:/repo/src/a.ts L12`
  - multiple lines: `@D:/repo/src/a.ts L12-14` (line numbers are 1-based)
  - path containing whitespace: the double-quoted form `@"D:/My Some/a.ts"` (natively supported by dsh-TUI's `extractMentions`)
- Delivery: with a running DeepSeek terminal → `terminal.show()` + `sendText(mention, false)` (single line, no Enter → it lands in the input box; the user adds a question and then presses Enter; on submit, dsh-TUI automatically attaches the whole file); no session → copy to the clipboard + show a hint.
- Entry points: `Ctrl+Alt+K` (macOS `Cmd+Alt+K`, `editorTextFocus`) + Command Palette `dsh-tui: Insert @-mention / 插入 @文件引用` (the title declared in `package.json`, quoted verbatim; its English half `dsh-tui: Insert @-mention` refers to the same Command Palette entry) + editor context menu.
- Why the line range is plain text instead of `#L`: dsh-TUI does not support it, and `#L` would break `@` parsing.

## 4. Gaps vs. the official Claude Code extension

| Dimension | Official Claude Code | dsh-tui-vscode today |
| --- | --- | --- |
| @-mention path | relative to workspace | absolute path (the session cwd does not know about the workspace) |
| Line range | `@path#L12-14` supported | only an `L12-14` plain-text hint; the whole file is attached |
| Selection context | a native channel feeds it straight into the conversation (shows N lines) | no such channel; approximated as "whole-file attachment + line-number hint" |
| Input surface | native panel | terminal input box (typed via `sendText`) |

The gap comes from dsh-TUI's architecture (session cwd-centered + no selection-context channel), not from any lack of capability in the extension.

## 4.1 The shape of the selection auto-mention capability

The official extension supports "editor selection enters the session context" in both panel and terminal modes: once code is selected, it can be referenced without any manual action; the manual fallback in terminal mode is the `Ctrl+Alt+K` shortcut (macOS `Cmd+Alt+K`), which inserts `@relative/path#Lstart-end`. The implementation details of that capability are not public.

dsh-TUI (whale, an independent cordis TUI) currently has no equivalent selection-context channel, and the only input channel between it and the extension is also `terminal.sendText`, so the capability can only be **approximated by downgrading** (see the next section).

## 4.2 Downgraded approximation (implemented in this repository, experimental)

`dsh-tui-vscode.autoInsertMention` (default **false**, experimental): when enabled, it listens for selection changes → 300ms debounce → automatically types `@absolute/path Lstart-end` into the input box of a **running** dsh-TUI via `sendText`.

- Difference from the official extension: the official one does not write the reference into the input box text; this implementation **literally types into the input box**, so it is off by default, only acts when a session is running, and de-duplicates the same selection to avoid stealing focus / flooding.
- With no running session it **silently ignores** the event (no copy, no hint) to avoid disturbing the user.
- Editors outside the file scheme (output/terminal and other non-file editors) do not trigger it.
- **Decoupled** from upstream patch #359: this extension-side work can be delivered independently; the `#L` line range / relative paths belong to the dsh-TUI upstream (issue #359), and once that lands, the gap table in §4 and the plan in §5 of this document will switch the implementation back to "relative path + #L line range".

## 5. Future plan: patch dsh-TUI to align with the official design

Goal: make `@relative/path` and line ranges work natively in dsh-TUI, so the extension can return to "relative path + line range" and the experience aligns with the official Claude Code extension. Directions (to be submitted to `ccch1mneyyy/dsh-TUI` as an RFC/Draft):

1. **Relative-path base**: make @-mention support a "workspace / caller-provided root" — the extension passes the workspace root to the TUI through the stdin initial prompt / an environment variable / lightweight IPC; **change the relative resolution base in `expandMentions`** (join against the "workspace root" instead of only `state.cwd`, or fall back by priority).
2. **Line-range syntax**: implement `@path#L12-14` / `#L12` to attach exactly the specified lines (change the file-reading path, slice by line); keep docs, fixtures, and conformance in sync (a TUI-proposal entry in the `dsh-ecosystem-spec` spec repository can be added as well).
3. **(Optional) selection-context channel**: provide a standard injection point for "N lines selected" for web/tui strategies to consume.
4. **After the patch lands**: `buildAtMention` in this extension can switch from "absolute path" back to "relative workspace path + #L line range", keeping absolute paths as a fallback (still valid).

## 6. Acceptance (future patch)

- [ ] dsh-TUI parses `@relative/path#L12-14` (or an equivalent) and attaches by line, with a clear warning for out-of-range/missing references;
- [ ] relative paths are based on "the session cwd or an explicitly passed workspace root" and are stable across drives/directories;
- [ ] extension side: relative path + line range as the primary form, absolute path as the fallback; shortcut / context-menu experience unchanged.
