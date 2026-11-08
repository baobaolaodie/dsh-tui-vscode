<div align="right">

English · [简体中文](ide-selection-channel_ZH.md)

</div>

# The IDE selection channel

Typing an `@path#L12-14` mention works, but it costs the user a keystroke pattern and it reads the file from disk — which is wrong the moment the buffer has unsaved edits. The IDE selection channel replaces both problems: the editor pushes what is actually selected, and dsh-TUI attaches it at submit time.

## Shape

On activation the extension starts a **loopback WebSocket server** on a random `127.0.0.1` port and advertises it two ways:

- **Environment, direct.** Terminals the extension launches receive `DSH_TUI_IDE_PORT` and `DSH_TUI_IDE_TOKEN`, so they can connect without looking anything up.
- **A lock file, as fallback.** `~/.dsh-tui/ide/<port>.lock` holds `{port, token, workspaceFolders, pid}` so a dsh-tui the user started by hand can find a server by scanning the directory and matching on workspace. The directory is created `0700` and the file `0600`; on Windows those mode bits only reach the read-only attribute, so the token separates processes rather than local accounts.

Only loopback is used, and the token is per server instance.

## Handshake

The protocol is version 2: the client sends `ide/hello` carrying the token and its protocol version, and the server answers `ide/hello_ack` with its own version and the workspace folders. A token or version mismatch is refused.

The workspace folder list only narrows the candidates. When several VS Code windows open the same workspace, every lock file matches, and a manually started dsh-tui takes the matches in port order — so it may connect to the other window.

## Connecting at startup

Sessions the extension launches know where to go: the port and token come from the environment, and their own window's server is dialed first. The extension creates the terminal only after that server is listening (and creates it anyway if startup failed), so a click on a freshly opened window still gets a terminal that points at its own window rather than one that can only be found by scanning.

A session started by hand does have to scan, and its first dial can lose to a stall: loading the DSH kernel blocks the main thread for hundreds of milliseconds to several seconds, while the per-attempt budget is 300 ms. A dsh-tui build that includes the upstream connect-phase retry keeps trying — four further attempts with a 0.5 s / 1.5 s / 3 s / 6 s backoff, each still under 300 ms, which bounds the whole window at roughly 10–12 seconds. Every attempt rescans `~/.dsh-tui/ide/`, so a lock file written after the TUI started still counts, and a successful handshake cancels whatever is pending.

The retry stops at the first successful connection. After a connection drops, the channel still degrades silently: the cached selection is cleared, the badge goes away, and nothing reconnects until the next session or a working-directory change.

Known boundaries:

- **Several windows on one workspace.** Both lock files match, and the client takes the matches in port order, so a manually started TUI can land on the other window's server. A session the extension launched is not exposed to that choice: its own server is named by the environment and dialed first.
- **A stall longer than the window.** About ten seconds is a fixed budget; a slow enough machine can still spend the session without a channel, and the retry is not unbounded.
- **A selection that is already stale.** The server can only replay what it last heard (see below), so an editor that closed without pushing an empty selection leaves that memory behind.

## What gets pushed

Selection changes are debounced **300 ms** and then sent as a `selection_changed` notification:

```json
{ "path": "…", "startLine": 0, "endLine": 2, "isEmpty": false, "text": "…", "documentVersion": 7 }
```

Line numbers are 0-based, `text` is the editor buffer's own selection text — unsaved edits included — and `documentVersion` lets the receiver reason about staleness. dsh-TUI attaches the block verbatim rather than re-reading a possibly-stale file, and shows a `⧉ Selected N lines from …` indicator line.

The push is capped at 200,000 characters, above dsh-TUI's own 50,000-character limit, so the cap is a bandwidth and memory guard rather than a correctness boundary.

Turning `dsh-tui-vscode.autoInsertMention` off does not simply stop pushing: it first cancels any pending debounced push, then sends one empty-selection notification, so a snapshot dsh-TUI is already holding does not get attached to the next message.

A client that connects later does not have to wait for the next selection change: the server keeps the most recent non-empty frame and sends it once, immediately after `hello_ack`. An empty selection clears that memory. When the frame was already typed into the terminal as an `@path#L…` mention — the fallback below — the extension registers that frame's fingerprint and the replay is skipped, so one message never carries the same context twice. The fingerprint lives in memory, so an extension-host restart forgets it.

## When the channel is unavailable

The extension falls back to typing `@relative/path#Lstart-end` into the running session's terminal. That fallback has its own precondition: an extension-owned session terminal must exist. The terminal is matched by name, so it still counts after dsh-tui has exited inside it — the reference goes to the terminal rather than to the clipboard, and a shell sitting at a prompt simply receives the text. With neither a client nor a terminal, nothing is typed.

## Lifecycle

Server startup failure degrades silently — everything else in the extension keeps working, and the failure is only logged. On deactivation the lock file and listeners are cleared, with a **synchronous** stop issued first: `start()` is asynchronous, and if the extension deactivated before it settled, a stop that only cleared the handle it had created would leave an unowned server behind. The host can exit without draining the microtask queue, so the synchronous pass matters.

## Version gate

Both sides of the handshake arrived in **dsh-tui 0.11.0**; dsh-tui 0.10.x has no `ide-channel` module at all. `IDE_PROTOCOL_VERSION` is still `2` in 0.15.0, and the extension-side half — speaking protocol v2 — arrived in **dsh-tui-vscode 0.7.0**.

The connect-phase retry is newer than both gates and needs a dsh-tui build that carries the upstream fix; **no released dsh-tui has it yet**. Without that build, a first dial that fails still costs the session its channel.

The earlier design note in [at-mention-design.md](at-mention-design.md) is a **0.6.2–0.6.3 snapshot** and describes the pre-channel behaviour, including the absolute-path form of mentions; treat it as history.
