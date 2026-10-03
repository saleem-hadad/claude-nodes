// Runs `claude` (or a plain shell, for terminal cards) in pseudo-terminals,
// one per session card.
import * as pty from 'node-pty'
import type { SessionKind, SessionStatus } from '@shared/types'
import { requireClaude, spawnEnv, userShell } from './env'
import { hookEnv, hookSettings, markProcess, noteUserInput } from './hooks'

const BUFFER_LIMIT = 2 * 1024 * 1024
const FLUSH_MS = 16
const KILL_GRACE_MS = 3000

export interface PtyCallbacks {
  onData(sessionId: string, data: string): void
  onExit(sessionId: string, exitCode: number): void
}

interface Running {
  sessionId: string
  projectId: string
  proc: pty.IPty
  /** Output kept for replaying into a freshly created terminal. */
  chunks: string[]
  size: number
  pending: string
  flushTimer: NodeJS.Timeout | null
  killTimer: NodeJS.Timeout | null
}

export interface SpawnOptions {
  sessionId: string
  projectId: string
  cwd: string
  /** Defaults to 'claude'. A terminal ignores resume, name and initialPrompt. */
  kind?: SessionKind
  /** Resume an existing transcript instead of starting a new session with this id. */
  resume: boolean
  name?: string
  initialPrompt?: string
  cols?: number
  rows?: number
}

const running = new Map<string, Running>()
let callbacks: PtyCallbacks = { onData() {}, onExit() {} }

export function configurePty(cb: PtyCallbacks) {
  callbacks = cb
}

export function isLive(sessionId: string) {
  return running.has(sessionId)
}

export function liveSessionIds(): string[] {
  return [...running.keys()]
}

function flush(r: Running) {
  if (r.flushTimer) {
    clearTimeout(r.flushTimer)
    r.flushTimer = null
  }
  if (!r.pending) return
  const data = r.pending
  r.pending = ''
  callbacks.onData(r.sessionId, data)
}

function append(r: Running, data: string) {
  r.chunks.push(data)
  r.size += data.length
  while (r.size > BUFFER_LIMIT && r.chunks.length > 1) {
    r.size -= r.chunks.shift()!.length
  }
  r.pending += data
  if (!r.flushTimer) r.flushTimer = setTimeout(() => flush(r), FLUSH_MS)
}

/** Command line for a card's process. Terminals get a login shell, like Terminal.app. */
function commandFor(opts: SpawnOptions): { file: string; args: string[]; env: Record<string, string> } {
  if (opts.kind === 'terminal') return { file: userShell(), args: ['-l'], env: spawnEnv() }

  const args = opts.resume ? ['--resume', opts.sessionId] : ['--session-id', opts.sessionId]
  if (opts.name) args.push('--name', opts.name)
  args.push('--permission-mode', 'acceptEdits')
  args.push('--settings', hookSettings())
  if (opts.initialPrompt) args.push(opts.initialPrompt)
  return { file: requireClaude(), args, env: spawnEnv(hookEnv(opts.sessionId)) }
}

export function spawnSession(opts: SpawnOptions) {
  if (running.has(opts.sessionId)) return
  const { file, args, env } = commandFor(opts)

  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: Math.max(20, opts.cols ?? 120),
    rows: Math.max(5, opts.rows ?? 36),
    cwd: opts.cwd,
    env
  })

  const r: Running = {
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    proc,
    chunks: [],
    size: 0,
    pending: '',
    flushTimer: null,
    killTimer: null
  }
  running.set(opts.sessionId, r)

  proc.onData((data) => append(r, data))
  proc.onExit(({ exitCode }) => {
    flush(r)
    if (r.killTimer) clearTimeout(r.killTimer)
    // A newer process may have replaced this one.
    if (running.get(r.sessionId) === r) running.delete(r.sessionId)
    markProcess(r.sessionId, false)
    callbacks.onExit(r.sessionId, exitCode)
  })

  // With a first message the turn starts immediately; show it as working right away.
  const initial: SessionStatus = opts.initialPrompt ? 'working' : 'done'
  markProcess(opts.sessionId, true, initial)
}

/**
 * Buffered output for replay. Pending output is flushed first, so everything
 * sent before this call is part of the snapshot and nothing is sent twice.
 */
export function snapshot(sessionId: string): string {
  const r = running.get(sessionId)
  if (!r) return ''
  flush(r)
  return r.chunks.join('')
}

export function write(sessionId: string, data: string) {
  const r = running.get(sessionId)
  if (!r) return
  noteUserInput(sessionId, data)
  r.proc.write(data)
}

export function resize(sessionId: string, cols: number, rows: number) {
  const r = running.get(sessionId)
  if (!r || !Number.isFinite(cols) || !Number.isFinite(rows)) return
  try {
    r.proc.resize(Math.max(20, Math.floor(cols)), Math.max(5, Math.floor(rows)))
  } catch {
    // The process may have just exited.
  }
}

export function kill(sessionId: string): Promise<void> {
  const r = running.get(sessionId)
  if (!r) return Promise.resolve()
  return new Promise((resolve) => {
    const done = r.proc.onExit(() => {
      done.dispose()
      resolve()
    })
    try {
      r.proc.kill('SIGTERM')
    } catch {
      // already gone
    }
    r.killTimer = setTimeout(() => {
      try {
        r.proc.kill('SIGKILL')
      } catch {
        // already gone
      }
      resolve()
    }, KILL_GRACE_MS)
  })
}

export function killProject(projectId: string) {
  for (const r of running.values()) if (r.projectId === projectId) kill(r.sessionId)
}

export function killAll() {
  for (const r of running.values()) {
    try {
      r.proc.kill('SIGTERM')
    } catch {
      // ignore
    }
  }
}
