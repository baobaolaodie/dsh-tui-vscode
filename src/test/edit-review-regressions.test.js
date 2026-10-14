'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EditLedger } = require('../edit-review-core');
const precise = require('../precise-review-core');
const callbacks = {}, commands = new Map();
let provider;
class EventEmitter {
    constructor() { this.event = () => ({ dispose() { } }); }
    fire() { }
    dispose() { }
}
class Uri {
    constructor(fsPath) { this.scheme = 'file'; this.fsPath = fsPath; }
    static file(p) { return new Uri(p); }
}
class Range {
    constructor(...args) { this.args = args; }
}
const disposable = { dispose() { } };
const mock = {
    Uri, Range, EventEmitter,
    CodeLens: class {
        constructor(range, command) { Object.assign(this, { range, command }); }
    },
    ThemeColor: class {
        constructor(id) { this.id = id; }
    },
    StatusBarAlignment: { Right: 1 }, OverviewRulerLane: { Left: 1 },
    MarkdownString: class {
        constructor() { this.value = ''; }
        appendMarkdown(s) { this.value += s; return this; }
        appendText(s) { this.value += s; return this; }
    },
    workspace: { textDocuments: [], workspaceFolders: [], getWorkspaceFolder: () => ({}), getConfiguration: () => ({ get: (_, fallback) => fallback }), registerTextDocumentContentProvider: () => disposable, createFileSystemWatcher: () => ({ onDidCreate() { }, onDidChange() { }, onDidDelete() { }, dispose() { } }),
        onDidOpenTextDocument: () => disposable, onDidSaveTextDocument: fn => (callbacks.save = fn, disposable), onDidChangeTextDocument: fn => (callbacks.change = fn, disposable), onDidChangeConfiguration: () => disposable },
    window: { terminals: [{ name: 'DeepSeek' }], visibleTextEditors: [], createStatusBarItem: () => ({ show() { }, hide() { }, dispose() { } }), onDidCloseTerminal: () => disposable, createTextEditorDecorationType: () => ({ dispose() { } }), registerTreeDataProvider: () => disposable, onDidChangeActiveTextEditor: () => disposable, onDidChangeVisibleTextEditors: () => disposable, showWarningMessage: async () => { }, setStatusBarMessage() { } },
    languages: { registerCodeLensProvider: (_, p) => (provider = p, disposable) },
    commands: { registerCommand: (id, fn) => (commands.set(id, fn), disposable), executeCommand: async () => { } }, l10n: { t: s => s },
};
const load = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? mock : load.call(this, name, ...args); };
const { EditReview } = require('../edit-review');
Module._load = load;
const owner = () => Object.assign(Object.create(EditReview.prototype), { disposed: false, ledger: new EditLedger(), settled: new Map(), directoryInventory: new Map(), selfMarks: new Map(), saveMarks: new Map(), fileQueues: new Map(), writingPaths: new Set(), cursor: new Map(), enabled: () => true, excluded: () => false, sessionActive: () => true, showDiff: async () => { }, schedulePersist() { }, refreshAll() { } });
const document = (file, text, dirty = false) => ({ uri: Uri.file(file), isClosed: false, isDirty: dirty, getText: () => text, lineCount: text.split('\n').length });
async function fixture(fn) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-regression-')); try {
    await fn(path.join(root, 'f.txt'));
}
finally {
    mock.workspace.textDocuments = [];
    await fs.rm(root, { recursive: true, force: true });
} }
test('an open DeepSeek terminal does not attribute an unrelated external write to AI', () => fixture(async (file) => {
    await fs.writeFile(file, 'ordinary script\n');
    const o = owner();
    o.settled.set(file, 'original\n');
    await o.processFsEvent(Uri.file(file), 'change');
    assert.equal(o.ledger.size, 0);
    assert.equal(o.settled.get(file), 'ordinary script\n');
}));
test('all deleted-text attachment paths use VS Code renderOptions.before', () => {
    for (const [before, after] of [['one\ntwo\nthree\n', 'one\nthree\n'], ['old word\nextra\n', 'new word\n'], ['abc def\n', 'abc xyz\n'], ['delete\n', '']]) {
        const o = owner();
        o.ledger.record('f', 'modify', before, false, after);
        o.decor = { added: 'a', insSpan: 'i', ghost: 'g', removed: 'r' };
        const batches = new Map();
        o.decorateEditor({ document: document('f', after), setDecorations: (type, opts) => batches.set(type, opts) });
        assert.ok(batches.get('g').length > 0);
        for (const decoration of batches.get('g')) {
            assert.equal(Object.hasOwn(decoration, 'before'), false);
            assert.equal(typeof decoration.renderOptions?.before?.contentText, 'string');
        }
    }
});
test('no-change save and empty document event do not invalidate the actual generated Keep button', () => fixture(async (file) => {
    const o = new EditReview({ subscriptions: [], extensionPath: '.' }, {});
    await o.ready;
    try {
        await fs.writeFile(file, 'AI\n');
        const doc = document(file, 'AI\n');
        mock.workspace.textDocuments = [doc];
        o.ledger.record(file, 'modify', 'before\n', false, 'AI\n');
        const lens = provider.provideCodeLenses(doc).find(l => l.command.command === 'dsh-tui-vscode.editKeep' && !l.command.arguments[1]?.file);
        assert.ok(lens);
        callbacks.save(doc);
        callbacks.change({ document: { ...doc, isDirty: true }, contentChanges: [] });
        assert.notEqual(o.ledger.get(file).userTouched, true);
        o.assertSafePath = async () => { };
        await commands.get(lens.command.command)(...lens.command.arguments);
        assert.equal(o.ledger.get(file), null);
        assert.equal(await fs.readFile(file, 'utf8'), 'AI\n');
    }
    finally {
        o.dispose();
        await o.shutdown();
    }
}));
test('a fresh button is never rendered against a different live document than its after hash', async () => {
    const o = new EditReview({ subscriptions: [], extensionPath: '.' }, {});
    await o.ready;
    try {
        o.ledger.record('f', 'modify', 'before\n', false, 'AI\n');
        const result = provider.provideCodeLenses(document('f', 'later\n'));
        assert.equal(result.some(l => ['dsh-tui-vscode.editKeep', 'dsh-tui-vscode.editUndo'].includes(l.command?.command)), false);
    }
    finally {
        o.dispose();
        await o.shutdown();
    }
});
test('non-overlapping user text is rebased into both snapshots, never attributed to AI', () => {
    const result = precise.rebaseUserEdit('old\nseparator\nuser before\n', 'AI\nseparator\nuser before\n', 'AI\nseparator\nuser after\n');
    assert.equal(result.conflict, false);
    assert.equal(result.before, 'old\nseparator\nuser after\n');
    assert.equal(result.after, 'AI\nseparator\nuser after\n');
    assert.equal(precise.reviewDiff(result.before, result.after).hunks.length, 1);
});
test('overlapping user change and deleted-line insertion ambiguity retain original and report conflict', () => {
    for (const [before, after, current] of [['old\n', 'AI\n', 'user\n'], ['a\ndeleted\nb\n', 'a\nb\n', 'a\nuser\nb\n']]) {
        const result = precise.rebaseUserEdit(before, after, current);
        assert.equal(result.conflict, true);
        assert.equal(result.before, before);
        assert.equal(result.after, after);
    }
});
