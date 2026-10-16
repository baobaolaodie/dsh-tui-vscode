'use strict';
/** Extension-owned Cordis plugin. No registration, policy or tool result is
 * replaced. A lost/unsupported IDE channel simply leaves the tool unreviewed. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX = 256 * 1024;
function expectedMutation(name, args, before) {
    if (name === 'write' && typeof args.content === 'string')
        return args.content;
    if (name === 'str_replace_editor' && args.command === 'create' && typeof args.file_text === 'string')
        return before === null ? args.file_text : undefined;
    if (typeof before !== 'string')
        return undefined;
    if (name === 'edit') {
        if (before.startsWith('\uFEFF') || typeof args.old_string !== 'string' || !args.old_string || typeof args.new_string !== 'string')
            return undefined;
        const normalize = v => v.replaceAll('\r\n', '\n');
        const source = normalize(before), old = normalize(args.old_string), replacement = normalize(args.new_string);
        if (!old || !source.includes(old))
            return undefined;
        const matches = source.split(old).length - 1;
        if (matches > 1 && args.replace_all !== true)
            return undefined;
        const edited = source.split(old).join(replacement);
        const sample = before.slice(0, 4096), crlf = sample.split('\r\n').length - 1, lf = sample.split('\n').length - 1 - crlf;
        return crlf > lf ? edited.replaceAll('\n', '\r\n') : edited;
    }
    const old = args.command === 'str_replace' ? args.old_str : undefined;
    const replacement = args.command === 'str_replace' ? (args.new_str ?? '') : undefined;
    if (typeof old === 'string' && old.length && typeof replacement === 'string') {
        const first = before.indexOf(old);
        if (first < 0)
            return undefined;
        if (name === 'edit' && args.replace_all === true)
            return before.split(old).join(replacement);
        if (before.indexOf(old, first + 1) >= 0)
            return undefined;
        return before.slice(0, first) + replacement + before.slice(first + old.length);
    }
    if (name === 'str_replace_editor' && args.command === 'insert' && Number.isInteger(args.insert_line) && typeof args.new_str === 'string') {
        const lines = before.split('\n');
        if (args.insert_line < 0 || args.insert_line > lines.length)
            return undefined;
        lines.splice(args.insert_line, 0, ...args.new_str.split('\n'));
        return lines.join('\n');
    }
    return undefined;
}
function validText(value) { return value === null || typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX && !value.includes('\0'); }
class EditChannel {
    constructor() { this.pending = new Map(); this.socket = null; this.connecting = null; }
    async connect() {
        if (this.socket?.readyState === 1)
            return;
        if (this.connecting)
            return this.connecting;
        const port = Number(process.env.DSH_TUI_IDE_PORT), token = process.env.DSH_VSCODE_EDIT_TOKEN;
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !token)
            throw Error('No edit channel');
        this.connecting = new Promise((resolve, reject) => {
            const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));
            const socket = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 4 * 1024 * 1024 });
            this.socket = socket;
            const timer = setTimeout(() => { socket.terminate(); reject(Error('Edit handshake timeout')); }, 2000);
            socket.on('open', () => socket.send(JSON.stringify({ method: 'edit/hello', params: { token, protocolVersion: 1 } })));
            socket.on('message', raw => {
                let msg;
                try {
                    msg = JSON.parse(String(raw));
                }
                catch {
                    return;
                }
                if (msg.method === 'edit/hello_ack' && msg.params?.protocolVersion === 1) {
                    clearTimeout(timer);
                    resolve();
                    return;
                }
                const waiting = this.pending.get(msg.id);
                if (!waiting)
                    return;
                this.pending.delete(msg.id);
                clearTimeout(waiting.timer);
                msg.error ? waiting.reject(Error(msg.error)) : waiting.resolve(msg.result);
            });
            const lost = () => { clearTimeout(timer); reject(Error('Edit channel unavailable')); if (this.socket === socket)
                this.socket = null; for (const [id, item] of this.pending) {
                clearTimeout(item.timer);
                item.reject(Error('Edit disconnected'));
                this.pending.delete(id);
            } };
            socket.on('error', lost);
            socket.on('close', lost);
        }).finally(() => { this.connecting = null; });
        return this.connecting;
    }
    async request(method, params, signal) {
        if (signal?.aborted)
            throw Error('Call canceled');
        await this.connect();
        return new Promise((resolve, reject) => {
            const id = randomUUID();
            const abort = () => { const item = this.pending.get(id); if (!item)
                return; this.pending.delete(id); clearTimeout(item.timer); reject(Error('Call canceled')); };
            const done = fn => value => { signal?.removeEventListener('abort', abort); fn(value); };
            const timer = setTimeout(() => { this.pending.delete(id); signal?.removeEventListener('abort', abort); reject(Error('Edit request timeout')); }, 20000);
            this.pending.set(id, { resolve: done(resolve), reject: done(reject), timer });
            signal?.addEventListener('abort', abort, { once: true });
            try {
                this.socket.send(JSON.stringify({ id, method, params }));
            }
            catch (e) {
                this.pending.delete(id);
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                reject(e);
            }
            if (signal?.aborted)
                abort();
        });
    }
    dispose() { this.socket?.terminate(); }
}
async function capture(ctx, exec) {
    const args = exec.arguments;
    if (!args || typeof args !== 'object' || !['write', 'edit', 'str_replace_editor'].includes(exec.name))
        return;
    if (exec.name === 'str_replace_editor' && !['create', 'str_replace', 'insert'].includes(args.command))
        return;
    const requested = exec.name === 'str_replace_editor' ? args.path : args.file_path;
    if (typeof requested !== 'string')
        return;
    const target = await ctx.fs.resolve(requested, { cwd: exec.agent?.session?.header?.cwd, signal: exec.signal });
    const file = ctx.fs.processPath(target);
    if (!path.isAbsolute(file) || ctx.fs.processPathFromHostPath(file) !== file)
        return;
    // Limit reads to the extension-spawned workspace. Backend and extension
    // independently enforce realpath containment before issuing a ready ack.
    const root = process.env.DSH_VSCODE_EDIT_ROOT;
    if (!root)
        return;
    const realRoot = await fs.realpath(root), realParent = await fs.realpath(path.dirname(file));
    const rel = path.relative(realRoot, realParent);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
        return;
    let before = null;
    try {
        const st = await fs.lstat(file);
        if (!st.isFile() || st.isSymbolicLink() || st.size > MAX)
            return;
        before = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fs.readFile(file));
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            return;
    }
    const after = expectedMutation(exec.name, args, before);
    if (!validText(before) || !validText(after) || after === undefined || before === after)
        return;
    return { operationId: randomUUID(), tool: exec.name, path: file, before, after, identity: { callId: String(exec.callId), rootCallId: String(exec.rootCallId), sessionId: String(exec.agent?.session?.id ?? exec.agent?.id ?? 'local') } };
}
function apply(ctx) {
    const channel = new EditChannel();
    const awaitingFinal = new Map(), pathCompletion = new Map();
    ctx.effect(() => () => { for (const item of awaitingFinal.values())
        item.finished(); awaitingFinal.clear(); pathCompletion.clear(); channel.dispose(); });
    // Final result follows post-execute/cancellation policies. This emit hook
    // does not block DSH, but its bounded request completes native streaming.
    ctx.on('tools/result', (exec, result) => {
        const tracked = awaitingFinal.get(exec.token);
        if (!tracked)
            return;
        awaitingFinal.delete(exec.token);
        const { operation, ready } = tracked, value = result?.value;
        const normalize = v => typeof v === 'string' ? v.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n') : v;
        const canonical = exec.name === 'str_replace_editor' || value && normalize(value.before) === normalize(operation.before) && normalize(value.after) === normalize(operation.after);
        void channel.request('edit/end', { ...operation, ticket: ready.ticket, success: result?.isError === false && !!canonical })
            .catch(() => { }).finally(() => { tracked.finished(); if (pathCompletion.get(operation.path) === tracked.done)
            pathCompletion.delete(operation.path); });
    });
    ctx.on('tools/execute', async (exec, next) => {
        let operation, ready;
        try {
            operation = await capture(ctx, exec);
            if (operation) {
                const previous = pathCompletion.get(operation.path);
                if (previous)
                    await previous;
                // The previous end may have changed the review baseline. A
                // fresh capture, not its display metadata, prepares this edit.
                operation = await capture(ctx, exec);
                if (operation)
                    ready = await channel.request('edit/begin', operation, exec.signal);
            }
        }
        catch { /* Never replace tool outcome with observation failure. */ }
        if (ready?.ticket && operation) {
            let finished;
            const done = new Promise(resolve => { finished = resolve; });
            awaitingFinal.set(exec.token, { operation, ready, done, finished });
            pathCompletion.set(operation.path, done);
        }
        return next();
    });
}
module.exports = { name: 'dsh-vscode-edit-observer', inject: ['tools', 'fs'], apply, expectedMutation, capture };
