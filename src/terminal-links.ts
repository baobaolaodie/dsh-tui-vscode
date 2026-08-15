/**
 * Terminal-link provider factory.
 *
 * Separated from extension.ts so the provider can be exercised inside a real
 * extension host (see src/test-suite/) and its behavior kept independent of
 * session bookkeeping.
 */
import * as vscode from 'vscode'
import { findFileLinks, type FileLink } from './links'

export interface LinkProviderDeps {
  /** True when the terminal belongs to this extension. */
  isOwnTerminal: (terminal: vscode.Terminal) => boolean
  /** Open the resolved file (with optional line/column selection). */
  openPath: (link: FileLink) => void
}

export function createTerminalLinkProvider(deps: LinkProviderDeps): vscode.TerminalLinkProvider {
  const linkTargets = new WeakMap<vscode.TerminalLink, FileLink>()
  return {
    provideTerminalLinks(context: vscode.TerminalLinkContext): vscode.TerminalLink[] | undefined {
      // Only decorate terminals owned by this extension.
      if (!deps.isOwnTerminal(context.terminal)) return undefined
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
      if (target) deps.openPath(target)
    },
  }
}