import * as vscode from 'vscode'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { SessionsTreeProvider } from './sessions-view'
import { SessionStatusBar } from './status'
import { relativeTime } from './relative-time'
import {
  appendSessionTitle,
  deleteSessionLog,
  ensureZstd,
  resetZstd,
  setSessionArchived,
  readWorkspaceMeta,
  listSessions,
} from './sessions'
import {
  buildLaunchEnv,
  createSendOnceGate,
  detectShellKind,
  formatLaunchPath,
  formatWorkspaceTargetArg,
  normalizeTerminalImageProtocol,
  normalizeTerminalLocation,
  resolveLaunchCommand,
  resolveTerminalImageCapability,
  shouldOfferImageSetup,
  shouldShowImageSetupPrompt,
  type ImageSetupPromptMemory,
  type TerminalEnv,
  type TerminalImageProtocol,
  type TerminalImageSetupOffer,
} from './session'
import { buildAtMention, normalizeMentionPath } from './at-mention'
import {
  buildMentionForSnapshot,
  capSelectionText,
  decideAutoInsert,
  shouldBroadcastSelection,
} from './auto-mention'
import { IdeServer, selectionLineRange } from './ide/server'

const TERMINAL_NAME = 'DeepSeek'

interface Settings {
  command: string
  extraArgs: string[]
  lang: string
  imageProtocol: TerminalImageProtocol
  /** The LIVE `terminal.integrated.enableImages` value — an observation, not a capability. */
  imagesEnabledSetting: boolean
  injectEditor: boolean
  editorCommand: string
  dshHome: string
  terminalLocation: string
}

function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
  return {
    command: cfg.get<string>('command', 'dsh-tui'),
    extraArgs: cfg.get<string[]>('extraArgs', []),
    lang: cfg.get<string>('lang', ''),
    imageProtocol: normalizeTerminalImageProtocol(cfg.get<string>('imageProtocol')),
    // The LIVE value of `terminal.integrated.enableImages` (read from the other
    // configuration section). An observation, not a capability: whether this
    // window has a renderer is decided by resolveTerminalImageCapability
    // against `hostImagesAtWindowStart`, and BOTH the session env gate and the
    // one-time setup prompt go through that decision.
    imagesEnabledSetting: vscode.workspace
      .getConfiguration('terminal.integrated')
      .get<boolean>('enableImages', false),
    injectEditor: cfg.get<boolean>('injectEditor', true),
    editorCommand: cfg.get<string>('editorCommand', 'code -w'),
    dshHome: cfg.get<string>('dshHome', ''),
    terminalLocation: cfg.get<string>('terminalLocation', 'editor'),
  }
}

export interface ExtensionApi {
  /** Send raw input into the dsh-tui terminal (used by tests/scripts). */
  sendInput(text: string): void
  /** True while a dsh-tui terminal exists. */
  hasTerminal(): boolean
  /**
   * E2E seam (test-only): write the persistent "image setup prompt already
   * shown" marker directly.
   *
   * Both image hosts launch against a wiped `--user-data-dir`
   * (`src/test-suite/run-tests.ts`), so the cross-window half of the prompt
   * dedupe — a globalState entry left behind by an EARLIER window — cannot be
   * produced from the test host any other way. REVIEW M-2 is a defect in
   * exactly that state (a profile that was already prompted), so the suite has
   * to be able to reach it.
   */
  seedImageSetupPrompted(shown: boolean): Thenable<void>
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  // ---- Window-start snapshot of terminal image rendering -------------------
  // VS Code loads its image addon while the window builds the renderer, so
  // `terminal.integrated.enableImages` only takes effect after a window reload:
  // a value written later in this window stays inert. Snapshot the setting once,
  // here at window start, so every gate in this window — the session env AND the
  // one-time prompt — is judged on what was actually effective when the window
  // started, never on a value someone just wrote (REVIEW F-3: trusting the live
  // value blanks the image slots and suppresses the prompt forever). A reload
  // restarts this extension host, so activate() then reads the new value.
  const hostImagesAtWindowStart = vscode.workspace
    .getConfiguration('terminal.integrated')
    .get<boolean>('enableImages', false)
  // The other half of the same window-lifetime fact: WHICH renderer this window
  // built. VS Code's own definition of `terminal.integrated.enableImages` gates
  // images on `terminal.integrated.gpuAcceleration`, and the image addon is only
  // attached to the WebGL renderer — `off`/`canvas` therefore mean "no addon at
  // all", where injecting `sixel` would blank the image slots just like an
  // unreloaded write does (Sourcery ①). Snapshotted next to the snapshot above,
  // never re-read: the renderer is built with the window, and only a reload
  // (which restarts this extension host) can change it. `auto`/`on` are the
  // "possibly WebGL" values; see resolveTerminalImageCapability for the residual
  // risk this proxy cannot cover.
  const gpuAccelerationAtWindowStart = vscode.workspace
    .getConfiguration('terminal.integrated')
    .get<string>('gpuAcceleration')

  const status = new SessionStatusBar()
  context.subscriptions.push(status)

  // The sidebar (activity bar) hosts the SESSION LIST, shaped like the
  // official Claude Code sessions sidebar. The session itself runs in a REAL
  // VS Code integrated terminal (default shell — PowerShell on Windows),
  // exactly like the official extension: createTerminal({ name, location:
  // Editor/Beside by default — configurable, env, isTransient }) + run the
  // CLI inside it.
  const sessionsTree = new SessionsTreeProvider()
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dsh-tui-vscode.sessions', sessionsTree),
    sessionsTree,
  )
  sessionsTree.startWatching(readSettings().dshHome)
  // Re-point the tree (and the commands that resolve through it) when the
  // configured DSH home changes: without this, a live config change would keep
  // listing the old home while delete/archive still resolved against it.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('dsh-tui-vscode.dshHome')) return
      sessionsTree.startWatching(readSettings().dshHome)
      sessionsTree.refresh()
    }),
  )

  function hasTerminal(): boolean {
    return vscode.window.terminals.some(t => t.name === TERMINAL_NAME)
  }
  /** The most recently created DeepSeek terminal, if any. */
  const findTerminal = (): vscode.Terminal | undefined =>
    [...vscode.window.terminals].reverse().find(t => t.name === TERMINAL_NAME)

  const refreshState = (): void => status.update(hasTerminal())
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => refreshState()),
    vscode.window.onDidCloseTerminal(() => refreshState()),
    // The sidebar shows only the CURRENT workspace's sessions — re-filter
    // when the user opens/closes/switches workspace folders.
    vscode.workspace.onDidChangeWorkspaceFolders(() => sessionsTree.refresh()),
  )

  // `cfg` is the snapshot the caller read ONCE for this launch (REVIEW F-8):
  // reading the configuration again in here would let the env gate and the
  // session-start prompt judge two different snapshots of the same launch.
  /**
   * Build the terminal env overlay for one launch from the caller's settings
   * snapshot. The image-protocol gate is resolved HERE rather than at each call
   * site so the sessions and the prompt of a single launch can never disagree,
   * and `extra` (the IDE channel pair, resume ids) stays the last writer — see
   * `buildLaunchEnv` for the merge order. The returned overlay carries VS Code's
   * `null`-deletes-the-variable marker for the `auto` tier (Sourcery ②).
   */
  function buildEnv(cfg: Settings, extra: Record<string, string> = {}): TerminalEnv {
    // The env gate takes the CAPABILITY, not the raw setting: a value written
    // after this window started has no renderer behind it, and asking dsh-tui
    // for sixel without one blanks the image slots (US-3).
    const imageCapability = resolveTerminalImageCapability(
      hostImagesAtWindowStart,
      cfg.imagesEnabledSetting,
      gpuAccelerationAtWindowStart,
    )
    return {
      ...buildLaunchEnv({
        base: process.env,
        lang: cfg.lang,
        imageProtocol: cfg.imageProtocol,
        hostImagesEnabled: imageCapability.hostImagesEnabled,
        injectEditor: cfg.injectEditor,
        editorCommand: cfg.editorCommand,
        dshHome: cfg.dshHome,
      }),
      ...extra,
    }
  }

  // ---- IDE selection channel --------------------------------------------
  // The extension hosts the loopback WS server the TUI connects to (env
  // direct via terminal env, or lock scan). Startup failure degrades
  // silently — every other feature keeps working without it.
  const ideServer = new IdeServer({
    token: randomBytes(16).toString('hex'),
    workspaceFolders: () =>
      (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
  })
  // 记录启动 promise：start() 是异步的。若扩展在它落定前就停用，stop() 会因为
  // 内部 wss 仍为 null 而直接返回，随后 listen 成功的那一次再也没有人接管
  // （server 泄漏 + env 被 start 重新写回）。dispose 因此等它落定再停。
  const ideServerStartup = ideServer.start().catch(error => {
    // Silent degradation with a log line only: the rest of the extension
    // is unaffected when the server cannot bind.
    console.error('[dsh-tui-vscode] IDE selection channel failed to start:', error)
  })
  context.subscriptions.push({
    dispose: () => {
      // Deactivate must clear the lock file so stale locks never accumulate.
      // 先同步停一次：清锁就在 stop() 的同步段里，而 dispose 之后宿主可能
      // 立刻退出、不保证排空 microtask 队列。start 尚未落定时这次是 no-op，
      // 落定后的第二次 stop() 才是真正收尾。
      void ideServer.stop()
      void ideServerStartup.then(() => ideServer.stop())
    },
  })

  /** Terminal env pair for the IDE channel ({} while the server is down). */
  const ideEnvPairs = (): Record<string, string> => ideServer.envForTerminal()

  /** Push one selection snapshot to connected dsh-tui sessions. */
  const broadcastSelection = (
    selection: {
      path: string
      startLine: number
      endLine: number
      isEmpty: boolean
      text: string
      documentVersion: number
    },
  ): boolean => ideServer.broadcastSelection(selection)

  /**
   * Open the session terminal: fixed name/icon, the workspace root as cwd, the
   * configured placement, and the env overlay from `buildEnv` — whose `null`
   * values VS Code turns into deletions from the inherited environment
   * (Sourcery ②), which is what makes the `auto` image-protocol tier work.
   */
  function createTerminal(cfg: Settings, env: TerminalEnv): vscode.Terminal {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir()
    // Placement is configurable (dsh-tui-vscode.terminalLocation), taken from
    // the snapshot read once per launch (REVIEW F-8) so a settings change still
    // applies to the next session immediately:
    // 'editor' keeps the historical default — a NEW column beside the
    // active one (ViewColumn.Beside), never taking over the user's current
    // column; 'active' reuses the current column; 'panel' parks the session
    // in the bottom panel next to ordinary terminals.
    const kind = normalizeTerminalLocation(cfg.terminalLocation)
    const location: vscode.TerminalOptions['location'] =
      kind === 'panel'
        ? vscode.TerminalLocation.Panel
        : { viewColumn: kind === 'active' ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside }
    return vscode.window.createTerminal({
      name: TERMINAL_NAME,
      cwd,
      env,
      iconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg'),
      location,
      isTransient: true,
    })
  }

  /** Wait until the shell is ready to accept input (shell integration or a
   *  conservative fallback), then run the command exactly once. The race
   *  semantics live on createSendOnceGate in session.ts — pure and
   *  unit-tested there; here we only wire real timers/events onto it. */
  function sendTextWhenReady(terminal: vscode.Terminal, command: string): void {
    const gate = createSendOnceGate(() => {
      try {
        terminal.sendText(command, true)
      } catch {
        // terminal already closed
      }
    })
    const fallback = setTimeout(() => gate.trySend(), 1200)
    const listener = vscode.window.onDidChangeTerminalShellIntegration(event => {
      if (event.terminal !== terminal) return
      clearTimeout(fallback)
      listener.dispose()
      gate.trySend()
    })
    // Safety: drop the listener if shell integration never arrives.
    setTimeout(() => listener.dispose(), 15000)
  }

  // ---- Terminal-images setup prompt ---------------------------------------
  // The extension never edits the user's VS Code settings on its own: the
  // enable prompt is the ONLY path that calls update(), and only after an
  // explicit click (DESIGN D3, AC-5). It fires on the user-initiated
  // session-start paths only — never from activate(), where the extension may
  // just have been auto-started without the user wanting a session (DESIGN D5)
  // — and at most once until the user answers, tracked in globalState so a
  // window reload keeps the answer (DESIGN D4).
  //
  // Its `reloadWindow` sibling is deliberately NOT one-shot: it explains a state
  // THIS window is in, which a cross-window globalState entry cannot answer for.
  // See promptForImageSetup (REVIEW M-2).
  const IMAGE_SETUP_PROMPTED_KEY = 'dsh-tui-vscode.imageSetupPrompted'
  // What THIS window remembers about the prompt: globalState.update() is async,
  // two quick starts must not race into two notifications, and — after a failed
  // settings write — the window's own state has to outrank the persisted marker
  // the failure path may not have managed to clear (Sourcery ⑥). See
  // shouldShowImageSetupPrompt for the full truth table.
  let imageSetupPromptMemory: ImageSetupPromptMemory = 'idle'

  /**
   * Reopen the prompt so a later session start tries again (DESIGN R1) — the ONE
   * deliberate exception to AC-5's one-shot prompt, tracked as REVIEW F-4: it
   * opens only after a settings write FAILED (rejected, or defeated by a
   * higher-priority override — Sourcery ③), i.e. while the user asked to enable
   * images and is still unserved. Every outcome a user can actually choose — the
   * enable click, "Not Now", dismissing the notification — stays one-shot for
   * the life of the globalState entry. Dropping the retry instead would strand
   * the user on the manual path with no way back to the one-click route.
   *
   * The in-window state is set to `retry` FIRST and deliberately not derived
   * from the persisted marker: clearing that marker is fire-and-forget and may
   * be delayed or rejected, and letting the stale entry decide would silence the
   * very retry this call promises (Sourcery ⑥).
   */
  function resetImageSetupPrompt(): void {
    imageSetupPromptMemory = 'retry'
    // The rejection must be observed (REVIEW F-9): this very write is what
    // makes the next session start retry, so failing silently would break the
    // promise it carries. `.then(undefined, …)` rather than `.catch(…)`: the
    // API returns VS Code's Thenable<void>, which only exposes `then`.
    void context.globalState.update(IMAGE_SETUP_PROMPTED_KEY, undefined).then(undefined, error => {
      console.error('[dsh-tui-vscode] could not reset the image setup prompt:', error)
    })
  }

  /**
   * Remember that the image-setup prompt was shown — in memory for the rest of
   * this window (two quick starts must not race into two notifications, since
   * `globalState.update()` is async) and in globalState for every later window.
   *
   * Called BEFORE the notification is awaited, and deliberately not awaited
   * here: bookkeeping must never cost the user the notification it accompanies.
   * The reload explanation in particular is the only thing standing between a
   * user and unexplained block characters (REVIEW M-2), so a failed marker
   * write must not swallow it. The rejection is observed rather than fatal,
   * with the same `.then(undefined, …)` shape as `resetImageSetupPrompt` (the
   * API returns VS Code's Thenable<void>, which only exposes `then`); a lost
   * marker only means "may be asked once more in a later window".
   */
  function markImageSetupPrompted(): void {
    imageSetupPromptMemory = 'asked'
    void context.globalState.update(IMAGE_SETUP_PROMPTED_KEY, true).then(undefined, error => {
      console.error('[dsh-tui-vscode] could not record the image setup prompt:', error)
    })
  }

  /**
   * The one and only settings write in this extension. Resolves false when VS
   * Code rejects it (restricted setting / untrusted workspace) so the caller can
   * hand over the manual path instead.
   *
   * The resolved `update()` promise is NOT the verdict (Sourcery ③):
   * `terminal.integrated.enableImages` has window scope, so a workspace or
   * folder override outranks the Global value this write sets and the write can
   * succeed while the EFFECTIVE setting stays `false`. Reporting success there
   * would offer a reload that cannot help, mark the one-time prompt as answered
   * and leave images disabled with no further offer — so the effective value is
   * read back, and anything but `true` takes the same failure path as a rejected
   * write.
   */
  async function enableHostImages(): Promise<boolean> {
    const images = vscode.workspace.getConfiguration('terminal.integrated')
    try {
      await images.update('enableImages', true, vscode.ConfigurationTarget.Global)
      // Read the effective value: a higher-priority override keeps it false, and
      // this call is deliberately on the same (uncached) configuration object
      // the update resolved on, so it observes the write that just landed.
      return images.get<boolean>('enableImages', false) === true
    } catch (error) {
      // Nothing was written — the caller must not pretend otherwise.
      console.error('[dsh-tui-vscode] could not enable terminal image rendering:', error)
      return false
    }
  }

  /**
   * Ask for the reload that makes an already-written `enableImages` take
   * effect. Shared by both paths that reach this state: the click that just
   * wrote the setting (see applyImageSetupChoice) and a value written outside
   * the extension (settings.json / settings sync) that this window has not
   * loaded yet.
   */
  async function offerWindowReload(): Promise<void> {
    const reloadAction = vscode.l10n.t('Reload Window')
    const reload = await vscode.window.showInformationMessage(
      vscode.l10n.t('Image rendering is enabled, but the setting takes effect only after a window reload. Reloading closes all running dsh-tui terminals; their sessions stay in the sidebar and can be resumed.'),
      reloadAction,
    )
    if (reload === reloadAction) {
      void vscode.commands.executeCommand('workbench.action.reloadWindow')
    }
  }

  /**
   * Act on the user's explicit "enable" click. The only caller is the prompt
   * branch below, which is what keeps `enableHostImages` the sole write path.
   *
   * A false verdict — a rejected write, or a write a higher-priority override
   * defeats (Sourcery ③) — shows the copyable manual instructions and forgets
   * the prompt so the next session start may retry; only a write that really
   * took effect goes on to ask for the reload it needs.
   */
  async function applyImageSetupChoice(): Promise<void> {
    if (!(await enableHostImages())) {
      // Hand over the copyable manual path and forget the prompt, so the next
      // session start may try the one-click route again (DESIGN R1).
      resetImageSetupPrompt()
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Could not enable terminal image rendering automatically. Set terminal.integrated.enableImages to true in Settings and reload the window. Reloading closes all running dsh-tui terminals; without a reload the setting does not take effect.'),
      )
      return
    }
    // Enabled, but the addon loads with the renderer — a reload is required,
    // and it closes the running terminals. Say so before offering the action.
    // NOTE: `hostImagesAtWindowStart` is deliberately NOT refreshed here — this
    // window still has no renderer, so it keeps injecting `none` (F-3) until the
    // reload that restarts this extension host and re-reads the snapshot.
    await offerWindowReload()
  }

  async function promptForImageSetup(offer: TerminalImageSetupOffer | undefined): Promise<void> {
    // No offer means this window's snapshot was already true: nothing to fix.
    if (!offer) return
    if (offer === 'reloadWindow') {
      // The setting is already on, but it was written inside this window and
      // never reloaded into a renderer. There is nothing to write and nothing
      // to ask permission for — say what is missing instead (the old gate
      // returned silently here, which is REVIEW F-3's second dead path).
      //
      // The one-shot dedupe below must NOT gate this branch (REVIEW M-2). What
      // it explains is a state THIS WINDOW is in, not a favour to ask for once
      // per profile: the enable prompt's marker is written on the first prompt
      // (any answer, including a dismissed notification) and globalState
      // outlives the window, so gating here would leave every already-prompted
      // profile — including one whose settings.json the user edited by hand —
      // staring at block characters with no explanation, forever. Marking still
      // happens, so the enable prompt stays one-shot for this profile.
      markImageSetupPrompted()
      await offerWindowReload()
      return
    }
    // One-shot gate: this window's own memory first — `asked` wins outright,
    // and `retry` (armed by a failed write) wins over the persisted marker the
    // failure path may not have cleared (Sourcery ⑥) — then the cross-window
    // marker, which only decides for a window that has not asked yet.
    if (
      !shouldShowImageSetupPrompt(
        imageSetupPromptMemory,
        context.globalState.get<boolean>(IMAGE_SETUP_PROMPTED_KEY),
      )
    ) {
      return
    }
    // Mark as shown BEFORE awaiting the notification: the user must be asked
    // exactly once, whether they answer it, dismiss it, or start another
    // session while it is still on screen.
    markImageSetupPrompted()
    const enableAction = vscode.l10n.t('Enable and Reload Window')
    const answer = await vscode.window.showInformationMessage(
      vscode.l10n.t('Terminal images need VS Code image rendering, but terminal.integrated.enableImages is off, so dsh-tui shows block characters instead of real images. The setting takes effect only after a window reload, and reloading closes running dsh-tui terminals.'),
      enableAction,
      vscode.l10n.t('Not Now'),
    )
    // "Not Now" — or a dismissed notification: stay prompted, never ask again.
    if (answer !== enableAction) return
    await applyImageSetupChoice()
  }

  /**
   * Start (or resume) a dsh-tui session: read the settings ONCE for this launch
   * (REVIEW F-8), offer the image setup while it is still both possible and
   * wanted, then create the terminal and hand the launch command to the
   * send-once gate. The offer is deliberately fire-and-forget: DESIGN D5 keeps
   * that side quest from ever affecting the launch itself.
   */
  function runCommand(resume: boolean, resumeSession?: string): void {
    const cfg = readSettings()
    // DESIGN D5: offer the terminal-images setup on session start, and never
    // let that side quest affect the launch itself. The offer comes from the
    // window-start capability snapshot, so a write this window has not reloaded
    // into asks for the reload instead of going silent (F-3). An explicit
    // `imageProtocol: none` then suppresses it: asking a user who chose
    // character art to enable images is pointless, and it would consume the
    // one-time marker for a prompt they never wanted (Sourcery ⑤).
    const imageCapability = resolveTerminalImageCapability(
      hostImagesAtWindowStart,
      cfg.imagesEnabledSetting,
      gpuAccelerationAtWindowStart,
    )
    void promptForImageSetup(
      shouldOfferImageSetup(cfg.imageProtocol, imageCapability.offer),
    ).catch(error =>
      console.error('[dsh-tui-vscode] image setup prompt failed:', error),
    )
    const isWindows = process.platform === 'win32'
    const shellKind = detectShellKind(vscode.env.shell)
    const command = cfg.command.trim() || 'dsh-tui'
    // Resolve against the HOST PATH: the terminal shell's PATH may differ
    // (login shells rebuild it) — verified on Linux CI. The shell kind also
    // tells us whether a Windows path must be converted for Git Bash/WSL.
    const resolved = resolveLaunchCommand(command, isWindows, shellKind)
    const parts = [formatLaunchPath(resolved ?? command, shellKind, isWindows)]
    for (const arg of cfg.extraArgs) parts.push(arg)
    // Missing-@mention fix: pin the session cwd to THIS workspace
    // root via a trailing positional arg — the launcher turns it into
    // DSH_TUI_WORKSPACE_TARGET and the TUI resolves it as its workspace, so
    // the session's relativization baseline matches ours exactly. Same source
    // as createTerminal's cwd: one truth for both.
    const targetArg = formatWorkspaceTargetArg(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      shellKind,
    )

    const existing = findTerminal()
    if (resumeSession) {
      // Resume a SPECIFIC session: the profile's cordis.patch.yml reads
      // DSH_TUI_RESUME_SESSION at boot — feed it through the terminal env
      // and run WITHOUT --resume (the launcher's --resume handler would
      // overwrite the env from ~/.dsh-tui/resume.txt).
      const env = buildEnv(cfg, {
        DSH_TUI_RESUME_SESSION: resumeSession,
        DSH_CC_RESUME_SESSION: resumeSession,
        ...ideEnvPairs(),
      })
      const terminal = createTerminal(cfg, env)
      terminal.show()
      sendTextWhenReady(terminal, parts.join(' ') + targetArg)
      return
    }
    if (resume) {
      // Resume the LAST session: --resume reads ~/.dsh-tui/resume.txt.
      parts.push('--resume')
      const terminal = createTerminal(cfg, buildEnv(cfg, ideEnvPairs()))
      terminal.show()
      sendTextWhenReady(terminal, parts.join(' ') + targetArg)
      return
    }
    // Multiple concurrent sessions (like Claude Code): every click opens a
    // NEW terminal+session; existing sessions keep running in their own
    // terminals. `existing` is intentionally unused here.
    void existing
    const terminal = createTerminal(cfg, buildEnv(cfg, ideEnvPairs()))
    terminal.show()
    sendTextWhenReady(terminal, parts.join(' ') + targetArg)
  }

  const register = (id: string, fn: (...args: unknown[]) => void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  }
  register('dsh-tui-vscode.open', () => runCommand(false))
  register('dsh-tui-vscode.start', () => runCommand(false))
  register('dsh-tui-vscode.resume', () => runCommand(true))
  register('dsh-tui-vscode.focus', () => {
    const terminal = findTerminal()
    if (terminal) {
      terminal.show()
    } else {
      runCommand(false)
    }
  })
  register('dsh-tui-vscode.kill', () => {
    const terminal = findTerminal()
    if (terminal) {
      // Ctrl+C, like interrupting Claude Code with a keyboard interrupt.
      terminal.sendText('\u0003', false)
    }
  })
  // 以 Claude Code 官方 insertAtMention 为基准,做 dsh-tui 适配:把当前文件/
  // 选中代码以 `@相对路径#L起-止` 形式插入输入框。dsh-TUI 的 @ 提及原生
  // 解析 `#L` 行区间(1-based、含端点);相对路径以「会话自己的 cwd」为基准,
  // 而本扩展启动的终端 cwd 即工作区根(createTerminal 同款取法),所以传
  // workspaceRoot 把路径相对化——消息更短且与会话 cwd 无关性等价;根外或无
  // 工作区时兜底正斜杠绝对路径(dsh-tui 对绝对路径原样直通)。行区间为空格
  // 分隔纯文本的旧形态已按上游新语法移除。
  register('dsh-tui-vscode.insertAtMention', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Focus an editor first, then insert an @file reference'),
      )
      return
    }
    const mentionPath = normalizeMentionPath(editor.document.uri.fsPath)
    const selection = editor.selection
    const mention = buildAtMention(
      mentionPath,
      {
        isEmpty: selection.isEmpty,
        ...selectionLineRange(selection),
      },
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    )
    const terminal = findTerminal()
    if (terminal) {
      // 插入输入框而不自动提交:用户可继续补问题,回车后 dsh-tui 会把
      // @ 引用文件的内容附到消息中。
      terminal.show()
      terminal.sendText(mention, false)
      return
    }
    // 无运行中的 dsh-tui 会话:回退为复制到剪贴板(未投递时的回退路径)。
    await vscode.env.clipboard.writeText(mention)
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Copied {0}. Paste it into the dsh-tui input box', mention),
    )
  })
  // 选区变化自动引用(默认开,对齐官方 Claude Code 的选区体验):官方语义是
  // 「编辑器选区实时出现在会话引用」——本扩展经 IDE 选区通道(ide/server.ts)
  // 把选区坐标**与编辑器缓冲区自己的选区文本**(含未保存修改,协议 v2)推送给
  // 运行中的 dsh-tui(其提交时原样附加该文本并在 footer 实时显示 ⧉ 徽标;
  // server 回退路径仍按坐标读盘——协议 v2 的 selection_changed 消费)。
  // server 缺席(启动失败/旧版 dsh-tui)时回退旧的敲字近似:把
  // `@相对路径#L起-止` 键入运行中的输入框(workspaceRoot 同 insertAtMention:
  // 根内相对化,根外兜底绝对)。也因此必须:仅在有运行中会话时注入、
  // 对同一选区去重,避免抢占输入框/刷屏。推送分支无此副作用——不碰输入框。
  // 监听器始终注册,回调内实时读配置(用户/E2E 改配置立即生效,无 attach
  // 时序依赖 —— 也避免了「改配置后监听器未挂上」的竞态)。
  {
    let lastInserted: string | undefined
    let postpone: ReturnType<typeof setTimeout> | undefined
    const isEnabled = (): boolean =>
      vscode.workspace
        .getConfiguration('dsh-tui-vscode')
        .get<boolean>('autoInsertMention', true)
    context.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(event => {
        if (!isEnabled()) return
        const editor = event.textEditor
        // 非文件 scheme(终端输出、diff 等)不注入;不等同于必须有
        // activeTextEditor —— 官方实现同样不要求 active,程序化/焦点切换
        // 时事件仍应工作(且后台编辑器选区通常不会变化,误触发风险低)。
        if (editor.document.uri.scheme !== 'file') return
        const selection = editor.selection
        // 行区间归一化一次,下面三处消费(清空广播/自动引用快照/通道推送)共用:
        // 整行选区的 VS Code end.line 是「末覆盖行 + 1」,协议按含端消费。
        const range = selectionLineRange(selection)
        // 清空选区(点一下/取消划行):广播 isEmpty 让 TUI 清掉 footer 徽标并
        // 停止本次选区附加——否则 TUI 的 selection 快照永不被清,徽标残留、
        // 再发消息仍带上旧选区索引(曾经静默失效的契约,autoInsertMention
        // 默认开后暴露)。走同一 300ms 防抖(拖选中间态收敛为最终值);
        // 无文本可敲所以不回退 sendText;server 缺席时静默(无可达听众)。
        if (selection.isEmpty) {
          if (postpone !== undefined) clearTimeout(postpone)
          postpone = setTimeout(() => {
            void broadcastSelection({
              path: normalizeMentionPath(editor.document.uri.fsPath),
              startLine: range.startLine,
              endLine: range.endLine,
              isEmpty: true,
              text: '',
              documentVersion: editor.document.version,
            })
            lastInserted = undefined
          }, 300)
          return
        }
        const snapshot = {
          path: editor.document.uri.fsPath,
          startLine: range.startLine,
          endLine: range.endLine,
        }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        // 引用原文自己算一次(与 decideAutoInsert 内部同一个纯函数):推送分支
        // 也可能在「重复」状态下发生,那时 outcome 里没有 mention 可用。
        const mention = buildMentionForSnapshot(snapshot, workspaceRoot)
        const outcome = decideAutoInsert({
          enabled: true,
          hasSelection: !selection.isEmpty,
          hasTerminal: hasTerminal(),
          snapshot,
          lastInserted,
          workspaceRoot,
        })
        // 「与上次相同」只该挡住往输入框敲字那条回退:通道推送是幂等的状态更新,
        // 不占输入框也不会刷屏。用它挡推送会让两次行区间相同、正文不同的手势
        // (整行选区按含端归一化后很常见:先拖到 (7,1) 再拖成整行)停在旧正文上
        // ——TUI 侧徽标/指示行按行数看不出差别,模型收到的却是上一次的内容。
        if (!shouldBroadcastSelection(outcome)) return
        // 300ms 防抖:连续拖选/多点只收敛为最后一次(复用 postpone 先例)。
        if (postpone !== undefined) clearTimeout(postpone)
        postpone = setTimeout(() => {
          // 首选:IDE 通道推送(不占输入框;server 未起则 false 回退)。
          // path 是纯文件路径(正斜杠归一化),坐标 0-based —— 协议契约;
          // 协议 v2 同时携带编辑器缓冲区自己的选区文本(含未保存修改),
          // TUI 端原样附加,不再从磁盘读可能与屏幕不一致的旧版本。
          if (
            broadcastSelection({
              path: normalizeMentionPath(editor.document.uri.fsPath),
              startLine: range.startLine,
              endLine: range.endLine,
              isEmpty: false,
              // 封顶：不让无上限的编辑器缓冲区内容整段推出去。**这不是断链
              // 防线**——实测 2MB 的帧仍能完整抵达（ws 默认上限 100 MiB）。
              // 取值依据与边界见 auto-mention.ts 的 MAX_PUSHED_SELECTION_CHARS。
              text: capSelectionText(editor.document.getText(selection)),
              documentVersion: editor.document.version,
            })
          ) {
            lastInserted = mention
            return
          }
          // 回退:旧行为——键入运行中的 dsh-tui 输入框。只有 insert 才值得敲:
          // duplicate(与上次相同)与 no-terminal(手动启动的会话没有扩展终端)
          // 都只该挡住这条回退,推送已在上面成功或此处被 action 收口。
          if (outcome.action !== 'insert') return
          const terminal = findTerminal()
          if (!terminal) return
          terminal.show()
          terminal.sendText(mention, false)
          lastInserted = mention
        }, 300)
      }),
      {
        dispose: () => {
          if (postpone !== undefined) clearTimeout(postpone)
        },
      },
    )
    // 配置由开→关时补推一次 isEmpty(issue #21 第 2 条)。TUI 只在收到 isEmpty
    // 时清掉选区快照——实测(两端真实实现联调):停止推送但连接仍在(禁用配置的
    // 真实语义)时,快照会残留,并附加到下一次提交。监听配置变化而不是在选区
    // 事件里判断:用户禁用后可能不再动编辑器,那条路径永远不会触发。
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('dsh-tui-vscode.autoInsertMention')) return
        if (isEnabled()) return
        // 先撤掉已排定的推送：否则「选区变化 → 300ms 内禁用」时，那颗定时器
        // 会补推一帧**非空**选区，刚清掉的快照又被装回 TUI（CodeRabbit 与独立
        // 审查各自指出同一处）。
        if (postpone !== undefined) {
          clearTimeout(postpone)
          postpone = undefined
        }
        // TUI 在 isEmpty 时不渲染 path,但协议要求它非空(parseSelectionChanged
        // 丢弃空 path 的帧),所以没有活动编辑器时给一个明确的占位。
        const path =
          vscode.window.activeTextEditor?.document.uri.fsPath ?? '(autoInsertMention disabled)'
        void broadcastSelection({
          path: normalizeMentionPath(path),
          startLine: 0,
          endLine: 0,
          isEmpty: true,
          text: '',
          documentVersion: 0,
        })
      }),
    )
  }
  register('dsh-tui-vscode.refreshSessions', () => {
    sessionsTree.refresh()
  })
  register('dsh-tui-vscode.resumeSession', (sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) return
    runCommand(true, sessionId)
  })
  /**
   * Session identity from a view/item/context command argument. Verified
   * against real VS Code clicks: the argument is the provider's ELEMENT
   * (the SessionRecord itself — id + file), not the rendered TreeItem.
   * TreeItem shapes (id/resourceUri, custom sessionId/sessionFile) are kept
   * as fallbacks for other VS Code versions.
   */
  const sessionIdentity = (item: unknown): { id: string; file: string } | undefined => {
    const it = item as
      | {
          id?: unknown
          file?: unknown
          resourceUri?: { fsPath?: unknown }
          sessionId?: unknown
          sessionFile?: unknown
        }
      | undefined
    if (!it) return undefined
    const id =
      typeof it.sessionId === 'string' ? it.sessionId : typeof it.id === 'string' ? it.id : undefined
    const file =
      typeof it.sessionFile === 'string'
        ? it.sessionFile
        : typeof it.file === 'string' // SessionRecord shape (real VS Code passes this)
          ? it.file
          : typeof it.resourceUri?.fsPath === 'string'
            ? it.resourceUri.fsPath
            : undefined
    return id !== undefined && file !== undefined ? { id, file } : undefined
  }

  register('dsh-tui-vscode.renameSession', async (item: unknown) => {
    const session = sessionIdentity(item)
    if (!session) return
    // The command may run before any list refresh initialized the wasm.
    await ensureZstd()
    const title = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Rename session {0}…', session.id.slice(0, 8)),
      placeHolder: vscode.l10n.t('Enter a new title'),
      ignoreFocusOut: true,
    })
    if (title === undefined) return // cancelled
    const trimmed = title.trim()
    if (!trimmed) return
    let result = appendSessionTitle(session.file, trimmed)
    if (result === 'unavailable') {
      // The wasm module instance can corrupt in a long-lived Electron host
      // (compress then emits non-frames). Reload it and retry once — the
      // first attempt verified its output and wrote nothing.
      resetZstd()
      await ensureZstd()
      result = appendSessionTitle(session.file, trimmed)
    }
    if (result === 'appended') {
      sessionsTree.refresh()
    } else {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Rename failed: the session log is not writable'),
      )
    }
  })
  register('dsh-tui-vscode.archiveSession', async (item: unknown) => {
    const session = sessionIdentity(item)
    if (!session) return
    // dsh-native archive: the session joins the workspace domain's archive
    // set (the same set the dsh web list reads) — hidden from the sidebar
    // while its log and accounting slot are retained, recoverable anytime.
    if (setSessionArchived(session.id, true, sessionsTree.dshHomeForCommands()) === 'ok') {
      sessionsTree.refresh()
    } else {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Archive failed: cannot write to the workspace-domain storage'),
      )
    }
  })
  register('dsh-tui-vscode.manageArchived', async () => {
    // List archived sessions (title + relative time); pick one, then choose
    // restore or permanent delete.
    const dshHome = sessionsTree.dshHomeForCommands()
    const archivedIds = readWorkspaceMeta(dshHome).archivedSessionIds
    if (archivedIds.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No archived sessions'))
      return
    }
    const all = await listSessions(dshHome, {})
    const byId = new Map(all.map(s => [s.id, s]))
    const items: vscode.QuickPickItem[] = archivedIds.map(id => {
      const rec = byId.get(id)
      const when = rec?.lastUsed ?? rec?.createdAt
      // relativeTime is a pure module (no vscode) whose sub-minute bucket is
      // the English l10n key 'just now'; translate that bucket here so the
      // wording follows the display language, while the numeric units
      // (12m / 3h / 2d) stay language-neutral.
      const elapsed = rec && when !== undefined ? relativeTime(when) : undefined
      let description = vscode.l10n.t('Log missing')
      if (elapsed !== undefined) {
        description = elapsed === 'just now' ? vscode.l10n.t('just now') : elapsed
      }
      return {
        label: rec?.title?.trim() || id.slice(0, 12),
        description,
        detail: id,
      }
    })
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Archived sessions'),
      placeHolder: vscode.l10n.t('Select a session'),
      ignoreFocusOut: true,
    })
    if (!picked || !picked.detail) return
    // Actions carry stable ids: comparing rendered labels would be
    // locale-sensitive and silently break under any non-English UI language.
    const actions: Array<vscode.QuickPickItem & { action: 'restore' | 'delete' }> = [
      {
        action: 'restore',
        label: `$(archive) ${vscode.l10n.t('Restore session')}`,
        detail: vscode.l10n.t('Move it back to the sidebar; the log and its position stay intact'),
      },
      {
        action: 'delete',
        label: `$(trash) ${vscode.l10n.t('Delete permanently')}`,
        detail: vscode.l10n.t('Permanently remove this session log directory; this cannot be undone'),
      },
    ]
    const action = await vscode.window.showQuickPick(actions, {
      title: vscode.l10n.t('Session: {0}', picked.label),
      ignoreFocusOut: true,
    })
    if (!action) return
    if (action.action === 'restore') {
      if (setSessionArchived(picked.detail, false, dshHome) === 'ok') {
        sessionsTree.refresh()
        void vscode.window.showInformationMessage(vscode.l10n.t('Session restored'))
      } else {
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Restore failed: cannot write to the workspace-domain storage'),
        )
      }
      return
    }
    const rec = byId.get(picked.detail)
    if (!rec) return
    const deleteLabel = vscode.l10n.t('Delete permanently')
    const confirm = await vscode.window.showWarningMessage(
      vscode.l10n.t('Permanently delete archived session {0}…? Its log directory will be removed for good; this cannot be undone.',
        picked.detail.slice(0, 8),
      ),
      { modal: true },
      deleteLabel,
    )
    if (confirm !== deleteLabel) return
    if (deleteSessionLog(rec.file, dshHome) === 'deleted') {
      // Drop the id from the archive set too (its log is gone).
      void setSessionArchived(picked.detail, false, dshHome)
      sessionsTree.refresh()
    }
  })
  register('dsh-tui-vscode.deleteSession', async (item: unknown) => {
    const session = sessionIdentity(item)
    if (!session) return
    const deleteLabel = vscode.l10n.t('Delete permanently')
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Permanently delete session {0}…? Its log directory will be removed and this cannot be undone. Consider archiving it first.',
        session.id.slice(0, 8),
      ),
      { modal: true },
      deleteLabel,
    )
    if (answer !== deleteLabel) return
    if (deleteSessionLog(session.file, sessionsTree.dshHomeForCommands()) === 'deleted') {
      sessionsTree.refresh()
    }
  })

  sessionsTree.refresh()
  refreshState()

  return {
    sendInput: text => {
      const terminal = findTerminal()
      if (terminal) terminal.sendText(text, false)
    },
    hasTerminal: () => hasTerminal(),
    // `await`ed rather than fire-and-forget: the caller is the e2e suite, and a
    // rejected write there must fail the case instead of passing it vacuously
    // (the same "no unhandled rejection" rule the F-9 guard enforces).
    async seedImageSetupPrompted(shown: boolean): Promise<void> {
      await context.globalState.update(IMAGE_SETUP_PROMPTED_KEY, shown ? true : undefined)
    },
  }
}

export function deactivate(): void {
  // The IDE selection channel server (and its lock file) is torn down via
  // the context.subscriptions dispose hook registered in activate().
}