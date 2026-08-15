/**
 * E2E launcher: downloads/uses a real VS Code, opens it with the extension
 * under test and runs src/test-suite/index.ts inside the extension host.
 *
 * Run via `pnpm test:e2e`.
 */
import { runTests } from '@vscode/test-electron'
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'

async function main(): Promise<void> {
  // out-test/test-suite -> repo root
  const root = join(__dirname, '..', '..')
  const ws = join(root, '.e2e-workspace')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'hello.ts'), 'export const answer = 42\n')
  rmSync(join(ws, 'env-out.txt'), { force: true })

  const isWin = process.platform === 'win32'
  const launcher = join(ws, isWin ? 'fake-dsh-tui.cmd' : 'fake-dsh-tui.sh')
  writeFileSync(
    launcher,
    isWin
      ? [
          '@echo off',
          'setlocal',
          'echo VISUAL=%VISUAL% > "%~dp0env-out.txt"',
          'echo DSH_TUI_LANG=%DSH_TUI_LANG% >> "%~dp0env-out.txt"',
          'echo DSH_HOME=%DSH_HOME% >> "%~dp0env-out.txt"',
          'echo ARGS=%* >> "%~dp0env-out.txt"',
          'echo FAKE_LAUNCHER_RAN >> "%~dp0env-out.txt"',
          'ping -n 60 127.0.0.1 > nul',
          'endlocal',
          '',
        ].join('\r\n')
      : [
          '#!/bin/sh',
          // printf '%s' prints the value verbatim — `echo` would interpret
          // backslash escapes (e.g. C:\\e2e-home → C:<ESC>2e-home).
          'printf \'%s\\n\' "VISUAL=$VISUAL" > "$(dirname "$0")/env-out.txt"',
          'printf \'%s\\n\' "DSH_TUI_LANG=$DSH_TUI_LANG" >> "$(dirname "$0")/env-out.txt"',
          'printf \'%s\\n\' "DSH_HOME=$DSH_HOME" >> "$(dirname "$0")/env-out.txt"',
          'printf \'%s\\n\' "ARGS=$*" >> "$(dirname "$0")/env-out.txt"',
          'printf \'%s\\n\' FAKE_LAUNCHER_RAN >> "$(dirname "$0")/env-out.txt"',
          'sleep 60',
          '',
        ].join('\n'),
  )
  chmodSync(launcher, 0o755)

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