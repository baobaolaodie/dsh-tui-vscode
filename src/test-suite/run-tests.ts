/**
 * E2E launcher for the Path B implementation: downloads/uses a real VS Code,
 * opens it with the extension under test and runs src/test-suite/index.ts
 * inside the extension host. The fake dsh-tui is a Node script (cross
 * platform, no cmd/sh quoting traps).
 */
import { runTests } from '@vscode/test-electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

async function main(): Promise<void> {
  // out-test/test-suite -> repo root
  const root = join(__dirname, '..', '..')
  // T-FIX-02: the workspace must be a SUBDIRECTORY of a real git repository —
  // the upstream TUI crawls to the git root for its session cwd (issue #96),
  // so a plain folder can never reproduce the "missing @mention" bug this
  // suite now pins. `git` is guaranteed on CI runners (this repo's own ci.yml
  // uses it) and on dev machines; the suite asserts the .git presence and
  // skips the affected cases honestly when absent.
  const parent = join(root, '.e2e-git-parent')
  try {
    execFileSync('git', ['init', '-q', parent])
  } catch {
    // No git in PATH: fall back to a bare directory — the subdirectory-workspace
    // assertions skip themselves (existsSync guard on parent/.git).
  }
  const ws = join(parent, '.e2e-workspace')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'hello.ts'), 'export const answer = 42\n')

  const launcher = join(ws, 'fake-dsh-tui.js')
  writeFileSync(
    launcher,
    [
      'const fs = require("fs")',
      'const path = require("path")',
      'const out = path.join(__dirname, "env-out.txt")',
      'const stdinOut = path.join(__dirname, "stdin-out.txt")',
      'fs.writeFileSync(out, [',
      '  `VISUAL=${process.env.VISUAL ?? ""}`,',
      '  `DSH_TUI_LANG=${process.env.DSH_TUI_LANG ?? ""}`,',
      '  `DSH_HOME=${process.env.DSH_HOME ?? ""}`,',
      '  `RESUME_SESSION=${process.env.DSH_TUI_RESUME_SESSION ?? ""}`,',
      '  `ARGS=${process.argv.slice(2).join(" ")}`,',
      '  `CWD=${process.cwd()}`,',
      '  "FAKE_LAUNCHER_RAN",',
      '].join("\\n") + "\\n")',
      'process.stdin.on("data", d => fs.appendFileSync(stdinOut, d))',
      'process.on("SIGINT", () => { fs.writeFileSync(path.join(__dirname, "exited.txt"), "1"); process.exit(0) })',
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'),
  )

  // A shim like the real dsh-tui launcher: .cmd on Windows, an extensionless
  // executable on POSIX (npm bins have no extension, so resolvePosixCommand
  // looks for the exact name).
  if (process.platform === 'win32') {
    writeFileSync(
      join(ws, 'fake-dsh-tui.cmd'),
      `@echo off\r\n"${process.execPath}" "${launcher}" %*\r\n`,
    )
  } else {
    const shim = join(ws, 'fake-dsh-tui')
    // The shim logs its own run + the child's output, so CI failures show
    // exactly why the launcher exited.
    writeFileSync(
      shim,
      [
        '#!/bin/sh',
        `SHIM_LOG="${launcher}.shim-log"`,
        'echo "SHIM_RAN pid=$$" > "$SHIM_LOG"',
        `"${process.execPath}" "${launcher}" "$@" >> "$SHIM_LOG" 2>&1`,
        'echo "SHIM_EXIT=$?" >> "$SHIM_LOG"',
        '',
      ].join('\n'),
    )
    chmodSync(shim, 0o755)
  }
  for (const file of ['env-out.txt', 'stdin-out.txt', 'exited.txt']) {
    rmSync(join(ws, file), { force: true })
  }

  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: join(__dirname, 'index.js'),
    launchArgs: [ws, '--disable-workspace-trust'],
  })
  console.log('[e2e] runTests completed')
}

main().catch(error => {
  console.error('[e2e] failed:', error)
  process.exit(1)
})