/**
 * Terminal-output file-link detection.
 *
 * Pure functions: `stripAnsiWithMap` removes escape sequences while keeping a
 * per-character index map back into the original line, and `findFileLinks`
 * locates clickable path[:line[:col]] references. The VS Code wiring lives in
 * extension.ts.
 */

export interface StrippedLine {
  /** Line without ANSI escape sequences. */
  text: string
  /** For each stripped character, its index in the original line. */
  index: number[]
}

/** Pragmatic ANSI stripper: CSI sequences, OSC (e.g. OSC 8 links), and the few bare escapes real terminals emit. */
const ANSI_RE =
  /\x1b(?:\[[0-9;:?<>]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[=>])/g

export function stripAnsiWithMap(line: string): StrippedLine {
  let text = ''
  const index: number[] = []
  let last = 0
  for (const m of line.matchAll(ANSI_RE)) {
    const start = m.index ?? 0
    for (let i = last; i < start; i++) {
      text += line[i]
      index.push(i)
    }
    last = start + m[0].length
  }
  for (let i = last; i < line.length; i++) {
    text += line[i]
    index.push(i)
  }
  return { text, index }
}

export interface FileLink {
  /** Start index into the ORIGINAL (unstripped) line. */
  start: number
  /** End index (exclusive) into the ORIGINAL line. */
  end: number
  path: string
  line?: number
  column?: number
}

/**
 * Two distinct exclusion sets are needed because greedy interior matching
 * must allow '.' (file extensions) and ASCII punctuation that a trailing
 * class then trims, while CJK sentence punctuation must stop the interior
 * itself (CJK prose follows paths directly, e.g. "看 /home/u/a.ts，然后").
 */
/** Characters that may never appear inside a path candidate. */
const INTERIOR_EXCL = String.raw`\s:;'"<>|*?，。！？；：、"”’）】》`
/** Characters that terminate a path candidate (interior exclusions + ASCII trailing punctuation). */
const TERMINATORS = INTERIOR_EXCL + String.raw`.,)`

/**
 * Absolute Windows path (C:\... or C:/...) with optional :line[:col].
 * The (?![/\\]) guard after the drive slash rejects scheme-like tokens
 * (`s://…` is a drive letter `s` followed by `://`).
 */
const WINDOWS_PATH_RE = new RegExp(
  String.raw`([A-Za-z]:[\\/](?![/\\])[^${INTERIOR_EXCL}]*[^${TERMINATORS}])(?::(\d+))?(?::(\d+))?`,
  'g',
)

/**
 * Absolute POSIX path (/... or ~/...) with optional :line[:col].
 * The (?<![\w:/]) guard stops `https://…`, `C:/…` and inline `x/2` from
 * matching a pseudo-path that starts mid-token or mid-scheme.
 */
const POSIX_PATH_RE = new RegExp(
  String.raw`(?<![\w:/])(~?/(?:[^${INTERIOR_EXCL}]|:(?!\d))*[^${TERMINATORS}])(?::(\d+))?(?::(\d+))?`,
  'g',
)
/** Relative path explicitly starting with ./ or ../; no line suffix support to avoid matching prose. */
const RELATIVE_PATH_RE = new RegExp(
  String.raw`(\.{1,2}/[^${INTERIOR_EXCL}]+[^${TERMINATORS}])`,
  'g',
)

export function findFileLinks(rawLine: string): FileLink[] {
  const { text, index } = stripAnsiWithMap(rawLine)
  const links: FileLink[] = []

  const push = (path: string, line: number | undefined, col: number | undefined, start: number, end: number): void => {
    links.push({
      start: index[start] ?? start,
      end: (index[end - 1] ?? end - 1) + 1,
      path,
      line,
      column: col,
    })
  }

  for (const re of [WINDOWS_PATH_RE, POSIX_PATH_RE, RELATIVE_PATH_RE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      const path = m[1]
      const line = m[2] !== undefined ? Number(m[2]) : undefined
      const col = m[3] !== undefined ? Number(m[3]) : undefined
      const start = m.index
      const end = start + m[0].length
      // Skip when the "path" is actually one token of prose inside a sentence
      // with no path-ish shape beyond the leading slash (e.g. "if / 2").
      if (path.length < 2) continue
      push(path, line, col, start, end)
    }
  }

  // Sort by start and remove overlaps (a Windows absolute path may also be
  // caught by the POSIX pattern via its C:/ prefix).
  links.sort((a, b) => a.start - b.start || a.end - b.end)
  const out: FileLink[] = []
  for (const l of links) {
    const prev = out[out.length - 1]
    if (prev && l.start < prev.end) continue
    out.push(l)
  }
  return out
}