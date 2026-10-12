# Native file review experiment

## Scope
Only this extension was changed. VS Code, dsh-tui and DSH code were not modified. No proposal flag, host injection, or user-file baseline replay is used.

## What this tests
Instead of drawing replacement decorations, the extension asks VS Code to capture selected file originals before external writes using the locally available `ChatResponseStream.externalEdit` method. VS Code should own the file review, old-line rendering, navigation and Keep / Undo.

This is explicitly an experiment. Stable participant registration works in VS Code 1.141.0; externalEdit is not declared in the public stable API and availability is checked at runtime. Future releases may remove or restrict it. A functioning VS Code chat model selection is required even though this participant never calls the model. The fake no-inference provider used in isolated tests is not registered in the installed extension.

## Entry points after reloading the extension
1. For one file, right-click the editor and choose **dsh-tui: Start native review for current file (experimental)**. For all open ordinary text tabs, use **Start native review for open files (experimental)**. For a custom selection, use **Start native file review (experimental)**.
2. The file selection is limited to 1–100 existing workspace text files (each up to 256 KiB), without unsaved user changes or previous unresolved legacy edits.
3. Wait for the status bar to show **Finish native review** (the compatibility status must report `snapshotReady: true`). Do not ask dsh-tui to edit while the status still says starting.
4. Ask the existing dsh-tui terminal to change only these selected files.
5. Click **Finish native review** in the status bar. Review the files using native controls.
6. After tracking finishes, use **dsh-tui: Show native review controls (experimental)**, the status-bar **Review tracked files** item, or the editor context command to reopen VS Code's native review controls for a tracked file. This delegates to VS Code's existing `chatEditor.action.reviewChanges`; the extension does not redraw Keep / Undo or the diff.
7. **dsh-tui: Show native review compatibility status** displays capability and snapshot evidence. The status-bar count is tracked-file count, not unresolved-change count.

## Continuation verification (2026-10-12)
- The continuation command was exercised through its actual extension command in an isolated VS Code 1.141.0 window. After tracking, the status bar pointed to `nativeReviewShow`; native whole-file Undo restored the editor and disk, Keep survived a later Undo attempt, and Keep-first / Undo-second preserved the first change. Evidence: `docs/reference/continuation-runtime/dev-extension/docs/reference/native-continuation-runtime-result.json`.
- Legacy lists, title actions and batch actions exclude native-owned files without deleting stored originals. Legacy Keep / Undo / Compare on such a file opens native review instead of deciding for the user.
- Returning files holds a gate across the confirmation and document-loading interval; new tracking cannot start during it. Failed file reads retain ownership. Subsequent explicitly started native review for a saved owned file remains supported.
- 62 local review checks and syntax checks passed. This run captured no new screenshots and performed no independent Copilot pixel comparison. Existing dark/light/long-deletion screenshots remain historical visual evidence, not proof of pixel equivalence.

## Current display verification (2026-10-12)
- 67 local checks pass, including rejection of incomplete original lines, an unsettled theme, or an obscured native overlay. These synthetic checks validate the observer only; actual screenshots remain required.
- Fresh dark/light/long-deletion screenshots were inspected under `docs/reference/display-clean-runtime/dev-extension/docs/reference/`. All show native review through the extension's `nativeReviewShow` entry; the right-bottom overlay is unobscured. The long original zone contains all eight Chinese lines (351 rendered characters).
- The initial `display-runtime/` capture is not accepted as unobscured evidence because a VS Code test notification covered the overlay. Only the independent test window used `notifications.clearAll`; no user notifications were changed.
- The independent test profile has no GitHub sign-in session; the installed Copilot 0.69.0 manifest alone is not a Copilot-generated edit reference. No credentials were copied and no Copilot inference was requested. Independent pixel comparison remains false. See `docs/native-review-visual-verification.md` for the matched-observation checklist.

## Limitations
- This is a selected-file, explicitly started experiment; it is not yet automatic or fully equivalent to Copilot's complete workflow. Native tracking observes every modification of selected files during the tracking interval, not only proven dsh-tui edits. Do not manually edit these files or run other rewriting programs during that interval. Finish explicitly after dsh-tui completes; a quiet filesystem alone does not establish completion.
- The current-file shortcut and open-file shortcut were exercised through their actual installed command registrations in the isolated test host. Three open files were tracked together. An eight-line Chinese deletion (351 rendered characters, exceeding the old 160-character cutoff) remained visible in full and native Undo restored exact CRLF content. Evidence: `native-review-long-deletion.png` and `native-runtime-result.json`.
- Existing yesterday edits remain in the legacy review. They are never reverted and replayed to force a native snapshot.
- New/deleted files and paths outside the selection are not covered by this experiment.
- Selected native-owned paths remain excluded from the legacy watcher so unresolved native decisions do not get duplicated. A subsequent edit should start another native tracking request. After all native changes are kept/undone and saved, **Return resolved native files to ordinary tracking** returns ownership explicitly after a confirmation; it never accepts/discards native changes itself.
- Actual dark and light editor evidence is saved under `docs/reference/native-review-{dark,light}.png`; these show the native renderer, not a separate independent Copilot screenshot comparison.
- Logic and capability checks do not establish pixel-level appearance. `native-runtime-result.json` states whether actual visual comparison was performed.
- Normal working windows were not reloaded automatically. Changes become active after a user-initiated window reload.

## Local verification
`node --test out/test/native-display-evidence.test.js out/test/edit-review-core.test.js out/test/native-review-core.test.js out/test/edit-review-integration.test.js out/test/native-review-wiring.test.js out/test/native-review-release.test.js`

The independent test window uses only extension-owned fixture files and data directories. Test-only dummy model requests throw immediately if inference is attempted. Backups of the three existing modified files are under `docs/reference/pre-native/`.
