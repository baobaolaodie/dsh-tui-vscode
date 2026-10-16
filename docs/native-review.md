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

## Current display verification (2026-10-13)

- 默认稳定路径已在独立 VS Code 1.141.0 宿主实际检查 Default Dark+、Default Light+ 和 Default High Contrast。
- CodeLens 的 Keep/Undo 通过真实鼠标点击执行；无改动保存后按钮仍有效；连续已核验文件工具写入后 fresh Undo 恢复正确内容。
- 深色主题下使用 `$(undo)` 的 Undo 入口可辨认；绿色新内容和红色旧文字可见。
- 完整 8 行中文删除在 Compare with original diff 中保留；实际 Undo 恢复精确 CRLF 内容。
- fresh 截图和结构化 DOM 证据：Proma 会话工作台 `stable-ui-2/screenshots/`。截图仅证明本扩展稳定路径在该宿主和固定 fixture 下可用，不声称与独立 Copilot 像素一致。

### Automatic native caveat

本轮额外验证了自动 `response.externalEdit`：首次事务能取得 snapshot、显示完整旧行和深/浅/高对比 Keep/Undo，并可点击 Keep。但同一文件 Keep 后再次启动 externalEdit，当前 VS Code 1.141.0 的原生 entry/lifecycle 没有稳定生成第二轮 Undo 控件。因此自动 native 选项默认关闭，不能把这个实验当作默认交付；用户可明确开启 `dsh-tui-vscode.editReview.native` 自行接受宿主兼容风险。手动 native tracking 仍保持原实验的显式 Start/Finish 流程。

## Limitations
- This is a selected-file, explicitly started experiment; it is not yet automatic or fully equivalent to Copilot's complete workflow. Native tracking observes every modification of selected files during the tracking interval, not only proven dsh-tui edits. Do not manually edit these files or run other rewriting programs during that interval. Finish explicitly after dsh-tui completes; a quiet filesystem alone does not establish completion.
- The current-file shortcut and open-file shortcut were exercised through their actual installed command registrations in the isolated test host. Three open files were tracked together. An eight-line Chinese deletion (351 rendered characters, exceeding the old 160-character cutoff) remained visible in full and native Undo restored exact CRLF content. Evidence: `native-review-long-deletion.png` and `native-runtime-result.json`.
- Existing yesterday edits remain in the legacy review. They are never reverted and replayed to force a native snapshot.
- New/deleted files and paths outside the selection are not covered by this experiment.
- Selected native-owned paths remain excluded from the legacy watcher so unresolved native decisions do not get duplicated. A subsequent edit should start another native tracking request. After all native changes are kept/undone and saved, **Return resolved native files to ordinary tracking** returns ownership explicitly after a confirmation; it never accepts/discards native changes itself. If a tracked file is deleted, use **Return current resolved file to ordinary review** only after confirming that native deletion has been handled externally; the command stops protection for that missing path without recreating it and leaves other tracked paths owned.
- Actual dark and light editor evidence is saved under `docs/reference/native-review-{dark,light}.png`; these show the native renderer, not a separate independent Copilot screenshot comparison.
- Logic and capability checks do not establish pixel-level appearance. `native-runtime-result.json` states whether actual visual comparison was performed.
- Normal working windows were not reloaded automatically. Changes become active after a user-initiated window reload.

## Local verification
`node --test out/test/native-display-evidence.test.js out/test/edit-review-core.test.js out/test/native-review-core.test.js out/test/edit-review-integration.test.js out/test/native-review-wiring.test.js out/test/native-review-release.test.js`

The independent test window uses only extension-owned fixture files and data directories. Test-only dummy model requests throw immediately if inference is attempted. Backups of the three existing modified files are under `docs/reference/pre-native/`.
