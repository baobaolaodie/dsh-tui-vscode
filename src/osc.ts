/**
 * OSC sequence handling for the PTY byte stream.
 *
 * dsh-tui is a pure terminal program: everything it prints is terminal
 * protocol. A few OSC sequences need host cooperation because our xterm.js
 * webview cannot answer them by itself:
 *
 *  - OSC 52 (clipboard set)      → handled in the host (vscode.env.clipboard)
 *  - OSC 11 (background query)   → answered with the current VS Code theme
 *  - OSC 0/1/2 (title)           → forwarded to the panel title
 *  - OSC 8 (hyperlinks)          → kept in the stream so xterm.js renders them
 *  - everything else             → stripped
 *
 * Sequences may be split across chunks, so the scanner keeps a pending buffer
 * until a terminator (BEL or ST) arrives.
 */

export interface OscEvent {
  kind: 'clipboard' | 'backgroundQuery' | 'title'
  payload?: string
}

export class OscScanner {
  private pending = ''

  scan(chunk: string): { clean: string; events: OscEvent[] } {
    const events: OscEvent[] = []
    let clean = ''
    const buf = this.pending + chunk
    this.pending = ''

    let i = 0
    while (i < buf.length) {
      const esc = buf.indexOf('\x1b', i)
      if (esc === -1) {
        clean += buf.slice(i)
        break
      }
      clean += buf.slice(i, esc)
      if (buf[esc + 1] === ']') {
        const bel = buf.indexOf('\x07', esc + 2)
        const st = buf.indexOf('\x1b\\', esc + 2)
        let end = -1
        if (bel !== -1 && (st === -1 || bel < st)) end = bel
        else if (st !== -1) end = st
        if (end === -1) {
          // Incomplete sequence — keep it for the next chunk.
          this.pending = buf.slice(esc)
          break
        }
        const body = buf.slice(esc + 2, end)
        const terminatorLen = buf[end] === '\x07' ? 1 : 2
        const kind = classify(body)
        if (kind === 'hyperlinks') {
          // OSC 8 must reach xterm.js so it can render the link underline.
          clean += buf.slice(esc, end + terminatorLen)
        } else if (kind !== 'other') {
          events.push({ kind, payload: oscPayload(body) })
        }
        i = end + terminatorLen
      } else {
        // Plain ESC (CSI / DCS / SS2...): keep it and continue after it.
        clean += '\x1b'
        i = esc + 1
      }
    }
    return { clean, events }
  }
}

type OscKind = OscEvent['kind'] | 'hyperlinks' | 'other'

function classify(body: string): OscKind {
  const sep = body.indexOf(';')
  const type = sep === -1 ? body : body.slice(0, sep)
  switch (type) {
    case '52':
      return 'clipboard'
    case '11':
      return oscPayload(body) === '?' ? 'backgroundQuery' : 'other'
    case '0':
    case '1':
    case '2':
      return 'title'
    case '8':
      return 'hyperlinks'
    default:
      return 'other'
  }
}

function oscPayload(body: string): string {
  const sep = body.indexOf(';')
  return sep === -1 ? '' : body.slice(sep + 1)
}