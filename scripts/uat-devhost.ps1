# Launch the Extension Development Host used by UAT (real VS Code install + isolated profile).
#
# Promoted from the archived UAT launcher used by vscode-terminal-image-protocol; two of its
# properties are load-bearing and must not be dropped (see LESSONS L-013 / L-015):
#
#   * The agent shell's colour/TTY markers are STRIPPED before the GUI host is spawned.
#     The DSH shell tools deliberately export NO_COLOR=1 / TERM=dumb for model-friendly
#     output, and Start-Process children inherit them all the way down to the CLI inside
#     the host's integrated terminal -- a TUI that honours NO_COLOR then renders in pure
#     greyscale, which was twice mis-attributed to a product defect.
#   * The three commit anchors are printed: the dev host loads out/ (compiled JS), and every
#     `npm test` / `npm run test:e2e` rewrites it, so evidence that does not state commit,
#     tree state and out/ build time cannot be traced back to the code it exercised.
#
# Why this shape:
#   * Use the REAL installed Code.exe. The .vscode-test archive copy cannot be started as a
#     manual dev host on this machine (LESSONS L-006: payload lives in the hash subdirectory).
#   * Use an ISOLATED --user-data-dir / --extensions-dir. Otherwise the launch collides with
#     the user's own running VS Code singleton, and an existing profile would pollute the UAT
#     preconditions (setting value, per-window one-shot prompt slot).
#   * Wipe the profile before every launch: several UAT steps require a default-valued,
#     never-prompted window, and the one-shot prompt slot is per window.
#
# Usage (from any shell, including the DSH agent shell):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/uat-devhost.ps1 -Tag my-uat-1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/uat-devhost.ps1 -Tag img-uat-2 `
#     -SettingsJson '{"terminal.integrated.enableImages": true}'
#
# The window stays open on purpose (it is the thing under test); close it yourself when the
# UAT round is over.
#
# NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 decodes a BOM-less UTF-8
# script as ANSI, so non-ASCII comments corrupt parsing and the script fails with a bogus
# "UnexpectedToken" at the line after the offending comment.
param(
  # Isolated profile name: any single safe path segment (it becomes a folder under %TEMP%).
  # Deliberately NOT an enum -- UAT rounds are named per change, e.g. `a1`, `img-uat-2`.
  [string]$Tag = 'dsh-uat',
  # Raw JSON written to <profile>/User/settings.json BEFORE launch. Used to hold a variable
  # constant across windows, e.g. to reproduce the user's own profile value of
  # workbench.experimental.modernUI (default true vs the user's explicit false).
  [string]$SettingsJson = '',
  # Real VS Code installation to development-host out of. Defaults to this machine's install;
  # override on another machine.
  [string]$CodeExe = 'E:\Microsoft VS Code\Code.exe',
  # Repository the dev host loads the extension from (its compiled out/). Defaults to this
  # machine's checkout; override when running from a different worktree.
  [string]$Repo = 'D:\LongYinHaHa\VSCode\deepsharness\dsh-tui-vscode'
)

$ErrorActionPreference = 'Stop'

if ($Tag -notmatch '^[A-Za-z0-9._-]+$') {
  throw "invalid -Tag '$Tag': use letters, digits, dot, underscore and hyphen only (it becomes a folder under %TEMP%)"
}

$dir = Join-Path $env:TEMP $Tag
$data = Join-Path $dir 'data'
$ext = Join-Path $dir 'ext'

if (-not (Test-Path -LiteralPath $CodeExe)) { throw "real Code.exe not found: $CodeExe" }
if (-not (Test-Path -LiteralPath $Repo)) { throw "repo not found: $Repo" }

# ---------------------------------------------------------------------------
# CRITICAL: strip the agent shell's colour/TTY markers BEFORE launching.
#
# This script is normally run from the DSH agent's shell, whose environment is
# NOT an interactive terminal. On this machine that shell carries:
#     NO_COLOR=1     TERM=dumb
# while the user's real Windows environment (User/Machine registry) defines
# NEITHER. Start-Process children inherit this process environment, so a dev
# host launched without this cleanup hands NO_COLOR=1 / TERM=dumb all the way
# down to the CLI running inside its integrated terminal - and a TUI that
# honours NO_COLOR then renders WITHOUT COLOUR.
#
# Measured symptom (2026-10-06): every dev host launched by the agent showed the
# TUI in pure greyscale (the settings screen's selection row rendered #4B4B4C
# neutral grey instead of the user's #3B4A66 blue; no saturated colour anywhere,
# while the background #191A1B and the body text #CCCCCC were byte-identical to
# the user's own window). The user's own windows, launched from their own shell,
# were always correct - which is exactly why the UAT runbook has the user run the
# launch command in cmd.exe themselves (L-013: prefer "do not launch it yourself").
#
# Unset TERM entirely rather than forcing a value: VS Code sets TERM for its own
# terminals, and a stale inherited value would shadow that.
# ---------------------------------------------------------------------------
foreach ($v in @('NO_COLOR', 'TERM', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'COLORTERM')) {
  if (Test-Path "Env:$v") { Remove-Item "Env:$v" -Force }
}
Write-Output ("env cleanup  : NO_COLOR removed={0}  TERM removed={1}" -f (-not (Test-Path 'Env:NO_COLOR')), (-not (Test-Path 'Env:TERM')))

# ---------------------------------------------------------------------------
# PIN THE EVIDENCE TO A COMMIT (L-015, after a gap the user caught).
#
# The dev host loads the extension from out/ (compiled JS), NOT from src/. Since
# every `npm test` / `npm run test:e2e` recompiles out/, a window can end up
# running code that matches no single commit: the first UAT-1/UAT-2 windows were
# launched at 34abd4c but only observed after later fixes had recompiled out/,
# so which code they exercised was undecidable. Printing these three lines into
# the UAT record removes the ambiguity - they state the commit the workspace is
# at, whether the tree is clean, and when out/ was built.
# ---------------------------------------------------------------------------
$head = (& git -C $Repo rev-parse HEAD 2>&1 | Out-String).Trim()
$dirtyLines = @(& git -C $Repo status --porcelain 2>&1 | Where-Object { $_ -ne '' })
$treeState = 'clean'
if ($dirtyLines.Count -gt 0) { $treeState = 'DIRTY (' + $dirtyLines.Count + ' entries)' }
$outJs = Join-Path $Repo 'out\extension.js'
$outTime = 'MISSING'
if (Test-Path -LiteralPath $outJs) { $outTime = (Get-Item -LiteralPath $outJs).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') }
Write-Output ("pinned commit: {0}" -f $head)
Write-Output ("worktree     : {0}" -f $treeState)
Write-Output ("out/ compiled: {0}   <- the dev host loads THIS, not src/" -f $outTime)

Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue

if ($SettingsJson -ne '') {
  $userDir = Join-Path $data 'User'
  New-Item -ItemType Directory -Force -Path $userDir | Out-Null
  Set-Content -LiteralPath (Join-Path $userDir 'settings.json') -Value $SettingsJson -Encoding UTF8
  Write-Output "seeded settings.json into $userDir"
}

Start-Process -FilePath $CodeExe -ArgumentList @(
  '--new-window',
  "--extensionDevelopmentPath=$Repo",
  '--disable-workspace-trust',
  "--user-data-dir=$data",
  "--extensions-dir=$ext",
  $Repo,
  'README.md'
)

Write-Output "launch requested: $Tag"
Write-Output "  profile : $dir"
Write-Output "  repo    : $Repo"

Start-Sleep -Seconds 12

$created = Test-Path -LiteralPath $data
$procs = @(Get-CimInstance Win32_Process -Filter "Name='Code.exe'" |
  Where-Object { $_.CommandLine -match [regex]::Escape($Tag) })

Write-Output ''
Write-Output '--- after 12s ---'
Write-Output ("profile dir created : {0}" -f $created)
Write-Output ("Code.exe procs for this profile : {0}" -f $procs.Count)
if ($procs.Count -gt 0) {
  Write-Output ("  first PID = {0}" -f $procs[0].ProcessId)
  Write-Output ("  check     : window title should contain [Extension Development Host]")
}
