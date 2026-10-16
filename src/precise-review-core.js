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
/** Mirror only provably disjoint user edits into the original snapshot.
 * Coordinates come from exact-text hunks, never substring search (duplicates
 * are common in code). Touching an AI deletion/insertion gap is ambiguous.
 */
function rebaseUserEdit(before, after, current) {
    const unchanged = { before, after, conflict: true };
    if (typeof before !== 'string' || typeof after !== 'string' || typeof current !== 'string') return unchanged;
    if (current === after) return { before, after, conflict: false };
    const ai = reviewDiff(before, after).hunks;
    const user = reviewDiff(after, current).hunks;
    const mapped = [];
    for (const u of user) {
        const start = u.beforeOffset, end = u.beforeEnd;
        for (const h of ai) {
            const hs = h.afterOffset, he = h.afterEnd;
            const overlap = start < he && end > hs;
            const userGap = start === end && start >= hs && start <= he;
            const aiGap = hs === he && hs >= start && hs <= end;
            if (overlap || userGap || aiGap) return unchanged;
        }
        const map = offset => offset + ai.filter(h => h.afterEnd <= offset).reduce((n, h) => n + h.oldText.length - h.newText.length, 0);
        const bs = map(start), be = map(end);
        if (before.slice(bs, be) !== u.oldText) return unchanged;
        mapped.push({ start: bs, end: be, text: u.newText });
    }
    let rebased = before;
    for (const edit of mapped.reverse()) rebased = rebased.slice(0, edit.start) + edit.text + rebased.slice(edit.end);
    return { before: rebased, after: current, conflict: false };
}
module.exports = { tokens, reviewDiff, keepChange, undoChange, changeHint, resolveChange, digest, rebaseUserEdit };
