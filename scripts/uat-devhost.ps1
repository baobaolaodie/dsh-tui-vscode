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
#   * Recompile out/ BEFORE the anchors are printed, so the out/ line really belongs to the
#     commit printed next to it instead of to whatever build happened to be lying around.
#   * Every argument that carries a path quotes itself: Start-Process joins -ArgumentList with
#     spaces and quotes nothing, so an unquoted path with a space is shattered into several
#     arguments before VS Code ever sees it.
#
# Nothing here is machine-specific: the repo defaults to the parent of this script's directory
# and Code.exe is resolved by parameter, environment variable or well-known install location,
# so the script runs unchanged from any checkout on any machine.
#
# Usage (from any shell, including the DSH agent shell):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/uat-devhost.ps1 -Tag my-uat-1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/uat-devhost.ps1 -Tag img-uat-2 `
#     -SettingsJson '{"terminal.integrated.enableImages": true}'
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/uat-devhost.ps1 -Tag my-uat-1 `
#     -Repo D:\other\checkout -CodeExe 'C:\Program Files\Microsoft VS Code\Code.exe'
#
# The window stays open on purpose (it is the thing under test); close it yourself when the
# UAT round is over. Re-running with the same -Tag while that window is still open is refused
# (see the guard further down) because it would wipe the profile underneath a live host.
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
  # Real VS Code installation to development-host out of. Resolution order:
  #   -CodeExe  ->  $env:DSH_UAT_CODE_EXE  ->  the well-known install locations probed below.
  # Nothing is pinned to one machine; pass -CodeExe (or set DSH_UAT_CODE_EXE) when the install
  # lives somewhere else.
  [string]$CodeExe = '',
  # Repository the dev host loads the extension from (its compiled out/). Defaults to the parent
  # of this script's own directory, i.e. the checkout the script was taken from -- pass -Repo
  # when running against another worktree.
  [string]$Repo = '',
  # Skip `npm run compile`. out/extension.js must already exist, and the out/ anchor is then NOT
  # guaranteed to come from the printed commit -- the run says so in its output.
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# VALIDATE THE TAG BEFORE ANYTHING IS DELETED.
#
# The tag becomes a directory name under %TEMP%, and the launch wipes that directory with
# -Recurse -Force. The character class alone is NOT enough: '.' and '..' match it, and
# Join-Path happily resolves them to %TEMP% itself or to its parent, so `-Tag .` used to wipe
# %TEMP% (and `-Tag ..` the directory above it) with no error at all -- reproduced by pointing
# $env:TEMP at a sandbox full of sentinel files and watching all of it disappear. Hence the
# explicit rejections ('.', '..', and the dot-trimmed aliases) plus the resolved-path assertion
# below, all of which run before the first Remove-Item.
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Tag)) {
  throw "invalid -Tag '$Tag': empty; the tag is used as a directory name under %TEMP%"
}
if ($Tag -notmatch '^[A-Za-z0-9._-]+$') {
  throw "invalid -Tag '$Tag': use letters, digits, dot, underscore and hyphen only (the tag is used as a directory name under %TEMP%)"
}
if ($Tag -eq '.' -or $Tag -eq '..') {
  throw "invalid -Tag '$Tag': '.' and '..' are relative path segments, not directory names; the tag is used as a directory name under %TEMP%, and accepting them would delete %TEMP% itself or its parent"
}
# Same class, same blast radius, one step further out: Win32 drops trailing dots from a path
# segment, so 'foo.' names the directory 'foo' -- and '...' names %TEMP% itself even though
# .NET's GetFullPath keeps the dots (so the parent assertion below cannot see it). Measured
# on 2026-10-06 with a sentinel tree in %TEMP%: `-Tag ...` passed the assertion and wiped
# %TEMP%'s contents, which is why the rejection is explicit for the dot-trimmed aliases too.
if ($Tag.EndsWith('.')) {
  throw "invalid -Tag '$Tag': Win32 strips trailing dots from a path segment, so '$Tag' names the same directory as its dot-trimmed form (for '...' that is %TEMP% itself); the tag is used as a directory name under %TEMP%, and this script deletes that directory recursively"
}
if ([string]::IsNullOrWhiteSpace($env:TEMP)) {
  throw '$env:TEMP is empty: the isolated profile lives under %TEMP% and there is nowhere to put it'
}

# Normalise both sides before comparing: $env:TEMP can arrive with a trailing separator or in
# short (8.3) form, and the assertion below must compare like with like.
$tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
$dir = [IO.Path]::GetFullPath((Join-Path $tempRoot $Tag))
if ([IO.Path]::GetDirectoryName($dir) -ne $tempRoot) {
  throw "refusing to use -Tag '$Tag': it resolves to '$dir', which is not a direct child of '$tempRoot'; the tag is used as a directory name under %TEMP%, and this script deletes that directory recursively"
}
$data = Join-Path $dir 'data'
$ext = Join-Path $dir 'ext'

# ---------------------------------------------------------------------------
# Resolve the repo and the VS Code install without depending on one machine's layout.
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Repo)) { $Repo = Split-Path -Parent $PSScriptRoot }
$Repo = [IO.Path]::GetFullPath($Repo)
if (-not (Test-Path -LiteralPath $Repo -PathType Container)) {
  throw "repo not found: $Repo (expected the checkout that contains this script's scripts/ directory; pass -Repo)"
}
if (-not (Test-Path -LiteralPath (Join-Path $Repo 'package.json') -PathType Leaf)) {
  throw "repo not found: '$Repo' has no package.json; pass -Repo <path to the dsh-tui-vscode checkout>"
}

$codeCandidates = @()
if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  $codeCandidates += (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe')
}
$codeCandidates += 'C:\Program Files\Microsoft VS Code\Code.exe'
$codeCandidates += 'E:\Microsoft VS Code\Code.exe'

if (-not [string]::IsNullOrWhiteSpace($CodeExe)) {
  $codeSource = '-CodeExe parameter'
} elseif (-not [string]::IsNullOrWhiteSpace($env:DSH_UAT_CODE_EXE)) {
  $CodeExe = $env:DSH_UAT_CODE_EXE
  $codeSource = 'env DSH_UAT_CODE_EXE'
} else {
  $codeSource = 'probed install location'
  foreach ($candidate in $codeCandidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $CodeExe = $candidate; break }
  }
}
if ([string]::IsNullOrWhiteSpace($CodeExe)) {
  throw ("real Code.exe not found; pass -CodeExe <path to Code.exe> or set DSH_UAT_CODE_EXE. Probed: " + ($codeCandidates -join '; '))
}
if (-not (Test-Path -LiteralPath $CodeExe -PathType Leaf)) { throw "real Code.exe not found: $CodeExe" }

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
# BUILD BEFORE PINNING THE EVIDENCE (L-015's other half).
#
# The dev host loads the extension from out/ (compiled JS), NOT from src/. Printing the
# commit without rebuilding made the anchors a half-truth: a window could be launched on an
# out/ left behind by an older commit (a previous checkout, an interrupted build, a stale
# `npm test`), and the "out/ compiled" timestamp was the only hint -- no build, no error. So
# out/ is rebuilt from the current worktree first, and a build failure or a missing bundle
# stops the launch instead of pinning evidence to code the window never loaded.
# ---------------------------------------------------------------------------
$outJs = Join-Path $Repo 'out\extension.js'
if ($SkipBuild) {
  if (-not (Test-Path -LiteralPath $outJs -PathType Leaf)) {
    throw "-SkipBuild was given but '$outJs' does not exist; run 'npm run compile' in $Repo first"
  }
  Write-Output 'build        : SKIPPED (-SkipBuild) -- the out/ anchor below is NOT guaranteed to come from the pinned commit'
} else {
  Write-Output ("build        : npm run compile in {0}" -f $Repo)
  $compileExit = 1
  $compileOut = ''
  $prevEap = $ErrorActionPreference
  Push-Location -LiteralPath $Repo
  try {
    # Native stderr on PowerShell 5.1 turns into ErrorRecords, which 'Stop' would promote to a
    # terminating error before the exit code could be read -- keep the redirection quiet.
    $ErrorActionPreference = 'Continue'
    $compileOut = (& npm run compile 2>&1 | Out-String)
    $compileExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
    Pop-Location
  }
  if ($compileExit -ne 0) {
    $tail = (@($compileOut -split "`r?`n" | Where-Object { $_ -ne '' }) | Select-Object -Last 15) -join "`n"
    throw "npm run compile failed in $Repo (exit $compileExit); refusing to pin UAT evidence to a build that did not happen. Tail of its output:`n$tail"
  }
  if (-not (Test-Path -LiteralPath $outJs -PathType Leaf)) {
    throw "npm run compile reported success but '$outJs' does not exist; run 'npm run compile' in $Repo and check the tsc output settings"
  }
  Write-Output 'build        : ok'
}

# ---------------------------------------------------------------------------
# PIN THE EVIDENCE TO A COMMIT (L-015, after a gap the user caught).
#
# Since every `npm test` / `npm run test:e2e` recompiles out/, a window can end up
# running code that matches no single commit: the first UAT-1/UAT-2 windows were
# launched at 34abd4c but only observed after later fixes had recompiled out/,
# so which code they exercised was undecidable. Printing these three lines into
# the UAT record removes the ambiguity - they state the commit the workspace is
# at, whether the tree is clean, and when out/ was built (which the build step
# above just made this commit's build).
# ---------------------------------------------------------------------------
$head = (& git -C $Repo rev-parse HEAD 2>&1 | Out-String).Trim()
$dirtyLines = @(& git -C $Repo status --porcelain 2>&1 | Where-Object { $_ -ne '' })
$treeState = 'clean'
if ($dirtyLines.Count -gt 0) { $treeState = 'DIRTY (' + $dirtyLines.Count + ' entries)' }
$outTime = (Get-Item -LiteralPath $outJs).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
Write-Output ("pinned commit: {0}" -f $head)
Write-Output ("worktree     : {0}" -f $treeState)
Write-Output ("out/ compiled: {0}   <- the dev host loads THIS, not src/" -f $outTime)

# ---------------------------------------------------------------------------
# ONE HOST PER TAG.
#
# The wipe below is what makes this launch reproducible, but it is also what makes a second
# launch with the same -Tag destructive: the first host is still running on that profile, and
# deleting the profile underneath it produces a window whose settings and per-window state no
# longer match what the UAT round claims to test. Refuse instead of racing.
# ---------------------------------------------------------------------------
$profileRe = '--user-data-dir=["'']?[^"'' ]*[\\/]' + [regex]::Escape($Tag) + '[\\/]'
$running = @(Get-CimInstance Win32_Process -Filter "Name='Code.exe'" |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match $profileRe -or $_.CommandLine -match [regex]::Escape($dir)) })
if ($running.Count -gt 0) {
  throw ("a dev host for tag '{0}' is already running (PID {1} uses the isolated profile '{2}'); close that window, or launch with a different -Tag -- wiping the profile now would pull it out from under a live host" -f $Tag, $running[0].ProcessId, $dir)
}

# Wipe the profile, and prove it is gone: a half-deleted profile (a file held open by a leftover
# Code.exe, an AV scanner) used to pass unnoticed and the UAT round then ran on preconditions
# nobody chose.
if (Test-Path -LiteralPath $dir) {
  try {
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop
  } catch {
    throw "failed to wipe the isolated profile '$dir': $($_.Exception.Message); close whatever holds it (or pick another -Tag) before running UAT"
  }
  if (Test-Path -LiteralPath $dir) {
    throw "isolated profile '$dir' still exists after Remove-Item; refusing to launch UAT on a profile that may still carry the previous round's settings and window state"
  }
}

if ($SettingsJson -ne '') {
  $userDir = Join-Path $data 'User'
  New-Item -ItemType Directory -Force -Path $userDir | Out-Null
  Set-Content -LiteralPath (Join-Path $userDir 'settings.json') -Value $SettingsJson -Encoding UTF8
  Write-Output "seeded settings.json into $userDir"
}

# ---------------------------------------------------------------------------
# Start-Process joins -ArgumentList with spaces and quotes nothing, so every element that
# carries a path quotes itself here: the repo path, %TEMP% and therefore the profile paths can
# all contain spaces, and an unquoted one is split into several arguments by the OS parser
# (VS Code then sees --extensionDevelopmentPath=D:\fake plus stray "repo\with" tokens). The
# constructed command line is printed below so the quoting is visible in the UAT record.
# ---------------------------------------------------------------------------
$launchArgs = @(
  '--new-window',
  ('--extensionDevelopmentPath="' + $Repo + '"'),
  '--disable-workspace-trust',
  ('--user-data-dir="' + $data + '"'),
  ('--extensions-dir="' + $ext + '"'),
  ('"' + $Repo + '"'),
  ('"' + (Join-Path $Repo 'README.md') + '"')
)
Write-Output ("launch args  : {0}" -f ($launchArgs -join ' '))
Start-Process -FilePath $CodeExe -ArgumentList $launchArgs

Write-Output "launch requested: $Tag"
Write-Output "  code exe: $CodeExe  ($codeSource)"
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
