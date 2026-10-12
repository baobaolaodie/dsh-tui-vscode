'use strict';
// Exact-text review decisions. No VS Code dependency, no filesystem writes.
const { createHash } = require('node:crypto');
const LIMIT = 1500;
const digest = text => createHash('sha256').update(text ?? '').digest('hex');
function tokens(text) { return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []; }
function operations(a, b) {
    if (a.length > LIMIT || b.length > LIMIT) return [...a.map(() => 'del'), ...b.map(() => 'ins')];
    const width = b.length + 1, dp = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
        dp[i * width + j] = a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    const result = []; let i = 0, j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) { result.push('eq'); i++; j++; }
        else if (i < a.length && (j === b.length || dp[(i + 1) * width + j] >= dp[i * width + j + 1])) { result.push('del'); i++; }
        else { result.push('ins'); j++; }
    }
    return result;
}
function reviewDiff(before, after, individualLines = false) {
    const a = tokens(before), b = tokens(after);
    let prefix = 0, suffix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    const ops = operations(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix));
    const ao = [0], bo = [0]; for (const t of a) ao.push(ao.at(-1) + t.length); for (const t of b) bo.push(bo.at(-1) + t.length);
    const hunks = []; let ai = prefix, bi = prefix, k = 0;
    const add = (as, ae, bs, be) => {
        const oldText = a.slice(as, ae).join(''), newText = b.slice(bs, be).join('');
        hunks.push({ beforeStart: as, afterInsert: bs, startLine: Math.min(bs, Math.max(b.length - 1, 0)), lineCount: be - bs,
            added: be - bs, removed: ae - as, kind: as === ae ? 'added' : bs === be ? 'removed' : 'modified',
            removedTexts: a.slice(as, ae).map(t => t.replace(/[\r\n]+$/, '')), addedTexts: b.slice(bs, be).map(t => t.replace(/[\r\n]+$/, '')),
            beforeOffset: ao[as], beforeEnd: ao[ae], afterOffset: bo[bs], afterEnd: bo[be], oldText, newText });
    };
    while (k < ops.length) {
        if (ops[k] === 'eq') { ai++; bi++; k++; continue; }
        const as = ai, bs = bi;
        while (k < ops.length && ops[k] !== 'eq') { if (ops[k++] === 'del') ai++; else bi++; }
        if (!individualLines) add(as, ai, bs, bi);
        else for (let n = 0; n < Math.max(ai - as, bi - bs); n++) add(Math.min(as + n, ai), Math.min(as + n + 1, ai), Math.min(bs + n, bi), Math.min(bs + n + 1, bi));
    }
    return { hunks, addedLines: hunks.reduce((n, h) => n + h.added, 0), removedLines: hunks.reduce((n, h) => n + h.removed, 0) };
}
function keepChange(before, h) {
    if (before.slice(h.beforeOffset, h.beforeEnd) !== h.oldText) throw Error('Stale original');
    return before.slice(0, h.beforeOffset) + h.newText + before.slice(h.beforeEnd);
}
function undoChange(after, h) {
    if (after.slice(h.afterOffset, h.afterEnd) !== h.newText) throw Error('Stale change');
    return after.slice(0, h.afterOffset) + h.oldText + after.slice(h.afterEnd);
}
function changeHint(entry, h, line = false) {
    return { id: entry.id, beforeHash: digest(entry.before), afterHash: digest(entry.after), offset: h.afterOffset, beforeOffset: h.beforeOffset, oldHash: digest(h.oldText), newHash: digest(h.newText), line };
}
function resolveChange(entry, current, hint) {
    if (!hint || hint.id !== entry.id || hint.beforeHash !== digest(entry.before) || hint.afterHash !== digest(entry.after) || current !== entry.after) return null;
    return reviewDiff(entry.before ?? '', current, hint.line).hunks.find(h => h.afterOffset === hint.offset && h.beforeOffset === hint.beforeOffset && digest(h.oldText) === hint.oldHash && digest(h.newText) === hint.newHash) ?? null;
}
module.exports = { tokens, reviewDiff, keepChange, undoChange, changeHint, resolveChange, digest };
