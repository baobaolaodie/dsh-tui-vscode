import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { matchPathToken } from '../links'

interface VsCodeApi {
  postMessage(message: unknown): void
}
declare function acquireVsCodeApi(): VsCodeApi

const vscode = acquireVsCodeApi()

const container = document.getElementById('terminal')
if (!container) throw new Error('missing #terminal element')

const term = new Terminal({
  cursorBlink: true,
  fontSize: 13,
  scrollback: 10000,
  convertEol: false,
  // Follow the user's editor font settings via VS Code CSS variables.
  fontFamily: 'var(--vscode-editor-font-family)',
})
const fit = new FitAddon()
term.loadAddon(fit)

// Path candidates (Windows absolute / POSIX absolute / ~ / ./ ../), each with
// an optional :line[:col] suffix. Group 1 = the full candidate text.
const PATH_URL_RE =
  /((?:[A-Za-z]:[\\/]|[~/]|\.{1,2}\/)[^\s:;'"<>|*?]+(?::\d+){0,2})/

term.loadAddon(
  new WebLinksAddon(
    (_event, uri) => {
      const hit = matchPathToken(uri.replace(/[.,);:：。，]+$/, ''))
      if (hit) vscode.postMessage({ type: 'openPath', path: hit.path, line: hit.line, col: hit.col })
    },
    { urlRegex: PATH_URL_RE },
  ),
)

term.open(container)
fit.fit()

term.onData(data => vscode.postMessage({ type: 'input', data }))
term.onResize(({ cols, rows }) => vscode.postMessage({ type: 'resize', cols, rows }))

window.addEventListener('message', event => {
  const msg = event.data
  if (!msg || typeof msg.type !== 'string') return
  switch (msg.type) {
    case 'data':
      term.write(msg.data)
      break
    case 'resize':
      term.resize(msg.cols, msg.rows)
      break
    case 'focus':
      term.focus()
      break
    case 'state': {
      const status = document.getElementById('status')
      if (!status) break
      if (msg.running) {
        status.textContent = '运行中' + (msg.pid ? ` (PID ${msg.pid})` : '')
        status.className = 'running'
      } else if (msg.exitCode !== undefined && msg.exitCode !== null) {
        status.textContent = `已退出 (code ${msg.exitCode})`
        status.className = 'stopped'
      } else {
        status.textContent = '未运行'
        status.className = 'stopped'
      }
      break
    }
    default:
      break
  }
})

// Toolbar buttons → host commands.
for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-cmd]')) {
  button.addEventListener('click', () => {
    vscode.postMessage({ type: 'command', command: button.dataset.cmd })
  })
}

const observer = new ResizeObserver(() => {
  try {
    fit.fit()
  } catch {
    // container hidden — ignore
  }
})
observer.observe(document.body)

vscode.postMessage({ type: 'ready', cols: term.cols, rows: term.rows })