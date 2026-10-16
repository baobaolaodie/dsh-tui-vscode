'use strict';
function validateDisplay(display, label) {
    const visible = selector => display.items?.find(item => item.selector === selector)?.visible ?? [];
    const old = visible('.chat-editing-original-zone');
    const overlay = visible('.chat-editing-editor-overlay');
    const controls = visible('.chat-diff-change-content-widget');
    if (!old.length) throw Error('Native original lines missing');
    if (!overlay.some(item => /Keep/.test(item.text) && /Undo/.test(item.text))) throw Error('Native Keep/Undo overlay missing');
    if (overlay.some(item => item.unobscured !== true)) throw Error('Native overlay obscured');
    if (!controls.some(item => /Keep/.test(item.text) && /Undo/.test(item.text))) throw Error('Native per-change controls missing');
    const classes = (display.themeClass ?? '').split(/\s+/);
    if (label === 'light' && !classes.includes('vs')) throw Error('Light theme not settled');
    if (label === 'dark' && !classes.includes('vs-dark')) throw Error('Dark theme not settled');
    const text = old.map(item => item.text).join('\n');
    if (label === 'long-deletion') {
        if (!Array.from({ length: 8 }, (_, index) => `旧稿第${index + 1}行`).every(line => text.includes(line))) throw Error('Long original lines incomplete');
    } else if (!text.includes('old') || old.length !== 2) throw Error('Expected two separated original lines');
    return { oldZones: old.length, perChangeControls: controls.length, overlayCount: overlay.length, oldCharacters: text.length, actualPixelComparison: false };
}
module.exports = { validateDisplay };
