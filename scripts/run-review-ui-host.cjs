'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const base = process.env.DSH_REVIEW_ARTIFACT_ROOT;
if (!base)
    throw Error('Set DSH_REVIEW_ARTIFACT_ROOT to an isolated authorized directory');
const executable = process.env.VSCODE_EXECUTABLE;
if (!executable || !fs.existsSync(executable))
    throw Error('Set VSCODE_EXECUTABLE; no download/install');
const stage = path.join(base, 'dev-extension'), workspace = path.join(base, 'workspace');
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
for (const item of ['out', 'media', 'l10n', 'bridge', 'node_modules', 'package.nls.json', 'package.nls.zh-cn.json']) {
    const source = path.join(repo, item), target = path.join(stage, item);
    if (!fs.existsSync(target)) {
        if (fs.statSync(source).isDirectory())
            fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
        else
            fs.copyFileSync(source, target);
    }
}
fs.writeFileSync(path.join(workspace, 'native.txt'), 'old one\r\nkeep\r\nold two');
fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify({ 'dsh-tui-vscode.editReview.native': false, 'dsh-tui-vscode.editReview.autoShowDiff': false, 'telemetry.telemetryLevel': 'off', 'window.title': 'DSH Stable Review UI Test', 'workbench.colorTheme': 'Default Dark+', 'update.mode': 'none', 'dsh-tui-vscode.editReview.exclude': ['**/.vscode/**', '**/*result.json'] }));
const args = [workspace, '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-updates', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${base}/user-data`, `--extensions-dir=${base}/extensions`, '--disable-extension=github.copilot-chat', '--disable-extension=vscode.github-authentication', `--extensionDevelopmentPath=${stage}`, `--extensionTestsPath=${repo}/out/review-ui-host-test.js`, '--remote-debugging-port=9238'];
const env = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'])
    if (process.env[key])
        env[key] = process.env[key];
if (process.env.DSH_REVIEW_VISUAL_HANDSHAKE)
    env.DSH_REVIEW_VISUAL_HANDSHAKE = '1';
const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
const fd = fs.openSync(path.join(base, 'host.log'), 'a');
for (const stream of [child.stdout, child.stderr])
    stream.on('data', data => { fs.writeSync(fd, data); process.stdout.write(data); });
fs.writeFileSync(path.join(base, 'process.json'), JSON.stringify({ pid: child.pid, args }));
let visualError;
if (env.DSH_REVIEW_VISUAL_HANDSHAKE) {
    require('./stable-review-ui-observer.cjs').observeStableUi(base, 9238).catch(error => { visualError = error; console.error(error); fs.writeFileSync(path.join(base, 'visual-error.txt'), error.stack || String(error)); });
}
const timer = setTimeout(() => { if (process.platform === 'win32')
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']);
else
    child.kill(); }, 60000);
child.on('error', e => { clearTimeout(timer); console.error(e); process.exitCode = 1; });
child.on('exit', (code, signal) => { clearTimeout(timer); fs.closeSync(fd); let result; try {
    result = JSON.parse(fs.readFileSync(path.join(workspace, 'ui-result.json'), 'utf8'));
}
catch { } console.log(JSON.stringify({ code, signal, result })); process.exitCode = code === 0 && result?.status === 'passed' && !visualError ? 0 : 1; });
