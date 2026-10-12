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
test('unscanned existing change is never treated as new file deletion', async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-review-test-'));
    try {
        const file=path.join(root,'existing.txt');await fs.writeFile(file,'valuable\n');
        const o=owner(); await o.processFsEvent(mock.Uri.file(file),'change');
        const entry=o.ledger.get(file);assert.equal(entry.kind,'modify');assert.equal(entry.beforeMissing,true);assert.equal(planUndo(entry,true,entry.after).action,'blocked');
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
test('strict UTF-8 observation preserves BOM',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-review-test-'));
    try { const file=path.join(root,'bom.txt');await fs.writeFile(file,'\uFEFFnew\r\n');const o=owner();o.settled.set(file,'\uFEFFold\r\n');await o.processFsEvent(mock.Uri.file(file),'change');assert.equal(o.ledger.get(file).after,'\uFEFFnew\r\n'); }
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
