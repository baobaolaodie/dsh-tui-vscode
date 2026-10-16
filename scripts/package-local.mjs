#!/usr/bin/env node
// 本地审阅增强版使用显式输出文件名，避免与同版本正式包混淆。
// 文件名由打包与安装共同引用；不修改扩展 name/publisher/version。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getVsixPath } from './vsix-artifact.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const require = createRequire(import.meta.url)
const vsce = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce')

execFileSync(process.execPath, [vsce, 'package', '--out', getVsixPath(ROOT, pkg)], {
  cwd: ROOT,
  stdio: 'inherit',
})
