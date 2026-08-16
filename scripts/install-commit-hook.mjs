#!/usr/bin/env node
// 钩子安装脚本（github-repo-setup 模板适配版）。
// 用法：node scripts/install-commit-hook.mjs
// 设计：钩子文件已入库 .githooks/（随 clone 分发、随 pull 更新、可演进）；
// 本脚本只需设置 core.hooksPath——不要写死 .git/hooks/（不入库，每个 clone 都要重装）。
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function main() {
  if (!existsSync(path.join(ROOT, '.git'))) {
    console.error('未找到 .git 目录（不是 git 仓库？）')
    process.exit(1)
  }
  execSync('git config core.hooksPath .githooks', { cwd: ROOT, stdio: 'inherit' })
  console.log('core.hooksPath → .githooks（钩子已入库：pre-commit / commit-msg）')
  console.log('提示：.gitattributes 已含 `.githooks/** text eol=lf`（Windows CRLF 会破坏 sh 钩子）')
}

main()
