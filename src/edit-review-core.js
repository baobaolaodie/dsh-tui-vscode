"use strict";
/**
 * edit-review-core — the data layer of the AI edit review feature (Phase 1).
 *
 * Pure Node (no `vscode` import): the pending-edit ledger, the line-by-line
 * comparison, and the undo planner. Everything here is unit-tested with
 * `node --test out/test/edit-review-core.test.js` and can run outside the
 * extension host.
 *
 * Model (kept deliberately small):
 * - `settled` state  = the last "quiet" content of a file. The plugin keeps
 *   it warm (initial scan + refresh after user edits settle), and uses it as
 *   the BEFORE image of the next AI edit.
 * - `PendingEntry`   = one un-reviewed AI change to one file: kind create /
 *   modify / delete, the BEFORE image (null for create; flagged missing when
 *   it could not be captured), and the AFTER image (null for delete).
 * - Exactly ONE pending entry per file: later AI edits to the same file roll
 *   into it (after is refreshed, before is kept from the first un-kept edit),
 *   so Undo reverts the whole un-reviewed stretch and Keep accepts all of it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EditLedger = exports.MAX_DIFF_DP_LINES = void 0;
exports.splitLines = splitLines;
exports.diffLines = diffLines;
exports.diffWords = diffWords;
exports.applyHunkKeep = applyHunkKeep;
exports.applyHunkRevert = applyHunkRevert;
exports.planUndo = planUndo;
exports.formatCounts = formatCounts;
/** Above this size the exact comparison degrades to one coarse block (speed). */
const MAX_DIFF_DP_LINES = 1500;
exports.MAX_DIFF_DP_LINES = MAX_DIFF_DP_LINES;
/**
 * Split text into lines; tolerant of LF / CRLF / lone CR. '' has no lines and
 * a trailing line break is a terminator, not an extra empty line (so 'a\nb'
 * and 'a\nb\n' compare equal).
 */
function splitLines(text) {
    if (text === '')
        return [];
    const lines = text.replace(/\r\n|\r/g, '\n').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '')
        lines.pop();
    return lines;
}
/**
 * Classic LCS walk over two small line arrays ('eq' | 'del' | 'ins' ops).
 * O(n*m) — only called on the uncommon middle section after common
 * prefix/suffix trimming, and only under MAX_DIFF_DP_LINES on both sides.
 */
function lcsOps(a, b) {
    const n = a.length;
    const m = b.length;
    const dp = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * (m + 1) + j] = a[i] === b[j]
                ? dp[(i + 1) * (m + 1) + j + 1] + 1
                : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
        }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            ops.push('eq');
            i++;
            j++;
        }
        else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
            ops.push('del');
            i++;
        }
        else {
            ops.push('ins');
            j++;
        }
    }
    for (; i < n; i++)
        ops.push('del');
    for (; j < m; j++)
        ops.push('ins');
    return ops;
}
/**
 * Compare two texts line by line.
 * @returns {{hunks: Array<{startLine: number, lineCount: number, added: number,
 *   removed: number, beforeStart: number, afterInsert: number,
 *   removedTexts: Array<string>, addedTexts: Array<string>,
 *   kind: 'added'|'removed'|'modified'}>, addedLines: number,
 *   removedLines: number}} hunks carry BOTH sides' coordinates: 0-based
 *   `startLine`..`startLine+lineCount-1` on the AFTER text (for a pure removal
 *   `lineCount` is 0 and `startLine` is the nearest surviving line to anchor
 *   the mark on), `afterInsert` is the unclamped AFTER insertion index (for
 *   splicing), `beforeStart` is the BEFORE-side line index (for splicing),
 *   and removedTexts/addedTexts keep both sides' line text.
 *   text: `startLine`..`startLine+lineCount-1` are the affected lines (for a
 *   pure removal `lineCount` is 0 and `startLine` is the nearest surviving
 *   line to anchor the mark on).
 */
function diffLines(beforeText, afterText) {
    const a = splitLines(beforeText);
    const b = splitLines(afterText);
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
        prefix++;
    let suffix = 0;
    while (suffix <= a.length - prefix
        && suffix <= b.length - prefix
        && a[a.length - 1 - suffix] === b[b.length - 1 - suffix])
        suffix++;
    const aMid = a.slice(prefix, a.length - suffix);
    const bMid = b.slice(prefix, b.length - suffix);
    let ops;
    if (aMid.length <= MAX_DIFF_DP_LINES && bMid.length <= MAX_DIFF_DP_LINES) {
        ops = lcsOps(aMid, bMid);
    }
    else {
        // Coarse fallback for very large rewrites: one removed block + one
        // added block. Counts stay conservative (min of the two sizes is
        // reported as "modified") so the label never overstates the change.
        ops = [];
        for (let i = 0; i < aMid.length; i++)
            ops.push('del');
        for (let j = 0; j < bMid.length; j++)
            ops.push('ins');
    }
    const hunks = [];
    let addedLines = 0;
    let removedLines = 0;
    let ai = prefix; // 0-based cursor into a (collects removed line texts)
    let bj = prefix; // 0-based cursor into b
    let k = 0;
    while (k < ops.length) {
        if (ops[k] === 'eq') {
            ai++;
            bj++;
            k++;
            continue;
        }
        const startBj = bj;
        const beforeStart = ai;
        let added = 0;
        let removed = 0;
        const removedTexts = [];
        const addedTexts = [];
        while (k < ops.length && ops[k] !== 'eq') {
            if (ops[k] === 'del') {
                removedTexts.push(a[ai++]);
                removed++;
            }
            else {
                addedTexts.push(b[bj++]);
                added++;
            }
            k++;
        }
        addedLines += added;
        removedLines += removed;
        const anchor = Math.min(startBj, Math.max(b.length - 1, 0));
        hunks.push({
            startLine: added > 0 ? startBj : anchor,
            lineCount: added,
            added,
            removed,
            beforeStart,
            afterInsert: startBj,
            removedTexts,
            addedTexts,
            kind: removed === 0 ? 'added' : added === 0 ? 'removed' : 'modified',
        });
    }
    return { hunks, addedLines, removedLines };
}
/** Compact label for a change: "+3 −1". Zero halves are kept for scanning. */
function formatCounts(added, removed) {
    return `+${added} \u2212${removed}`;
}
/** Line-ending aware rejoin: splitLines normalizes, so restore the original. */
function detectEol(text) {
    return text.includes('\r\n') ? '\r\n' : '\n';
}
function joinLines(lines, eol, trailing) {
    return lines.join(eol) + (trailing ? eol : '');
}
const MAX_DIFF_WORD_DP = 600;
/**
 * Word-level comparison of one changed line pair — the inner-changes pass of
 * VS Code's own diff renderer (char-insert / inline-deleted-text positions).
 * Operates in UTF-16 offsets (= editor columns).
 * @returns {Array<{oStart: number, oEnd: number, nStart: number, nEnd: number}>}
 *   changed spans; a pure insertion has oStart===oEnd, a pure deletion
 *   nStart===nEnd, a rewrite both nonzero. Empty array = identical lines.
 */
function diffWords(oldLine, newLine) {
    const a = oldLine.split('');
    const b = newLine.split('');
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p])
        p++;
    let s = 0;
    while (s <= a.length - p
        && s <= b.length - p
        && a[a.length - 1 - s] === b[b.length - 1 - s])
        s++;
    const aM = a.slice(p, a.length - s);
    const bM = b.slice(p, b.length - s);
    if (aM.length === 0 && bM.length === 0)
        return [];
    let ops;
    if (aM.length <= MAX_DIFF_WORD_DP && bM.length <= MAX_DIFF_WORD_DP) {
        ops = lcsOps(aM, bM);
    }
    else {
        ops = [];
        for (let i = 0; i < aM.length; i++)
            ops.push('del');
        for (let j = 0; j < bM.length; j++)
            ops.push('ins');
    }
    const edits = [];
    let oi = p;
    let ni = p;
    let k = 0;
    while (k < ops.length) {
        if (ops[k] === 'eq') {
            oi++;
            ni++;
            k++;
            continue;
        }
        const oStart = oi;
        const nStart = ni;
        while (k < ops.length && ops[k] !== 'eq') {
            if (ops[k] === 'del')
                oi++;
            else
                ni++;
            k++;
        }
        edits.push({ oStart, oEnd: oi, nStart, nEnd: ni });
    }
    return edits;
}
/**
 * Per-edit Keep: fold exactly THIS edit into the baseline. The other edits
 * stay pending ("without affecting other edits in the file").
 */
function applyHunkKeep(beforeText, hunk) {
    const eol = detectEol(beforeText);
    const trailing = /[\r\n]$/.test(beforeText);
    const lines = splitLines(beforeText);
    lines.splice(hunk.beforeStart, hunk.removed, ...hunk.addedTexts);
    return joinLines(lines, eol, trailing);
}
/**
 * Per-edit Undo: revert exactly THIS edit in the live text, leaving every
 * other edit in the file untouched.
 */
function applyHunkRevert(currentText, hunk) {
    const eol = detectEol(currentText);
    const trailing = /[\r\n]$/.test(currentText);
    const lines = splitLines(currentText);
    lines.splice(hunk.afterInsert, hunk.lineCount, ...hunk.removedTexts);
    return joinLines(lines, eol, trailing);
}
/**
 * Decide what Undo should do for one pending entry.
 * @param entry          the pending entry
 * @param currentExists  whether the file exists on disk right now
 * @param currentText    current content (null when it cannot be read)
 * @returns one of:
 *   {action:'restore-content'}  write `before` back over the file
 *   {action:'restore-file'}     recreate the file with `before` (it vanished)
 *   {action:'delete-file'}      remove the file AI created
 *   {action:'drop'}             nothing to do; just drop the entry
 *   {action:'confirm', fallback, reason}  hand edits detected — ask first
 *   {action:'blocked', reason}  cannot undo (no baseline captured)
 */
function planUndo(entry, currentExists, currentText) {
    if (entry.kind !== 'create' && entry.beforeMissing) {
        return { action: 'blocked', reason: 'missing-baseline' };
    }
    if (entry.userTouched) {
        return { action: 'confirm', fallback: entry.kind === 'create' ? 'delete-file' : currentExists ? 'restore-content' : 'restore-file', reason: 'user-edited' };
    }
    if (entry.kind === 'create') {
        if (!currentExists)
            return { action: 'drop' };
        if (entry.after !== null && currentText === entry.after)
            return { action: 'delete-file' };
        return { action: 'confirm', fallback: 'delete-file', reason: 'hand-edited' };
    }
    if (entry.kind === 'delete') {
        if (!currentExists)
            return { action: 'restore-file' };
        return { action: 'confirm', fallback: 'restore-file', reason: 'recreated' };
    }
    // modify
    if (!currentExists) {
        return { action: 'confirm', fallback: 'restore-file', reason: 'gone' };
    }
    if (currentText === entry.after)
        return { action: 'restore-content' };
    return { action: 'confirm', fallback: 'restore-content', reason: 'hand-edited' };
}
/**
 * The pending-edit ledger: at most one entry per file path, with merge rules
 * for repeated AI touches and listeners for the UI layer. `toJSON`/`load`
 * round-trip the ledger through the plugin's storage so pending reviews
 * survive a window reload.
 */
class EditLedger {
    constructor() {
        this.entries = new Map();
        this.seq = 0;
        this.subs = new Set();
    }
    onChange(cb) {
        this.subs.add(cb);
        return () => {
            this.subs.delete(cb);
        };
    }
    emit() {
        for (const cb of [...this.subs])
            cb();
    }
    get size() {
        return this.entries.size;
    }
    get(path) {
        return this.entries.get(path) ?? null;
    }
    list() {
        return [...this.entries.values()].sort((x, y) => y.lastTs - x.lastTs);
    }
    /**
     * Record one AI change. Merge rules when the file is already pending:
     * - create + delete          → net zero, the entry is dropped
     * - delete + create/modify   → the file is back: kind becomes 'modify'
     * - anything else            → `after` is refreshed, `before` is preserved
     * Returns the (new or updated) entry, or null when a pair cancelled out.
     */
    record(path, kind, beforeText, beforeMissing, afterText) {
        const existing = this.entries.get(path);
        if (existing) {
            if (existing.kind === 'create' && kind === 'delete') {
                this.entries.delete(path);
                this.emit();
                return null;
            }
            if (existing.kind === 'delete' && kind !== 'delete') {
                existing.kind = 'modify';
            }
            existing.userTouched = existing.userTouched === true;
            existing.after = afterText;
            existing.lastTs = Date.now();
            this.emit();
            return existing;
        }
        const now = Date.now();
        const entry = {
            id: `e${++this.seq}`,
            path,
            kind,
            before: beforeMissing ? null : beforeText,
            beforeMissing: beforeMissing === true,
            after: afterText,
            firstTs: now,
            lastTs: now,
        };
        this.entries.set(path, entry);
        this.emit();
        return entry;
    }
    /** Accept (Keep) one file's pending change. Returns the dropped entry. */
    keep(path) {
        const entry = this.entries.get(path) ?? null;
        if (entry) {
            this.entries.delete(path);
            this.emit();
        }
        return entry;
    }
    /** Drop one entry without any action (after an undo, or a cancelled pair). */
    remove(path) {
        return this.keep(path);
    }
    /** Re-anchor the baseline after ONE edit was kept (per-edit Keep). */
    rebaseBefore(path, beforeText) {
        const entry = this.entries.get(path);
        if (!entry)
            return null;
        entry.before = beforeText;
        if (entry.kind === 'create') entry.kind = 'modify';
        entry.beforeMissing = false;
        this.emit();
        return entry;
    }
    /** Refresh the AFTER image (per-edit Undo rewrote the file). */
    setAfter(path, afterText) {
        const entry = this.entries.get(path);
        if (!entry)
            return null;
        entry.after = afterText;
        entry.lastTs = Date.now();
        this.emit();
        return entry;
    }
    clear() {
        if (this.entries.size > 0) {
            this.entries.clear();
            this.emit();
        }
    }
    toJSON() {
        return {
            version: 1,
            seq: this.seq,
            entries: this.list().map(e => ({
                id: e.id,
                path: e.path,
                kind: e.kind,
                before: e.before,
                beforeMissing: e.beforeMissing,
                after: e.after,
                userTouched: e.userTouched === true,
                firstTs: e.firstTs,
                lastTs: e.lastTs,
            })),
        };
    }
    /** Rebuild from {@link EditLedger#toJSON} output. Invalid shapes are ignored. */
    load(raw) {
        this.entries.clear();
        this.seq = 0;
        if (!raw || raw.version !== 1 || !Array.isArray(raw.entries))
            return;
        for (const rec of raw.entries) {
            if (!rec || typeof rec.path !== 'string')
                continue;
            if (rec.kind !== 'create' && rec.kind !== 'modify' && rec.kind !== 'delete')
                continue;
            this.entries.set(rec.path, {
                id: typeof rec.id === 'string' ? rec.id : `e${++this.seq}`,
                path: rec.path,
                kind: rec.kind,
                before: typeof rec.before === 'string' ? rec.before : null,
                beforeMissing: rec.kind !== 'create' && (rec.beforeMissing === true || typeof rec.before !== 'string'),
                userTouched: rec.userTouched === true,
                after: typeof rec.after === 'string' ? rec.after : null,
                firstTs: typeof rec.firstTs === 'number' ? rec.firstTs : Date.now(),
                lastTs: typeof rec.lastTs === 'number' ? rec.lastTs : Date.now(),
            });
        }
        if (typeof raw.seq === 'number' && raw.seq > this.seq)
            this.seq = raw.seq;
    }
}
exports.EditLedger = EditLedger;
