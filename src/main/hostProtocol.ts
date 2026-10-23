// Messages between the app (pty.ts) and the session host (host.ts): one JSON
// object per line over a Unix socket.
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { StringDecoder } from 'string_decoder'
import type { SessionStatus } from '@shared/types'

/**
 * Bumped whenever a message changes shape. The app only talks to a host that
 * speaks its version. `hello`, `welcome.protocol` and `shutdown` never change,
 * so any app can tell an older host apart and stop it.
 */
export const PROTOCOL = 1

/** Hooks and the keystrokes status depends on, in the order they happened, with when. */
export type HistoryEntry = ({ hook: string; payload: Record<string, unknown> } | { input: string }) & { at: number }

export interface HostSession {
  sessionId: string
  projectId: string
  /** Status when the process started. */
  initial: SessionStatus
  /** Recent output, for replaying into a terminal. */
  buffer: string
  /** Everything that has moved its status since the process started, oldest first. */
  history: HistoryEntry[]
}

export interface SpawnRequest {
  type: 'spawn'
  id: number
  sessionId: string
  projectId: string
  initial: SessionStatus
  file: string
  args: string[]
  env: Record<string, string>
  cwd: string
  cols: number
  rows: number
}

export type ClientMessage =
  | { type: 'hello'; protocol: number }
  | SpawnRequest
  | { type: 'write'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'kill'; sessionId: string }
  /** Stops every session and the host itself. */
  | { type: 'shutdown' }

export type HostMessage =
  | { type: 'welcome'; protocol: number; hookPort: number; hookToken: string; sessions: HostSession[] }
  | { type: 'spawned'; id: number; error?: string }
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string; exitCode: number }
  | { type: 'hook'; sessionId: string; event: string; payload: Record<string, unknown> }

/** Keystrokes the status heuristics act on (noteUserInput in hooks.ts). */
export const STATUS_KEY = /^(?:\r|\x1b|\x03|[1-9])$/

export interface HostPaths {
  /** Private to the user, like the socket inside it: whoever can connect can run commands. */
  dir: string
  socket: string
  log: string
}

export function hostPaths(userData: string): HostPaths {
  const dir = path.join(userData, 'host')
  let socket = path.join(dir, 'host.sock')
  // macOS caps socket paths at 104 bytes; the per-user temp folder is private too.
  if (Buffer.byteLength(socket) > 100) {
    const hash = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 12)
    socket = path.join(os.tmpdir(), `claude-nodes-${hash}.sock`)
  }
  return { dir, socket, log: path.join(dir, 'host.log') }
}

export function ensurePrivateDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

export const encode = (msg: ClientMessage | HostMessage) => JSON.stringify(msg) + '\n'

/** Splits a socket's bytes into messages. Malformed lines are dropped. */
export function messageReader<T>(onMessage: (msg: T) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder('utf8')
  let partial = ''
  return (chunk) => {
    const text = decoder.write(chunk)
    // Only the new text is scanned, so a long message arriving in pieces stays linear.
    let start = 0
    let nl: number
    while ((nl = text.indexOf('\n', start)) >= 0) {
      const line = partial + text.slice(start, nl)
      partial = ''
      start = nl + 1
      if (!line) continue
      let msg: T
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      onMessage(msg)
    }
    partial += text.slice(start)
  }
}
