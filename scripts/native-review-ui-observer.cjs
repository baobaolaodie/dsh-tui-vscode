'use strict';
// Read-only renderer inspection plus native pointer clicks in the one
// isolated test window. Never changes workbench DOM, styles or app services.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = url => new Promise((resolve, reject) => http.get(url, res => { let body = ''; res.on('data', d => body += d); res.on('end', () => { try {
    resolve(JSON.parse(body));
}
catch (e) {
    reject(e);
} }); }).on('error', reject));
async function observeNativeUi(base, port) {
    let socket, seq = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const connect = async () => {
        for (let i = 0; i < 100; i++) {
            try {
                const targets = await json(`http://127.0.0.1:${port}/json/list`);
                const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url));
                if (page) {
                    socket = new WebSocket(page.webSocketDebuggerUrl);
                    await new Promise((r, j) => { socket.once('open', r); socket.once('error', j); });
                    socket.on('message', raw => { const data = JSON.parse(String(raw)); const p = pending.get(data.id); if (p) {
                        pending.delete(data.id);
                        data.error ? p.reject(Error(data.error.message)) : p.resolve(data.result);
                    } });
                    return;
                }
            }
            catch { }
            await sleep(200);
        }
        throw Error('Isolated workbench renderer unavailable');
    };
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
    const inspect = () => evaluate(`(() => {
 const selectors=['.chat-editing-original-zone','.chat-editing-editor-overlay','.chat-diff-change-content-widget','.codelens-decoration','.notifications-toasts'];
 return {themeClass:document.querySelector('.monaco-workbench')?.className,items:selectors.map(selector=>({selector,visible:[...document.querySelectorAll(selector)].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).map(e=>{const b=e.getBoundingClientRect(),s=getComputedStyle(e);return{text:e.textContent,bounds:{x:b.x,y:b.y,width:b.width,height:b.height},color:s.color,background:s.backgroundColor,unobscured:e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))||document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===e}})}))};})()`);
    try {
        await connect();
        const file = path.join(base, 'workspace', 'native-probe-result.json');
        const marker = path.join(base, 'workspace', 'visual-next.json');
        const seen = new Set();
        for (let count = 0; count < 600; count++) {
            let result;
            try {
                result = JSON.parse(fs.readFileSync(file, 'utf8'));
            }
            catch { }
            if (result?.status === 'failed')
                throw Error(result.error);
            if (result?.status === 'passed')
                return;
            const phase = result?.phase;
            if (phase === 'native-click-keep' || phase === 'native-click-undo') {
                if (!seen.has(phase)) {
                    await sleep(500);
                    const label = phase.endsWith('keep') ? 'Keep' : 'Undo';
                    let point;
                    for (let attempt = 0; attempt < 30 && !point; attempt++) {
                        point = await evaluate(`(() => {const roots=[...document.querySelectorAll('.chat-editing-editor-overlay'),...document.querySelectorAll('.chat-diff-change-content-widget')].filter(e=>e.getBoundingClientRect().width>0);for(const root of roots){const button=[...root.querySelectorAll('button,a')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(button){const b=button.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2,text:button.textContent,color:getComputedStyle(button).color};}}return null;})()`);
                        if (!point)
                            await sleep(200);
                    }
                    if (!point) {
                        fs.writeFileSync(path.join(base, `${phase}-missing.json`), JSON.stringify(await inspect(), null, 2));
                        throw Error(`${label} native overlay button not found`);
                    }
                    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
                    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
                    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
                    await sleep(500);
                    fs.writeFileSync(path.join(base, `${phase}.json`), JSON.stringify(point, null, 2));
                    seen.add(phase);
                    fs.writeFileSync(marker, '{}');
                }
            }
            if (phase?.startsWith('native-visual-Default') && !seen.has(phase)) {
                await sleep(800);
                let data = await inspect();
                const old = data.items.find(i => i.selector === '.chat-editing-original-zone')?.visible || [];
                const overlay = data.items.find(i => i.selector === '.chat-editing-editor-overlay')?.visible || [];
                const controls = data.items.find(i => i.selector === '.chat-diff-change-content-widget')?.visible || [];
                if (!old.length || !overlay.some(o => /Keep/.test(o.text) && /Undo/.test(o.text)) || !controls.some(o => /Keep/.test(o.text) && /Undo/.test(o.text)))
                    throw Error(`Native old lines or controls missing: ${JSON.stringify(data)}`);
                const label = phase.includes('Light') ? 'light' : phase.includes('Contrast') ? 'high-contrast' : 'dark';
                fs.mkdirSync(path.join(base, 'screenshots'), { recursive: true });
                fs.writeFileSync(path.join(base, 'screenshots', `${label}.json`), JSON.stringify(data, null, 2));
                const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                fs.writeFileSync(path.join(base, 'screenshots', `${label}.png`), Buffer.from(image.data, 'base64'));
                seen.add(phase);
                fs.writeFileSync(marker, '{}');
            }
            await sleep(200);
        }
        throw Error('Visual host did not finish');
    }
    finally {
        socket?.close();
    }
}
module.exports = { observeNativeUi };
