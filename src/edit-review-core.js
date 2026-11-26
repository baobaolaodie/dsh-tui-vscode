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
const nodePath = require('node:path');
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROVENANCE_RE = exports.canonicalPathKey = exports.EditLedger = exports.MAX_DIFF_DP_LINES = void 0;
exports.splitLines = splitLines;
exports.diffLines = diffLines;
exports.diffWords = diffWords;
exports.elementChanges = elementChanges;
exports.pairLines = pairLines;
exports.planUndo = planUndo;
exports.formatCounts = formatCounts;
/** Above this size the exact comparison degrades to one coarse block (speed). */
const MAX_DIFF_DP_LINES = 1500;
exports.MAX_DIFF_DP_LINES = MAX_DIFF_DP_LINES;
/**
 * Shape of a provenance tag. The ledger only needs to keep the tags it was
 * given ("file-tool-v1" for a verified file-tool transaction, "upstream-v1"
 * for an event that arrived over the IDE channel, "unverified" otherwise);
 * persistence must never flatten an unknown-but-well-formed tag back to
 * "unverified", or a reload would mislabel the review source.
 */
const PROVENANCE_RE = /^[a-z][a-z0-9-]{0,31}$/;
exports.PROVENANCE_RE = PROVENANCE_RE;
/** Cap on the persisted id counter (a corrupt `seq` must not mint `e1e21`). */
const MAX_LEDGER_SEQ = 1e9;
exports.MAX_LEDGER_SEQ = MAX_LEDGER_SEQ;
/**
 * Canonical key for the review maps. The same file can arrive from two
 * sources with different casing: the DSH tool argument ("C:\Users\...",
 * whatever the tool/agent wrote) and VS Code's document path (the workspace
 * URI casing, "c:\Users\..."). Windows file systems are case-insensitive,
 * so keying by the raw string splits one file into two halves: the pending
 * badge and the diff (they carry the entry's own path) keep working, while
 * every editor-side lookup misses and the file shows no buttons or marks.
 * Fold separators + case on win32 only; entries keep the original path text
 * for display and file operations. Normalize first: the same file can arrive
 * as `C:\w\f`, `C:\w\\.\f` or `C:/w/f` from different writers.
 */
function canonicalPathKey(target, platform = process.platform) {
    if (typeof target !== 'string' || target.length === 0)
        return target;
    if (platform !== 'win32')
        return target;
    return nodePath.win32.normalize(target).toLowerCase();
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
    // Strict '<': the suffix may not overlap the common prefix. With '<=' a
    // lone repeated line (`x\nx` -> `x`) is consumed by the prefix and the
    // suffix at once, so the diff reports zero hunks for a real change.
    while (suffix < a.length - prefix
        && suffix < b.length - prefix
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
        // added block, with the real block sizes as the counts (the label may
        // overstate a rewrite, never understate it).
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
/** Numeric part of a minted entry id (`e42` -> 42); 0 for anything else. */
function entryOrdinal(entry) {
    const match = typeof entry.id === 'string' ? /^e(\d+)$/.exec(entry.id) : null;
    return match === null ? 0 : Number(match[1]);
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
    // Strict '<' for the same reason as in diffLines: the suffix must not
    // reach back into the prefix (e.g. `foo` -> `fo` has a real deletion).
    while (s < a.length - p
        && s < b.length - p
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
    // A created file that is already gone has nothing to restore: drop the
    // entry before any confirmation prompt would offer to delete it.
    if (entry.kind === 'create' && !currentExists) {
        return { action: 'drop' };
    }
    // Any unresolved conflict asks first: the marker may stand without the
    // userTouched flag (an upstream baseline mismatch), and it must never be
    // written over silently.
    if (entry.userTouched || entry.conflict) {
        return { action: 'confirm', fallback: entry.kind === 'create' ? 'delete-file' : currentExists ? 'restore-content' : 'restore-file', reason: 'user-edited' };
    }
    if (entry.kind === 'create') {
        if (entry.after !== null && currentText === entry.after)
            return { action: 'delete-file' };
        return { action: 'confirm', fallback: 'delete-file', reason: 'hand-edited' };
    }
    if (entry.kind === 'delete') {
        if (!currentExists)
            return { action: 'restore-file' };
        return { action: 'confirm', fallback: 'restore-file', reason: 'recreated' };
    }
    // modify: without an after image there is nothing safe to compare against.
    if (typeof entry.after !== 'string') {
        return { action: 'blocked', reason: 'invalid-entry' };
    }
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
        return [...this.entries.values()].sort((x, y) => {
            if (y.lastTs !== x.lastTs) return y.lastTs - x.lastTs;
            // Same-millisecond touches: the entry minted last is the newer one.
            return entryOrdinal(y) - entryOrdinal(x);
        });
    }
    /**
     * Record one AI change. Merge rules when the file is already pending:
     * - create + delete          → net zero, the entry is dropped
     * - delete + create/modify   → the file is back: kind becomes 'modify'
     * - modify + delete          → the pending review becomes 'delete'
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
            // An existing pending change that now ends in removal is a delete
            // review: the baseline stays, but the UI must label it deleted
            // (create + delete was handled above as a net-zero pair).
            if (afterText === null && existing.kind !== 'create') existing.kind = 'delete';
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
            userTouched: false,
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
    /**
     * Rebuild from {@link EditLedger#toJSON} output. Invalid shapes are ignored.
     *
     * The TEXT shape (size bound, NUL) is enforced by the custody layer
     * (`edit-ledger-store.js`), which owns the review text contract; callers
     * that use this class directly are responsible for that check.
     */
    load(raw) {
        this.entries.clear();
        this.seq = 0;
        if (!raw || raw.version !== 1 || !Array.isArray(raw.entries))
            return;
        let maxSeq = typeof raw.seq === 'number' && raw.seq > 0 ? Math.min(Math.floor(raw.seq), MAX_LEDGER_SEQ) : 0;
        const records = [];
        for (const rec of raw.entries) {
            if (!rec || typeof rec.path !== 'string')
                continue;
            if (rec.kind !== 'create' && rec.kind !== 'modify' && rec.kind !== 'delete')
                continue;
            const before = typeof rec.before === 'string' ? rec.before : null;
            const after = typeof rec.after === 'string' ? rec.after : null;
            // Older snapshots stored a removed file as modify + after:null (the
            // reviewed host called the ledger with that shape); migrate it, even
            // when the pre-edit original was never captured.
            const legacyDelete = rec.kind === 'modify' && after === null && (before !== null || rec.beforeMissing === true);
            const kind = legacyDelete ? 'delete' : rec.kind;
            const beforeMissing = kind !== 'create' && (rec.beforeMissing === true || before === null);
            // Shape rules: a create has no before image, a delete has no after
            // image, and a modify needs its after image (its before may be the
            // one that was never captured).
            if (kind === 'create' && (before !== null || beforeMissing)) continue;
            if (kind === 'delete' && after !== null) continue;
            if (kind !== 'delete' && after === null) continue;
            if (kind === 'modify' && before === null && !beforeMissing) continue;
            // A pending review whose images are identical is not a review.
            if (before !== null && after !== null && before === after) continue;
            const match = typeof rec.id === 'string' ? /^e(\d+)$/.exec(rec.id) : null;
            const parsedId = match === null ? null : Number(match[1]);
            // An id past the counter cap cannot be continued safely: remint it.
            const keepId = parsedId !== null && parsedId <= MAX_LEDGER_SEQ;
            if (keepId) maxSeq = Math.max(maxSeq, parsedId);
            records.push({ rec, kind, before, after, beforeMissing, id: keepId ? rec.id : null });
        }
        // Two passes: collect the largest id first, then mint ids for records
        // that carry none — an id must never be handed out twice.
        for (const { rec, kind, before, after, beforeMissing, id } of records) {
            const stored = {
                id: id ?? `e${++maxSeq}`,
                path: rec.path,
                kind,
                before,
                beforeMissing,
                userTouched: rec.userTouched === true,
                provenance: typeof rec.provenance === 'string' && PROVENANCE_RE.test(rec.provenance) ? rec.provenance : 'unverified',
                after,
                firstTs: typeof rec.firstTs === 'number' ? rec.firstTs : Date.now(),
                lastTs: typeof rec.lastTs === 'number' ? rec.lastTs : Date.now(),
            };
            if (typeof rec.conflict === 'string')
                stored.conflict = rec.conflict;
            this.entries.set(canonicalPathKey(rec.path), stored);
        }
        this.seq = maxSeq;
    }
}
exports.EditLedger = EditLedger;
