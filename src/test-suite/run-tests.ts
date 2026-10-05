/**
 * E2E launcher for the Path B implementation: downloads/uses a real VS Code,
 * opens it with the extension under test and runs src/test-suite/index.ts
 * inside the extension host. The fake dsh-tui is a Node script (cross
 * platform, no cmd/sh quoting traps).
 */
import { runTests } from '@vscode/test-electron'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

async function main(): Promise<void> {
  // out-test/test-suite -> repo root
  const root = join(__dirname, '..', '..')
  // The workspace must be a SUBDIRECTORY of a real git repository —
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
      // The image-protocol gate's observable output (T-FIX-02): the e2e cases
      // assert what the session terminal actually received, never the setting.
      '  `DSH_TUI_IMAGE_PROTOCOL=${process.env.DSH_TUI_IMAGE_PROTOCOL ?? ""}`,',
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

  // ── zh-cn fake language pack: cold registration + hot assertions (T04) ─────
  // ADR-005 / L-003: `--locale=zh-cn` only reaches `vscode.env.language` once
  // a language pack has been scanned into the SAME profile, and the first
  // launch only performs that registration. Copy the in-repo 2-file fixture
  // into a fixed extensions dir, then launch A (warm-up) and B (assertions)
  // against the same fixed extensions/user-data dirs.
  const l10nExts = join(ws, 'l10n-exts')
  const l10nProfile = join(ws, 'l10n-user')
  const packId = 'dsh-tui-vscode-e2e.e2e-language-pack-zh-cn-0.0.1'
  const fixture = join(root, 'src', 'test-suite', 'fixtures', 'e2e-language-pack-zh-cn')
  // Fixed paths, wiped first: launch A must be a genuine cold registration
  // even when `.e2e-workspace` survived an earlier run.
  rmSync(l10nExts, { recursive: true, force: true })
  rmSync(l10nProfile, { recursive: true, force: true })
  mkdirSync(join(l10nExts, packId), { recursive: true })
  cpSync(fixture, join(l10nExts, packId), { recursive: true })

  const zhArgs = [
    ws,
    '--disable-workspace-trust',
    `--extensions-dir=${l10nExts}`,
    `--user-data-dir=${l10nProfile}`,
    '--locale=zh-cn',
  ]
  const zhLaunch = async (mode: 'warmup' | 'zh-cn'): Promise<void> => {
    const startedAt = Date.now()
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: join(__dirname, 'index.js'),
      launchArgs: zhArgs,
      extensionTestsEnv: { DSH_E2E_L10N_MODE: mode },
    })
    console.log(`[e2e] zh-cn ${mode} launch completed in ${Date.now() - startedAt}ms`)
  }
  await zhLaunch('warmup') // launch A: language-pack registration only
  await zhLaunch('zh-cn') // launch B: env.language + localized UI assertions
  console.log('[e2e] zh-cn language-pack flow completed')

  // ── Terminal-image protocol hosts (T-FIX-02) ──────────────────────────────
  // REVIEW F-2: AC-5's orchestration and the F-3 capability gate had no in-repo
  // coverage. `src/session.ts` resolves the capability from what
  // `terminal.integrated.enableImages` was when THIS window started AND its
  // live value, and the one-time setup offer is per window (`src/extension.ts`
  // marks it in globalState before awaiting the notification) — so each
  // window-start state needs its own host, with its own COLD user-data dir:
  //   * `images-off`: no settings.json, so the setting is off when the window
  //     starts. The A leg writes it on INSIDE that window and asserts the
  //     injection stays `none` while the reload offer appears (F-3), and that a
  //     start with the setting off injects `none`.
  //   * `images-on`: settings.json pre-set to true, so this window really
  //     loaded the image addon — the only state that may inject `sixel` (the B
  //     leg). Its first start has nothing to offer, which leaves the window's
  //     single offer slot free for the AC-5 assertions (b/c).
  // Both are cold launches for the same reason the zh-cn pack needs one
  // (LESSONS L-003): the state under test is "what the window started with".
  const imagesOffProfile = join(ws, 'images-off-user')
  const imagesOnProfile = join(ws, 'images-on-user')
  rmSync(imagesOffProfile, { recursive: true, force: true })
  rmSync(imagesOnProfile, { recursive: true, force: true })
  mkdirSync(join(imagesOnProfile, 'User'), { recursive: true })
  writeFileSync(
    join(imagesOnProfile, 'User', 'settings.json'),
    JSON.stringify({ 'terminal.integrated.enableImages': true }, null, 2) + '\n',
  )
  const imageLaunch = async (mode: 'images-off' | 'images-on', profile: string): Promise<void> => {
    const startedAt = Date.now()
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: join(__dirname, 'index.js'),
      launchArgs: [ws, '--disable-workspace-trust', `--user-data-dir=${profile}`],
      extensionTestsEnv: { DSH_E2E_IMAGE_MODE: mode },
    })
    console.log(`[e2e] ${mode} launch completed in ${Date.now() - startedAt}ms`)
  }
  await imageLaunch('images-off', imagesOffProfile)
  await imageLaunch('images-on', imagesOnProfile)
  console.log('[e2e] terminal-image protocol flow completed')
}

main().catch(error => {
  console.error('[e2e] failed:', error)
  process.exit(1)
})