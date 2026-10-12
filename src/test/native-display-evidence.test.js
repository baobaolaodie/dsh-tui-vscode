'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDisplay } = require('../native-display-check.cjs');
const sample = () => ({ themeClass: 'monaco-workbench vs-dark', items: [
    { selector: '.chat-editing-original-zone', visible: [{ text: 'old one' }, { text: 'old two' }] },
    { selector: '.chat-editing-editor-overlay', visible: [{ text: 'Keep\nUndo\n2 of 2', unobscured: true }] },
    { selector: '.chat-diff-change-content-widget', visible: [{ text: 'Keep\nUndo' }, { text: 'Keep\nUndo' }] },
] });
test('synthetic observations check completeness but never prove pixel comparison', () => {
    const result = validateDisplay(sample(), 'dark');
    assert.equal(result.oldZones, 2);
    assert.equal(result.actualPixelComparison, false);
});
test('missing originals or overlay cannot be accepted as display evidence', () => {
    const display = sample(); display.items[0].visible = [];
    assert.throws(() => validateDisplay(display, 'dark'), /original lines missing/);
    const overlay = sample(); overlay.items[1].visible = [];
    assert.throws(() => validateDisplay(overlay, 'dark'), /overlay missing/);
});
test('notification-obscured overlay cannot count as complete visual evidence', () => {
    const display = sample(); display.items[1].visible[0].unobscured = false;
    assert.throws(() => validateDisplay(display, 'dark'), /overlay obscured/);
});
test('wrong or unsettled theme cannot count as light evidence', () => {
    assert.throws(() => validateDisplay(sample(), 'light'), /Light theme/);
    const display = sample(); display.themeClass = 'monaco-workbench vs';
    assert.equal(validateDisplay(display, 'light').oldZones, 2);
});
test('long deletion requires all eight original lines, not a truncated fragment', () => {
    const display = sample(); display.items[0].visible = [{ text: '旧稿第1行' }];
    assert.throws(() => validateDisplay(display, 'long-deletion'), /incomplete/);
    display.items[0].visible[0].text = Array.from({ length: 8 }, (_, i) => `旧稿第${i + 1}行`).join('\n');
    assert.equal(validateDisplay(display, 'long-deletion').oldZones, 1);
});
