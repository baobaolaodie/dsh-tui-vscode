'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { reviewDiff, changeHint } = require('./precise-review-core');
async function waitFor(predicate, message) {
    const start = Date.now();
    while (!await predicate()) {
        if (Date.now() - start > 10000) throw Error(`Timeout: ${message}`);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}
async function run() {
    const extension = vscode.extensions.getExtension('baobaolaodie.dsh-tui-vscode');
    assert.ok(extension);
    const api = await extension.activate();
    const review = api.getEditReviewTestBridge();
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const file = path.join(root, 'review-fixture.js');
    const uri = vscode.Uri.file(file);
    const before = 'const a = "old a";\r\nconst b = "old b";\r\n// unchanged\r\nconst c = "old c";';
    const after = before.replace('old a','new a').replace('old b','new b').replace('old c','new c');
    await review.ready;
    await review.prepareSession();
    const terminal = vscode.window.createTerminal({ name: 'DeepSeek' });
    review.trackTerminal(terminal);
    const result = { version: vscode.version, inferenceRequested: false, onlyFixtureFiles: true };
    try {
        let editor = await vscode.window.showTextDocument(uri, { preview: false });
        await fs.writeFile(file, after);
        await waitFor(() => review.ledger.get(file)?.after === after, 'filesystem watcher records change');
        result.watcherCapturedExactOriginal = review.ledger.get(file).before === before;
        assert.equal(result.watcherCapturedExactOriginal, true);
        await waitFor(() => editor.document.getText() === after, 'editor reload');
        const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri);
        assert.ok(Array.isArray(lenses) && lenses.every(lens => lens.range && lens.command));
        result.flatCodeLenses = lenses.length;
        assert.ok(lenses.filter(l => l.command.command === 'dsh-tui-vscode.editUndo' && l.command.arguments.length === 2 && !l.command.arguments[1]?.file).length === 2);
        result.eachHunkHasKeepUndo = true;
        await review.showDiff(file, true);
        const originalUri = vscode.Uri.parse(`dsh-edit-review:original?side=before&f=${encodeURIComponent(file)}`);
        const original = await vscode.workspace.openTextDocument(originalUri);
        assert.equal(original.getText(), before);
        editor = await vscode.window.showTextDocument(uri, { preview: false });
        editor.selection = new vscode.Selection(0,0,0,0);
        await vscode.commands.executeCommand('dsh-tui-vscode.editKeepLine');
        const keptOne = before.replace('old a','new a');
        assert.equal(review.ledger.get(file).before, keptOne);
        await waitFor(() => original.getText() === keptOne, 'live original side refresh');
        result.keepOneLineUpdatesDiffBaseline = true;
        editor.selection = new vscode.Selection(1,0,1,0);
        await vscode.commands.executeCommand('dsh-tui-vscode.editUndoLine');
        const fixed = after.replace('new b','old b');
        assert.equal(await fs.readFile(file,'utf8'), fixed);
        assert.equal(review.ledger.get(file).after, fixed);
        result.undoOneAdjacentLinePreservesOthers = true;
        result.exactCRLFAndNoFinalNewline = !fixed.endsWith('\n') && fixed.includes('\r\n');
        const entry = review.ledger.get(file);
        const h = reviewDiff(entry.before, entry.after).hunks.at(-1);
        await vscode.commands.executeCommand('dsh-tui-vscode.editUndo', file, changeHint(entry,h));
        assert.equal(await fs.readFile(file,'utf8'), keptOne);
        assert.equal(review.ledger.get(file), null);
        result.undoOtherHunkPreservesKeptLine = true;
        // Save then rewrite within the old 2-second suppression window.
        const trace = [];
        const oldProcess = review.processFsEvent.bind(review);
        review.processFsEvent = async (uri, kind) => {
            const initial = review.settled.get(file);
            const entryBefore = review.ledger.get(file)?.after;
            await oldProcess(uri, kind);
            if (uri.fsPath === file) trace.push({kind, initial, final: review.settled.get(file), entryBefore, entryAfter:review.ledger.get(file)?.after, session:review.sessionActive()});
        };
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri,new vscode.Position(0,0),'// user save\r\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        await editor.document.save();
        await new Promise(resolve=>setTimeout(resolve,600));
        const saved = editor.document.getText();
        const next = saved.replace('old c','updated c');
        await fs.writeFile(file,next);
        const afterEvidence = async predicate => {
            await waitFor(predicate, 'fast rewrite after user save');
        };
        try { await afterEvidence(() => review.ledger.get(file)?.after === next); }
        catch (error) {
            result.debug = { trace, entry: review.ledger.get(file), baseline: review.settled.get(file), docText: editor.document.getText(), isDirty: editor.document.isDirty, session: review.sessionActive(), self: review.selfMarks.get(file), save: review.saveMarks.get(file) };
            throw error;
        }
        result.fastRewriteNotHiddenBySaveShield = true;
        await waitFor(() => editor.document.getText() === next, 'editor reload after save');
        await vscode.commands.executeCommand('dsh-tui-vscode.editUndo', file);
        assert.equal(await fs.readFile(file,'utf8'), saved);
        result.wholeFileUndo = true;
        await new Promise(resolve => setTimeout(resolve, 600));
        await fs.writeFile(file,next);
        await waitFor(() => review.ledger.get(file)?.after === next, 'second fast rewrite after undo');
        await waitFor(() => editor.document.getText() === next, 'editor reload second');
        const pending = new vscode.WorkspaceEdit();
        pending.insert(uri, new vscode.Position(0,0), '// later user edit\r\n');
        assert.ok(await vscode.workspace.applyEdit(pending));
        await editor.document.save();
        assert.equal(review.ledger.get(file).userTouched, true);
        const mixed = editor.document.getText();
        const stale = changeHint(review.ledger.get(file), reviewDiff(review.ledger.get(file).before,review.ledger.get(file).after).hunks[0]);
        await vscode.commands.executeCommand('dsh-tui-vscode.editUndo',file,stale);
        assert.equal(await fs.readFile(file,'utf8'), mixed);
        result.userEditsBlockPerHunkUndo = true;
        await vscode.commands.executeCommand('dsh-tui-vscode.editKeepAll');
        assert.equal(review.entries().length,0);
        assert.equal(await fs.readFile(file,'utf8'),mixed);
        result.keepAll = true;
        // New creation is classified correctly, acceptance does not modify disk.
        const created = path.join(root,'created.txt');
        await fs.writeFile(created,'new file\n');
        await waitFor(()=>review.ledger.get(created)?.kind==='create','new file');
        await vscode.commands.executeCommand('dsh-tui-vscode.editKeep',created);
        assert.equal(await fs.readFile(created,'utf8'),'new file\n');
        result.newFileKeep = true;
        // Deleted originals remain available and file-level Undo recreates exact text.
        const deleted = path.join(root,'deleted.txt');
        await fs.unlink(deleted);
        await waitFor(()=>review.ledger.get(deleted)?.kind==='delete','deleted file');
        await vscode.commands.executeCommand('dsh-tui-vscode.editUndo',deleted);
        assert.equal(await fs.readFile(deleted,'utf8'),'delete original\r\n');
        result.deletedFileRestored = true;
    } finally {
        terminal.dispose();
        await fs.writeFile(path.join(root,'host-result.json'),JSON.stringify(result,null,2));
    }
    console.log('REVIEW_HOST_RESULT',JSON.stringify(result));
}
module.exports = { run };
