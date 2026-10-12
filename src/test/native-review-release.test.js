'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeReviewSession } = require('../native-review-core');
test('release is blocked while native writes are being tracked', async () => {
    const session = new NativeReviewSession();
    const done = session.run({ externalEdit: async (_, callback) => callback() }, [{ fsPath: 'a' }]);
    assert.throws(() => session.release(['a']), /Finish/);
    session.finish(); await done;
    session.release(['a']);
    assert.equal(session.owns('a'), false);
});
test('releasing a settled file never releases other pending files', async () => {
    const session = new NativeReviewSession();
    await session.run({ externalEdit: async (_, callback) => callback() }, [{ fsPath: 'a' }, { fsPath: 'b' }], () => session.finish());
    session.release(['a']);
    assert.equal(session.owns('a'), false);
    assert.equal(session.owns('b'), true);
});
