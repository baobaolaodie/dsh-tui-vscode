<div align="right">

English · [简体中文](ide-selection-channel_ZH.md)

</div>

# The IDE selection channel

Typing an `@path#L12-14` mention works, but it costs the user a keystroke pattern and it reads the file from disk — which is wrong the moment the buffer has unsaved edits. The IDE selection channel replaces both problems: the editor pushes what is actually selected, and dsh-TUI attaches it at submit time.

## Shape

On activation the extension starts a **loopback WebSocket server** on a random `127.0.0.1` port and advertises it two ways:

- **Environment, direct.** Terminals the extension launches receive `DSH_TUI_IDE_PORT` and `DSH_TUI_IDE_TOKEN`, so they can connect without looking anything up.
- **A lock file, as fallback.** `~/.dsh-tui/ide/<port>.lock` holds `{port, token, workspaceFolders, pid}` so a dsh-tui the user started by hand can find a server by scanning the directory and matching on workspace. The directory is created `0700` and the file `0600`.

Only loopback is used, and the token is per server instance.

## Handshake

The protocol is version 2: the client sends `ide/hello` carrying the token and its protocol version, and the server answers `ide/hello_ack` with its own version and the workspace folders. A token or version mismatch is refused.

The workspace folder list is what lets a manually started dsh-tui pick the right server when several VS Code windows are open.

## What gets pushed

Selection changes are debounced **300 ms** and then sent as a `selection_changed` notification:

```json
{ "path": "…", "startLine": 0, "endLine": 2, "isEmpty": false, "text": "…", "documentVersion": 7 }
```

Line numbers are 0-based, `text` is the editor buffer's own selection text — unsaved edits included — and `documentVersion` lets the receiver reason about staleness. dsh-TUI attaches the block verbatim rather than re-reading a possibly-stale file, and shows a `⧉ Selected N lines from …` indicator line.

The push is capped at 200,000 characters, above dsh-TUI's own 50,000-character limit, so the cap is a bandwidth and memory guard rather than a correctness boundary.

Turning `dsh-tui-vscode.autoInsertMention` off does not simply stop pushing: it first cancels any pending debounced push, then sends one empty-selection notification, so a snapshot dsh-TUI is already holding does not get attached to the next message.

## When the channel is unavailable

The extension falls back to typing `@relative/path#Lstart-end` into the running session's terminal. That fallback has its own precondition: there must be a running session terminal owned by this extension. With neither a client nor a terminal, nothing is typed.

## Lifecycle

Server startup failure degrades silently — everything else in the extension keeps working, and the failure is only logged. On deactivation the lock file and listeners are cleared, with a **synchronous** stop issued first: `start()` is asynchronous, and if the extension deactivated before it settled, a stop that only cleared the handle it had created would leave an unowned server behind. The host can exit without draining the microtask queue, so the synchronous pass matters.

## Version gate

Both sides of the handshake arrived in **dsh-tui 0.11.0**; dsh-tui 0.10.x has no `ide-channel` module at all. `IDE_PROTOCOL_VERSION` is still `2` in 0.15.0, and the extension-side half — speaking protocol v2 — arrived in **dsh-tui-vscode 0.7.0**.

The earlier design note in [at-mention-design.md](at-mention-design.md) is a **0.6.2–0.6.3 snapshot** and describes the pre-channel behaviour, including the absolute-path form of mentions; treat it as history.
