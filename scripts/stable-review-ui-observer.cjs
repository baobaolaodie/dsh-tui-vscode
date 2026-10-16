'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = url => new Promise((resolve, reject) => http.get(url, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try {
    resolve(JSON.parse(s));
}
catch (e) {
    reject(e);
} }); }).on('error', reject));
async function observeStableUi(base, port) { let ws, seq = 0; const pending = new Map(); const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); for (let i = 0; i < 100; i++) {
    try {
        const targets = await json(`http://127.0.0.1:${port}/json/list`), page = targets.find(t => t.type === 'page' && /workbench/.test(t.url));
        if (page) {
            ws = new WebSocket(page.webSocketDebuggerUrl);
            await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
            ws.on('message', raw => { const m = JSON.parse(String(raw)), p = pending.get(m.id); if (p) {
                pending.delete(m.id);
                m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
            } });
            break;
        }
    }
    catch { }
    await sleep(200);
} if (!ws)
    throw Error('renderer unavailable'); const evalJs = e => send('Runtime.evaluate', { expression: e, returnByValue: true }).then(r => r.result.value); const seen = new Set(); const output = path.join(base, 'workspace', 'ui-result.json'), marker = path.join(base, 'workspace', 'visual-next.json'); try {
    for (let i = 0; i < 600; i++) {
        let result;
        try {
            result = JSON.parse(fs.readFileSync(output, 'utf8'));
        }
        catch { }
        if (result?.status === 'failed')
            throw Error(result.error);
        if (result?.status === 'passed')
            return;
        const phase = result?.phase;
        if (seen.has(phase)) {
            await sleep(150);
            continue;
        }
        if (phase?.startsWith('inline-') || phase?.startsWith('diff-')) {
            const snap = await evalJs(`(()=>{const sels=['.chat-editing-original-zone','.chat-editing-editor-overlay','.chat-diff-change-content-widget','.dsh-edit-review-added','.dsh-edit-review-removed','.monaco-editor'];return {theme:document.querySelector('.monaco-workbench')?.className,items:sels.map(selector=>({selector,items:[...document.querySelectorAll(selector)].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).map(e=>{const b=e.getBoundingClientRect(),s=getComputedStyle(e);return{text:e.textContent,color:s.color,background:s.backgroundColor,bounds:{x:b.x,y:b.y,width:b.width,height:b.height}}})}))}})()`);
            fs.mkdirSync(path.join(base, 'screenshots'), { recursive: true });
            fs.writeFileSync(path.join(base, 'screenshots', `${phase}.json`), JSON.stringify(snap, null, 2));
            const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            fs.writeFileSync(path.join(base, 'screenshots', `${phase}.png`), Buffer.from(image.data, 'base64'));
            seen.add(phase);
            fs.writeFileSync(marker, '{}');
        }
        else if (phase === 'click-keep-first' || phase === 'click-undo-second') {
            await sleep(400);
            const label = phase === 'click-keep-first' ? 'Keep this change' : 'Undo this change';
            const point = await evalJs(`(()=>{const ls=[...document.querySelectorAll('.codelens-decoration a')];const e=ls.find(e=>e.textContent.includes(${JSON.stringify(label)}));if(!e)return null;const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2,text:e.textContent}})()`);
            if (!point)
                throw Error(`stable ${phase} control not found`);
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
            await sleep(500);
            fs.writeFileSync(path.join(base, phase + '.json'), JSON.stringify(point));
            seen.add(phase);
            fs.writeFileSync(marker, '{}');
        }
        await sleep(150);
    }
    throw Error('stable UI host timeout');
}
finally {
    ws.close();
} }
module.exports = { observeStableUi };
