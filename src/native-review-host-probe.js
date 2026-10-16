'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
async function run() {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const output = path.join(root, 'native-probe-result.json');
    const result = { version: vscode.version, inferenceCalls: 0, status: 'running' };
    const write = () => fs.writeFileSync(output, JSON.stringify(result, null, 2));
    try {
        const ext = vscode.extensions.getExtension('baobaolaodie.dsh-tui-vscode');
        const api = await ext.activate();
        const native = api.getNativeReviewTestBridge(), tx = api.getEditTransactionsTestBridge();
        await api.getEditReviewTestBridge().ready;
        const model = { id: 'fixture', name: 'No-inference Review Fixture', family: 'review-fixture', version: '1', maxInputTokens: 8192, maxOutputTokens: 8192, capabilities: { toolCalling: true } };
        const reg = vscode.lm.registerLanguageModelChatProvider('dsh-review-fixture', {
            provideLanguageModelChatInformation: async () => [model], provideTokenCount: async () => 0,
            provideLanguageModelChatResponse: async () => { result.inferenceCalls++; write(); throw Error('Inference prohibited in review probe'); },
        });
        result.models = (await vscode.lm.selectChatModels({ vendor: 'dsh-review-fixture' })).map(m => ({ id: m.id, vendor: m.vendor, family: m.family }));
        write();
        await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'edit', isPartialQuery: true, query: '' });
        await vscode.commands.executeCommand('workbench.action.chat.changeModel', { vendor: 'dsh-review-fixture', id: 'fixture', family: 'review-fixture' });
        const file = path.join(root, 'native.txt'), uri = vscode.Uri.file(file);
        await vscode.window.showTextDocument(uri);
        const owner = {}, op = { operationId: 'native-1', tool: 'write', path: file, before: 'old one\r\nkeep\r\nold two', after: 'new one\r\nkeep\r\nnew two', identity: { callId: 'fixture-1' } };
        result.begin = await tx.begin(owner, op);
        result.evidence = { ...native.lastEvidence };
        write();
        assert.equal(result.begin.mode, 'native');
        fs.writeFileSync(file, op.after);
        await tx.end(owner, { ...op, ticket: result.begin.ticket, success: true });
        await vscode.window.showTextDocument(uri);
        await vscode.commands.executeCommand('chatEditor.action.reviewChanges');
        result.completed = { ...native.lastEvidence };
        result.owned = native.owns(file);
        assert.equal(result.inferenceCalls, 0);
        result.phase = 'native-visual-ready';
        write();
        if (process.env.DSH_REVIEW_VISUAL_HANDSHAKE) {
            const marker = path.join(root, 'visual-next.json');
            const wait = async () => { const start = Date.now(); while (!fs.existsSync(marker)) {
                if (Date.now() - start > 60000)
                    throw Error('Visual controller timed out');
                await new Promise(r => setTimeout(r, 100));
            } const data = JSON.parse(fs.readFileSync(marker, 'utf8')); fs.unlinkSync(marker); return data; };
            await vscode.commands.executeCommand('notifications.clearAll');
            for (const theme of ['Default Dark+', 'Default Light+', 'Default High Contrast']) {
                await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Workspace);
                await vscode.window.showTextDocument(uri);
                await vscode.commands.executeCommand('chatEditor.action.reviewChanges');
                result.phase = `native-visual-${theme}`;
                write();
                await wait();
            }
            // Real native Keep/Undo through the controls' registered actions. The
            // renderer screenshot controller may click hunk widgets before advancing.
            result.phase = 'native-click-keep';
            write();
            await wait();
            result.afterKeep = fs.readFileSync(file, 'utf8');
            assert.equal(result.afterKeep, op.after);
            const before2 = op.after, after2 = before2.replace('new two', 'newer two');
            const op2 = { ...op, operationId: 'native-2', before: before2, after: after2, identity: { callId: 'fixture-2' } };
            const ack2 = await tx.begin(owner, op2);
            assert.equal(ack2.mode, 'native');
            fs.writeFileSync(file, after2);
            await tx.end(owner, { ...op2, ticket: ack2.ticket, success: true });
            await vscode.window.showTextDocument(uri);
            await vscode.commands.executeCommand('chatEditor.action.reviewChanges');
            result.phase = 'native-click-undo';
            write();
            await wait();
            const doc = await vscode.workspace.openTextDocument(uri);
            const start = Date.now();
            while (doc.getText() !== before2) {
                if (Date.now() - start > 5000)
                    throw Error('Native Undo did not restore editor');
                await new Promise(r => setTimeout(r, 50));
            }
            if (doc.isDirty)
                await doc.save();
            result.afterLaterUndo = fs.readFileSync(file, 'utf8');
            assert.equal(result.afterLaterUndo, before2);
            result.keepThenUndoPreservesKeptText = true;
        }
        result.status = 'passed';
        write();
        reg.dispose();
    }
    catch (e) {
        result.status = 'failed';
        result.error = String(e.stack || e);
        write();
        throw e;
    }
}
module.exports = { run };
