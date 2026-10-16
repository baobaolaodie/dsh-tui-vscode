'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const load = Module._load;
const { EditLedger, planUndo } = require('../edit-review-core');
const mock = {
    Uri: { file: fsPath => ({ scheme:'file', fsPath }) },
    workspace: { textDocuments:[], getWorkspaceFolder:()=>({}), getConfiguration:()=>({get:()=>false}) },
    window: { showWarningMessage:async()=>{}, setStatusBarMessage:()=>{} },
    MarkdownString: class { constructor(){this.value='';} appendMarkdown(s){this.value+=s;return this;} appendText(s){this.value+=s.replace(/[\[\]()~`]/g,'\\$&');return this;} },
    l10n: {t:s=>s},
};
Module._load = function(name,...args){ return name==='vscode'?mock:load.call(this,name,...args); };
const {EditReview}=require('../edit-review');
Module._load=load;
function owner() {
    const o = Object.create(EditReview.prototype);
    Object.assign(o,{ disposed:false, ledger:new EditLedger(),settled:new Map(),directoryInventory:new Map(),selfMarks:new Map(),saveMarks:new Map(),fileQueues:new Map(),writingPaths:new Set(),enabled:()=>true,excluded:()=>false,sessionActive:()=>true });
    return o;
}
async function assertCompletes(operation, message) {
    let timer;
    try {
        await Promise.race([
            operation,
            new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), 250); }),
        ]);
    } finally { clearTimeout(timer); }
}
test('stale decision completes and releases its path queue without dismissing a notification', async () => {
    const previous = mock.window.showWarningMessage;
    const o = owner();
    let warnings = 0;
    mock.window.showWarningMessage = () => { warnings++; return new Promise(() => {}); };
    try {
        await assertCompletes(o.withPath('missing', () => o.undoHunk('missing', {})), 'stale Undo awaited notification dismissal');
        await o.withPath('missing', async () => {});
        assert.equal(warnings, 1);
        assert.equal(o.fileQueues.size, 0);
    } finally { mock.window.showWarningMessage = previous; }
});
test('unscanned ordinary external change updates the settled baseline but is never treated as AI', async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-review-test-'));
    try {
        const file=path.join(root,'existing.txt');await fs.writeFile(file,'valuable\n');
        const o=owner(); await o.processFsEvent(mock.Uri.file(file),'change');
        assert.equal(o.ledger.get(file),null); assert.equal(o.settled.get(file),'valuable\n');
    } finally { await fs.rm(root,{recursive:true,force:true}); }
});
test('partial keep of created file accepts its existence, whole undo restores kept content',()=>{
    const led=new EditLedger();led.record('new','create',null,false,'accepted\nother\n');
    led.rebaseBefore('new','accepted\n');
    assert.equal(led.get('new').kind,'modify');
    assert.equal(planUndo(led.get('new'),true,'accepted\nother\n').action,'restore-content');
    led.record('new','delete','ignored',false,null);
    assert.equal(led.get('new').before,'accepted\n');
});
test('mixed user/AI pending changes require confirmation even after external rewrite',()=>{
    const led=new EditLedger();led.record('f','modify','original\n',false,'AI\n');
    led.get('f').userTouched=true;
    led.record('f','modify','ignored',false,'AI2\nUSER SAVED\n');
    assert.equal(planUndo(led.get('f'),true,led.get('f').after).action,'confirm');
    const restored=new EditLedger();restored.load(led.toJSON());assert.equal(restored.get('f').userTouched,true);
});
test('persisted missing baseline is blocked rather than restored to empty',()=>{
    const led=new EditLedger();led.load({version:1,entries:[{path:'f',kind:'modify',after:'valuable',beforeMissing:false}]});
    assert.equal(planUndo(led.get('f'),true,'valuable').action,'blocked');
});
test('strict UTF-8 observation keeps BOM changes outside the AI ledger',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-review-test-'));
    try { const file=path.join(root,'bom.txt');await fs.writeFile(file,'\uFEFFnew\r\n');const o=owner();o.settled.set(file,'\uFEFFold\r\n');await o.processFsEvent(mock.Uri.file(file),'change');assert.equal(o.ledger.get(file),null);assert.equal(o.settled.get(file),'\uFEFFnew\r\n'); }
    finally { await fs.rm(root,{recursive:true,force:true}); }
});
test('file text cannot inject trusted hover command links',()=>{
    const o=owner();const entry={id:'e',path:'f',before:'[Click](command:dsh-tui-vscode.editKeep)',after:'new'};
    const h=require('../precise-review-core').reviewDiff(entry.before,entry.after).hunks[0];
    const value=o.hunkHover(entry,h).value;
    assert.ok(value.includes('\\[Click\\]\\(command:'));
});
test('same-path decisions and filesystem events share ordering',async()=>{
    const o=owner();const calls=[];let release;
    const a=o.withPath('f',async()=>{calls.push('a');await new Promise(r=>release=r);calls.push('b');});
    const b=o.withPath('f',async()=>calls.push('c'));
    await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['a']);release();await Promise.all([a,b]);assert.deepEqual(calls,['a','b','c']);
});
test('old file Keep cannot accept a disk rewrite before the watcher updates ledger', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-test-'));
    try {
        const file = path.join(root, 'existing.txt');
        await fs.writeFile(file, 'newer unseen\n');
        const o = owner(); o.resolvePath = value => value;
        o.ledger.record(file, 'modify', 'original\n', false, 'reviewed\n');
        await o.keep(file, o.fileHint(o.ledger.get(file)));
        assert.ok(o.ledger.get(file), 'unseen version must remain pending');
        assert.equal(await fs.readFile(file, 'utf8'), 'newer unseen\n');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('BOM baseline is never passed through WorkspaceEdit or missing-file restoration', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-test-'));
    try {
        const file = path.join(root, 'bom.txt');
        const o = owner(); o.resolvePath = value => value;
        o.ledger.record(file, 'delete', '\uFEFForiginal\r\n', false, null);
        let writes = 0; o.applyPlan = async () => { writes++; };
        await o.undo(file);
        assert.equal(writes, 0);
        assert.ok(o.ledger.get(file));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('shutdown waits for initialized state and in-flight decisions before final flush', async () => {
    const o = owner();
    let initialized, decision;
    o.ready = new Promise(resolve => { initialized = resolve; });
    o.docTimers = new Map();
    const final = o.withPath('f', async () => { await new Promise(resolve => { decision = resolve; }); o.ledger.record('f', 'modify', 'before', false, 'after'); });
    let persisted;
    o.flushState = async () => { persisted = o.ledger.toJSON(); };
    const closing = o.shutdown();
    initialized(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(persisted, undefined);
    await o.withPath('g', () => { throw Error('new work must not start during shutdown'); });
    decision(); await final; await closing;
    assert.equal(persisted.entries[0].after, 'after');
});
test('storage failure propagates to awaited flush and later retries still work', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-store-'));
    try {
        const blocker = path.join(root, 'not-a-directory'); await fs.writeFile(blocker, 'x');
        const o = owner(); o.persistence = Promise.resolve();
        let target = path.join(blocker, 'pending.json'); o.storeFile = () => target;
        await assert.rejects(o.flushState());
        target = path.join(root, 'pending.json');
        o.ledger.record('f', 'modify', 'before', false, 'after');
        await o.flushState();
        assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).entries[0].after, 'after');
        assert.deepEqual((await fs.readdir(root)).sort(), ['not-a-directory', 'pending.json']);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('old file Keep detects editor/disk mismatch and deleted-file recreation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-test-'));
    const previous = mock.workspace.textDocuments;
    try {
        const file = path.join(root, 'existing.txt'); await fs.writeFile(file, 'after');
        const o = owner(); o.resolvePath = value => value;
        o.ledger.record(file, 'modify', 'before', false, 'after');
        mock.workspace.textDocuments = [{ uri: mock.Uri.file(file), isClosed: false, isDirty: false, getText: () => 'old editor' }];
        await o.keep(file, o.fileHint(o.ledger.get(file))); assert.ok(o.ledger.get(file));
        mock.workspace.textDocuments = [];
        o.ledger.clear(); o.ledger.record(file, 'delete', 'before', false, null);
        await o.keep(file, o.fileHint(o.ledger.get(file))); assert.ok(o.ledger.get(file));
    } finally { mock.workspace.textDocuments = previous; await fs.rm(root, { recursive: true, force: true }); }
});
test('explicit current whole-file Keep can accept a saved mixed version without writing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-test-'));
    try {
        const file = path.join(root, 'mixed.txt'); await fs.writeFile(file, 'AI and user saved');
        const o = owner(); o.resolvePath = value => value;
        o.ledger.record(file, 'modify', 'before', false, 'AI'); o.ledger.get(file).userTouched = true;
        await o.keep(file);
        assert.equal(o.ledger.get(file), null);
        assert.equal(o.settled.get(file), 'AI and user saved');
        assert.equal(await fs.readFile(file, 'utf8'), 'AI and user saved');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
