'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewDiff, keepChange, undoChange, changeHint, resolveChange, tokens } = require('../precise-review-core');
test('line tokens preserve mixed terminators and absence of final newline', () => {
    assert.deepEqual(tokens('a\r\nb\nc\rd'), ['a\r\n', 'b\n', 'c\r', 'd']);
});
test('adjacent rewrites can be kept and undone one line at a time', () => {
    const before = 'a\r\nb\r\nc\r\n', after = 'A\r\nB\r\nc\r\n';
    assert.equal(reviewDiff(before, after).hunks.length, 1);
    const lines = reviewDiff(before, after, true).hunks;
    assert.equal(lines.length, 2);
    const kept = keepChange(before, lines[0]);
    assert.equal(kept, 'A\r\nb\r\nc\r\n');
    assert.equal(undoChange(after, reviewDiff(kept, after).hunks[0]), kept);
});
test('EOF insertions and deletion recover exact original bytes', () => {
    for (const [before, after] of [['a', 'a\nb\n'], ['a\r\nb\r\n', 'a'], ['', 'x\n'], ['a\n', 'a'], ['a\r\nb\nc', 'A\r\nb\nc']]) {
        const h = reviewDiff(before, after).hunks;
        let fixed = after;
        for (const item of [...h].reverse()) fixed = undoChange(fixed, item);
        assert.equal(fixed, before);
        let kept = before;
        for (const item of [...h].reverse()) kept = keepChange(kept, item);
        assert.equal(kept, after);
    }
});
test('outdated buttons never target the nearest or another hunk', () => {
    const entry = { id: 'e1', before: 'old\n', after: 'new\n' };
    const hint = changeHint(entry, reviewDiff(entry.before, entry.after).hunks[0]);
    assert.ok(resolveChange(entry, entry.after, hint));
    assert.equal(resolveChange(entry, 'user\n', hint), null);
    assert.equal(resolveChange({ ...entry, after: 'newer\n' }, 'newer\n', hint), null);
    assert.equal(resolveChange({ ...entry, id: 'e2' }, entry.after, hint), null);
});
test('line deletion offsets remain unique on the same anchor', () => {
    const entry = { id: 'e', before: 'a\nb\nc\nd\n', after: 'a\nd\n' };
    const hs = reviewDiff(entry.before, entry.after, true).hunks;
    assert.equal(hs.length, 2);
    for (const h of hs) assert.deepEqual(resolveChange(entry, entry.after, changeHint(entry, h, true)), h);
    assert.equal(undoChange(entry.after, hs[1]), 'a\nc\nd\n');
});
test('bounded diff degrades to a block without losing exact content', () => {
    const before = Array.from({length:1600}, (_,i)=>`a${i}\n`).join('');
    const after = Array.from({length:1600}, (_,i)=>`b${i}\r\n`).join('');
    const hs = reviewDiff(before, after).hunks;
    assert.equal(hs.length, 1); assert.equal(undoChange(after, hs[0]), before);
});
