// Keeps one xterm instance per session alive for the lifetime of the renderer.
// Closing the terminal modal only moves the terminal's host element into a
// hidden holder, so reopening a card shows the exact screen it left.
//
// Ordering: sessions.open() returns the output buffered by the main process
// up to the moment it replied. Electron delivers main -> renderer messages in
// order, so any ptyData event that arrives while open() is pending is already
// part of that replay and is dropped. Once the replay is written the entry is
// 'ready' and live data is written straight through.
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'

/**
 * - opening: sessions.open() is in flight; live data is covered by its replay
 * - ready:   replay written, live data flows straight into the terminal
 * - exited:  the process ended (or opening failed); the next attach resumes it
 */
type EntryState = 'opening' | 'ready' | 'exited'

interface Entry {
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
  state: EntryState
  opening: Promise<void> | null
  /** The process exited while open() was still in flight. */
  exitPending: boolean
  hasOutput: boolean
  outputListeners: Set<() => void>
}

const entries = new Map<string, Entry>()

const EXIT_LINE = '\r\n\x1b[2m[process exited · press Resume or reopen the card to continue]\x1b[0m\r\n'

export const TERMINAL_THEME: ITheme = {
  background: '#1e1e20',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  cursorAccent: '#1e1e20',
  selectionBackground: '#0a84ff55',
  selectionInactiveBackground: '#8e8e9340',
  scrollbarSliderBackground: '#ffffff1f',
  scrollbarSliderHoverBackground: '#ffffff33',
  scrollbarSliderActiveBackground: '#ffffff47',
  black: '#3a3a3c',
  red: '#ff6b62',
  green: '#5fd068',
  yellow: '#f5c451',
  blue: '#5aa9ff',
  magenta: '#d68cf7',
  cyan: '#5ad1e0',
  white: '#d8d8dc',
  brightBlack: '#6e6e73',
  brightRed: '#ff8a80',
  brightGreen: '#7fe08a',
  brightYellow: '#ffd978',
  brightBlue: '#80bdff',
  brightMagenta: '#e2a8fb',
  brightCyan: '#80e2ee',
  brightWhite: '#f5f5f7'
}

let holder: HTMLDivElement | null = null

/** Offscreen parking spot for terminals whose modal is closed. */
function getHolder(): HTMLDivElement {
  if (!holder) {
    holder = document.createElement('div')
    holder.setAttribute('aria-hidden', 'true')
    Object.assign(holder.style, {
      position: 'fixed',
      left: '-10000px',
      top: '0',
      width: '1200px',
      height: '800px',
      overflow: 'hidden',
      visibility: 'hidden',
      pointerEvents: 'none'
    })
    document.body.appendChild(holder)
  }
  return holder
}

let subscribed = false

function ensureSubscribed() {
  if (subscribed) return
  subscribed = true

  window.api.on.ptyData((sessionId, data) => {
    const entry = entries.get(sessionId)
    // No entry: the main process buffers until someone opens it.
    // Opening: this data is already included in the pending replay.
    if (entry?.state === 'ready') writeOutput(entry, data)
  })

  window.api.on.ptyExit((sessionId) => {
    const entry = entries.get(sessionId)
    if (!entry) return
    if (entry.state === 'opening') entry.exitPending = true
    else if (entry.state === 'ready') markExited(entry)
  })
}

function writeOutput(entry: Entry, data: string) {
  if (!data) return
  entry.term.write(data)
  entry.hasOutput = true
  for (const listener of entry.outputListeners) listener()
}

function markExited(entry: Entry) {
  entry.term.write(EXIT_LINE)
  entry.state = 'exited'
}

function shellQuote(path: string): string {
  if (/^[\w@%+=:,./-]+$/.test(path)) return path
  return `'${path.replace(/'/g, `'\\''`)}'`
}

function createEntry(sessionId: string, container: HTMLElement): Entry {
  const host = document.createElement('div')
  host.className = 'term-host'
  // xterm measures its parent on open(), so the host must be laid out first.
  container.appendChild(host)

  const term = new Terminal({
    fontFamily: "'SF Mono', ui-monospace, Menlo, Monaco, monospace",
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    allowProposedApi: true,
    macOptionIsMeta: false,
    scrollback: 10000,
    theme: TERMINAL_THEME
  })

  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  // window.open with a real URL reaches the main process's window-open
  // handler, which hands http(s) links to the default browser.
  term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, '_blank')))

  term.open(host)

  try {
    const webgl = new WebglAddon()
    // Chromium caps live WebGL contexts; fall back to the DOM renderer if lost.
    webgl.onContextLoss(() => webgl.dispose())
    term.loadAddon(webgl)
  } catch {
    // WebGL unavailable; the default renderer is fine.
  }

  const entry: Entry = {
    term,
    fit,
    host,
    state: 'opening',
    opening: null,
    exitPending: false,
    hasOutput: false,
    outputListeners: new Set()
  }

  term.attachCustomKeyEventHandler((ev) => {
    // Shift+Enter inserts a newline in Claude's prompt (same sequence
    // `/terminal-setup` configures for other terminals). Swallow the
    // keypress too so a plain Enter is never sent.
    if (ev.key === 'Enter' && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      if (ev.type === 'keydown') {
        ev.preventDefault()
        window.api.sessions.write(sessionId, '\x1b\r')
      }
      return false
    }

    if (ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      if (ev.type !== 'keydown') return false
      const key = ev.key.toLowerCase()
      if (key === 'k') {
        ev.preventDefault()
        term.clear()
      } else if (key === 'c' && term.hasSelection()) {
        ev.preventDefault()
        navigator.clipboard.writeText(term.getSelection()).catch(() => {})
      } else if (key === 'a') {
        ev.preventDefault()
        term.selectAll()
      }
      // Everything else (⌘V, ⌘W, ⌘N…) falls through to the app menu.
      return false
    }

    return true
  })

  term.onData((data) => {
    if (entry.state !== 'exited') window.api.sessions.write(sessionId, data)
  })
  term.onResize(({ cols, rows }) => {
    if (entry.state === 'ready') window.api.sessions.resize(sessionId, cols, rows)
  })

  // Dropping files types their paths, as Terminal.app and iTerm do. Pasting
  // (rather than writing) keeps bracketed paste, so Claude can attach images.
  host.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types.includes('Files')) return
    ev.preventDefault()
    ev.dataTransfer.dropEffect = 'copy'
  })
  host.addEventListener('drop', (ev) => {
    const files = ev.dataTransfer?.files
    if (!files?.length) return
    ev.preventDefault()
    const paths = Array.from(files)
      .map((file) => window.api.pathForFile(file))
      .filter(Boolean)
      .map(shellQuote)
    if (paths.length) term.paste(paths.join(' ') + ' ')
    term.focus()
  })

  entries.set(sessionId, entry)
  return entry
}

function fitEntry(entry: Entry) {
  if (!entry.host.isConnected || entry.host.parentElement === holder) return
  try {
    entry.fit.fit()
  } catch {
    // Container not measurable yet (e.g. mid-layout); the next resize refits.
  }
}

async function openProcess(sessionId: string, projectId: string, entry: Entry) {
  entry.state = 'opening'
  entry.exitPending = false
  try {
    const { replay } = await window.api.sessions.open(
      projectId,
      sessionId,
      entry.term.cols,
      entry.term.rows
    )
    if (entries.get(sessionId) !== entry) return // disposed meanwhile
    writeOutput(entry, replay)
    entry.state = 'ready'
    // Size may have changed while opening; make sure the pty matches.
    window.api.sessions.resize(sessionId, entry.term.cols, entry.term.rows)
    if (entry.exitPending) {
      entry.exitPending = false
      markExited(entry)
    }
  } catch (err) {
    // Leave it resumable: the next attach retries open().
    entry.state = 'exited'
    throw err
  } finally {
    entry.opening = null
  }
}

/**
 * Shows the session's terminal inside `container`, creating it and starting
 * (or resuming) the claude process if needed. Resolves once output is flowing;
 * rejects if the process could not be started.
 */
export async function attach(sessionId: string, projectId: string, container: HTMLElement) {
  ensureSubscribed()

  // Everything up to the first await runs synchronously, so callers can
  // subscribe with onOutput() right after calling attach().
  let entry = entries.get(sessionId)
  const isNew = !entry
  if (!entry) {
    entry = createEntry(sessionId, container)
  } else {
    container.appendChild(entry.host)
  }
  fitEntry(entry)

  if (entry.opening) {
    // Already opening (e.g. React StrictMode re-running the effect).
    await entry.opening
    return
  }

  if (isNew || entry.state === 'exited') {
    if (!isNew) {
      // A resumed Claude redraws the whole conversation; start from a clean screen.
      entry.term.reset()
      entry.hasOutput = false
    }
    entry.opening = openProcess(sessionId, projectId, entry)
    await entry.opening
    return
  }

  window.api.sessions.resize(sessionId, entry.term.cols, entry.term.rows)
}

/** Parks the terminal offscreen, keeping its state for the next attach. */
export function detach(sessionId: string) {
  const entry = entries.get(sessionId)
  if (!entry) return
  entry.term.blur()
  getHolder().appendChild(entry.host)
}

/** Destroys the terminal, e.g. when its card is removed from the board. */
export function dispose(sessionId: string) {
  const entry = entries.get(sessionId)
  if (!entry) return
  entries.delete(sessionId)
  entry.outputListeners.clear()
  entry.term.dispose()
  entry.host.remove()
}

/** Refits to the current container and resizes the pty to match. */
export function refit(sessionId: string) {
  const entry = entries.get(sessionId)
  if (entry) fitEntry(entry)
}

export function focus(sessionId: string) {
  entries.get(sessionId)?.term.focus()
}

/** Whether the terminal has shown any output yet. */
export function hasOutput(sessionId: string): boolean {
  return entries.get(sessionId)?.hasOutput ?? false
}

/** Whether the next attach will start or resume a claude process. */
export function needsOpen(sessionId: string): boolean {
  const entry = entries.get(sessionId)
  return !entry || entry.state !== 'ready'
}

/** Calls `listener` whenever output is written to the session's terminal. */
export function onOutput(sessionId: string, listener: () => void): () => void {
  const entry = entries.get(sessionId)
  if (!entry) return () => {}
  entry.outputListeners.add(listener)
  return () => entry.outputListeners.delete(listener)
}
