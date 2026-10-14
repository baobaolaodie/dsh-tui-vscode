'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const load = Module._load;
let handler, disconnected;
const mockWs = { WebSocketServer: class {
        constructor() { this.handlers = {}; }
        on(n, f) { this.handlers[n] = f; }
        once(n, f) { this.handlers[n] = f; }
        address() { return { port: 34567 }; }
        close(cb) { cb?.(); }
    }, };
Module._load = function (name, ...args) { if (name === 'ws')
    return mockWs; return load.call(this, name, ...args); };
const { IdeServer } = require('../ide/server');
Module._load = load;
class Socket {
    constructor() { this.OPEN = 1; this.readyState = 1; this.sent = []; this.handlers = {}; }
    on(n, f) { (this.handlers[n] ??= []).push(f); }
    send(v) { this.sent.push(JSON.parse(v)); }
    close() { for (const f of this.handlers.close ?? [])
        f(); }
    terminate() { this.close(); }
}
const fire = (socket, name, ...args) => { for (const f of socket.handlers[name] ?? [])
    f(...args); };
test('edit protocol requires dedicated token, binds owner, and dispatches begin/end only', async () => {
    const server = new IdeServer({ token: 'ide', editToken: 'edit', workspaceFolders: () => ['/w'], onEdit: async (o, m, p) => { handler = { o, m, p }; return { ok: true }; }, onEditDisconnect: o => { disconnected = o; } });
    const socket = new Socket();
    const on = server['onConnection'].bind(server); // use a minimal fake server event path
    // onConnection is private at type level but remains a normal JS method.
    on(socket);
    fire(socket, 'message', JSON.stringify({ method: 'edit/hello', params: { token: 'edit', protocolVersion: 1 } }));
    assert.equal(socket.sent[0].method, 'edit/hello_ack');
    fire(socket, 'message', JSON.stringify({ id: '1', method: 'edit/begin', params: { operationId: 'x' } }));
    await new Promise(setImmediate);
    assert.equal(handler.m, 'edit/begin');
    assert.equal(handler.p.operationId, 'x');
    assert.deepEqual(socket.sent.at(-1), { id: '1', result: { ok: true } });
    fire(socket, 'close');
    assert.equal(disconnected, socket);
});
test('normal IDE hello cannot use edit messages', async () => {
    const server = new IdeServer({ token: 'ide', editToken: 'edit', workspaceFolders: () => [], onEdit: async () => { throw Error('must not run'); } });
    const socket = new Socket();
    server['onConnection'](socket);
    fire(socket, 'message', JSON.stringify({ method: 'ide/hello', params: { token: 'ide', protocolVersion: 2 } }));
    fire(socket, 'message', JSON.stringify({ id: 'x', method: 'edit/begin', params: {} }));
    await new Promise(setImmediate);
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0].method, 'ide/hello_ack');
});
