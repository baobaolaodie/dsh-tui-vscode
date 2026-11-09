'use strict';
/**
 * review-text — the text contract the pending-edit ledger is allowed to carry.
 *
 * The review feature compares three texts: the pre-edit original, the AI edit
 * result, and what is on disk / in the editor right now. Those comparisons are
 * exact (`current === entry.after`), so all producers must agree on the same
 * shape first: UTF-8, decoded strictly, with an encoding BOM RETAINED (a BOM
 * file is recognizable and Undo is refused for it instead of silently dropping
 * the preamble), no NUL bytes, bounded size.
 *
 * Pure Node (no `vscode` import, no filesystem access): the host reads a file
 * with `fs.readFile` and hands the bytes to `decodeReviewText()`; the
 * attribution layer validates an incoming event the same way. One module keeps
 * the presentation and the attribution layers from each inventing their own
 * idea of "reviewable text".
 */
/** Same bound the review feature always used: one file image ≤ 256 KiB. */
const MAX_FILE_BYTES = 256 * 1024;

const NUL = '\u0000';

/** Byte length of the UTF-8 encoding of `text` (the size limit's unit). */
function textByteLength(text) {
    return Buffer.byteLength(text, 'utf8');
}

/** True when `text` contains an unpaired UTF-16 surrogate. */
function hasUnpairedSurrogate(text) {
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
            index++;
        }
        else if (code >= 0xdc00 && code <= 0xdfff) {
            return true;
        }
    }
    return false;
}

/**
 * True when `text` may live in the ledger: a string of bounded UTF-8 size
 * without NUL bytes (a NUL means binary and cannot be reviewed) and without
 * unpaired surrogates (they cannot survive the UTF-8 round trip).
 */
function isReviewableText(text) {
    if (typeof text !== 'string') return false;
    if (text.includes(NUL)) return false;
    if (textByteLength(text) > MAX_FILE_BYTES) return false;
    return !hasUnpairedSurrogate(text);
}

/**
 * Decode bytes read from disk into the ledger's text shape.
 *
 * Strict UTF-8 (invalid bytes → null), BOM retained, size checked before
 * decoding so a huge file costs nothing. Returns null when the bytes are not
 * reviewable; the caller drops the file silently.
 * @param {Uint8Array|Buffer} bytes
 * @returns {string|null}
 */
function decodeReviewText(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_FILE_BYTES) return null;
    let text;
    try {
        // ignoreBOM: keep an encoding preamble in the text — the ledger must be
        // able to tell a BOM file apart (its Undo is refused, a BOM must never
        // be silently written back or dropped).
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    catch {
        return null;
    }
    return isReviewableText(text) ? text : null;
}

module.exports = { MAX_FILE_BYTES, decodeReviewText, isReviewableText, textByteLength };
