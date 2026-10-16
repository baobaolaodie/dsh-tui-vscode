'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let applyResult = true;
let saved = true;
let captured;
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const root = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'dsh-review-write-'));
const fixture = path.join(root, 'fixture.txt');
const doc = { uri: { scheme: 'file', fsPath: fixture }, getText: () => 'original', isClosed: false, lineCount: 2, lineAt: () => ({ text: 'last' }), save: async () => { if (saved) await fsp.writeFile(fixture, 'original'); return saved; } };
test.after(async () => { await fsp.rm(root, {recursive: true, force: true}); });
class Range { constructor(...args) { this.args = args; } }
class WorkspaceEdit { replace(uri, range, text) { captured = { uri, range, text }; } }
const mock = { Uri: { file: fsPath => ({ fsPath }) }, Range, WorkspaceEdit, workspace: { getWorkspaceFolder: () => ({}), textDocuments: [doc], applyEdit: async () => applyResult } };
Module._load = function(request, ...args) { return request === 'vscode' ? mock : originalLoad.call(this, request, ...args); };
const { EditReview } = require('../edit-review');
Module._load = originalLoad;
const owner = () => Object.assign(Object.create(EditReview.prototype), { selfMarks: new Map(), settled: new Map(), fileQueues: new Map(), writingPaths: new Set(), disposed: false, enabled: () => true, scheduleDocSettle: () => {}, nativeReview: { owns: () => true } });
test('undo builds a real TextEdit for an open document', async () => {
    applyResult = true; saved = true;
    const instance = owner();
    await EditReview.prototype.writeContent.call(instance, doc.uri.fsPath, 'original');
    assert.equal(captured.text, 'original');
    assert.deepEqual(captured.range.args, [0, 0, 1, 4]);
    assert.equal(instance.settled.get(doc.uri.fsPath), 'original');
});
test('failed apply must not claim restoration succeeded', async () => {
    applyResult = false; saved = true;
    const instance = owner();
    await assert.rejects(EditReview.prototype.writeContent.call(instance, doc.uri.fsPath, 'original'), /refused/);
    assert.equal(instance.settled.size, 0);
});
test('failed save must not clear pending baseline', async () => {
    applyResult = true; saved = false;
    const instance = owner();
    await assert.rejects(EditReview.prototype.writeContent.call(instance, doc.uri.fsPath, 'original'), /saved/);
    assert.equal(instance.settled.size, 0);
});
test('legacy list excludes native-owned files without discarding their stored originals', () => {
    const originalEntries = [{ path: 'native' }, { path: 'legacy' }];
    const instance = { ledger: { list: () => originalEntries }, nativeReview: { owns: path => path === 'native' } };
    assert.deepEqual(EditReview.prototype.entries.call(instance), [{ path: 'legacy' }]);
    assert.equal(originalEntries.length, 2);
});

test('legacy file decisions and comparison defer to native controls without touching stored originals', async () => {
    const calls = [];
    const instance = {
        resolvePath: value => value,
        ledger: { get: () => { throw Error('legacy baseline must not be used'); }, keep: () => { throw Error('legacy keep must not run'); } },
        nativeReview: { owns: () => true, showReview: async uri => calls.push(uri.fsPath) },
    };
    await EditReview.prototype.keep.call(instance, 'native');
    await EditReview.prototype.undo.call(instance, 'native');
    await EditReview.prototype.showDiff.call(instance, 'native');
    assert.deepEqual(calls, ['native', 'native', 'native']);
});

test('native-owned paths never enter the legacy external edit ledger', async () => {
    const instance = owner();
    instance.excluded = () => { throw Error('legacy classification must not run'); };
    let settled;
    instance.scheduleDocSettle = path => { settled = path; };
    await EditReview.prototype.onFsEvent.call(instance, doc.uri, 'change');
    assert.equal(settled, doc.uri.fsPath);
});
