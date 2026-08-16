/**
 * DSH session discovery for the sidebar session list.
 *
 * Sessions persist under `$DSH_HOME/sessions/<cwd-encoded>/<sessionId>/session.jsonl.zstd`
 * (dsh-session-persistence-jsonl). Titles follow the TUI's contract
 * (src/dsh-adapter/compat/sessionLog.ts): the LAST `session/title` event wins,
 * falling back to the first `user/message` text.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as zstd from '@bokuweb/zstd-wasm'
import { gunzipSync } from 'node:zlib'

export interface SessionRecord {
  id: string
  /** Display title, or undefined when the log has none. */
  title?: string
  cwd?: string
  createdAt?: number
  file: string
}

export interface SessionFile {
  id: string
  file: string
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
            out.push({ id: entry, file })
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
 */
export function readSessionRecord(file: string): SessionRecord | undefined {
  try {
    const text = decodeSessionLog(file).toString('utf8')
    const header: {
      id?: string
      cwd?: string
      createdAt?: number
    } = {}
    let titled: string | undefined
    let firstUser: string | undefined

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
    if (!header.id) return undefined
    return {
      id: header.id,
      title: titled ?? firstUser,
      cwd: header.cwd,
      createdAt: header.createdAt,
      file,
    }
  } catch {
    return undefined
  }
}

/** All sessions across DSH_HOME, most recently created first. */
export function listSessions(dshHome?: string): SessionRecord[] {
  return findSessionFiles(dshHome)
    .map(sf => readSessionRecord(sf.file))
    .filter((s): s is SessionRecord => s !== undefined && s.id.length > 0)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}