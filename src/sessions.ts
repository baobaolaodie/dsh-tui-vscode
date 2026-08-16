/**
 * DSH session discovery for the sidebar session list.
 *
 * Sessions persist under `$DSH_HOME/sessions/<cwd-encoded>/<sessionId>/session.jsonl.zstd`
 * (dsh-session-persistence-jsonl). Titles follow the TUI's contract
 * (src/dsh-adapter/compat/sessionLog.ts): the LAST `session/title` event wins,
 * falling back to the first `user/message` text. Last-used comes from the
 * TUI's own MRU file (`~/.dsh-tui/last-used.json`, the same map the TUI's
 * `/resume` picker sorts by).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import * as zstd from '@bokuweb/zstd-wasm'
import { gunzipSync } from 'node:zlib'

/** zstd WASM must be initialized once before decompression (async). */
let zstdInit: Promise<void> | null = null
export function ensureZstd(): Promise<void> {
  if (!zstdInit) zstdInit = zstd.init()
  return zstdInit
}

export interface SessionRecord {
  id: string
  /** Display title (last session/title event, else first user message). */
  title?: string
  cwd?: string
  /** Short project name derived from cwd (or the cwd-encoded group dir). */
  project?: string
  createdAt?: number
  /** Epoch ms from the TUI's last-used MRU map, when present. */
  lastUsed?: number
  file: string
}

export interface SessionFile {
  id: string
  /** The cwd-encoded group dir name (e.g. `--D-x--`). */
  group: string
  file: string
}

/**
 * Decode a cwd-encoded group dir: `--D-a-b--` → `D:\a\b` (best effort).
 * The encoding maps `:` (drive) and `\` both to `-`; hyphenated path segments
 * are inherently lossy (`flow-comet` → `flow\comet`).
 */
export function decodeGroupDir(name: string): string | undefined {
  const m = /^--(.+)--$/.exec(name)
  if (!m) return undefined
  const parts = m[1].split('-')
  if (parts.length > 0 && /^[A-Za-z]$/.test(parts[0])) {
    return parts[0] + ':' + sep + parts.slice(1).join(sep)
  }
  return m[1].replace(/-/g, sep)
}

/** Short project name from the session cwd, falling back to the group dir. */
export function projectNameOf(
  cwd: string | undefined,
  group: string | undefined,
): string | undefined {
  const base = (p: string): string | undefined => {
    const trimmed = p.replace(/[\\/]+$/, '')
    const b = basename(trimmed)
    return b && b.length > 0 ? b : undefined
  }
  if (cwd && cwd.trim()) {
    const fromCwd = base(cwd.trim())
    if (fromCwd) return fromCwd
  }
  if (group) {
    const decoded = decodeGroupDir(group)
    if (decoded) {
      const fromGroup = base(decoded)
      if (fromGroup) return fromGroup
    }
  }
  return undefined
}

/** Walk the DSH sessions tree and return every session log file. */
export function findSessionFiles(dshHome?: string): SessionFile[] {
  const root = join(dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
  const out: SessionFile[] = []
  let dirs: string[]
  try {
    dirs = readdirSync(root)
  } catch {
    return out
  }
  for (const group of dirs) {
    const groupPath = join(root, group)
    let entries: string[]
    try {
      entries = readdirSync(groupPath)
    } catch {
      continue
    }
    for (const entry of entries) {
      const sessionDir = join(groupPath, entry)
      try {
        if (!statSync(sessionDir).isDirectory()) continue
      } catch {
        continue
      }
      for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
        const file = join(sessionDir, name)
        try {
          if (statSync(file).isFile()) {
            out.push({ id: entry, group, file })
            break
          }
        } catch {
          // try the next name
        }
      }
    }
  }
  return out
}

/** Decompress a session log (zstd / gzip / plain jsonl). */
export function decodeSessionLog(file: string): Buffer {
  const buf = readFileSync(file)
  const magic = buf.length > 4 ? buf.readUInt32LE(0) : 0
  if (magic === 0xfd2fb528) {
    // zstd magic (28 B5 2F FD little-endian → 0xfd2fb528)
    return Buffer.from(zstd.decompress(buf))
  }
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return gunzipSync(buf)
  }
  return buf
}

function firstTextOfContent(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content.trim().slice(0, 80) || undefined
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: unknown; text?: unknown }
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          return b.text.trim().slice(0, 80)
        }
      }
    }
  }
  return undefined
}

/**
 * Read one session's display record from its log: header + title (last
 * `session/title` event, falling back to the first `user/message` text).
 * Tolerant: a log without a session header still yields a record (id from
 * the session dir, cwd from the group dir, createdAt from the file mtime) so
 * every persisted session is listable.
 */
export function readSessionRecord(
  file: string,
  group?: string,
): SessionRecord | undefined {
  let text: string | undefined
  try {
    text = decodeSessionLog(file).toString('utf8')
  } catch {
    text = undefined
  }
  const header: {
    id?: string
    cwd?: string
    createdAt?: number
  } = {}
  let titled: string | undefined
  let firstUser: string | undefined

  if (text !== undefined) {
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const type = event['type']
      if (type === 'session' && event['id'] !== undefined) {
        header.id = String(event['id'])
        header.cwd = typeof event['cwd'] === 'string' ? event['cwd'] : undefined
        header.createdAt =
          typeof event['createdAt'] === 'number' ? event['createdAt'] : undefined
        continue
      }
      if (type === 'session/title') {
        const data = event['data'] as { title?: unknown } | undefined
        const title = data?.['title']
        if (typeof title === 'string' && title.trim()) titled = title.trim()
        continue
      }
      if (type === 'user/message') {
        if (firstUser === undefined) {
          const data = event['data'] as { content?: unknown } | undefined
          firstUser = firstTextOfContent(data?.content)
        }
      }
    }
  }
  let createdAt = header.createdAt
  if (createdAt === undefined) {
    try {
      createdAt = statSync(file).mtimeMs
    } catch {
      // keep undefined
    }
  }
  const sessionDir = file.slice(0, file.lastIndexOf(sep))
  return {
    id: header.id ?? basename(sessionDir),
    title: titled ?? firstUser,
    cwd: header.cwd,
    project: projectNameOf(header.cwd, group),
    createdAt,
    file,
  }
}

/** The TUI's last-used MRU map (session id → epoch ms). */
export function readLastUsed(): Record<string, number> {
  try {
    const file = join(homedir(), '.dsh-tui', 'last-used.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[id] = value
    }
    return out
  } catch {
    return {}
  }
}

/**
 * All sessions across DSH_HOME, each annotated with lastUsed; ordered by
 * last-used desc, then created desc (the TUI's /resume MRU convention).
 */
export async function listSessions(dshHome?: string): Promise<SessionRecord[]> {
  await ensureZstd()
  const lastUsed = readLastUsed()
  return findSessionFiles(dshHome)
    .map(sf => {
      const rec = readSessionRecord(sf.file, sf.group)
      if (!rec) return undefined
      const used = lastUsed[rec.id]
      if (typeof used === 'number') rec.lastUsed = used
      return rec
    })
    .filter((s): s is SessionRecord => s !== undefined)
    .sort(
      (a, b) =>
        (b.lastUsed ?? -Infinity) - (a.lastUsed ?? -Infinity) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0),
    )
}