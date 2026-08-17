/**
 * DSH session discovery for the sidebar session list.
 *
 * Sessions persist under `$DSH_HOME/sessions/<cwd-encoded>/<sessionId>/session.jsonl.zstd`
 * (dsh-session-persistence-jsonl), each log a CHAIN of zstd frames — one per
 * durable flush — decoded frame-by-frame below (a whole-buffer decompress
 * fails or truncates on multi-frame logs). Titles follow the TUI's contract
 * (src/dsh-adapter/compat/sessionLog.ts): the LAST `session/title` event wins,
 * falling back to the first human prompt. Last-used comes from the TUI's own
 * MRU file (`~/.dsh-tui/last-used.json`, the same map the TUI's `/resume`
 * picker sorts by). `listSessions` can restrict the view to the current
 * workspace (same semantics as the TUI's `sessionCwdMatches`), hide
 * boot-only sessions (no human prompt) and hide delegated sub-agent runs.
 */
import {
  readdirSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  appendFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  renameSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as zstd from '@bokuweb/zstd-wasm'
import { gunzipSync } from 'node:zlib'

/**
 * The CURRENT @bokuweb/zstd-wasm module instance. Never captured at import
 * time: the library's instance can corrupt in a long-lived Electron host
 * (compress/decompress then emit non-frame results) and resetZstd() swaps
 * it for a fresh one — every call site must resolve through getZstd() so a
 * reload actually takes effect.
 */
let zstdModule: typeof zstd | null = null
function getZstd(): typeof zstd {
  if (zstdModule === null) {
    // require() (not the import binding) so a cleared require cache yields
    // a genuinely new module instance.
    zstdModule = require('@bokuweb/zstd-wasm') as typeof zstd
  }
  return zstdModule
}

/** zstd WASM must be initialized once before decompression (async). */
let zstdInit: Promise<void> | null = null
export function ensureZstd(): Promise<void> {
  if (!zstdInit) zstdInit = getZstd().init()
  return zstdInit
}

/**
 * Set when the wasm module behaves corruptly (observed in long-lived
 * Electron extension hosts: compress/decompress emit non-frame results).
 * listSessions() checks this after building the list and reloads the module
 * once before rebuilding. Never exposed to callers.
 */
let zstdSuspected = false

/**
 * Zstandard frame magic, little-endian (RFC 8878 §3.1.1.1).
 * The persistence backend stores one session as a CHAIN of independently
 * decodable zstd frames — one per durable append batch — so a log grows by
 * concatenation. A single whole-buffer decompress only handles the first
 * frame (or fails outright once the stream exceeds the first frame's declared
 * content size), which is why these helpers walk the chain structurally.
 * Ported from dsh-TUI's sessions/frames.ts (measured there: identical frame
 * set to a magic scan over a 31 MB corpus, zero false positives, 4× faster).
 */
const ZSTD_MAGIC = 0xfd2fb528

/** Byte range of one structurally complete frame; `end` is exclusive. */
export interface FrameRange {
  start: number
  end: number
}

/**
 * Locate the end of the frame starting at `start`, without decompressing it.
 * Walks the Frame_Header and each Block_Header per RFC 8878 §3.1.1; a
 * `Reserved` block type means the bytes are not a frame at all.
 * @returns The frame's exclusive end offset, or -1 when not a complete frame.
 */
export function frameEnd(buffer: Buffer, start: number): number {
  let at = start
  if (at < 0 || at + 5 > buffer.length) return -1
  if (buffer.readUInt32LE(at) !== ZSTD_MAGIC) return -1
  at += 4

  const descriptor = buffer[at]!
  at += 1
  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const hasChecksum = (descriptor >> 2) & 1
  const dictionaryIdFlag = descriptor & 3

  if (singleSegment === 0) at += 1
  at += [0, 1, 2, 4][dictionaryIdFlag]!
  at += contentSizeFlag === 0 ? singleSegment : [0, 2, 4, 8][contentSizeFlag]!
  if (at > buffer.length) return -1

  for (;;) {
    if (at + 3 > buffer.length) return -1
    const header = buffer[at]! | (buffer[at + 1]! << 8) | (buffer[at + 2]! << 16)
    at += 3
    const isLast = header & 1
    const blockType = (header >> 1) & 3
    const blockSize = header >>> 3
    if (blockType === 3) return -1 // Reserved — not a frame
    at += blockType === 1 ? 1 : blockSize
    if (at > buffer.length) return -1
    if (isLast === 1) break
  }

  if (hasChecksum === 1) at += 4
  return at <= buffer.length ? at : -1
}

/** Walk complete frames forward from `from`. */
export function walkFrames(
  buffer: Buffer,
  from = 0,
  maxFrames = Number.POSITIVE_INFINITY,
): FrameRange[] {
  const frames: FrameRange[] = []
  let at = from
  while (at < buffer.length && frames.length < maxFrames) {
    const end = frameEnd(buffer, at)
    if (end < 0) break
    frames.push({ start: at, end })
    at = end
  }
  return frames
}

/**
 * All structurally complete frames inside a buffer, RESUMING past corrupt
 * frames: when the forward walk stops on a bad frame, the next magic
 * candidate is tried (a coincidental magic would still have to spell a valid
 * block chain to pass {@link frameEnd}, so false positives are not a
 * practical risk). Unlike {@link resyncFrames} this needs no EOF anchor,
 * which is exactly what a HEAD window lacks — it is what lets a whole-file
 * window with a corrupt middle frame keep the frames after it (the full-read
 * path recovers them via its tail resync; the windowed path must too).
 */
function walkFramesResuming(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): FrameRange[] {
  const frames: FrameRange[] = []
  let at = 0
  while (at < buffer.length && frames.length < maxFrames) {
    const end = frameEnd(buffer, at)
    if (end >= 0) {
      frames.push({ start: at, end })
      at = end
      continue
    }
    let next = -1
    for (let i = at + 1; i + 4 <= buffer.length; i++) {
      if (buffer.readUInt32LE(i) === ZSTD_MAGIC) {
        next = i
        break
      }
    }
    if (next < 0) break
    at = next
  }
  return frames
}

/**
 * Re-synchronize on a frame boundary inside a buffer whose last byte is the
 * file's last byte: try every magic candidate in order and keep the first
 * frame chain that lands exactly on the buffer's end.
 */
export function resyncFrames(buffer: Buffer): FrameRange[] {
  for (let at = 0; at + 4 <= buffer.length; at++) {
    if (buffer.readUInt32LE(at) !== ZSTD_MAGIC) continue
    const frames = walkFrames(buffer, at)
    const last = frames[frames.length - 1]
    if (last !== undefined && last.end === buffer.length) return frames
  }
  return []
}

/**
 * All structurally complete zstd frames of a whole log: a forward walk, plus
 * a tail re-sync when the walk stopped early (torn or corrupt mid-file frame)
 * so trailing frames — the current title lives there — are not lost.
 */
function zstdFrames(buffer: Buffer): FrameRange[] {
  const head = walkFrames(buffer)
  const headEnd = head.length > 0 ? head[head.length - 1]!.end : 0
  if (headEnd === buffer.length) return head
  const tail = resyncFrames(buffer)
  if (tail.length === 0) return head
  const tailStart = tail[0]!.start
  if (tailStart >= headEnd) return [...head, ...tail]
  return head
}

export interface SessionRecord {
  id: string
  /** Display title (see precedence in listSessions). */
  title?: string
  /** Title from a `session/title` log event only (undefined otherwise). */
  eventTitle?: string
  cwd?: string
  /** Short project name derived from cwd (or the cwd-encoded group dir). */
  project?: string
  createdAt?: number
  /** Epoch ms from the TUI's last-used MRU map, when present. */
  lastUsed?: number
  /** Session header `origin` — 'subagent' marks a delegated run. */
  origin?: string
  /** Session header `parentSession`, for sub-agent runs. */
  parent?: string
  /**
   * Whether the log holds a human prompt (a `user/message` typed at the
   * keyboard, or an inbox splice carrying one). Unknown logs default to
   * true so nothing real is ever hidden; false only when the WHOLE log was
   * read and no human prompt exists (a boot-only artifact).
   */
  hasPrompt: boolean
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

/** Last path segment, separator-agnostic (`D:\a\b` → `b`; '' when empty). */
export function pathBase(p: string): string | undefined {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  const b = parts[parts.length - 1]
  return b && b.length > 0 ? b : undefined
}

/**
 * The sidebar label for one session: display title → working-directory
 * basename → generic placeholder. Mirrors the TUI's last-resort chain (its
 * `fallback` title source is the cwd basename), kept pure so the tree view
 * stays trivially testable.
 */
export function sessionLabel(rec: SessionRecord): string {
  const title = rec.title?.trim()
  if (title && title.length > 0) return title
  if (rec.cwd && rec.cwd.trim()) {
    const base = pathBase(rec.cwd.trim())
    if (base) return base
  }
  return '未命名会话'
}

/** Short project name from the session cwd, falling back to the group dir. */
export function projectNameOf(
  cwd: string | undefined,
  group: string | undefined,
): string | undefined {
  if (cwd && cwd.trim()) {
    const fromCwd = pathBase(cwd.trim())
    if (fromCwd) return fromCwd
  }
  if (group) {
    const decoded = decodeGroupDir(group)
    if (decoded) {
      const fromGroup = pathBase(decoded)
      if (fromGroup) return fromGroup
    }
  }
  return undefined
}

/**
 * Resolve the DSH home directory: the explicit override wins when it is a
 * NON-EMPTY string (the config default is '' — an empty override must fall
 * back to the environment, exactly like an absent one), then `$DSH_HOME`,
 * then `~/.dsh`.
 */
function resolveDshHome(dshHome?: string): string {
  return dshHome?.trim() || process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Walk the DSH sessions tree and return every session log file. */
export function findSessionFiles(dshHome?: string): SessionFile[] {
  const root = join(resolveDshHome(dshHome), 'sessions')
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

/**
 * Decompress a session log (concatenated zstd frames / gzip / plain jsonl).
 *
 * zstd logs are a CHAIN of frames (one per flush); a whole-buffer decompress
 * fails or truncates on multi-frame logs (measured: 15 of 99 real sessions
 * decode to nothing, hiding their titles and cwd). Frames are therefore
 * walked structurally and decompressed one by one; a frame that fails is
 * skipped rather than thrown — the rest of the log stands (torn tails are
 * the backend's own documented recovery case).
 */
export function decodeSessionLog(file: string): Buffer {
  const buf = readFileSync(file)
  const magic = buf.length > 4 ? buf.readUInt32LE(0) : 0
  if (magic === ZSTD_MAGIC) {
    // zstd magic (28 B5 2F FD little-endian → 0xfd2fb528)
    const frames = zstdFrames(buf)
    if (frames.length > 0) {
      const parts: Buffer[] = []
      for (const frame of frames) {
        try {
          parts.push(Buffer.from(getZstd().decompress(buf.subarray(frame.start, frame.end))))
        } catch {
          // torn/incomplete frame — keep decoding the rest
        }
      }
      // Every structurally complete frame failed to decompress — the log is
      // effectively unreadable. Throw (like the no-frame path below) so
      // callers treat it as unknown rather than as a read-to-the-end empty
      // log: a real conversation must not be hidden as a boot artifact.
      // This is also the signature of a corrupt wasm module (Electron host),
      // which listSessions() recovers from by reloading the module.
      if (parts.length === 0) {
        zstdSuspected = true
        throw new Error('no zstd frame decodes')
      }
      return Buffer.concat(parts)
    }
    // No structurally complete frame — best-effort single decompress.
    zstdSuspected = true
    return Buffer.from(getZstd().decompress(buf))
  }
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return gunzipSync(buf)
  }
  return buf
}

/**
 * Bounded reads over the concatenated-zstd session logs (ported from
 * dsh-TUI's sessions/frames.ts): the first few frames hold the session
 * header and its opening prompt, the last few hold whatever was appended
 * most recently (the current title — titles are re-emitted, last wins).
 * Everything in between is never touched, which turns a 15 MB log read into
 * a 64 KB + 128 KB window read.
 */
const HEAD_WINDOW_BYTES = 64 * 1024
/** Head frame ceiling — a cost bound independent of how bytes compress. */
const HEAD_MAX_FRAMES = 128
const TAIL_WINDOW_BYTES = 128 * 1024

/** A file's size and last-write time, read once for both. */
interface FileFacts {
  bytes: number
  modifiedAt: number
}

function fileFacts(path: string): FileFacts | undefined {
  try {
    const stats = statSync(path)
    return { bytes: stats.size, modifiedAt: stats.mtimeMs }
  } catch {
    return undefined
  }
}

/**
 * Read a window from one end of a file without loading the whole thing.
 * @param end - Read the last `bytes` instead of the first.
 * @returns The window, plus whether it covers the entire file (which tells a
 *   head reader that its last frame cannot be truncated).
 */
function readWindow(
  path: string,
  bytes: number,
  end = false,
): { buffer: Buffer; whole: boolean } | undefined {
  const facts = fileFacts(path)
  if (facts === undefined) return undefined
  const length = Math.min(bytes, facts.bytes)
  if (length === 0) return { buffer: Buffer.alloc(0), whole: true }
  const buffer = Buffer.alloc(length)
  let handle: number
  try {
    handle = openSync(path, 'r')
  } catch {
    return undefined
  }
  let read: number
  try {
    read = readSync(handle, buffer, 0, length, end ? facts.bytes - length : 0)
  } catch {
    return undefined
  } finally {
    closeSync(handle)
  }
  // A short read is not an error: the frame walk simply sees fewer bytes and
  // reports one fewer complete frame. Reporting `whole` honestly is what
  // matters — a tail reader must know whether it may assume a boundary.
  return { buffer: read === length ? buffer : buffer.subarray(0, read), whole: read === facts.bytes }
}

/** Decode frames to JSON event envelopes, tolerantly (skip bad frames/lines). */
function decodeFrames(buffer: Buffer, frames: FrameRange[]): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  let decodedFrames = 0
  let failedFrames = 0
  for (const frame of frames) {
    let text: string
    try {
      text = Buffer.from(getZstd().decompress(buffer.subarray(frame.start, frame.end))).toString('utf8')
      decodedFrames += 1
    } catch {
      failedFrames += 1
      continue // incomplete flush or torn frame — the rest of the log stands
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          events.push(parsed as Record<string, unknown>)
        }
      } catch {
        // A half-written line at the tail; earlier lines remain valid.
      }
    }
  }
  // Every structurally complete frame failed to decompress — the signature
  // of a corrupt wasm module in a long-lived Electron host (a torn tail
  // only ever fails SOME frames). listSessions() reloads the module then.
  if (failedFrames > 0 && decodedFrames === 0) zstdSuspected = true
  return events
}

/** Decode a window read from the END of a file (re-synchronized to EOF). */
function decodeTail(window: { buffer: Buffer; whole: boolean }): Record<string, unknown>[] {
  return decodeFrames(
    window.buffer,
    window.whole ? walkFrames(window.buffer) : resyncFrames(window.buffer),
  )
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
 * Whether a message `source` marks it as typed by the person at the
 * keyboard. Plugin injections, instruction snapshots and sub-agent reports
 * all arrive as user-role messages too, and counting them would report a
 * conversation where none happened (same rule as dsh-TUI's sessions/digest).
 */
function isHumanSource(source: unknown): boolean {
  if (source === undefined || source === null) return true
  if (typeof source !== 'object') return false
  return (source as Record<string, unknown>)['kind'] === 'user'
}

/** The human prompt carried by one log line, in either of its two forms. */
function humanPromptOf(event: Record<string, unknown>): string | undefined {
  const data = event['data'] as Record<string, unknown> | undefined
  if (data === null || typeof data !== 'object') return undefined

  if (event['type'] === 'user/message') {
    return isHumanSource(data['source']) ? firstTextOfContent(data['content']) : undefined
  }
  // The inbox splice precedes the durable user/message and reaches the log
  // several frames earlier — read it so the prompt fallback still works for
  // logs that never materialize the message form.
  if (event['type'] === 'agent/inbox/spliced') {
    const inserted = data['inserted']
    if (!Array.isArray(inserted)) return undefined
    for (const message of inserted) {
      if (message === null || typeof message !== 'object') continue
      const entry = message as Record<string, unknown>
      if (entry['role'] !== 'user' || !isHumanSource(entry['source'])) continue
      const text = firstTextOfContent(entry['content'])
      if (text !== undefined) return text
    }
  }
  return undefined
}

/**
 * Read one session's display record from its log: header + title (last
 * `session/title` event, falling back to the first HUMAN prompt) + whether a
 * human prompt exists at all. Tolerant: a log without a session header still
 * yields a record (id from the session dir, cwd from the group dir, createdAt
 * from the file mtime) so every persisted session is listable. `hasPrompt`
 * defaults to true and only becomes false when the whole log was read and no
 * human prompt was found — an unknown log is never hidden.
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
    origin?: string
    parentSession?: string
  } = {}
  let titled: string | undefined
  let firstUser: string | undefined
  let sawHumanPrompt = false

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
        header.origin = typeof event['origin'] === 'string' ? event['origin'] : undefined
        header.parentSession =
          typeof event['parentSession'] === 'string' ? event['parentSession'] : undefined
        continue
      }
      if (type === 'session/title') {
        const data = event['data'] as { title?: unknown } | undefined
        const title = data?.['title']
        if (typeof title === 'string' && title.trim()) titled = title.trim()
        continue
      }
      if (type === 'user/message' || type === 'agent/inbox/spliced') {
        const prompt = humanPromptOf(event)
        if (prompt !== undefined) {
          sawHumanPrompt = true
          if (firstUser === undefined) firstUser = prompt
        } else if (
          type === 'user/message' &&
          isHumanSource((event['data'] as Record<string, unknown> | undefined)?.['source'])
        ) {
          // A human user/message whose text could not be extracted (e.g. an
          // image-only prompt) is still a conversation — keep it listable.
          sawHumanPrompt = true
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
    eventTitle: titled,
    cwd: header.cwd,
    project: projectNameOf(header.cwd, group),
    origin: header.origin,
    parent: header.parentSession,
    hasPrompt: text !== undefined ? sawHumanPrompt : true,
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

interface SessionHead {
  rec: SessionRecord
  /** Whether the head window covered the whole log (no tail read needed). */
  whole: boolean
}

/**
 * Read the bounded HEAD of a session log: header fields (id/cwd/createdAt/
 * origin), the first human prompt, and `session/title` events (the LAST one
 * in the window wins, per the TUI's title contract). `hasPrompt` follows the
 * TUI digest rule: a human prompt in the window, or a log too large for the
 * window to have been read to the end. Non-zstd logs (gzip/plain, legacy and
 * small by construction) fall back to the full-read path.
 */
function readSessionHead(file: string, group?: string): SessionHead | undefined {
  const window = readWindow(file, HEAD_WINDOW_BYTES)
  if (window === undefined) return undefined
  const magic = window.buffer.length > 4 ? window.buffer.readUInt32LE(0) : 0
  if (magic !== ZSTD_MAGIC) {
    const rec = readSessionRecord(file, group)
    return rec === undefined ? undefined : { rec, whole: true }
  }
  const events = decodeFrames(
    window.buffer,
    walkFramesResuming(window.buffer, HEAD_MAX_FRAMES),
  )
  const header: {
    id?: string
    cwd?: string
    createdAt?: number
    origin?: string
    parentSession?: string
  } = {}
  let headTitle: string | undefined
  let firstUser: string | undefined
  let promptSeen = false
  for (const event of events) {
    const type = event['type']
    if (type === 'session' && event['id'] !== undefined) {
      header.id = String(event['id'])
      header.cwd = typeof event['cwd'] === 'string' ? event['cwd'] : undefined
      header.createdAt =
        typeof event['createdAt'] === 'number' ? event['createdAt'] : undefined
      header.origin = typeof event['origin'] === 'string' ? event['origin'] : undefined
      header.parentSession =
        typeof event['parentSession'] === 'string' ? event['parentSession'] : undefined
      continue
    }
    if (type === 'session/title') {
      const data = event['data'] as { title?: unknown } | undefined
      const title = data?.['title']
      if (typeof title === 'string' && title.trim()) headTitle = title.trim()
      continue
    }
    if (type === 'user/message' || type === 'agent/inbox/spliced') {
      const prompt = humanPromptOf(event)
      if (prompt !== undefined) {
        promptSeen = true
        if (firstUser === undefined) firstUser = prompt
      } else if (
        type === 'user/message' &&
        isHumanSource((event['data'] as Record<string, unknown> | undefined)?.['source'])
      ) {
        // A human user/message whose text could not be extracted (e.g. an
        // image-only prompt) is still a conversation.
        promptSeen = true
      }
    }
  }
  let createdAt = header.createdAt
  if (createdAt === undefined) {
    const facts = fileFacts(file)
    if (facts !== undefined) createdAt = facts.modifiedAt
  }
  const sessionDir = file.slice(0, file.lastIndexOf(sep))
  const rec: SessionRecord = {
    id: header.id ?? basename(sessionDir),
    title: headTitle ?? firstUser,
    eventTitle: headTitle,
    cwd: header.cwd,
    project: projectNameOf(header.cwd, group),
    origin: header.origin,
    parent: header.parentSession,
    hasPrompt: promptSeen || !window.whole,
    createdAt,
    file,
  }
  return { rec, whole: window.whole }
}

/**
 * Attach the CURRENT title from the log's tail window (titles are
 * re-emitted; the last one wins). A no-op when the head window already
 * covered the whole log.
 */
function attachTailTitle(rec: SessionRecord, file: string, headWhole: boolean): void {
  if (headWhole) return
  const window = readWindow(file, TAIL_WINDOW_BYTES, true)
  if (window === undefined) return
  for (const event of decodeTail(window)) {
    if (event['type'] !== 'session/title') continue
    const data = event['data'] as { title?: unknown } | undefined
    const title = data?.['title']
    if (typeof title === 'string' && title.trim()) {
      rec.title = title.trim()
      rec.eventTitle = title.trim()
    }
  }
}

/**
 * Full bounded read (head + tail): the windowed counterpart of
 * {@link readSessionRecord} with the same record contract, but only
 * ~192 KB of the log is ever read — the current title comes from the tail
 * (last `session/title` wins) falling back to the head's. Used by
 * {@link listSessions}; `readSessionRecord` stays for full-read callers and
 * as the compatibility path for non-zstd logs.
 */
export function readSessionSummary(file: string, group?: string): SessionRecord | undefined {
  const head = readSessionHead(file, group)
  if (head === undefined) return undefined
  attachTailTitle(head.rec, file, head.whole)
  return head.rec
}

/**
 * Workspace domain metadata from `$DSH_HOME/storages/workspace.json` — the
 * SAME file the dsh web session list reads. `archivedSessionIds` is the
 * registry-global archive set: archived sessions are hidden from every
 * grouping surface while their log and workspace accounting slot are
 * retained, so unarchiving restores the exact position.
 */
export interface WorkspaceMeta {
  archivedSessionIds: string[]
}

export function readWorkspaceMeta(dshHome?: string): WorkspaceMeta {
  const out: WorkspaceMeta = { archivedSessionIds: [] }
  try {
    const file = join(resolveDshHome(dshHome), 'storages', 'workspace.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      global?: { archivedSessionIds?: unknown }
    }
    const archived = parsed?.global?.archivedSessionIds
    if (Array.isArray(archived)) {
      out.archivedSessionIds = archived.filter((x): x is string => typeof x === 'string')
    }
  } catch {
    // absent or unreadable — no archive set
  }
  return out
}

/**
 * Archive or unarchive a session by editing the workspace domain's
 * registry-global archive set (the dsh web session list's own source).
 * Archiving hides the session from every grouping surface; its log and
 * workspace accounting slot are untouched, so unarchiving restores its
 * exact position. The file is re-read immediately before the write and
 * replaced atomically (tmp + rename — the dsh-storage-json backend's own
 * discipline): the dsh concurrency model is one writer per process with
 * last-write-wins, and this extension is a second writer exactly like
 * another dsh process would be.
 * @returns 'ok', or 'unavailable' when the workspace domain is absent or
 *   unreadable.
 */
export function setSessionArchived(
  sessionId: string,
  archived: boolean,
  dshHome?: string,
): 'ok' | 'unavailable' {
  try {
    const file = join(resolveDshHome(dshHome), 'storages', 'workspace.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      global?: { archivedSessionIds?: unknown }
    }
    if (parsed.global === null || typeof parsed.global !== 'object') return 'unavailable'
    const list = Array.isArray(parsed.global.archivedSessionIds)
      ? parsed.global.archivedSessionIds.filter((x): x is string => typeof x === 'string')
      : []
    const present = list.indexOf(sessionId)
    if (archived && present < 0) list.push(sessionId)
    if (!archived && present >= 0) list.splice(present, 1)
    parsed.global.archivedSessionIds = list
    // Atomic whole-file replacement, mirroring dsh-storage-json.
    const tmp = join(dirname(file), `.${randomUUID()}.tmp`)
    writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, file)
    return 'ok'
  } catch {
    return 'unavailable'
  }
}

/**
 * Session metadata from the dsh-storage ledger (`$DSH_HOME/storages/
 * session_projcache.json`): display titles (`tables.sessions[<id>].rows.
 * title.val` — the source the dsh web session list displays), the
 * authoritative `identity.cwd`, and the `sessionListMetadata.blank` flag
 * (a boot-only session with no prompt). The ledger covers only sessions the
 * TUI has flushed recently, so it is a fallback, never the primary source.
 */
export interface StorageMeta {
  titles: Record<string, string>
  cwds: Record<string, string>
  blanks: Record<string, boolean>
}

export function readStorageMeta(dshHome?: string): StorageMeta {
  const out: StorageMeta = { titles: {}, cwds: {}, blanks: {} }
  try {
    const file = join(
      resolveDshHome(dshHome),
      'storages',
      'session_projcache.json',
    )
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      tables?: {
        sessions?: Record<
          string,
          {
            identity?: { cwd?: unknown }
            rows?: {
              title?: { val?: unknown }
              sessionListMetadata?: { val?: { blank?: unknown } }
            }
          }
        >
      }
    }
    const sessions = parsed?.tables?.sessions
    if (sessions) {
      for (const [id, entry] of Object.entries(sessions)) {
        const title = entry?.rows?.title?.val
        if (typeof title === 'string' && title.trim()) out.titles[id] = title.trim()
        const cwd = entry?.identity?.cwd
        if (typeof cwd === 'string' && cwd.trim()) out.cwds[id] = cwd.trim()
        if (entry?.rows?.sessionListMetadata?.val?.blank === true) out.blanks[id] = true
      }
    }
  } catch {
    // ledger absent or unreadable — the log remains the source
  }
  return out
}

/**
 * Session titles from the dsh-storage ledger — kept for callers/tests that
 * want titles only (see {@link readStorageMeta} for the full read).
 */
export function readStorageTitles(dshHome?: string): Record<string, string> {
  return readStorageMeta(dshHome).titles
}

/** Normalize a cwd for comparison: forward slashes, no trailing slash; case
 *  folded when the platform's filesystem semantics are case-insensitive. */
function normalizeCwd(path: string, caseInsensitive: boolean): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

/**
 * Whether a session's recorded cwd belongs to a workspace directory —
 * workspace-anchored (adapted from dsh-TUI's `sessionCwdMatches`, issue
 * #96/#153 semantics): exact match, PLUS sessions recorded in a
 * subdirectory (pre-upgrade launches recorded the launch subdirectory as
 * the header cwd — they belong to the same workspace). The TUI's REVERSE
 * direction (current cwd inside the recorded path) is deliberately NOT
 * carried over: there the anchor is the live session's cwd, which can
 * itself be a subdirectory after a resume; here the anchor is the VS Code
 * workspace folder, so a session recorded in a PARENT directory belongs to
 * a different workspace and must not appear. Container directories — $HOME,
 * drive roots, UNC share roots — are nobody's workspace: at those
 * boundaries, in either direction, only an exact match passes, so `~`
 * never matches every session on the machine. `caseInsensitive` is a
 * parameter (not a platform read) so tests can exercise both modes on any
 * host.
 */
export function sessionCwdMatches(
  workspaceDir: string,
  recordedCwd: string,
  caseInsensitive: boolean = process.platform === 'win32',
): boolean {
  const cwd = normalizeCwd(workspaceDir, caseInsensitive)
  const recorded = normalizeCwd(recordedCwd, caseInsensitive)
  if (recorded === '' || cwd === '') return false
  const home = normalizeCwd(homedir(), caseInsensitive)
  // Paths below arrive backslash-normalized (`\\server\share` →
  // `//server/share`, `\\?\C:\` → `//?/C:`), trailing slashes stripped.
  const isContainer = (path: string): boolean =>
    (home !== '' && path === home) ||
    /^[a-z]:$/i.test(path) || // drive root: C:
    /^\/\/[^/]+\/[^/]+$/.test(path) || // UNC share root: //server/share
    /^\/\/\?\/[a-z]:$/i.test(path) || // extended drive root: //?/C:
    /^\/\/\?\/unc\/[^/]+\/[^/]+$/i.test(path) // extended UNC root: //?/UNC/server/share
  if (isContainer(cwd) || isContainer(recorded)) return recorded === cwd
  return (
    recorded === cwd ||
    // Pre-upgrade subdirectory session of this workspace.
    recorded.startsWith(`${cwd}/`)
  )
}

/**
 * Compress one log frame with the wasm zstd and VERIFY it: the library's
 * module instance can corrupt in a long-lived Electron host — compress then
 * emits non-frame bytes, or a frame whose magic is right but whose content
 * does not decompress (observed). Only a frame that round-trips (decompresses
 * back to the exact input) is ever written — a corrupt append would poison
 * the shared log.
 */
export function compressFrame(text: string): Buffer | undefined {
  try {
    const mod = getZstd()
    const out = Buffer.from(mod.compress(Buffer.from(text, 'utf8'), 3))
    if (out.length < 4 || out.readUInt32LE(0) !== ZSTD_MAGIC) return undefined
    const back = Buffer.from(mod.decompress(out))
    return back.toString('utf8') === text ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * Drop every cached @bokuweb/zstd-wasm module and forget the init promise,
 * so the next ensureZstd()/compressFrame() builds a fresh wasm instance.
 * Recovery path for the corrupt-module state observed in the Electron host.
 */
export function resetZstd(): void {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${sep}@bokuweb${sep}zstd-wasm${sep}`)) delete require.cache[key]
  }
  zstdModule = null
  zstdInit = null
}

/**
 * Append a `session/title` event to a session log — the rename contract of
 * the dsh-TUI `/resume` picker (`appendSessionTitle` in compat/sessionLog.
 * ts): one more zstd frame appended at EOF, `seq = maxSeq + 1`, and
 * last-title-wins on every reader. Append-only (O_APPEND via appendFileSync),
 * existing bytes are never rewritten, so a concurrently writing TUI/web
 * session is safe. The live session's own TUI does not see the new title
 * until it re-reads the log — the sidebar rename is meant for stored
 * sessions. The compressed frame is verified before writing; a corrupt wasm
 * state yields 'unavailable' (callers may resetZstd + retry).
 * @param file - Absolute path of the session log (session.jsonl.zstd).
 * @param title - New display title (already trimmed by the caller).
 * @returns 'appended', or 'unavailable' when the log is absent/undecodable
 *   or a valid frame could not be produced.
 */
export function appendSessionTitle(
  file: string,
  title: string,
): 'appended' | 'unavailable' {
  try {
    // Only zstd logs can take a new frame: appending one to a gzip/plain
    // legacy log would corrupt its format (the TUI's own rename only ever
    // targets session.jsonl.zstd).
    const buf = readFileSync(file)
    if (buf.length <= 4 || buf.readUInt32LE(0) !== ZSTD_MAGIC) return 'unavailable'
    const text = decodeSessionLog(file).toString('utf8')
    let maxSeq = -1
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      try {
        const event = JSON.parse(line) as { seq?: unknown }
        if (typeof event['seq'] === 'number' && event['seq'] > maxSeq) maxSeq = event['seq']
      } catch {
        // unparseable line — not a seq witness
      }
    }
    // Same envelope shape as a manual /rename append ({ title } only); the
    // seed validator asks only for type/seq/time/data on non-message types.
    const event = {
      type: 'session/title',
      seq: maxSeq + 1,
      time: Date.now(),
      data: { title },
    }
    const frame = compressFrame(JSON.stringify(event) + '\n')
    if (frame === undefined) return 'unavailable'
    appendFileSync(file, frame)
    return 'appended'
  } catch {
    return 'unavailable'
  }
}

/**
 * Delete a session's log directory — the delete contract of the dsh-TUI
 * `/resume` picker (`deleteSessionLog` in compat/sessionLog.ts). Refuses when
 * the resolved directory escapes the sessions root: a symlinked group
 * directory could otherwise steer the recursive rm outside the root, so both
 * sides are realpath'd before the containment check.
 * @param file - Absolute path of the session log (session.jsonl.zstd).
 * @param dshHome - DSH home override (defaults to env/`~/.dsh`), matching
 *   the listing functions.
 * @returns 'deleted', or 'unavailable' when the log is absent or the path
 *   escapes the sessions root.
 */
export function deleteSessionLog(file: string, dshHome?: string): 'deleted' | 'unavailable' {
  try {
    const root = join(resolveDshHome(dshHome), 'sessions')
    const dir = dirname(file)
    const realDir = realpathSync(dir)
    const realRoot = realpathSync(root)
    // Case-insensitive containment on Windows: the file argument arrives
    // from vscode.Uri.file(...).fsPath, which normalizes the drive letter
    // to LOWER case (c:\...) while $DSH_HOME keeps its original case
    // (C:\...) — a case-sensitive prefix test would refuse every delete.
    const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
    if (!norm(realDir).startsWith(norm(realRoot) + sep)) return 'unavailable'
    rmSync(dir, { recursive: true, force: true })
    return 'deleted'
  } catch {
    return 'unavailable'
  }
}

export interface ListSessionsOptions {
  /** Show only sessions whose cwd belongs to one of these directories
   *  (exact or descendant, per {@link sessionCwdMatches}). Sessions with no
   *  resolvable cwd are excluded. */
  workspaceDirs?: string[]
  /** Drop boot-only sessions with no human prompt (nothing to resume). */
  hideEmpty?: boolean
  /** Drop delegated sub-agent runs (session header `origin: 'subagent'`). */
  hideSubagents?: boolean
  /** Drop sessions in the workspace domain's archive set (web-consistent). */
  hideArchived?: boolean
}

/**
 * All sessions across DSH_HOME, each annotated with lastUsed; ordered by
 * last-used desc, then created desc (the TUI's /resume MRU convention).
 * Title precedence: log `session/title` → storage-ledger title → first human
 * prompt (the web session list's own source). The workspace filter runs last
 * so counts stay meaningful, and unknown hasPrompt (undecodable log) is
 * treated as true — hiding a real session is a defect, showing a boot
 * artifact is a nuisance.
 */
/**
 * Build the filtered, sorted session list with the CURRENT wasm module.
 * Synchronous body (zstd reads are sync) so listSessions can rebuild it
 * after reloading a corrupt module.
 */
function buildSessionList(
  dshHome: string | undefined,
  options: ListSessionsOptions,
  lastUsed: Record<string, number>,
  storage: StorageMeta,
  archivedIds: ReadonlySet<string>,
): SessionRecord[] {
  return findSessionFiles(dshHome)
    .map(sf => {
      // Bounded head read only (64 KB): header fields, first human prompt,
      // head title. The tail (current title) is read ONLY for sessions that
      // survive the filters below — a session outside the workspace, a
      // boot-only artifact or a sub-agent run never pays for the tail read.
      const head = readSessionHead(sf.file, sf.group)
      if (head === undefined) return undefined
      const rec = head.rec
      if (rec.cwd === undefined) {
        const ledgerCwd = storage.cwds[rec.id]
        if (ledgerCwd !== undefined) {
          rec.cwd = ledgerCwd
          rec.project = projectNameOf(ledgerCwd, sf.group)
        }
      }
      const subagent = options.hideSubagents === true && rec.origin === 'subagent'
      const empty = options.hideEmpty === true && rec.hasPrompt === false
      const cwd = rec.cwd
      const outOfWorkspace =
        options.workspaceDirs !== undefined &&
        options.workspaceDirs.length > 0 &&
        (cwd === undefined || !options.workspaceDirs.some(dir => sessionCwdMatches(dir, cwd)))
      if (!subagent && !empty && !outOfWorkspace) {
        attachTailTitle(rec, sf.file, head.whole)
      }
      const used = lastUsed[rec.id]
      if (typeof used === 'number') rec.lastUsed = used
      const storageTitle = storage.titles[rec.id]
      if (storageTitle !== undefined && rec.eventTitle === undefined) {
        // The web session list shows the storage-ledger title; let it win
        // over the raw first-human-prompt fallback.
        rec.title = storageTitle
      }
      if (storage.blanks[rec.id] === true && rec.hasPrompt) {
        // The ledger watched the session live and saw no prompt at all.
        rec.hasPrompt = false
      }
      return rec
    })
    .filter((s): s is SessionRecord => s !== undefined)
    .filter(s => !options.hideSubagents || s.origin !== 'subagent')
    .filter(s => !options.hideEmpty || s.hasPrompt !== false)
    .filter(s => !options.hideArchived || !archivedIds.has(s.id))
    .filter(s => {
      if (!options.workspaceDirs || options.workspaceDirs.length === 0) return true
      const cwd = s.cwd
      if (cwd === undefined) return false
      return options.workspaceDirs.some(dir => sessionCwdMatches(dir, cwd))
    })
    .sort(
      (a, b) =>
        (b.lastUsed ?? -Infinity) - (a.lastUsed ?? -Infinity) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0),
    )
}

export async function listSessions(
  dshHome?: string,
  options: ListSessionsOptions = {},
): Promise<SessionRecord[]> {
  await ensureZstd()
  const lastUsed = readLastUsed()
  const storage = readStorageMeta(dshHome)
  const archivedIds = new Set(readWorkspaceMeta(dshHome).archivedSessionIds)
  let result = buildSessionList(dshHome, options, lastUsed, storage, archivedIds)
  if (zstdSuspected) {
    // The wasm module corrupted during the build (observed in long-lived
    // Electron hosts — every frame "fails to decompress"). Reload the
    // module and rebuild ONCE; never loop (a genuinely broken log stays
    // broken either way).
    zstdSuspected = false
    resetZstd()
    await ensureZstd()
    result = buildSessionList(dshHome, options, lastUsed, storage, archivedIds)
  }
  return result
}