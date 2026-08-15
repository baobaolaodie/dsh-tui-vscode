/**
 * Path resolution for terminal file links.
 *
 * Pure (no `vscode` import) so the three resolution rules — absolute,
 * ~-expansion, and workspace-root-relative — are unit-testable.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface ResolveOptions {
  /** Workspace root used to resolve relative paths ('' disables it). */
  root?: string
  /** Home directory for `~/` expansion; defaults to os.homedir(). */
  home?: string
}

export function resolveLocalPath(p: string, opts: ResolveOptions = {}): string {
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/')) {
    // Absolute Windows or POSIX path — use as-is.
    return p
  }
  if (p === '~' || p.startsWith('~/')) {
    const home = opts.home ?? homedir()
    return join(home, p === '~' ? '' : p.slice(2))
  }
  const root = opts.root ?? ''
  return root ? resolve(root, p) : p
}