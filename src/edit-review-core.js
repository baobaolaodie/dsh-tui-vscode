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
exports.canonicalPathKey = exports.EditLedger = exports.MAX_DIFF_DP_LINES = void 0;
exports.splitLines = splitLines;
exports.diffLines = diffLines;
exports.diffWords = diffWords;
exports.elementChanges = elementChanges;
exports.pairLines = pairLines;
exports.applyHunkKeep = applyHunkKeep;
exports.applyHunkRevert = applyHunkRevert;
exports.planUndo = planUndo;
exports.formatCounts = formatCounts;
/** Above this size the exact comparison degrades to one coarse block (speed). */
const MAX_DIFF_DP_LINES = 1500;
exports.MAX_DIFF_DP_LINES = MAX_DIFF_DP_LINES;
/**
 * Canonical key for the review maps. The same file can arrive from two
 * sources with different casing: the DSH tool argument ("C:\Users\...",
 * whatever the tool/agent wrote) and VS Code's document path (the workspace
 * URI casing, "c:\Users\..."). Windows file systems are case-insensitive,
 * so keying by the raw string splits one file into two halves: the pending
 * badge and the diff (they carry the entry's own path) keep working, while
 * every editor-side lookup misses and the file shows no buttons or marks.
 * Fold separators + case on win32 only; entries keep the original path text
 * for display and file operations.
 */
function canonicalPathKey(path, platform = process.platform) {
    if (typeof path !== 'string' || path.length === 0)
        return path;
    if (platform !== 'win32')
        return path;
    return path.replace(/\//g, '\\').toLowerCase();
}
exports.canonicalPathKey = canonicalPathKey;
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
/** Max characters an element span may grow away from its raw edge. */
const MAX_ELEMENT_GROWTH = 60;
/** True for characters that belong to a word/identifier/number-like element. */
function isElementChar(c) {
    return c !== undefined && /[\p{L}\p{N}_.~-]/u.test(c);
}
/**
 * Element-level review spans for one changed line pair.
 *
 * `diffWords` works character by character, so a small edit inside a word
 * arrives as single-character shards (`holds` -> `s`, `VA1-3.xlsx` -> `-3`,
 * a rewritten tail -> several fragments). The editor marks should read like a
 * git diff instead: the changed ELEMENT (word / identifier / number / file
 * token) highlighted as one span, not per-character confetti.
 *
 * This expands every raw span across its surrounding element characters on
 * the SAME side and then unions overlapping groups, so each returned span is
 * one contiguous element-level change (optionally one deleted element paired
 * with the inserted element that replaced it).
 * @returns {Array<{oStart: number, oEnd: number, nStart: number, nEnd: number}>}
 *   spans in the same shape as `diffWords`; a pure insertion has
 *   oStart===oEnd, a pure deletion nStart===nEnd.
 */
function elementChanges(oldLine, newLine) {
    const raw = diffWords(oldLine, newLine);
    if (raw.length === 0)
        return raw;
    const groups = [];
    for (const e of raw) {
        const oldSpan = e.oEnd > e.oStart ? expandElementSpan(oldLine, e.oStart, e.oEnd) : null;
        const newSpan = e.nEnd > e.nStart ? expandElementSpan(newLine, e.nStart, e.nEnd) : null;
        if (oldSpan || newSpan)
            groups.push({ oldSpan, newSpan });
    }
    // Union groups that overlap, touch, or sit on both sides of a short
    // whitespace-only gap (a rewritten phrase stays ONE mark per side instead
    // of one per word). Repeat until stable so chains merge transitively.
    const bridge = (a, b, line) => {
        if (!a || !b)
            return false;
        if (overlapsOrTouches(a, b))
            return true;
        const [l, r] = a.start <= b.start ? [a, b] : [b, a];
        const gap = r.start - l.end;
        if (gap <= 0 || gap > 2)
            return false;
        return /^\s+$/.test(line.slice(l.end, r.start));
    };
    const connects = (g, m) => bridge(g.oldSpan, m.oldSpan, oldLine) || bridge(g.newSpan, m.newSpan, newLine);
    let merged = [];
    for (let pass = 0; pass <= groups.length; pass++) {
        const next = [];
        let joined = false;
        for (const g of merged.concat(pass === 0 ? groups : [])) {
            const hit = next.find(m => connects(g, m));
            if (!hit)
                next.push(g);
            else {
                hit.oldSpan = unionSpan(hit.oldSpan, g.oldSpan);
                hit.newSpan = unionSpan(hit.newSpan, g.newSpan);
                joined = true;
            }
        }
        merged = next;
        if (!joined)
            break;
    }
    const spans = [];
    for (const g of merged) {
        const oldSpan = g.oldSpan ? trimSpan(oldLine, g.oldSpan) : null;
        const newSpan = g.newSpan ? trimSpan(newLine, g.newSpan) : null;
        if (!oldSpan && !newSpan)
            continue;
        const oStart = oldSpan ? oldSpan.start : (newSpan.start);
        const oEnd = oldSpan ? oldSpan.end : oStart;
        const nStart = newSpan ? newSpan.start : Math.min(oStart, newLine.length);
        const nEnd = newSpan ? newSpan.end : nStart;
        spans.push({ oStart, oEnd, nStart, nEnd });
    }
    return spans;
}
/** Grow a raw span across the element characters touching both of its edges. */
function expandElementSpan(line, start, end) {
    let s = start, e = end, steps = 0;
    while (s > 0 && steps < MAX_ELEMENT_GROWTH && isElementChar(line[s - 1]) && isElementChar(line[s])) {
        s--;
        steps++;
    }
    steps = 0;
    while (e < line.length && steps < MAX_ELEMENT_GROWTH && isElementChar(line[e - 1]) && isElementChar(line[e])) {
        e++;
        steps++;
    }
    return { start: s, end: e };
}
function trimSpan(line, span) {
    let { start, end } = span;
    while (start < end && /\s/.test(line[start]))
        start++;
    while (end > start && /\s/.test(line[end - 1]))
        end--;
    return start < end ? { start, end } : null;
}
function overlapsOrTouches(a, b) {
    if (!a || !b)
        return false;
    return a.start <= b.end && b.start <= a.end;
}
function unionSpan(a, b) {
    if (!a)
        return b;
    if (!b)
        return a;
    return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}
const MAX_ALIGNMENT_CELLS = 4096;
/**
 * Pair the old and new lines of a modified hunk by content similarity.
 *
 * The hunk counts often differ (a delete plus a rewrite inside one block),
 * and index order then pairs unrelated lines ("Foreach s in 1 2 3 {"
 * against an import line), which renders as a nonsense end-to-end span. A
 * monotone best-similarity alignment pairs the lines that actually
 * correspond; leftovers stay unpaired and show as pure deletions/insertions.
 * Very large blocks skip the alignment and keep index order (bounded cost).
 * @returns {{pairs: Array<{oldIndex: number, newIndex: number}>, unpairedOld: number[], unpairedNew: number[]}}
 */
function pairLines(oldLines, newLines) {
    const ra = oldLines.length, rb = newLines.length;
    const pairs = [], unpairedOld = [], unpairedNew = [];
    if (!ra || !rb)
        return { pairs, unpairedOld: oldLines.map((_, i) => i), unpairedNew: newLines.map((_, i) => i) };
    if (ra * rb > MAX_ALIGNMENT_CELLS) {
        const k = Math.min(ra, rb);
        for (let n = 0; n < k; n++)
            pairs.push({ oldIndex: n, newIndex: n });
        for (let n = k; n < ra; n++)
            unpairedOld.push(n);
        for (let n = k; n < rb; n++)
            unpairedNew.push(n);
        return { pairs, unpairedOld, unpairedNew };
    }
    const sim = [];
    for (let i = 0; i < ra; i++) {
        sim.push([]);
        for (let j = 0; j < rb; j++)
            sim[i].push(lineSimilarity(oldLines[i], newLines[j]));
    }
    // Best monotone alignment: pair (i, j) adds similarity, leaving a line
    // unpaired costs nothing, a tiny bias keeps index-order pairing when all
    // similarities are equal (the classic rewritten-block look).
    const BIAS = 1e-6;
    const width = rb + 1;
    const dp = new Float64Array((ra + 1) * width);
    const from = new Uint8Array((ra + 1) * width); // 0 skip old, 1 skip new, 2 pair
    for (let i = 1; i <= ra; i++) {
        for (let j = 1; j <= rb; j++) {
            const skipOld = dp[(i - 1) * width + j];
            const skipNew = dp[i * width + (j - 1)];
            const paired = dp[(i - 1) * width + (j - 1)] + sim[i - 1][j - 1] + BIAS;
            if (paired >= skipOld && paired >= skipNew) {
                dp[i * width + j] = paired;
                from[i * width + j] = 2;
            }
            else if (skipOld >= skipNew) {
                dp[i * width + j] = skipOld;
                from[i * width + j] = 0;
            }
            else {
                dp[i * width + j] = skipNew;
                from[i * width + j] = 1;
            }
        }
    }
    let i = ra, j = rb;
    while (i > 0 && j > 0) {
        const step = from[i * width + j];
        if (step === 2) {
            pairs.push({ oldIndex: i - 1, newIndex: j - 1 });
            i--;
            j--;
        }
        else if (step === 0) {
            unpairedOld.push(--i);
        }
        else {
            unpairedNew.push(--j);
        }
    }
    while (i > 0) { unpairedOld.push(--i); }
    while (j > 0) { unpairedNew.push(--j); }
    pairs.reverse();
    unpairedOld.reverse();
    unpairedNew.reverse();
    return { pairs, unpairedOld, unpairedNew };
}
/** Cheap 0..1 content similarity for two lines (prefix + suffix + bag overlap). */
function lineSimilarity(a, b) {
    if (a === b)
        return 1;
    const n = Math.min(a.length, b.length);
    let p = 0;
    while (p < n && a[p] === b[p])
        p++;
    let s = 0;
    while (s < n - p && a[a.length - 1 - s] === b[b.length - 1 - s])
        s++;
    const bag = new Map();
    for (let k = 0; k < a.length; k++)
        bag.set(a[k], (bag.get(a[k]) ?? 0) + 1);
    let overlap = 0;
    for (let k = 0; k < b.length; k++) {
        const left = bag.get(b[k]);
        if (left > 0) {
            bag.set(b[k], left - 1);
            overlap++;
        }
    }
    return (p + s + overlap) / (a.length + b.length || 1);
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
        return this.entries.get(canonicalPathKey(path)) ?? null;
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
    record(path, kind, beforeText, beforeMissing, afterText, provenance) {
        const key = canonicalPathKey(path);
        const existing = this.entries.get(key);
        if (existing) {
            if (existing.kind === 'create' && kind === 'delete') {
                this.entries.delete(key);
                this.emit();
                return null;
            }
            if (existing.kind === 'delete' && kind !== 'delete') {
                existing.kind = 'modify';
            }
            existing.userTouched = existing.userTouched === true;
            // Provenance can never be upgraded by merging a later tool edit.
            if (provenance && existing.provenance !== provenance) existing.provenance = 'unverified';
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
            provenance: provenance ?? 'unverified',
            firstTs: now,
            lastTs: now,
        };
        this.entries.set(key, entry);
        this.emit();
        return entry;
    }
    /** Accept (Keep) one file's pending change. Returns the dropped entry. */
    keep(path) {
        const key = canonicalPathKey(path);
        const entry = this.entries.get(key) ?? null;
        if (entry) {
            this.entries.delete(key);
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
        const entry = this.entries.get(canonicalPathKey(path));
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
        const entry = this.entries.get(canonicalPathKey(path));
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
                provenance: e.provenance ?? 'unverified',
                conflict: e.conflict,
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
            this.entries.set(canonicalPathKey(rec.path), {
                id: typeof rec.id === 'string' ? rec.id : `e${++this.seq}`,
                path: rec.path,
                kind: rec.kind,
                before: typeof rec.before === 'string' ? rec.before : null,
                beforeMissing: rec.kind !== 'create' && (rec.beforeMissing === true || typeof rec.before !== 'string'),
                userTouched: rec.userTouched === true,
                provenance: rec.provenance === 'file-tool-v1' ? 'file-tool-v1' : 'unverified',
                conflict: typeof rec.conflict === 'string' ? rec.conflict : undefined,
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
