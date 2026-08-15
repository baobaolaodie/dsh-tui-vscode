import * as vscode from 'vscode'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildLaunchEnv, buildTerminalPlan } from './session'
import { findFileLinks, type FileLink } from './links'
import { SessionStatusBar } from './status'

interface Settings {
  command: string
  extraArgs: string[]
  terminalName: string
  lang: string
  injectEditor: boolean
  editorCommand: string
}

function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration('dsh-tui-vscode')
  return {
    command: cfg.get<string>('command', 'dsh-tui'),
    extraArgs: cfg.get<string[]>('extraArgs', []),
    terminalName: cfg.get<string>('terminalName', 'dsh-tui'),
    lang: cfg.get<string>('lang', ''),
    injectEditor: cfg.get<boolean>('injectEditor', true),
    editorCommand: cfg.get<string>('editorCommand', 'code -w'),
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const sessions = new Set<vscode.Terminal>()
  const status = new SessionStatusBar()
  context.subscriptions.push(status)

  const refresh = (): void => {
    const active = [...sessions].some(t => !t.exitStatus)
    status.update(active)
  }

  const launch = (resume: boolean): void => {
    const existing = [...sessions].find(t => !t.exitStatus)
    if (existing) {
      existing.show()
      refresh()
      return
    }
    const cfg = readSettings()
    const env = buildLaunchEnv({
      base: process.env,
      lang: cfg.lang,
      injectEditor: cfg.injectEditor,
      editorCommand: cfg.editorCommand,
    })
    const plan = buildTerminalPlan({
      resume,
      extraArgs: cfg.extraArgs,
      command: cfg.command,
      isWindows: process.platform === 'win32',
    })
    const terminal = vscode.window.createTerminal({
      name: cfg.terminalName,
      shellPath: plan.shellPath,
      shellArgs: plan.shellArgs,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    })
    sessions.add(terminal)
    terminal.show()
    refresh()
  }

  const focusSession = (): void => {
    const existing = [...sessions].find(t => !t.exitStatus)
    if (existing) {
      existing.show()
      return
    }
    launch(false)
  }

  const killSession = (): void => {
    const terminal = [...sessions].find(t => !t.exitStatus)
    if (!terminal) return
    // First Ctrl+C interrupts the running turn; a second one (idle) exits the
    // TUI. Falling back to dispose() keeps the session from lingering.
    try {
      terminal.sendText('\u0003')
    } catch {
      // terminal already gone — onDidCloseTerminal will clean up
    }
    setTimeout(() => {
      if (!terminal.exitStatus) {
        try {
          terminal.dispose()
        } catch {
          // ignore: already closed
        }
      }
    }, 600)
  }

  const openLink = (link: FileLink): void => {
    const uri = resolveFileUri(link.path)
    if (!uri) return
    const selection = link.line !== undefined
      ? new vscode.Range(
          Math.max(0, link.line - 1),
          Math.max(0, (link.column ?? 1) - 1),
          Math.max(0, link.line - 1),
          Math.max(0, (link.column ?? 1) - 1),
        )
      : undefined
    void vscode.window.showTextDocument(uri, { preview: true, selection })
  }

  const linkTargets = new WeakMap<vscode.TerminalLink, FileLink>()

  const terminalLinkProvider: vscode.TerminalLinkProvider = {
    provideTerminalLinks(context: vscode.TerminalLinkContext): vscode.TerminalLink[] | undefined {
      // Only decorate terminals owned by this extension.
      if (![...sessions].some(t => t === context.terminal)) return undefined
      return findFileLinks(context.line).map(link => {
        const terminalLink = new vscode.TerminalLink(
          link.start,
          link.end - link.start,
          link.path + (link.line !== undefined ? `:${link.line}` : ''),
        )
        linkTargets.set(terminalLink, link)
        return terminalLink
      })
    },
    handleTerminalLink(link: vscode.TerminalLink): void {
      const target = linkTargets.get(link)
      if (target) openLink(target)
    },
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('dsh-tui-vscode.start', () => launch(false)),
    vscode.commands.registerCommand('dsh-tui-vscode.resume', () => launch(true)),
    vscode.commands.registerCommand('dsh-tui-vscode.focus', focusSession),
    vscode.commands.registerCommand('dsh-tui-vscode.kill', killSession),
    vscode.window.registerTerminalLinkProvider(terminalLinkProvider),
    vscode.window.onDidCloseTerminal(terminal => {
      if (sessions.delete(terminal)) refresh()
    }),
  )
}

export function deactivate(): void {
  // Terminal processes outlive the extension; nothing to tear down.
}

function resolveFileUri(path: string): vscode.Uri | undefined {
  try {
    let abs: string
    if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/')) {
      abs = path
    } else if (path === '~' || path.startsWith('~/')) {
      abs = join(homedir(), path.slice(path === '~' ? 1 : 2))
    } else {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      abs = root ? resolve(root, path) : path
    }
    return vscode.Uri.file(abs)
  } catch {
    return undefined
  }
}