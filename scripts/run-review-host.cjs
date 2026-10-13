'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const artifactRoot = process.env.DSH_REVIEW_ARTIFACT_ROOT || path.join(root, '.scratch', 'review-host');
const testRoot = path.join(artifactRoot, `review-host-${Date.now()}`);
const workspace = path.join(testRoot, 'workspace');
const executable = process.env.VSCODE_EXECUTABLE;
if (!executable || !fs.existsSync(executable)) {
    console.error('Set VSCODE_EXECUTABLE to an existing VS Code executable. No downloads or installation are performed.');
    process.exit(1);
}
fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
fs.mkdirSync(path.join(testRoot, 'extensions'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'review-fixture.js'), 'const a = "old a";\r\nconst b = "old b";\r\n// unchanged\r\nconst c = "old c";');
fs.writeFileSync(path.join(workspace, 'deleted.txt'), 'delete original\r\n');
fs.writeFileSync(path.join(workspace, 'bom.txt'), '\uFEFFBOM original\r\n');
fs.writeFileSync(path.join(workspace, 'batch-a.txt'), 'batch A original\n');
fs.writeFileSync(path.join(workspace, 'batch-b.txt'), 'batch B original');
fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
    'dsh-tui-vscode.editReview.exclude': ['**/.vscode/**', '**/host-result.json', '**/host-result.json.tmp'],
    'dsh-tui-vscode.editReview.autoShowDiff': false,
    'window.title': 'dsh-tui review isolated test',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
}));
const args = [workspace, '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-updates', '--no-sandbox', '--disable-gpu-sandbox',
    `--user-data-dir=${path.join(testRoot, 'user-data')}`, `--extensions-dir=${path.join(testRoot, 'extensions')}`,
    '--disable-extension=github.copilot-chat', '--disable-extension=vscode.github-authentication',
    `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(root, 'out/review-host-test.js')}`];
console.log('HOST_ROOT', testRoot);
fs.writeFileSync(path.join(artifactRoot, 'latest-host-root.txt'), testRoot);
const child = spawn(executable, args, { shell: false, env: process.env });
const log = fs.openSync(path.join(testRoot, 'host-log.txt'), 'a');
for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on('data', data => { fs.writeSync(log, data); output.write(data); });
}
let timedOut = false;
const timer = setTimeout(() => {
    timedOut = true;
    console.error('Isolated host exceeded 90 seconds; terminating only its process tree', child.pid);
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
}, 90000);
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => {
    clearTimeout(timer);
    fs.closeSync(log);
    let evidence;
    try { evidence = JSON.parse(fs.readFileSync(path.join(workspace, 'host-result.json'), 'utf8')); }
    catch (error) { console.error('Missing or invalid host evidence:', error.message); }
    console.log('HOST_EXIT', JSON.stringify({ code, signal, timedOut, status: evidence?.status, phase: evidence?.phase }));
    process.exitCode = code === 0 && !timedOut && evidence?.status === 'passed' ? 0 : 1;
});
