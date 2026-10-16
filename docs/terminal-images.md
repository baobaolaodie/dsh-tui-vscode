<div align="right">

English · [简体中文](terminal-images_ZH.md)

</div>

# Terminal images — why the gate looks like this

The README states the three conditions and the two settings. This note records why the extension checks them the way it does, what it deliberately does not claim, and which question is still open.

## The failure this exists to prevent

When the conditions are not met, the image area must show **half-block character art**, never an empty slot.

The extension exports `DSH_TUI_IMAGE_PROTOCOL` for every session it launches. `sixel` asks dsh-tui for real raster images; `none` asks for the character-art fallback; `auto` removes the variable entirely and lets dsh-tui decide.

`auto` is a removal rather than an omission because VS Code overlays the environment passed to `createTerminal` onto the environment the terminal would otherwise inherit. Leaving the key out would let a value exported by your shell profile, or inherited from the VS Code process, reach dsh-tui and silently pin a protocol — which is exactly the state `auto` is meant to escape.

The pinning exists because VS Code's `@xterm/addon-image` answers the Kitty graphics query with an `OK` that was never verified against an actual draw, while dsh-tui prefers Kitty over Sixel. The artwork was therefore erased and never redrawn. Pinning Sixel avoids that path.

## The three observations

VS Code exposes no API for the renderer actually in use, so the extension cannot ask "can this window paint images?". It reads three values instead:

1. **`terminal.integrated.enableImages`, snapshotted once at `activate()`** and deliberately not refreshed inside that window.
2. **`terminal.integrated.gpuAcceleration`**, snapshotted at the same moment.
3. **The live `terminal.integrated.enableImages`.**

A session is given `sixel` only while all three allow it. The window-start snapshots exist because the extension cannot observe when VS Code actually builds a terminal's renderer; the live read catches a setting that was turned *off* mid-window.

The practical consequence: turning `enableImages` on does not take effect for sessions started in that same window. The extension keeps exporting `none`, so the image area stays visible as character art, and each session start says so and offers a **Reload Window** button. Only sessions started after the reload get `sixel`.

That reload notice is deliberately **not** one-shot. It reappears on every session start until the window is reloaded, because the state it describes is still true. The "enable images" notice is the one that is asked once — with a deliberate exception: if the settings write failed, nothing was written, so the next session start offers the one-click path again rather than leaving you stuck. The retry is held by the window's own state rather than by the persisted marker, because clearing that marker is fire-and-forget and a delayed or rejected clear must not silence the retry the failure just promised.

## Settings scopes

`terminal.integrated.enableImages` has window scope, so a workspace or folder override outranks the Global value the extension writes. A write that *is* accepted but has no effect would otherwise look like success.

The extension therefore inspects every scope with `Configuration.inspect()` **before** writing and lets the highest-precedence scope that sets anything decide — folder over workspace over Global, with a scope that sets nothing skipped rather than read as an override or as a success:

- An explicit `false` at the deciding scope defeats the Global write. Nothing is written, and you get manual instructions instead of a reload offer.
- A `true` there means the setting is already effectively on, so the write goes through and the reload offer still goes out.

The verdict deliberately never re-reads the setting after writing. `Configuration.update()` resolves before the new value reaches the extension host, so a read taken immediately afterwards can still see the old value and turn a successful click into a false failure.

## Residual risk

These are known and not claimed solved:

- VS Code has no API reporting which renderer is active, so the gate cannot be exact.
- `gpuAcceleration: auto` can still resolve to VS Code's **DOM renderer** (its non-WebGL renderer) on a machine without a usable GPU. The gate allows `sixel` there; the character-art fallback is what keeps the worst case visible.
- A `gpuAcceleration` change made mid-window is only re-read after the reload that restarts the extension host.

## Version gates

`DSH_TUI_IMAGE_PROTOCOL` is absent in dsh-tui 0.9.0 and 0.9.1 and present from **0.10.0** onward; it is still read in 0.15.0 (`lib/types/ink/ink.js`), and dsh-tui still prefers Kitty over Sixel, so pinning Sixel remains justified. The extension-side half — injecting the variable at all — arrived in **dsh-tui-vscode 0.7.5**.

Runtime-verified on Windows 11 (10.0.26200) + VS Code 1.140.0 + dsh-tui 0.15.0: the extension's real-extension-host e2e suite passes there, including the guarded test that resumes a real dsh-tui session. Other platforms, remote setups and other VS Code versions are unverified.

## Open question

The extension's gate assumes a reload is required, and `.specs/adr/006` states the stronger claim that the setting "does nothing until the window is reloaded" because VS Code builds the image addon only while loading a window. Reading the VS Code 1.140.0 bundle suggests the addon is evaluated **per terminal**, when that terminal's WebGL renderer is built: terminals that already exist keep their old state, but a terminal created after the setting changed reads the live value and does get the addon — and this extension creates a new terminal for every session.

If that reading is right, the *reason* given for the gate is too strong, while the gate itself and the reload advice still hold (the extension's own window-start snapshot is what suppresses `sixel`). Settle it with `.specs/tools/terminal-probe/da1-probe.mjs` on a terminal created after a mid-window write — `?62;4;9;22c` in the reply means the addon attached.
