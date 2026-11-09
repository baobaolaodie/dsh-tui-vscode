'use strict';
/**
 * edit-ledger-store — custody of the pending-edit ledger (data layer).
 *
 * The split keeps three layers apart: this module owns the ONE thing the
 * presentation layer and the attribution layer must share — the list of
 * un-reviewed AI changes to files — plus the paths the extension itself is
 * currently writing, so an in-flight restore is never mistaken for a user
 * edit. It is pure Node: no `vscode` import, no filesystem access, no timers,
 * no randomness. The host supplies the current text and performs every write;
 * the store only decides what the ledger should look like afterwards, and it
 * is where the merge rules of "one pending entry per file" are locked by unit
 * tests.
 *
 * Text shapes are not decided here: `record()` accepts only text that passes
 * `review-text.js`'s contract (UTF-8 size bound, no NUL), because the ledger
 * compares images exactly against what the editor and the disk produce.
 *
 * Consumers (the following PRs of the split):
 * - presentation: subscribes with `onChange`, draws from `list()`, settles
 *   decisions with `keep()`, `keepHunk()`, `planHunkUndo()` +
 *   `commitHunkUndo()`, and mirrors hand edits with `observeUserEdit()`;
 * - attribution: reads the existing baseline with `get()` (or checks it with
 *   `checkBaseline()`), records a verified tool change with `record()`, and
 *   marks writes in flight with `markWriting()` / `clearWriting()`.
 *
 * IO stays in the host deliberately: `planHunkUndo()` returns the exact text
 * to write and does not mutate anything; `commitHunkUndo()` publishes the
 * result only after the host confirms the write succeeded.
 */
const { EditLedger, MAX_LEDGER_SEQ, PROVENANCE_RE, canonicalPathKey, planUndo } = require('./edit-review-core');
const { isReviewableText } = require('./review-text');
const precise = require('./precise-review-core');

const KINDS = Object.freeze(['create', 'modify', 'delete']);
/** Entry fields a consumer may patch; everything else is derived or owned. */
const MUTABLE_FIELDS = Object.freeze(['userTouched', 'conflict']);
/** Conflict marker for "an upstream edit started from a different baseline". */
const BASELINE_CONFLICT = 'transaction-before-mismatch';

/** True when either image carries a UTF-8 encoding BOM (review-text keeps it). */
function hasBom(entry) {
    return (typeof entry.before === 'string' && entry.before.startsWith('\uFEFF'))
        || (typeof entry.after === 'string' && entry.after.startsWith('\uFEFF'));
}

class EditLedgerStore {
    #ledger;

    constructor() {
        /** @type {EditLedger} the pure model; use the wrapper methods instead. */
        this.#ledger = new EditLedger();
        this.writing = new Map();
    }

    // ---- custody -----------------------------------------------------------
    /** Number of files with an un-reviewed change. */
    get size() {
        return this.#ledger.size;
    }

    /** The pending entry for `path`, or null. */
    get(path) {
        return this.#ledger.get(path);
    }

    /** All pending entries, most recently touched first. */
    list() {
        return this.#ledger.list();
    }

    /**
     * Record one AI change.
     *
     * Call `get(path)` before `record()` when the caller needs to know whether
     * this is a NEW pending review or an edit merged into an existing one (the
     * presentation layer only auto-opens a comparison for the first one).
     *
     * @param {{path: string, before?: string|null, after?: string|null,
     *   kind?: 'create'|'modify'|'delete', beforeMissing?: boolean,
     *   provenance?: string}} input `kind` is inferred from which side is
     *   null when omitted; `beforeMissing` means "the pre-edit original could
     *   not be captured" (Undo and per-hunk decisions are unavailable;
     *   whole-file Keep still works).
     * @returns {object|null} the new or merged entry; null when the change
     *   cancels an earlier one out (create followed by delete, or the file is
     *   back at its baseline).
     * @throws {TypeError} on a malformed notification or non-reviewable text —
     *   the caller drops that change and keeps running.
     */
    record(input) {
        if (!input || typeof input !== 'object') throw new TypeError('record() needs an object');
        const { path: target, before = null, after = null, provenance = 'unverified' } = input;
        const beforeMissing = input.beforeMissing === true;
        if (typeof target !== 'string' || target.length === 0) throw new TypeError('record() needs a path');
        if (before !== null && typeof before !== 'string') throw new TypeError('record(): before must be a string or null');
        if (after !== null && !isReviewableText(after)) throw new TypeError('record(): unreviewable after image');
        if (typeof provenance !== 'string' || !PROVENANCE_RE.test(provenance)) {
            throw new TypeError(`record(): bad provenance ${String(provenance)}`);
        }
        let kind = input.kind;
        if (kind === undefined) {
            if (after === null) kind = 'delete';
            else kind = before === null && !beforeMissing ? 'create' : 'modify';
        }
        if (!KINDS.includes(kind)) throw new TypeError(`record(): unknown kind ${kind}`);
        // The reviewed host reports a removed file as modify + after:null; that
        // is a deletion, not a modify without an image.
        if (kind === 'modify' && after === null) kind = 'delete';
        const existing = this.#ledger.get(target);
        // A merge into an existing entry keeps the entry's original before
        // image, so the operation's own before (often a whole file) is not
        // stored and does not need to pass the text contract.
        const effectiveBefore = beforeMissing ? null : before;
        if (!existing && effectiveBefore !== null && !isReviewableText(effectiveBefore)) {
            throw new TypeError('record(): unreviewable before image');
        }
        if (kind === 'create') {
            // A merge into an existing entry may carry the operation's own
            // before image; the ledger keeps the entry's original one.
            if (effectiveBefore !== null && !existing) throw new TypeError('record(): a create has no before image');
            if (beforeMissing) throw new TypeError('record(): a create cannot be missing its before image');
            if (typeof after !== 'string') throw new TypeError('record(): a create needs its after image');
        }
        else if (kind === 'delete') {
            if (effectiveBefore !== null && typeof effectiveBefore !== 'string') {
                throw new TypeError('record(): a delete needs its before image or beforeMissing');
            }
            if (after !== null) throw new TypeError('record(): a delete has no after image');
        }
        else if (typeof after !== 'string') {
            throw new TypeError('record(): a modify needs its after image');
        }
        if (kind !== 'create' && !existing && effectiveBefore === null && !beforeMissing) {
            throw new TypeError(`record(): a ${kind} needs its before image`);
        }
        // A change that brings the file back to its baseline is not a review:
        // drop the pending entry instead of recording a zero-hunk phantom.
        // (Decide before recording so listeners see one change, not two.)
        const baselineBefore = existing ? existing.before : effectiveBefore;
        if (baselineBefore !== null && after === baselineBefore) {
            if (existing) this.#ledger.remove(target);
            return null;
        }
        return this.#ledger.record(target, kind, before, beforeMissing, after, provenance);
    }

    /** Accept the pending change for `path` and forget it (Keep never writes). */
    keep(path) {
        return this.#ledger.keep(path);
    }

    /** Forget the entry for `path` without drawing conclusions (already handled). */
    remove(path) {
        return this.#ledger.remove(path);
    }

    /**
     * Drop every pending entry (host decided all of them).
     *
     * This is NOT "Undo all": the files are untouched. A bulk Undo must run
     * the per-file decision path (read disk, plan, write) and only remove the
     * entries it actually restored.
     */
    clear() {
        this.#ledger.clear();
    }

    /** Re-anchor the baseline after ONE hunk was kept (never empty). */
    rebaseBefore(path, before) {
        if (!isReviewableText(before)) throw new TypeError('rebaseBefore(): unreviewable before image');
        return this.#ledger.rebaseBefore(path, before);
    }

    /** Refresh the AFTER image after a hunk undo rewrote the file. */
    setAfter(path, after) {
        if (!isReviewableText(after)) throw new TypeError('setAfter(): unreviewable after image');
        const entry = this.#ledger.get(path);
        if (entry && entry.kind === 'delete') {
            // The file exists with content again: the review is no longer a
            // deletion but a modification against the same baseline.
            entry.kind = 'modify';
        }
        return this.#ledger.setAfter(path, after);
    }

    /** Patch the two consumer-owned entry fields and notify. Null when absent. */
    update(path, patch) {
        const entry = this.#ledger.get(path);
        if (!entry || !patch || typeof patch !== 'object') return null;
        if (patch.userTouched !== undefined && typeof patch.userTouched !== 'boolean') {
            throw new TypeError('update(): userTouched must be a boolean');
        }
        if (patch.conflict !== undefined && typeof patch.conflict !== 'string') {
            throw new TypeError('update(): conflict must be a string');
        }
        const next = { ...patch };
        // An empty conflict code is "no conflict", not a sticky empty string.
        if (next.conflict === '') next.conflict = undefined;
        let changed = false;
        for (const key of Object.keys(next)) {
            if (!MUTABLE_FIELDS.includes(key)) continue;
            if (entry[key] === next[key]) continue;
            if (next[key] === undefined) delete entry[key];
            else entry[key] = next[key];
            changed = true;
        }
        if (changed) this.#ledger.emit();
        return entry;
    }

    // ---- writes in flight --------------------------------------------------
    /**
     * Mark `path` as being written by the host right now.
     *
     * Overlapping writes to one path are counted: call it once per write and
     * pair every call with `clearWriting()` in a `finally` block. A leaked mark
     * silences the file's user-edit trail for the rest of the session.
     */
    markWriting(path) {
        const key = canonicalPathKey(path);
        this.writing.set(key, (this.writing.get(key) ?? 0) + 1);
    }

    /** Clear one in-flight mark for `path` (pair with markWriting). */
    clearWriting(path) {
        const key = canonicalPathKey(path);
        const remaining = (this.writing.get(key) ?? 0) - 1;
        if (remaining > 0) this.writing.set(key, remaining);
        else this.writing.delete(key);
    }

    /** True while the host is writing `path` (its fs events are not user edits). */
    isWriting(path) {
        return this.writing.has(canonicalPathKey(path));
    }

    // ---- decisions (pure; the host supplies text and performs writes) ------
    /**
     * Whole-file Undo plan (restore / delete / drop / confirm / blocked).
     *
     * BOM-prefixed images are blocked here: the editor model omits the UTF-8
     * BOM, so restoring through it would either lose the preamble or double it.
     * @returns one of the `planUndo()` actions, or null when there is no entry.
     */
    planUndo(path, currentExists, currentText) {
        const entry = this.#ledger.get(path);
        if (!entry) return null;
        if (hasBom(entry)) return { action: 'blocked', reason: 'bom-unsupported' };
        return planUndo(entry, currentExists, currentText);
    }

    /**
     * Attribution baseline check: may a new verified edit start from `before`?
     *
     * Mirrors the review rule "a new verified edit must not relabel an older
     * unverified stretch": when the file already has a pending entry, the new
     * edit must start exactly at its recorded after image, and a pending entry
     * the user has touched is a conflict. On a mismatch the entry is marked
     * (`userTouched` + a stable conflict code) and the caller must NOT record.
     * @returns {{status: 'no-entry'|'ok'|'mismatch'}}
     */
    checkBaseline(path, beforeText) {
        const entry = this.#ledger.get(path);
        if (!entry) return { status: 'no-entry' };
        // Any unresolved conflict (including one flagged without userTouched)
        // and any image mismatch is a mismatch.
        if (entry.userTouched === true || entry.conflict || entry.after !== beforeText) {
            let changed = false;
            if (entry.userTouched !== true) {
                entry.userTouched = true;
                changed = true;
            }
            if (!entry.conflict) {
                entry.conflict = BASELINE_CONFLICT;
                changed = true;
            }
            if (changed) this.#ledger.emit();
            return { status: 'mismatch' };
        }
        return { status: 'ok' };
    }

    /**
     * The whole-file button hint: pins the entry identity and both image
     * digests, so a control rendered before the ledger changed can never
     * target the newer state.
     */
    fileHint(path) {
        const entry = this.#ledger.get(path);
        if (!entry) return null;
        return {
            file: true,
            id: entry.id,
            beforeHash: precise.digest(entry.before),
            afterHash: precise.digest(entry.after),
        };
    }

    /** True when `hint` (from `fileHint()`) still describes the entry at `path`. */
    matchesFileHint(path, hint) {
        const entry = this.#ledger.get(path);
        if (!entry || !hint || hint.file !== true) return false;
        return entry.id === hint.id
            && precise.digest(entry.before) === hint.beforeHash
            && precise.digest(entry.after) === hint.afterHash;
    }

    /**
     * Resolve the hunk a button hint points at, against the CURRENT text.
     * The hint pins the entry's identity and both image digests, so an old
     * control can never target a nearer hunk or another review.
     * @returns the exact-text hunk, or null when the hint is stale.
     */
    resolveHunk(path, hint, current) {
        const entry = this.#ledger.get(path);
        if (!entry || entry.beforeMissing || entry.kind === 'delete') return null;
        if (entry.conflict === 'save-participant') return null;
        // A BOM file is recognized so its Undo can be refused, not written
        // through a model that drops the preamble (or writes it twice).
        if (hasBom(entry)) return null;
        if (typeof current !== 'string') return null;
        return precise.resolveChange(entry, current, hint);
    }

    /**
     * Keep exactly one hunk: fold it into the baseline. Writing nothing is the
     * point of Keep — the file already contains the accepted text.
     * @returns {{status: 'kept', before: string, done: boolean}|{status: 'stale'}}
     *   `done` means the entry was fully accepted and dropped.
     */
    keepHunk(path, hint, current) {
        const entry = this.#ledger.get(path);
        const hunk = this.resolveHunk(path, hint, current);
        if (!entry || !hunk) return { status: 'stale' };
        const before = precise.keepChange(entry.before ?? '', hunk);
        // The folded baseline must stay reviewable; refuse before mutating so
        // a flag clearing is never left behind by a failed rebase.
        if (!isReviewableText(before)) return { status: 'stale' };
        const done = before === current;
        if (done) {
            // The whole pending stretch is accepted: one change (the drop).
            this.keep(path);
            return { status: 'kept', before, done };
        }
        // Resolving the hint already proved `current === entry.after`, so a
        // leftover flag is stale: an explicit hunk decision resolves it.
        if (entry.userTouched || entry.conflict) {
            entry.userTouched = false;
            delete entry.conflict;
        }
        this.rebaseBefore(path, before);
        return { status: 'kept', before, done };
    }

    /**
     * Plan one hunk undo. Pure: the host writes `text`, then calls
     * `commitHunkUndo()` only if the write succeeded.
     *
     * The host must keep plan → write → commit as one queued operation for the
     * path: the plan binds to the entry through the hint, and `commitHunkUndo`
     * publishes the text it is given. Data-layer methods cannot make the host's
     * I/O atomic; PR-2 owns that queue.
     * @returns {{status: 'planned', text: string, done: boolean}|{status: 'stale'}}
     *   `done` means the file is back to its pre-edit content (the entry can go).
     */
    planHunkUndo(path, hint, current) {
        const entry = this.#ledger.get(path);
        const hunk = this.resolveHunk(path, hint, current);
        if (!entry || !hunk) return { status: 'stale' };
        const text = precise.undoChange(current, hunk);
        // The host writes exactly this text: refuse a result the ledger could
        // not store (the host treats `stale` as "do not write").
        if (!isReviewableText(text)) return { status: 'stale' };
        return { status: 'planned', text, done: entry.kind !== 'create' && entry.before === text };
    }

    /**
     * Publish a completed hunk undo (the write already succeeded).
     *
     * The host MUST pass the text it read back from disk, not the planned text:
     * a save participant may have changed the file, and the ledger's `after`
     * must be what the editor will actually see.
     * @returns {object|null} the remaining entry, or null when it was dropped.
     */
    commitHunkUndo(path, text) {
        const entry = this.#ledger.get(path);
        if (!entry) return null;
        // A delete review has no after image; a hunk undo can never target it
        // (resolveHunk refuses it), so refuse the commit instead of writing an
        // invalid shape the persistence layer would restore later.
        if (entry.kind === 'delete') return entry;
        // The host normally passed text through review-text; reject anything
        // else instead of persisting an image the editor can never match.
        if (!isReviewableText(text)) throw new TypeError('commitHunkUndo(): unreviewable after image');
        // An explicit hunk decision resolves a stale flag, whatever its code.
        if (entry.userTouched || entry.conflict) {
            entry.userTouched = false;
            delete entry.conflict;
        }
        if (entry.kind !== 'create' && entry.before === text) {
            this.remove(path);
            return null;
        }
        this.setAfter(path, text);
        return this.#ledger.get(path) ?? null;
    }

    /**
     * Mirror a hand edit into the pending entry.
     *
     * Edits that provably do not overlap the AI stretch are folded into BOTH
     * snapshots so later Keep/Undo keep meaning the same thing; an edit that
     * touches it is an explicit conflict, not a permanent save latch.
     * @returns {{status: 'no-entry'|'invalid-text'|'writing'|'unchanged'|'conflict'|'rebased'}}
     */
    observeUserEdit(path, current) {
        const entry = this.#ledger.get(path);
        if (!entry) return { status: 'no-entry' };
        // A hand edit is host-supplied text too: an oversized or binary buffer
        // must not be folded into the ledger and lost on the next reload.
        if (!isReviewableText(current)) return { status: 'invalid-text' };
        if (this.isWriting(path)) return { status: 'writing' };
        if (current === entry.after) {
            // Only an ordinary overlap flag lifts by itself; a flagged
            // uncertainty (a save participant changed the file during our own
            // write, or an upstream edit started from a different baseline)
            // stays until an explicit decision resolves it.
            if (entry.userTouched && (entry.conflict === undefined || entry.conflict === 'overlap-or-external')) {
                entry.userTouched = false;
                delete entry.conflict;
                this.#ledger.emit();
            }
            return { status: 'unchanged' };
        }
        const rebased = entry.beforeMissing
            ? { conflict: true }
            : precise.rebaseUserEdit(entry.before, entry.after, current);
        if (rebased.conflict) {
            // An overlap never overwrites a sticky conflict code with the
            // generic one.
            const conflict = entry.conflict === undefined || entry.conflict === 'overlap-or-external'
                ? 'overlap-or-external'
                : entry.conflict;
            if (entry.userTouched !== true || entry.conflict !== conflict) {
                entry.userTouched = true;
                entry.conflict = conflict;
                this.#ledger.emit();
            }
            return { status: 'conflict' };
        }
        // The mirrored images must stay reviewable; when the hand edit pushes
        // them past the contract, keep the entry untouched and flag it.
        if (!isReviewableText(rebased.before) || !isReviewableText(rebased.after)) {
            const conflict = entry.conflict === undefined || entry.conflict === 'overlap-or-external'
                ? 'overlap-or-external'
                : entry.conflict;
            if (entry.userTouched !== true || entry.conflict !== conflict) {
                entry.userTouched = true;
                entry.conflict = conflict;
                this.#ledger.emit();
            }
            return { status: 'conflict' };
        }
        entry.before = rebased.before;
        entry.after = rebased.after;
        entry.lastTs = Date.now();
        // A hand edit that provably does not overlap the AI stretch re-anchors
        // both images. Ordinary overlap flags lift, but a flagged uncertainty
        // stays sticky until one of the explicit resolution paths runs.
        if (entry.conflict === undefined || entry.conflict === 'overlap-or-external') {
            entry.userTouched = false;
            delete entry.conflict;
        }
        this.#ledger.emit();
        return { status: 'rebased' };
    }

    // ---- persistence (the host serialises to its storage) ------------------
    /** Plain JSON-safe snapshot of the pending ledger. */
    toJSON() {
        return this.#ledger.toJSON();
    }

    /**
     * Rebuild from `toJSON()` output; invalid shapes are ignored. Entries
     * whose persisted text violates the review text contract are filtered out
     * before loading (a reload must not resurrect a review that can never
     * match the editor), and listeners are notified exactly once.
     */
    fromJSON(raw) {
        this.writing.clear();
        let sanitized = raw;
        let maxId = 0;
        if (raw && Array.isArray(raw.entries)) {
            const kept = [];
            for (const rec of raw.entries) {
                if (!rec || typeof rec !== 'object') continue;
                const match = typeof rec.id === 'string' ? /^e(\d+)$/.exec(rec.id) : null;
                if (match) {
                    const idNumber = Number(match[1]);
                    if (idNumber <= MAX_LEDGER_SEQ) maxId = Math.max(maxId, idNumber);
                }
                const validBefore = rec.before === null || rec.before === undefined || isReviewableText(rec.before);
                const validAfter = rec.after === null || rec.after === undefined || isReviewableText(rec.after);
                if (validBefore && validAfter) kept.push(rec);
            }
            // Keep the id sequence above every id the snapshot ever carried,
            // including the entries filtered out here.
            const seq = typeof raw.seq === 'number' && raw.seq > 0
                ? Math.min(Math.floor(raw.seq), MAX_LEDGER_SEQ)
                : 0;
            sanitized = { ...raw, seq: Math.max(seq, maxId), entries: kept };
        }
        this.#ledger.load(sanitized);
        this.#ledger.emit();
    }

    /** Subscribe to ledger changes (record / keep / update / ...). */
    onChange(callback) {
        return this.#ledger.onChange(callback);
    }

    /**
     * Notify listeners after a deliberate external mutation of an entry.
     * Prefer `update()`: it keeps the mutable field list explicit.
     */
    notify() {
        this.#ledger.emit();
    }
}

module.exports = { EditLedgerStore };
