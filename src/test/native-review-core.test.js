'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeReviewSession } = require('../native-review-core');
const uri = name => ({ fsPath: name });

test('unsupported capability never acquires ownership', async () => {
    const session = new NativeReviewSession();
    await assert.rejects(session.run({}, [uri('a')]), /externalEdit/);
    assert.equal(session.active, false);
    assert.equal(session.owns('a'), false);
});
test('native ownership and ready begin only after native snapshot callback', async () => {
    const session = new NativeReviewSession();
    const sequence = [];
    const response = { externalEdit: async (uris, callback) => {
        sequence.push('snapshot');
        assert.equal(session.owns('a'), false);
        await callback();
        sequence.push('finish');
    }};
    const done = session.run(response, [uri('a')], () => {
        sequence.push('ready');
        assert.equal(session.owns('a'), true);
        session.finish();
    });
    await done;
    assert.deepEqual(sequence, ['snapshot', 'ready', 'finish']);
    assert.equal(session.active, false);
    assert.equal(session.owns('a'), true); // pending native review must not get legacy UI
});
test('concurrent session is refused and finish is idempotent', async () => {
    const session = new NativeReviewSession();
    const response = { externalEdit: async (_, callback) => callback() };
    const done = session.run(response, [uri('a')]);
    await assert.rejects(session.run(response, [uri('b')]), /already/);
    assert.equal(session.finish(), true);
    assert.equal(session.finish(), false);
    await done;
});
test('resource cap and invalid file paths are rejected before native calls', async () => {
    const session = new NativeReviewSession();
    const response = { externalEdit: () => { throw Error('must not be called'); } };
    await assert.rejects(session.run(response, []), /1.*100/);
    await assert.rejects(session.run(response, Array(101).fill(uri('a'))), /1.*100/);
    await assert.rejects(session.run(response, [{}]), /path/);
});
test('native start failure leaves no acquired paths', async () => {
    const session = new NativeReviewSession();
    await assert.rejects(session.run({ externalEdit: async () => { throw Error('snapshot rejected'); } }, [uri('a')]), /snapshot rejected/);
    assert.equal(session.active, false);
    assert.equal(session.owns('a'), false);
});
test('ready failure settles callback and retains native ownership safely', async () => {
    const session = new NativeReviewSession();
    await assert.rejects(session.run({ externalEdit: async (_, callback) => callback() }, [uri('a')], () => { throw Error('ready error'); }), /ready error/);
    assert.equal(session.active, false);
    assert.equal(session.owns('a'), true);
});
test('finish while snapshot is pending causes no false ready signal', async () => {
    const session = new NativeReviewSession();
    let enter;
    let ready = false;
    const response = { externalEdit: (_, callback) => new Promise(resolve => { enter = async () => { await callback(); resolve(); }; }) };
    const done = session.run(response, [uri('a')], () => { ready = true; });
    session.finish();
    await enter();
    await done;
    assert.equal(ready, false);
    assert.equal(session.active, false);
});
test('paths are deduplicated and ownership compares case-insensitively on Windows', async () => {
    const session = new NativeReviewSession();
    let count;
    await session.run({ externalEdit: async (uris, callback) => { count = uris.length; await callback(); } }, [uri('C:\\A'), uri('C:\\A')], () => session.finish());
    assert.equal(count, 1);
    assert.equal(session.owns('c:\\a'), process.platform === 'win32');
});
