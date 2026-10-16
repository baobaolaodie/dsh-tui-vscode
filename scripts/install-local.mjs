#!/usr/bin/env node
// 本地安装打包产物：node scripts/install-local.mjs（由 `npm run install:local` 调用）。
// 设计：打包与安装共享带 -edit-review 后缀的产物名；版本从 manifest 读取，
// 不会回退安装相同版本号的正式版默认文件名。
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getVsixFileName } from './vsix-artifact.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const vsix = getVsixFileName(pkg)

execSync(`code --install-extension ${vsix} --force`, { cwd: ROOT, stdio: 'inherit' })
