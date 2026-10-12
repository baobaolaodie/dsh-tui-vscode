"use strict";
/**
 * Unit tests for the AI edit review data layer (no vscode needed).
 * Run: node --test out/test/edit-review-core.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EditLedger, diffLines, diffWords, applyHunkKeep, applyHunkRevert, planUndo, formatCounts } = require('../edit-review-core');
// ---- diffLines -------------------------------------------------------------
test('identical texts produce no hunks and zero counts', () => {
    const d = diffLines('a\nb\nc', 'a\nb\nc');
    assert.equal(d.hunks.length, 0);
    assert.equal(d.addedLines, 0);
    assert.equal(d.removedLines, 0);
});
test('an appended block is one added hunk at the right lines', () => {
    const d = diffLines('a\nb', 'a\nb\nc\nd');
    assert.equal(d.addedLines, 2);
    assert.equal(d.removedLines, 0);
    assert.deepEqual(d.hunks, [{ startLine: 2, lineCount: 2, added: 2, removed: 0, beforeStart: 2, afterInsert: 2, removedTexts: [], addedTexts: ['c', 'd'], kind: 'added' }]);
});
test('a removed block anchors on the nearest surviving line', () => {
    const d = diffLines('a\nb\nc\nd', 'a\nd');
    assert.equal(d.addedLines, 0);
    assert.equal(d.removedLines, 2);
    assert.equal(d.hunks.length, 1);
    assert.equal(d.hunks[0].kind, 'removed');
    assert.equal(d.hunks[0].lineCount, 0);
    assert.equal(d.hunks[0].startLine, 1); // 'd' is now line index 1
    assert.equal(d.hunks[0].beforeStart, 1);
    assert.equal(d.hunks[0].afterInsert, 1);
    assert.deepEqual(d.hunks[0].removedTexts, ['b', 'c']);
    assert.deepEqual(d.hunks[0].addedTexts, []);
});
test('a rewritten line counts as one added and one removed', () => {
    const d = diffLines('a\nold\nc', 'a\nnew\nc');
    assert.deepEqual(d.hunks, [{ startLine: 1, lineCount: 1, added: 1, removed: 1, beforeStart: 1, afterInsert: 1, removedTexts: ['old'], addedTexts: ['new'], kind: 'modified' }]);
    assert.equal(formatCounts(d.addedLines, d.removedLines), '+1 \u22121');
});
test('new file (empty before) reports every line as added', () => {
    const d = diffLines('', 'x\ny\nz');
    assert.equal(d.addedLines, 3);
    assert.equal(d.removedLines, 0);
    assert.equal(d.hunks.length, 1);
});
test('two separate edits produce two hunks with correct coordinates', () => {
    const d = diffLines('a\nb\nc\nd\ne', 'a\nB\nc\nd\nE');
    assert.equal(d.hunks.length, 2);
    assert.deepEqual(d.hunks[0], { startLine: 1, lineCount: 1, added: 1, removed: 1, beforeStart: 1, afterInsert: 1, removedTexts: ['b'], addedTexts: ['B'], kind: 'modified' });
    assert.deepEqual(d.hunks[1], { startLine: 4, lineCount: 1, added: 1, removed: 1, beforeStart: 4, afterInsert: 4, removedTexts: ['e'], addedTexts: ['E'], kind: 'modified' });
});
test('CRLF input is handled like LF', () => {
    const d = diffLines('a\r\nb\r\n', 'a\r\nb\r\nc');
    assert.equal(d.addedLines, 1);
    assert.equal(d.removedLines, 0);
});
// ---- diffWords (word-level spans, Copilot's inner-changes pass) ------------
test('diffWords finds an inserted span inside a line', () => {
    assert.deepEqual(diffWords('hello world', 'hello brave world'), [
        { oStart: 6, oEnd: 6, nStart: 6, nEnd: 11 },
    ]);
});
test('diffWords pairs a replaced word as one span', () => {
    assert.deepEqual(diffWords('the cat sat', 'the dog sat'), [
        { oStart: 4, oEnd: 7, nStart: 4, nEnd: 7 },
    ]);
});
test('diffWords reports [] for identical lines and pure deletion spans', () => {
    assert.deepEqual(diffWords('same', 'same'), []);
    assert.deepEqual(diffWords('keep drop keep', 'keep keep'), [
        { oStart: 5, oEnd: 9, nStart: 5, nEnd: 5 },
    ]);
});
// ---- per-edit Keep / Undo (Copilot's per-change decisions) -----------------
test('applyHunkKeep folds exactly one edit into the baseline', () => {
    const d = diffLines('a\nold\nc\nd', 'a\nnew\nc\nd');
    const kept = applyHunkKeep('a\nold\nc\nd', d.hunks[0]);
    assert.equal(kept, 'a\nnew\nc\nd');
    assert.equal(diffLines(kept, 'a\nnew\nc\nd').hunks.length, 0);
});
test('applyHunkRevert reverts exactly one edit in the live text', () => {
    const d = diffLines('a\nold\nc\nd', 'a\nnew\nc\nd');
    assert.equal(applyHunkRevert('a\nnew\nc\nd', d.hunks[0]), 'a\nold\nc\nd');
});
test('per-edit keep and undo compose without touching other edits', () => {
    const before = 'a\nb\nc\nd\ne';
    const after = 'a\nB\nc\nd\nE';
    const d = diffLines(before, after);
    const kept = applyHunkKeep(before, d.hunks[0]); // keep the FIRST edit
    assert.equal(kept, 'a\nB\nc\nd\ne');
    const d2 = diffLines(kept, after);
    assert.equal(d2.hunks.length, 1); // second edit still pending
    assert.equal(applyHunkRevert(after, d2.hunks[0]), 'a\nB\nc\nd\ne');
});
test('hunk splices preserve CRLF endings and the trailing newline', () => {
    const d = diffLines('a\r\nold\r\n', 'a\r\nnew\r\n');
    assert.equal(applyHunkRevert('a\r\nnew\r\n', d.hunks[0]), 'a\r\nold\r\n');
    assert.equal(applyHunkKeep('a\r\nold\r\n', d.hunks[0]), 'a\r\nnew\r\n');
});
// ---- EditLedger merge rules -----------------------------------------------
test('record keeps one entry per file and preserves the first before image', () => {
    const led = new EditLedger();
    led.record('/w/f', 'modify', 'v1', false, 'v2');
    led.record('/w/f', 'modify', 'ignored', false, 'v3');
    assert.equal(led.size, 1);
    const e = led.get('/w/f');
    assert.equal(e.before, 'v1');
    assert.equal(e.after, 'v3');
});
test('create then modify stays a create (undo deletes the file)', () => {
    const led = new EditLedger();
    led.record('/w/new', 'create', null, false, 'one');
    led.record('/w/new', 'modify', 'one', false, 'two');
    assert.equal(led.get('/w/new').kind, 'create');
    assert.equal(led.get('/w/new').before, null);
    assert.equal(led.get('/w/new').after, 'two');
});
test('create then delete cancels out entirely', () => {
    const led = new EditLedger();
    led.record('/w/new', 'create', null, false, 'one');
    const result = led.record('/w/new', 'delete', 'one', false, null);
    assert.equal(result, null);
    assert.equal(led.size, 0);
});
test('delete then recreate becomes a modify keeping the original before', () => {
    const led = new EditLedger();
    led.record('/w/f', 'delete', 'old', false, null);
    led.record('/w/f', 'create', null, false, 'new');
    const e = led.get('/w/f');
    assert.equal(e.kind, 'modify');
    assert.equal(e.before, 'old');
    assert.equal(e.after, 'new');
});
test('keep drops the entry and notifies listeners once', () => {
    const led = new EditLedger();
    let calls = 0;
    led.onChange(() => calls++);
    led.record('/w/f', 'modify', 'a', false, 'b');
    assert.equal(calls, 1);
    const dropped = led.keep('/w/f');
    assert.equal(dropped.path, '/w/f');
    assert.equal(led.size, 0);
    assert.equal(calls, 2);
});
test('toJSON/load round-trips the ledger', () => {
    const led = new EditLedger();
    led.record('/w/f', 'modify', 'a', false, 'b');
    led.record('/w/g', 'modify', null, true, 'x');
    const led2 = new EditLedger();
    led2.load(JSON.parse(JSON.stringify(led.toJSON())));
    assert.equal(led2.size, 2);
    assert.equal(led2.get('/w/f').before, 'a');
    assert.equal(led2.get('/w/g').beforeMissing, true);
    const led3 = new EditLedger();
    led3.load({ version: 99, entries: 'nonsense' });
    assert.equal(led3.size, 0);
});
// ---- planUndo --------------------------------------------------------------
const entry = (over) => ({
    id: 'e1', path: '/w/f', kind: 'modify', before: 'v1', beforeMissing: false,
    after: 'v2', firstTs: 0, lastTs: 0, ...over,
});
test('undo of a clean modify restores the before image', () => {
    assert.deepEqual(planUndo(entry(), true, 'v2'), { action: 'restore-content' });
});
test('undo blocks when no baseline was captured', () => {
    assert.deepEqual(planUndo(entry({ beforeMissing: true }), true, 'v2'), { action: 'blocked', reason: 'missing-baseline' });
});
test('undo asks first when the user hand-edited after the AI', () => {
    assert.deepEqual(planUndo(entry(), true, 'v2-user'), {
        action: 'confirm', fallback: 'restore-content', reason: 'hand-edited',
    });
});
test('undo of a clean create deletes the file', () => {
    assert.deepEqual(planUndo(entry({ kind: 'create', before: null }), true, 'v2'), { action: 'delete-file' });
});
test('undo of a vanished create just drops the entry', () => {
    assert.deepEqual(planUndo(entry({ kind: 'create', before: null }), false, null), { action: 'drop' });
});
test('undo of a clean delete recreates the file', () => {
    assert.deepEqual(planUndo(entry({ kind: 'delete', after: null }), false, null), { action: 'restore-file' });
});
test('undo of a delete whose file was recreated asks first', () => {
    assert.deepEqual(planUndo(entry({ kind: 'delete', after: null }), true, 'user'), {
        action: 'confirm', fallback: 'restore-file', reason: 'recreated',
    });
});
