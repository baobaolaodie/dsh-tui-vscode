'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const original = Module._load;
let handler;
const disposable = { dispose() {} };
const mock = {
    chat: { createChatParticipant: (_, callback) => { handler = callback; return { ...disposable }; } },
    ThemeIcon: class {},
    StatusBarAlignment: { Right: 1 },
    Uri: { file: fsPath => ({ fsPath }) },
    workspace: { openTextDocument: async uri => ({ uri, isDirty: false, getText: () => 'resolved' }) },
    window: { showWarningMessage: async () => undefined, showInformationMessage: async () => {}, createOutputChannel: () => ({ appendLine() {}, show() {}, ...disposable }), createStatusBarItem: () => ({ show() {}, hide() {}, ...disposable }) },
    commands: { registerCommand: () => disposable },
};
Module._load = function(name, ...args) { return name === 'vscode' ? mock : original.call(this, name, ...args); };
const { NativeReview } = require('../native-review');
Module._load = original;
test('participant receives response as third argument (stable VS Code signature)', async () => {
    const owner = new NativeReview({ subscriptions: [] }, {});
    let message;
    const response = { externalEdit() {}, markdown(text) { message = text; } };
    await handler({ prompt: 'help' }, { history: [] }, response, {});
    assert.equal(owner.lastEvidence.externalEditAvailable, true);
    assert.match(message, /Start native file review/);
    owner.dispose();
});
test('return to ordinary tracking requires explicit confirmation', async () => {
    const legacy = { settled: new Map(), refreshAll() {} };
    const owner = new NativeReview({ subscriptions: [] }, legacy);
    owner.session.owned.add('a');
    await owner.releaseResolved();
    assert.equal(owner.owns('a'), true);
    assert.equal(legacy.settled.size, 0);
    owner.dispose();
});
test('saved resolved files become the new ordinary baseline only after confirmation', async () => {
    const legacy = { settled: new Map(), refreshAll() {} };
    const owner = new NativeReview({ subscriptions: [] }, legacy);
    owner.session.owned.add('a');
    const previous = mock.window.showWarningMessage;
    mock.window.showWarningMessage = async () => 'All native changes resolved';
    try {
        await owner.releaseResolved();
        assert.equal(owner.owns('a'), false);
        assert.equal(legacy.settled.get('a'), 'resolved');
    } finally { mock.window.showWarningMessage = previous; owner.dispose(); }
});
test('dirty files retain native ownership even after confirmation', async () => {
    const legacy = { settled: new Map(), refreshAll() {} };
    const owner = new NativeReview({ subscriptions: [] }, legacy);
    owner.session.owned.add('a');
    const previousWarning = mock.window.showWarningMessage;
    const previousOpen = mock.workspace.openTextDocument;
    mock.window.showWarningMessage = async () => 'All native changes resolved';
    mock.workspace.openTextDocument = async uri => ({ uri, isDirty: true, getText: () => 'unsaved' });
    try {
        await owner.releaseResolved();
        assert.equal(owner.owns('a'), true);
        assert.equal(legacy.settled.size, 0);
    } finally { mock.window.showWarningMessage = previousWarning; mock.workspace.openTextDocument = previousOpen; owner.dispose(); }
});
test('current-file shortcut forwards only the selected real file', async () => {
    const owner = new NativeReview({ subscriptions: [] }, {});
    const uri = { scheme: 'file', fsPath: 'a' };
    let selected;
    owner.start = async resources => { selected = resources; };
    await owner.startCurrent(uri);
    assert.deepEqual(selected, [uri]);
    owner.dispose();
});
test('current-file shortcut rejects virtual or missing active documents', async () => {
    const owner = new NativeReview({ subscriptions: [] }, {});
    let started = false;
    owner.start = async () => { started = true; };
    await owner.startCurrent({ scheme: 'untitled', fsPath: '' });
    await owner.startCurrent();
    assert.equal(started, false);
    owner.dispose();
});
test('validation rejects unsaved files before native tracking starts', async () => {
    const owner = new NativeReview({ subscriptions: [] }, { excluded: () => false, ledger: { get: () => null } });
    const open = mock.workspace.openTextDocument;
    mock.workspace.getWorkspaceFolder = () => ({});
    mock.FileType = { File: 1 };
    mock.workspace.fs = { stat: async () => ({ type: 1, size: 10 }) };
    mock.workspace.openTextDocument = async uri => ({ uri, isDirty: true, getText: () => 'unsaved' });
    try { await assert.rejects(owner.validateResources([{ scheme: 'file', fsPath: 'a' }]), /Save your own/); }
    finally { mock.workspace.openTextDocument = open; owner.dispose(); }
});
test('launch gate covers asynchronous selection and always releases after failure', async () => {
    const owner = new NativeReview({ subscriptions: [] }, {});
    let release;
    let calls = 0;
    owner.startOnce = async () => { calls++; await new Promise(resolve => { release = resolve; }); };
    const first = owner.start();
    await owner.start();
    assert.equal(calls, 1);
    release(); await first;
    assert.equal(owner.launching, false);
    owner.startOnce = async () => { throw Error('selection error'); };
    await assert.rejects(owner.start(), /selection error/);
    assert.equal(owner.launching, false);
    owner.dispose();
});
test('open-files shortcut includes text tabs only and deduplicates file paths', async () => {
    const owner = new NativeReview({ subscriptions: [] }, { excluded: path => path === 'excluded' });
    mock.TabInputText = class { constructor(uri) { this.uri = uri; } };
    const uri = path => ({ scheme: 'file', fsPath: path });
    const previousGroups = mock.window.tabGroups;
    const previousFolder = mock.workspace.getWorkspaceFolder;
    mock.workspace.getWorkspaceFolder = resource => resource.fsPath !== 'outside' ? {} : undefined;
    mock.window.tabGroups = { all: [{ tabs: [
        { input: new mock.TabInputText(uri('a')) }, { input: new mock.TabInputText(uri('a')) },
        { input: new mock.TabInputText(uri('excluded')) }, { input: new mock.TabInputText(uri('outside')) },
        { input: { uri: uri('diff-input') } }, { input: new mock.TabInputText({ scheme: 'untitled', fsPath: 'virtual' }) },
    ] }] };
    let selected;
    owner.start = async resources => { selected = resources; };
    try { await owner.startOpen(); assert.deepEqual(selected.map(resource => resource.fsPath), ['a']); }
    finally { mock.window.tabGroups = previousGroups; mock.workspace.getWorkspaceFolder = previousFolder; owner.dispose(); }
});
test('finish during async validation prevents starting native chat tracking', async () => {
    const owner = new NativeReview({ subscriptions: [] }, {});
    let release;
    let launched = false;
    const execute = mock.commands.executeCommand;
    const warning = mock.window.showWarningMessage;
    mock.window.showWarningMessage = async () => 'Start native tracking';
    mock.commands.executeCommand = async () => { launched = true; };
    owner.validateResources = async () => new Promise(resolve => { release = resolve; });
    try {
        const starting = owner.start([{ scheme: 'file', fsPath: 'a' }]);
        await new Promise(resolve => setImmediate(resolve));
        owner.finish(); release(); await starting;
        assert.equal(launched, false);
        assert.equal(owner.pending, null);
        assert.equal(owner.session.active, false);
    } finally { mock.commands.executeCommand = execute; mock.window.showWarningMessage = warning; owner.dispose(); }
});
test('finish after request entered validation also prevents snapshot acquisition', async () => {
    const owner = new NativeReview({ subscriptions: [] }, { refreshAll() {} });
    owner.pending = { resources: [{ fsPath: 'a' }], nonce: 'request', epoch: owner.epoch };
    let release;
    let acquired = false;
    owner.validateResources = async () => new Promise(resolve => { release = resolve; });
    const token = { isCancellationRequested: false, onCancellationRequested: () => disposable };
    const response = { markdown() {}, externalEdit: async () => { acquired = true; } };
    const handling = owner.handle({ command: 'track', prompt: 'request' }, response, token);
    owner.finish(); release(); await handling;
    assert.equal(acquired, false);
    assert.equal(owner.lastEvidence.snapshotReady, false);
    owner.dispose();
});
test('ownership survives a fresh extension instance but active tracking never resumes', async () => {
    const stored = new Map();
    const state = { get: (key, fallback) => stored.get(key) ?? fallback, update: async (key, value) => stored.set(key, value) };
    const folder = mock.workspace.getWorkspaceFolder;
    mock.workspace.getWorkspaceFolder = uri => uri.fsPath !== 'C:\\outside.txt' ? {} : undefined;
    const first = new NativeReview({ subscriptions: [], workspaceState: state }, {});
    try {
        first.session.owned.add('C:\\fixture.txt');
        first.session.owned.add('relative-invalid');
        first.session.owned.add('C:\\outside.txt');
        await first.persistOwnership();
        first.dispose();
        const restored = new NativeReview({ subscriptions: [], workspaceState: state }, {});
        assert.equal(restored.owns('C:\\fixture.txt'), true);
        assert.equal(restored.owns('relative-invalid'), false);
        assert.equal(restored.owns('C:\\outside.txt'), false);
        assert.equal(restored.session.active, false);
        assert.equal(restored.pending, null);
        restored.dispose();
    } finally { mock.workspace.getWorkspaceFolder = folder; first.dispose(); }
});
test('ownership writes stay ordered and a failure does not poison later writes', async () => {
    const writes = [];
    let fail = true;
    const state = { get: (_, fallback) => fallback, update: async (_, value) => { if (fail) { fail = false; throw Error('disk error'); } writes.push(value); } };
    const owner = new NativeReview({ subscriptions: [], workspaceState: state }, {});
    owner.session.owned.add('a');
    await assert.rejects(owner.persistOwnership(), /disk error/);
    owner.session.owned.add('b');
    await owner.persistOwnership();
    assert.deepEqual(writes, [['a', 'b']]);
    owner.dispose();
});
test('failed ownership save keeps native protection and never resets ordinary baseline', async () => {
    const legacy = { settled: new Map(), refreshAll() {} };
    const state = { get: (_, fallback) => fallback, update: async () => { throw Error('cannot save'); } };
    const owner = new NativeReview({ subscriptions: [], workspaceState: state }, legacy);
    owner.session.owned.add('a');
    const warn = mock.window.showWarningMessage;
    mock.window.showWarningMessage = async () => 'All native changes resolved';
    try {
        await owner.releaseResolved();
        assert.equal(owner.owns('a'), true);
        assert.equal(legacy.settled.size, 0);
    } finally { mock.window.showWarningMessage = warn; owner.dispose(); }
});
test('review continuation opens only a native-owned file and delegates to native controls', async () => {
    const owner = new NativeReview({ subscriptions: [] }, {});
    owner.session.owned.add('a');
    const execute = mock.commands.executeCommand;
    const show = mock.window.showTextDocument;
    const editor = mock.window.activeTextEditor;
    const calls = [];
    mock.window.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: 'a' } } };
    mock.window.showTextDocument = async uri => { calls.push(['open', uri.fsPath]); };
    mock.commands.executeCommand = async command => { calls.push(['command', command]); };
    try {
        await owner.showReview();
        assert.deepEqual(calls, [['open', 'a'], ['command', 'chatEditor.action.reviewChanges']]);
        calls.length = 0;
        await owner.showReview({ scheme: 'file', fsPath: 'outside' });
        assert.equal(calls.length, 0);
    } finally { mock.commands.executeCommand = execute; mock.window.showTextDocument = show; mock.window.activeTextEditor = editor; owner.dispose(); }
});
test('native status remains reachable after tracking stops without claiming pending changes', () => {
    const owner = new NativeReview({ subscriptions: [] }, {});
    owner.session.owned.add('a');
    owner.refreshStatus();
    assert.equal(owner.status.command, 'dsh-tui-vscode.nativeReviewShow');
    assert.match(owner.status.text, /Review tracked files/);
    assert.doesNotMatch(owner.status.text, /pending/i);
    owner.pending = { resources: [], nonce: 'wait' };
    owner.refreshStatus();
    assert.equal(owner.status.command, 'dsh-tui-vscode.nativeReviewFinish');
    owner.dispose();
});
test('release gate covers confirmation so a new tracking request cannot race ownership return', async () => {
    const legacy = { settled: new Map(), refreshAll() {} };
    const owner = new NativeReview({ subscriptions: [] }, legacy);
    owner.session.owned.add('a');
    const warn = mock.window.showWarningMessage;
    let confirm;
    mock.window.showWarningMessage = () => new Promise(resolve => { confirm = resolve; });
    let started = false;
    owner.startOnce = async () => { started = true; };
    try {
        const returning = owner.releaseResolved();
        await owner.start([]);
        assert.equal(started, false);
        confirm(undefined); await returning;
        assert.equal(owner.releasing, false);
        assert.equal(owner.owns('a'), true);
    } finally { mock.window.showWarningMessage = warn; owner.dispose(); }
});

test('validation permits subsequent native tracking of a saved native-owned file', async () => {
    const owner = new NativeReview({ subscriptions: [] }, { excluded: () => false, ledger: { get: () => null } });
    owner.session.owned.add('a');
    const previousFolder = mock.workspace.getWorkspaceFolder;
    const previousOpen = mock.workspace.openTextDocument;
    const previousStat = mock.workspace.fs;
    mock.workspace.getWorkspaceFolder = () => ({});
    mock.FileType = { File: 1 };
    mock.workspace.fs = { stat: async () => ({ type: 1, size: 10 }) };
    mock.workspace.openTextDocument = async uri => ({ uri, isDirty: false, getText: () => 'text' });
    try { await owner.validateResources([{ scheme: 'file', fsPath: 'a' }]); }
    finally { mock.workspace.getWorkspaceFolder = previousFolder; mock.workspace.openTextDocument = previousOpen; mock.workspace.fs = previousStat; owner.dispose(); }
});

test('registration failure does not crash extension activation', () => {
    const create = mock.chat.createChatParticipant;
    mock.chat.createChatParticipant = () => { throw Error('not available'); };
    const owner = new NativeReview({ subscriptions: [] }, {});
    assert.equal(owner.lastEvidence.participantRegistered, false);
    owner.dispose();
    mock.chat.createChatParticipant = create;
});
test('missing native file can be explicitly released without releasing other tracked files', async () => {
    const legacy = { settled: new Map([['missing', 'old']]), refreshAll() {} };
    const owner = new NativeReview({ subscriptions: [] }, legacy);
    owner.session.owned.add('missing'); owner.session.owned.add('other');
    const warning = mock.window.showWarningMessage, open = mock.workspace.openTextDocument, stat = mock.workspace.fs;
    mock.workspace.openTextDocument = async () => { throw Object.assign(Error('missing'), { code: 'FileNotFound' }); };
    mock.workspace.fs = { stat: async () => { throw Object.assign(Error('missing'), { code: 'FileNotFound' }); } };
    mock.window.showWarningMessage = async (_, options, label) => label;
    try {
        await owner.releaseResolved({ scheme: 'file', fsPath: 'missing' });
        assert.equal(owner.owns('missing'), false);
        assert.equal(owner.owns('other'), true);
        assert.equal(legacy.settled.has('missing'), false);
    } finally { mock.window.showWarningMessage = warning; mock.workspace.openTextDocument = open; mock.workspace.fs = stat; owner.dispose(); }
});
test('missing native file retains ownership when extra abandonment confirmation is declined', async () => {
    const legacy = { settled: new Map(), refreshAll() {} };
    const owner = new NativeReview({ subscriptions: [] }, legacy);
    owner.session.owned.add('missing');
    const warning = mock.window.showWarningMessage, open = mock.workspace.openTextDocument, stat = mock.workspace.fs;
    mock.workspace.openTextDocument = async () => { throw Object.assign(Error('missing'), { code: 'FileNotFound' }); };
    mock.workspace.fs = { stat: async () => { throw Object.assign(Error('missing'), { code: 'FileNotFound' }); } };
    let warnings = 0;
    mock.window.showWarningMessage = async (_, options, label) => ++warnings === 1 ? label : undefined;
    try {
        await owner.releaseResolved();
        assert.equal(owner.owns('missing'), true);
        assert.equal(warnings, 2);
    } finally { mock.window.showWarningMessage = warning; mock.workspace.openTextDocument = open; mock.workspace.fs = stat; owner.dispose(); }
});
test('awaited native shutdown waits for ownership persistence and reports failure', async () => {
    let finish;
    const state = { get: (_, fallback) => fallback, update: () => new Promise((_, reject) => { finish = reject; }) };
    const owner = new NativeReview({ subscriptions: [], workspaceState: state }, {});
    owner.session.owned.add('a');
    const writing = owner.persistOwnership(); writing.catch(() => {});
    const closing = owner.shutdown();
    await new Promise(resolve => setImmediate(resolve));
    finish(Error('shutdown storage failed'));
    await assert.rejects(closing, /shutdown storage failed/);
});
