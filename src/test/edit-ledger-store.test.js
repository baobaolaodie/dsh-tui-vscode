'use strict';
/**
 * Unit tests for the pending-edit store (data layer, no vscode needed).
 * Run: node --test out/test/edit-ledger-store.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EditLedgerStore } = require('../edit-ledger-store');
const precise = require('../precise-review-core');

// ---- record ---------------------------------------------------------------
test('record infers the kind from the missing side and keeps both images', () => {
    const store = new EditLedgerStore();
    const created = store.record({ path: '/w/new.txt', after: 'one' });
    assert.equal(created.kind, 'create');
    assert.equal(created.before, null);
    const modified = store.record({ path: '/w/f.txt', before: 'one', after: 'two' });
    assert.equal(modified.kind, 'modify');
    const deleted = store.record({ path: '/w/old.txt', before: 'gone', after: null });
    assert.equal(deleted.kind, 'delete');
    assert.equal(store.size, 3);
});

test('record rejects contradictory or malformed input', () => {
    const store = new EditLedgerStore();
    assert.throws(() => store.record(), TypeError);
    assert.throws(() => store.record({}), TypeError);
    assert.throws(() => store.record({ path: '/w/f', before: 'a', after: 'b', kind: 'replaced' }), TypeError);
    assert.throws(() => store.record({ path: '/w/f', before: 'a', after: 'b', kind: 'create' }), TypeError);
    assert.throws(() => store.record({ path: '/w/f', before: 'a', after: 'b', kind: 'delete' }), TypeError);
    assert.throws(() => store.record({ path: '/w/f', after: 'b', kind: 'modify' }), TypeError);
    assert.throws(() => store.record({ path: '/w/f', before: 'a', after: 'b', provenance: 'not a tag' }), TypeError);
    assert.equal(store.size, 0);
});

test('record merges repeated AI edits into one entry and preserves the first before', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'v1', after: 'v2' });
    store.record({ path: '/w/f', before: 'ignored', after: 'v3' });
    assert.equal(store.size, 1);
    assert.equal(store.get('/w/f').before, 'v1');
    assert.equal(store.get('/w/f').after, 'v3');
});

test('a created-then-deleted file cancels out entirely', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', after: 'one' });
    assert.equal(store.record({ path: '/w/f', before: 'one', after: null }), null);
    assert.equal(store.size, 0);
});

test('a deleted-then-recreated file becomes a modify with the original before', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'old', after: null });
    store.record({ path: '/w/f', after: 'new' });
    assert.equal(store.get('/w/f').kind, 'modify');
    assert.equal(store.get('/w/f').before, 'old');
    assert.equal(store.get('/w/f').after, 'new');
});

// ---- custody --------------------------------------------------------------
test('keep drops one entry and notifies listeners once', () => {
    const store = new EditLedgerStore();
    let calls = 0;
    store.onChange(() => calls++);
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    assert.equal(calls, 1);
    const dropped = store.keep('/w/f');
    assert.equal(dropped.path, '/w/f');
    assert.equal(store.size, 0);
    assert.equal(calls, 2);
    assert.equal(store.keep('/w/f'), null);
});

test('clear drops every pending entry at once', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/a', before: 'a', after: 'b' });
    store.record({ path: '/w/b', before: 'c', after: 'd' });
    store.clear();
    assert.equal(store.size, 0);
    assert.deepEqual(store.list(), []);
});

test('update patches allowed fields only and reports changes', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    let calls = 0;
    store.onChange(() => calls++);
    const entry = store.update('/w/f', { userTouched: true, conflict: 'overlap-or-external', ignored: 1 });
    assert.equal(entry.userTouched, true);
    assert.equal(entry.conflict, 'overlap-or-external');
    assert.equal('ignored' in entry, false);
    assert.equal(calls, 1);
    // No-op patch must not notify.
    store.update('/w/f', { userTouched: true });
    assert.equal(calls, 1);
    // undefined deletes an optional field.
    store.update('/w/f', { conflict: undefined });
    assert.equal('conflict' in store.get('/w/f'), false);
    assert.equal(store.update('/w/missing', { userTouched: true }), null);
});

// ---- writes in flight -----------------------------------------------------
test('writing markers follow the canonical path key', () => {
    const store = new EditLedgerStore();
    assert.equal(store.isWriting('/w/f'), false);
    store.markWriting('/w/f');
    assert.equal(store.isWriting('/w/f'), true);
    store.clearWriting('/w/f');
    assert.equal(store.isWriting('/w/f'), false);
});

test('writing markers fold case like the ledger does on Windows', { skip: process.platform !== 'win32' }, () => {
    const store = new EditLedgerStore();
    store.markWriting('C:\\Work\\File.TXT');
    assert.equal(store.isWriting('c:\\work\\file.txt'), true);
    store.clearWriting('c:/WORK/file.txt');
    assert.equal(store.isWriting('C:\\Work\\File.TXT'), false);
});

// ---- whole-file decisions -------------------------------------------------
test('planUndo delegates the whole-file decision to the core planner', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'v1', after: 'v2' });
    assert.deepEqual(store.planUndo('/w/f', true, 'v2'), { action: 'restore-content' });
    assert.equal(store.planUndo('/w/missing', true, 'x'), null);
});

// ---- per-hunk Keep --------------------------------------------------------
test('keepHunk folds exactly one change into the baseline and drops the last one', () => {
    const before = 'a\nb\nc\nd\n';
    const after = 'a\nB\nc\nD\n';
    const store = new EditLedgerStore();
    const entry = store.record({ path: '/w/f', before, after });
    const hunks = precise.reviewDiff(before, after).hunks;
    assert.equal(hunks.length, 2);

    const first = store.keepHunk('/w/f', precise.changeHint(entry, hunks[0]), after);
    assert.equal(first.status, 'kept');
    assert.equal(first.done, false);
    assert.equal(store.get('/w/f').before, 'a\nB\nc\nd\n');
    assert.equal(store.get('/w/f').after, after);

    const remaining = precise.reviewDiff(store.get('/w/f').before, after).hunks;
    assert.equal(remaining.length, 1);
    const second = store.keepHunk('/w/f', precise.changeHint(store.get('/w/f'), remaining[0]), after);
    assert.equal(second.done, true);
    assert.equal(store.size, 0);
});

test('keepHunk refuses a stale hint instead of targeting another change', () => {
    const before = 'a\nb\nc\n';
    const after = 'a\nB\nc\n';
    const store = new EditLedgerStore();
    const entry = store.record({ path: '/w/f', before, after });
    const hint = precise.changeHint(entry, precise.reviewDiff(before, after).hunks[0]);
    assert.deepEqual(store.keepHunk('/w/f', hint, 'user-edited\n'), { status: 'stale' });
    assert.equal(store.get('/w/f').before, before);
    assert.deepEqual(store.keepHunk('/w/unknown', hint, after), { status: 'stale' });
});

// ---- per-hunk Undo --------------------------------------------------------
test('planHunkUndo is pure and commitHunkUndo publishes the written text', () => {
    const before = 'a\nb\nc\nd\n';
    const after = 'a\nB\nc\nD\n';
    const store = new EditLedgerStore();
    const entry = store.record({ path: '/w/f', before, after });
    const hunks = precise.reviewDiff(before, after).hunks;

    const plan = store.planHunkUndo('/w/f', precise.changeHint(entry, hunks[0]), after);
    assert.equal(plan.status, 'planned');
    assert.equal(plan.text, 'a\nb\nc\nD\n');
    assert.equal(plan.done, false);
    // Nothing changed until the host confirms the write.
    assert.equal(store.get('/w/f').after, after);

    store.commitHunkUndo('/w/f', plan.text);
    assert.equal(store.get('/w/f').after, plan.text);

    const current = store.get('/w/f').after;
    const rest = precise.reviewDiff(store.get('/w/f').before, current).hunks;
    const plan2 = store.planHunkUndo('/w/f', precise.changeHint(store.get('/w/f'), rest[0]), current);
    assert.equal(plan2.done, true);
    assert.equal(plan2.text, before);
    store.commitHunkUndo('/w/f', plan2.text);
    assert.equal(store.size, 0);
});

test('a partially undone created file stays pending', () => {
    const after = 'one\ntwo\n';
    const store = new EditLedgerStore();
    const entry = store.record({ path: '/w/new', after });
    assert.equal(entry.kind, 'create');
    const hunks = precise.reviewDiff('', after).hunks;
    const plan = store.planHunkUndo('/w/new', precise.changeHint(entry, hunks[0]), after);
    assert.equal(plan.status, 'planned');
    assert.equal(plan.done, false);
    store.commitHunkUndo('/w/new', plan.text);
    assert.equal(store.size, 1);
    assert.equal(store.get('/w/new').kind, 'create');
});

test('per-hunk decisions are refused after a save-participant conflict', () => {
    const before = 'a\nb\n';
    const after = 'a\nB\n';
    const store = new EditLedgerStore();
    const entry = store.record({ path: '/w/f', before, after });
    store.update('/w/f', { userTouched: true, conflict: 'save-participant' });
    const hint = precise.changeHint(entry, precise.reviewDiff(before, after).hunks[0]);
    assert.equal(store.resolveHunk('/w/f', hint, after), null);
    assert.deepEqual(store.keepHunk('/w/f', hint, after), { status: 'stale' });
});

// ---- user edits -----------------------------------------------------------
test('observeUserEdit rebases a provably disjoint hand edit into both sides', () => {
    // AI rewrote line 2; the user then edited line 1 — disjoint, so the
    // pending review keeps meaning the same thing.
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'x\na\n', after: 'x\nA\n' });
    const result = store.observeUserEdit('/w/f', 'y\nA\n');
    assert.equal(result.status, 'rebased');
    assert.equal(store.get('/w/f').before, 'y\na\n');
    assert.equal(store.get('/w/f').after, 'y\nA\n');
    assert.equal(store.get('/w/f').userTouched, false);
});

test('observeUserEdit flags an overlapping hand edit as a conflict', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'a\nb\n', after: 'a\nB\n' });
    const result = store.observeUserEdit('/w/f', 'a\nX\n');
    assert.equal(result.status, 'conflict');
    assert.equal(store.get('/w/f').userTouched, true);
    assert.equal(store.get('/w/f').conflict, 'overlap-or-external');
    // Returning to the recorded after image clears the flag again.
    assert.equal(store.observeUserEdit('/w/f', 'a\nB\n').status, 'unchanged');
    assert.equal(store.get('/w/f').userTouched, false);
});

test('observeUserEdit ignores files without an entry and writes in flight', () => {
    const store = new EditLedgerStore();
    assert.equal(store.observeUserEdit('/w/none', 'x').status, 'no-entry');
    store.record({ path: '/w/f', before: 'a\nb\n', after: 'a\nB\n' });
    store.markWriting('/w/f');
    assert.equal(store.observeUserEdit('/w/f', 'a\nX\n').status, 'writing');
    store.clearWriting('/w/f');
    assert.equal(store.observeUserEdit('/w/f', 'a\nX\n').status, 'conflict');
});

// ---- persistence ----------------------------------------------------------
test('toJSON/fromJSON round-trips the ledger and drops transient write marks', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    store.record({ path: '/w/g', after: 'x' });
    store.markWriting('/w/f');

    const restored = new EditLedgerStore();
    restored.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
    assert.equal(restored.size, 2);
    assert.equal(restored.get('/w/f').before, 'a');
    assert.equal(restored.isWriting('/w/f'), false);

    const empty = new EditLedgerStore();
    empty.record({ path: '/w/x', before: 'a', after: 'b' });
    empty.fromJSON({ version: 99, entries: 'nonsense' });
    assert.equal(empty.size, 0);
});

test('onChange subscriptions can be disposed', () => {
    const store = new EditLedgerStore();
    let calls = 0;
    const off = store.onChange(() => calls++);
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    assert.equal(calls, 1);
    off();
    store.record({ path: '/w/g', before: 'c', after: 'd' });
    assert.equal(calls, 1);
});

// ---- provenance / persistence contract ----
test('a well-formed provenance tag survives persistence instead of collapsing', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'a', after: 'b', provenance: 'upstream-v1' });
    assert.equal(store.get('/w/f').provenance, 'upstream-v1');
    const restored = new EditLedgerStore();
    restored.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
    assert.equal(restored.get('/w/f').provenance, 'upstream-v1');
});

test('an unknown or malformed persisted provenance falls back to unverified', () => {
    const store = new EditLedgerStore();
    store.fromJSON({ version: 1, entries: [
        { path: '/w/a', kind: 'modify', before: 'x', after: 'y', provenance: 'Not A Tag' },
        { path: '/w/b', kind: 'modify', before: 'x', after: 'y', provenance: 'upstream-v1' },
    ] });
    assert.equal(store.get('/w/a').provenance, 'unverified');
    assert.equal(store.get('/w/b').provenance, 'upstream-v1');
});

test('fromJSON notifies listeners once so a restored ledger is drawn', () => {
    const store = new EditLedgerStore();
    let calls = 0;
    store.onChange(() => calls++);
    store.fromJSON({ version: 1, entries: [{ path: '/w/f', kind: 'modify', before: 'a', after: 'b' }] });
    assert.equal(calls, 1);
    assert.equal(store.size, 1);
});

test('load drops entries whose persisted text is not reviewable', () => {
    const store = new EditLedgerStore();
    store.fromJSON({ version: 1, entries: [
        { path: '/w/big', kind: 'modify', before: 'a', after: 'x'.repeat(256 * 1024 + 1) },
        { path: '/w/nul', kind: 'modify', before: 'a', after: 'a\u0000b' },
        { path: '/w/ok', kind: 'modify', before: 'a', after: 'b' },
    ] });
    assert.equal(store.size, 1);
    assert.ok(store.get('/w/ok'));
});

test('a fresh entry and a reloaded entry share the same conflict-key shape', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    assert.equal('conflict' in store.get('/w/f'), false);
    const restored = new EditLedgerStore();
    restored.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
    assert.equal('conflict' in restored.get('/w/f'), false);
});

// ---- record contract ----
test('record refuses unreviewable text', () => {
    const store = new EditLedgerStore();
    assert.throws(() => store.record({ path: '/w/f', before: 'a', after: 'a\u0000b' }), TypeError);
    assert.throws(() => store.record({ path: '/w/f', before: 'x'.repeat(256 * 1024 + 1), after: 'b' }), TypeError);
    assert.equal(store.size, 0);
});

test('a net-zero change is not recorded as a review', () => {
    const store = new EditLedgerStore();
    assert.equal(store.record({ path: '/w/f', before: 'same', after: 'same' }), null);
    assert.equal(store.size, 0);
});

test('a pending modify that ends in removal becomes a delete review', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'old', after: 'new' });
    const entry = store.record({ path: '/w/f', before: 'new', after: null });
    assert.equal(entry.kind, 'delete');
    assert.equal(entry.before, 'old');
    assert.equal(entry.after, null);
});

// ---- attribution helpers ----
test('checkBaseline accepts only an untouched file that still matches the entry', () => {
    const store = new EditLedgerStore();
    assert.deepEqual(store.checkBaseline('/w/f', 'b'), { status: 'no-entry' });
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    assert.deepEqual(store.checkBaseline('/w/f', 'b'), { status: 'ok' });
    assert.deepEqual(store.checkBaseline('/w/f', 'other'), { status: 'mismatch' });
    assert.equal(store.get('/w/f').userTouched, true);
    assert.equal(store.get('/w/f').conflict, 'transaction-before-mismatch');
});

test('checkBaseline keeps a conflict that earlier verification already named', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    store.update('/w/f', { userTouched: true, conflict: 'overlap-or-external' });
    assert.deepEqual(store.checkBaseline('/w/f', 'b'), { status: 'mismatch' });
    assert.equal(store.get('/w/f').conflict, 'overlap-or-external');
});

test('fileHint pins the entry and both images for whole-file buttons', () => {
    const store = new EditLedgerStore();
    assert.equal(store.fileHint('/w/f'), null);
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    const hint = store.fileHint('/w/f');
    assert.equal(hint.file, true);
    assert.equal(store.matchesFileHint('/w/f', hint), true);
    assert.equal(store.matchesFileHint('/w/f', { ...hint, afterHash: 'other' }), false);
    assert.equal(store.matchesFileHint('/w/f', { ...hint, id: 'e99' }), false);
    assert.equal(store.matchesFileHint('/w/missing', hint), false);
});

// ---- hunk decisions clear stale user flags ----
test('keepHunk clears a stale user-touched flag after the file matches again', () => {
    const before = 'a\nb\nc\nd\n';
    const after = 'a\nB\nc\nD\n';
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before, after });
    store.update('/w/f', { userTouched: true, conflict: 'overlap-or-external' });
    const entry = store.get('/w/f');
    const hunk = precise.reviewDiff(before, after).hunks[0];
    const result = store.keepHunk('/w/f', precise.changeHint(entry, hunk), after);
    assert.equal(result.status, 'kept');
    assert.equal(result.done, false);
    assert.equal(store.get('/w/f').userTouched, false);
    assert.equal('conflict' in store.get('/w/f'), false);
});

test('commitHunkUndo clears a stale user-touched flag after the write lands', () => {
    const before = 'a\nb\nc\nd\n';
    const after = 'a\nB\nc\nD\n';
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before, after });
    store.update('/w/f', { userTouched: true, conflict: 'transaction-before-mismatch' });
    const entry = store.get('/w/f');
    const hunk = precise.reviewDiff(before, after).hunks[0];
    const plan = store.planHunkUndo('/w/f', precise.changeHint(entry, hunk), after);
    assert.equal(plan.status, 'planned');
    store.commitHunkUndo('/w/f', plan.text);
    assert.equal(store.get('/w/f').userTouched, false);
    assert.equal('conflict' in store.get('/w/f'), false);
});

test('update cannot rewrite the entry identity or images', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    const entry = store.update('/w/f', { kind: 'delete', before: 'x', after: null, beforeMissing: true });
    assert.equal(entry.kind, 'modify');
    assert.equal(entry.before, 'a');
    assert.equal(entry.after, 'b');
    assert.equal(entry.beforeMissing, false);
});

// ---- notification counts (one change per notification) ---------------------
test('a net-zero change notifies only when a pending entry was dropped', () => {
    const store = new EditLedgerStore();
    let calls = 0;
    store.onChange(() => calls++);
    // No entry existed: nothing changed, so nothing is announced.
    assert.equal(store.record({ path: '/w/f', before: 'a', after: 'a' }), null);
    assert.equal(calls, 0);
    store.record({ path: '/w/g', before: 'a', after: 'b' });
    calls = 0;
    // The file is back at its baseline: one change (the drop), not two.
    assert.equal(store.record({ path: '/w/g', before: 'b', after: 'a' }), null);
    assert.equal(calls, 1);
    assert.equal(store.size, 0);
});

test('a final hunk undo notifies once', () => {
    const before = 'a\nb\n';
    const after = 'a\nB\n';
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before, after });
    const entry = store.get('/w/f');
    const hint = precise.changeHint(entry, precise.reviewDiff(before, after).hunks[0]);
    const plan = store.planHunkUndo('/w/f', hint, after);
    let calls = 0;
    store.onChange(() => calls++);
    assert.equal(plan.done, true);
    store.commitHunkUndo('/w/f', plan.text);
    assert.equal(calls, 1);
    assert.equal(store.size, 0);
});

// ---- attribution guards ----------------------------------------------------
test('commitHunkUndo refuses a delete review instead of writing an after image', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/d', before: 'gone', after: null });
    const entry = store.commitHunkUndo('/w/d', 'written');
    assert.equal(entry.kind, 'delete');
    assert.equal(store.get('/w/d').after, null);
});

test('matchesFileHint requires the whole-file marker', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    const hint = store.fileHint('/w/f');
    const { file, ...hunkShaped } = hint;
    assert.equal(file, true);
    assert.equal(store.matchesFileHint('/w/f', hunkShaped), false);
});

// ---- user edits ------------------------------------------------------------
test('observeUserEdit distinguishes a missing entry from unreadable text', () => {
    const store = new EditLedgerStore();
    assert.equal(store.observeUserEdit('/w/none', 'x').status, 'no-entry');
    store.record({ path: '/w/f', before: 'a\nb\n', after: 'a\nB\n' });
    assert.equal(store.observeUserEdit('/w/f', null).status, 'invalid-text');
});

test('observeUserEdit refreshes the list order of a rebased entry', async () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/a', before: 'x\na\n', after: 'x\nA\n' });
    await new Promise(resolve => setTimeout(resolve, 5));
    store.record({ path: '/w/b', before: 'p', after: 'q' });
    assert.equal(store.list()[0].path, '/w/b');
    await new Promise(resolve => setTimeout(resolve, 5));
    store.observeUserEdit('/w/a', 'y\nA\n');
    assert.equal(store.list()[0].path, '/w/a');
});

test('observeUserEdit keeps a save-participant conflict sticky across a rebase', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'x\na\n', after: 'x\nA\n' });
    store.update('/w/f', { userTouched: true, conflict: 'save-participant' });
    const result = store.observeUserEdit('/w/f', 'y\nA\n');
    assert.equal(result.status, 'rebased');
    // The images are re-anchored, but the uncertainty is not silently lifted.
    assert.equal(store.get('/w/f').before, 'y\na\n');
    assert.equal(store.get('/w/f').after, 'y\nA\n');
    assert.equal(store.get('/w/f').conflict, 'save-participant');
    assert.equal(store.get('/w/f').userTouched, true);
});

// ---- hardened store contracts ----------------------------------------------
test('fromJSON filters invalid text and notifies exactly once', () => {
    const store = new EditLedgerStore();
    let calls = 0;
    store.onChange(() => calls++);
    const big = 'x'.repeat(256 * 1024 + 1);
    store.fromJSON({ version: 1, seq: 2, entries: [
        { id: 'e9', path: '/w/big', kind: 'modify', before: 'a', after: big },
        { id: 'e10', path: '/w/nul', kind: 'modify', before: 'a', after: 'a\u0000b' },
        { id: 'e1', path: '/w/ok', kind: 'modify', before: 'a', after: 'b' },
    ] });
    assert.equal(calls, 1);
    assert.equal(store.size, 1);
    // Ids of the filtered entries still count: nothing is handed out twice.
    const next = store.record({ path: '/w/new', before: 'c', after: 'd' });
    assert.equal(next.id, 'e11');
});

test('fromJSON drops a zero-change persisted entry', () => {
    const store = new EditLedgerStore();
    store.fromJSON({ version: 1, entries: [{ path: '/w/same', kind: 'modify', before: 'a', after: 'a' }] });
    assert.equal(store.size, 0);
});

test('observeUserEdit rejects text the ledger cannot carry', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'a\nb\n', after: 'a\nB\n' });
    assert.equal(store.observeUserEdit('/w/f', 'x'.repeat(256 * 1024 + 1)).status, 'invalid-text');
    assert.equal(store.observeUserEdit('/w/f', 'a\u0000B\n').status, 'invalid-text');
    assert.equal(store.observeUserEdit('/w/f', 'a\uD800B\n').status, 'invalid-text');
    assert.equal(store.get('/w/f').after, 'a\nB\n');
});

test('setAfter and commitHunkUndo refuse images the record contract forbids', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    assert.throws(() => store.setAfter('/w/f', null), TypeError);
    assert.throws(() => store.setAfter('/w/f', 'x'.repeat(256 * 1024 + 1)), TypeError);
    assert.throws(() => store.commitHunkUndo('/w/f', null), TypeError);
    store.record({ path: '/w/d', before: 'gone', after: null });
    // A delete whose file now has content is a modification, not an invalid
    // shape: the after image is accepted and the kind follows.
    store.setAfter('/w/d', 'written');
    assert.equal(store.get('/w/d').kind, 'modify');
    assert.equal(store.get('/w/d').after, 'written');
});

test('record enforces the image/kinds shape matrix', () => {
    const store = new EditLedgerStore();
    assert.throws(() => store.record({ path: '/w/f', kind: 'modify', before: 'a', after: 42 }), TypeError);
    assert.throws(() => store.record({ path: '/w/f', kind: 'create', after: null }), TypeError);
    assert.throws(() => store.record({ path: '/w/f', kind: 'delete', before: null, after: null }), TypeError);
    assert.throws(() => store.record({ path: '/w/f', kind: 'create', before: 'a', after: 'b' }), TypeError);
    // A merge into an existing entry may carry the operation's own before.
    store.record({ path: '/w/f', before: 'B', after: 'A' });
    const merged = store.record({ path: '/w/f', kind: 'create', before: 'B', after: 'C' });
    assert.equal(merged.kind, 'modify');
    assert.equal(merged.before, 'B');
    assert.equal(merged.after, 'C');
});

test('update validates the two consumer fields', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    assert.throws(() => store.update('/w/f', { userTouched: 'yes' }), TypeError);
    assert.throws(() => store.update('/w/f', { conflict: 42 }), TypeError);
});

test('checkBaseline marks a mismatch once, not on every repeated call', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    let calls = 0;
    store.onChange(() => calls++);
    assert.equal(store.checkBaseline('/w/f', 'other').status, 'mismatch');
    assert.equal(calls, 1);
    assert.equal(store.checkBaseline('/w/f', 'other').status, 'mismatch');
    assert.equal(calls, 1);
});

test('a save-participant conflict survives an overlap and a return to after', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'x\na\n', after: 'x\nA\n' });
    store.update('/w/f', { userTouched: true, conflict: 'save-participant' });
    assert.equal(store.observeUserEdit('/w/f', 'y\nZ\n').status, 'conflict');
    assert.equal(store.get('/w/f').conflict, 'save-participant');
    assert.equal(store.observeUserEdit('/w/f', 'x\nA\n').status, 'unchanged');
    assert.equal(store.get('/w/f').userTouched, true);
    assert.equal(store.get('/w/f').conflict, 'save-participant');
});

test('a baseline-mismatch conflict is not lifted by returning to after', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    assert.equal(store.checkBaseline('/w/f', 'other').status, 'mismatch');
    assert.equal(store.observeUserEdit('/w/f', 'b').status, 'unchanged');
    assert.equal(store.get('/w/f').userTouched, true);
    assert.equal(store.get('/w/f').conflict, 'transaction-before-mismatch');
});

// ---- merge / delete contact with the reviewed host shapes -------------------
test('delete merges do not require the operation before image', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/c', after: 'one' });
    assert.equal(store.record({ path: '/w/c', after: null, kind: 'delete' }), null);
    assert.equal(store.size, 0);
    store.record({ path: '/w/m', before: 'old', after: 'new' });
    store.record({ path: '/w/m', before: 'new', after: null });
    assert.equal(store.get('/w/m').kind, 'delete');
    store.record({ path: '/w/n', before: 'gone', after: 'edit' });
    store.record({ path: '/w/n', before: 'edited', after: null, kind: 'modify' });
    assert.equal(store.get('/w/n').kind, 'delete');
});

test('a fresh modify with a null after is normalized to a delete', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/d', before: 'gone', after: null, kind: 'modify' });
    assert.equal(store.get('/w/d').kind, 'delete');
});

test('a merge does not validate the before image it discards', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    const huge = 'x'.repeat(256 * 1024 + 1);
    const merged = store.record({ path: '/w/f', kind: 'create', before: huge, after: 'c' });
    assert.equal(merged.after, 'c');
    assert.equal(merged.before, 'a');
});

test('observeUserEdit flags a rebase whose images would leave the text contract', () => {
    const long = 'A'.repeat(200000);
    const before = long + '\nmiddle\ntail\n';
    const after = 'short\nmiddle\ntail\n';
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before, after });
    const current = 'short\nmiddle\n' + 'Z'.repeat(262000) + '\n';
    const result = store.observeUserEdit('/w/f', current);
    assert.equal(result.status, 'conflict');
    assert.equal(store.get('/w/f').before, before);
    assert.equal(store.get('/w/f').after, after);
    assert.equal(store.get('/w/f').userTouched, true);
});

test('planHunkUndo refuses a planned text the ledger could not hold', () => {
    const before = 'A'.repeat(200000) + '\nmiddle\n';
    const after = 'middle\n' + 'B'.repeat(200000) + '\n';
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before, after });
    const entry = store.get('/w/f');
    const hunks = precise.reviewDiff(before, after).hunks;
    const removal = hunks.find(h => h.beforeOffset === 0 && h.beforeEnd === 200001);
    assert.ok(removal);
    const plan = store.planHunkUndo('/w/f', precise.changeHint(entry, removal), after);
    assert.equal(plan.status, 'stale');
    assert.equal(store.get('/w/f').after, after);
});

test('update clears a conflict when given an empty code', () => {
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before: 'a', after: 'b' });
    store.update('/w/f', { userTouched: true, conflict: 'overlap-or-external' });
    store.update('/w/f', { userTouched: false, conflict: '' });
    assert.equal('conflict' in store.get('/w/f'), false);
    assert.deepEqual(store.planUndo('/w/f', true, 'b'), { action: 'restore-content' });
});

test('a corrupt persisted seq is clamped to a sane id range', () => {
    const store = new EditLedgerStore();
    store.fromJSON({ version: 1, seq: 1e21, entries: [] });
    const entry = store.record({ path: '/w/f', before: 'a', after: 'b' });
    assert.match(entry.id, /^e\d+$/);
});

test('a fresh delete without a captured baseline is recorded as a blocked review', () => {
    const store = new EditLedgerStore();
    const entry = store.record({ path: '/w/d', after: null, kind: 'delete', beforeMissing: true });
    assert.equal(entry.kind, 'delete');
    assert.equal(entry.before, null);
    assert.equal(entry.beforeMissing, true);
    assert.deepEqual(store.planUndo('/w/d', false, null), { action: 'blocked', reason: 'missing-baseline' });
});

test('keepHunk refuses a folded baseline past the text contract and keeps flags', () => {
    const before = 'A'.repeat(200000) + '\nmiddle\nX\n';
    const after = 'small\nmiddle\n' + 'Y'.repeat(100000) + '\n';
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before, after });
    store.update('/w/f', { userTouched: true, conflict: 'overlap-or-external' });
    const entry = store.get('/w/f');
    const hunks = precise.reviewDiff(before, after).hunks;
    // The hunk that replaces the trailing X with the long Y line: folding it
    // into the baseline would produce ~300 KB > 256 KiB.
    const hunk = hunks.find(h => h.removedTexts.join('') === 'X' || h.oldText === 'X\n') ?? hunks[hunks.length - 1];
    const result = store.keepHunk('/w/f', precise.changeHint(entry, hunk), after);
    assert.equal(result.status, 'stale');
    assert.equal(store.get('/w/f').before, before);
    assert.equal(store.get('/w/f').userTouched, true);
    assert.equal(store.get('/w/f').conflict, 'overlap-or-external');
});

// ---- automated-review follow-ups -------------------------------------------
test('a BOM entry is carried, but its undos are refused', () => {
    const before = '\uFEFFold\n';
    const after = '\uFEFFnew\n';
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before, after });
    assert.equal(store.get('/w/f').kind, 'modify');
    assert.deepEqual(store.planUndo('/w/f', true, after), { action: 'blocked', reason: 'bom-unsupported' });
    const entry = store.get('/w/f');
    const hunks = precise.reviewDiff(before, after).hunks;
    assert.equal(store.resolveHunk('/w/f', precise.changeHint(entry, hunks[0]), after), null);
});

test('an explicit hunk decision clears a conflict marker without the touched flag', () => {
    const before = 'a\nb\nc\nd\n';
    const after = 'a\nB\nc\nD\n';
    const store = new EditLedgerStore();
    store.record({ path: '/w/f', before, after });
    store.update('/w/f', { userTouched: false, conflict: 'transaction-before-mismatch' });
    const entry = store.get('/w/f');
    const hunk = precise.reviewDiff(before, after).hunks[0];
    const result = store.keepHunk('/w/f', precise.changeHint(entry, hunk), after);
    assert.equal(result.status, 'kept');
    assert.equal('conflict' in store.get('/w/f'), false);
    assert.equal(store.get('/w/f').userTouched, false);
});

test('overlapping write marks count down instead of clearing early', () => {
    const store = new EditLedgerStore();
    store.markWriting('/w/f');
    store.markWriting('/w/f');
    store.clearWriting('/w/f');
    assert.equal(store.isWriting('/w/f'), true);
    store.clearWriting('/w/f');
    assert.equal(store.isWriting('/w/f'), false);
});

test('a create cannot claim a missing before image', () => {
    const store = new EditLedgerStore();
    assert.throws(() => store.record({ path: '/w/f', kind: 'create', after: 'x', beforeMissing: true }), TypeError);
});

test('fromJSON remints an over-cap persisted id', () => {
    const store = new EditLedgerStore();
    store.fromJSON({ version: 1, entries: [{ id: 'e2000000000', path: '/w/f', kind: 'modify', before: 'a', after: 'b' }] });
    const entry = store.get('/w/f');
    assert.match(entry.id, /^e\d+$/);
    const next = store.record({ path: '/w/g', before: 'a', after: 'b' });
    assert.notEqual(next.id, entry.id);
});
