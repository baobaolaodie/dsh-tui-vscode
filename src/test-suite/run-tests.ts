/**
 * E2E launcher for the Path B implementation: downloads/uses a real VS Code,
 * opens it with the extension under test and runs src/test-suite/index.ts
 * inside the extension host. The fake dsh-tui is a Node script (cross
 * platform, no cmd/sh quoting traps).
 */
import { runTests } from '@vscode/test-electron'
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

async function main(): Promise<void> {
  // out-test/test-suite -> repo root
  const root = join(__dirname, '..', '..')
  const ws = join(root, '.e2e-workspace')
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
      '  `ARGS=${process.argv.slice(2).join(" ")}`,',
      '  "FAKE_LAUNCHER_RAN",',
      '].join("\\n") + "\\n")',
      'process.stdin.on("data", d => fs.appendFileSync(stdinOut, d))',
      'process.on("SIGINT", () => { fs.writeFileSync(path.join(__dirname, "exited.txt"), "1"); process.exit(0) })',
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'),
  )

  // A .cmd/.sh shim like the real dsh-tui.cmd: forwards to the node script.
  if (process.platform === 'win32') {
    writeFileSync(
      join(ws, 'fake-dsh-tui.cmd'),
      `@echo off\r\n"${process.execPath}" "${launcher}" %*\r\n`,
    )
  } else {
    const shim = join(ws, 'fake-dsh-tui.sh')
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${launcher}" "$@"\n`)
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