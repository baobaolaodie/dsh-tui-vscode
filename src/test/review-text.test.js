'use strict';
/**
 * Unit tests for the review text contract (data layer, no vscode needed).
 * Run: node --test out/test/review-text.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_FILE_BYTES, decodeReviewText, isReviewableText } = require('../review-text');

test('reviewable text is a bounded string without NUL bytes', () => {
    assert.equal(isReviewableText(''), true);
    assert.equal(isReviewableText('plain text\nwith lines'), true);
    assert.equal(isReviewableText('a\u0000b'), false);
    assert.equal(isReviewableText(42), false);
    assert.equal(isReviewableText(null), false);
    assert.equal(isReviewableText('a'.repeat(MAX_FILE_BYTES)), true);
    assert.equal(isReviewableText('a'.repeat(MAX_FILE_BYTES + 1)), false);
});

test('decodeReviewText decodes strict UTF-8 and keeps an encoding BOM', () => {
    assert.equal(decodeReviewText(Buffer.from('hello\n', 'utf8')), 'hello\n');
    // A BOM stays in the text on purpose: a BOM file must be recognizable so
    // Undo is refused instead of silently dropping the preamble.
    assert.equal(decodeReviewText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')])), '\uFEFFhi');
});

test('decodeReviewText rejects invalid UTF-8, NUL bytes and oversized buffers', () => {
    assert.equal(decodeReviewText(Buffer.from([0xff, 0xfe])), null);
    assert.equal(decodeReviewText(Buffer.from('a\u0000b', 'utf8')), null);
    assert.equal(decodeReviewText(Buffer.alloc(MAX_FILE_BYTES + 1, 0x61)), null);
    assert.equal(decodeReviewText('not bytes'), null);
});

test('lone surrogates are not reviewable text', () => {
    assert.equal(isReviewableText('a\uD800b'), false);
    assert.equal(isReviewableText('a\uDC00b'), false);
    assert.equal(decodeReviewText(Buffer.from('ok', 'utf8')), 'ok');
});
