#!/usr/bin/env node
// 本地安装打包产物：node scripts/install-local.mjs（由 `npm run install:local` 调用）。
// 设计：vsce 默认产物名为 <name>-<version>.vsix，这里从 package.json 动态读取
// name/version 拼接——版本升级时无需同步任何硬编码文件名（曾硬编码 0.5.1 导致
// 版本升到 0.6.0 后 install:local 找不到旧文件而失败）。
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const vsix = `${pkg.name}-${pkg.version}.vsix`

execSync(`code --install-extension ${vsix} --force`, { cwd: ROOT, stdio: 'inherit' })
