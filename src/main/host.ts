// The session host: a background process that owns the sessions'
// pseudo-terminals, so they keep running after the app quits.
//
// The app starts it detached, running Electron's binary as plain Node, and
// talks to it over a Unix socket (hostProtocol.ts). A relaunched app
// reconnects and gets back every live session with its recent output and
// everything that has moved its status. Hooks come here too: a process's hook
// endpoint is fixed when it starts, so it has to outlive the app as well. So
// do the board tools' requests, which the host passes on to the app.
//
// The host exits once it has no sessions and no app connected.
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import net from 'net'
import type { AddressInfo } from 'net'
import * as pty from 'node-pty'
import type { SessionStatus } from '@shared/types'
import {
  MCP_PATH,
  MCP_SESSION_HEADER,
  PROTOCOL,
  STATUS_KEY,
  STATUS_LINE_EVENT,
  encode,
  messageReader,
  type ClientMessage,
  type HistoryEntry,
  type HostMessage,
  type SpawnRequest
} from './hostProtocol'

const BUFFER_LIMIT = 2 * 1024 * 1024
const HISTORY_LIMIT = 1000
const KILL_GRACE_MS = 3000
/** A host nobody connects to, started by an app that then crashed, gives up after this. */
const UNUSED_MS = 30_000

interface Session {
  sessionId: string
  projectId: string
  initial: SessionStatus
  proc: pty.IPty
  chunks: string[]
  size: number
  history: HistoryEntry[]
  statusLine?: { payload: Record<string, unknown>; at: number }
  killTimer: NodeJS.Timeout | null
}

const socketPath = process.argv[2]
const sessions = new Map<string, Session>()
/** Connected apps that speak our protocol. */
const clients = new Set<net.Socket>()
const hookToken = crypto.randomBytes(16).toString('hex')
let hookPort = 0
let stopping = false

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args)

function broadcast(msg: HostMessage) {
  const line = encode(msg)
  for (const client of clients) client.write(line)
}

function exitIfIdle() {
  if (sessions.size === 0 && (clients.size === 0 || stopping)) {
    log('idle, exiting')
    process.exit(0)
  }
}

function record(s: Session, entry: HistoryEntry) {
  s.history.push(entry)
  if (s.history.length > HISTORY_LIMIT) s.history.splice(0, s.history.length - HISTORY_LIMIT)
}

/** A hook payload as kept in history: its short scalar fields, without tool inputs and outputs. */
function slim(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
    else if (typeof value === 'string' && value.length <= 1024) out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// Sessions

function spawnSession(req: SpawnRequest): string | undefined {
  if (sessions.has(req.sessionId)) return
  let proc: pty.IPty
  try {
    proc = pty.spawn(req.file, req.args, {
      name: 'xterm-256color',
      cols: req.cols,
      rows: req.rows,
      cwd: req.cwd,
      env: req.env
    })
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }

  const s: Session = {
    sessionId: req.sessionId,
    projectId: req.projectId,
    initial: req.initial,
    proc,
    chunks: [],
    size: 0,
    history: [],
    killTimer: null
  }
  sessions.set(s.sessionId, s)
  log('spawned', s.sessionId, req.file)

  proc.onData((data) => {
    s.chunks.push(data)
    s.size += data.length
    while (s.size > BUFFER_LIMIT && s.chunks.length > 1) s.size -= s.chunks.shift()!.length
    broadcast({ type: 'data', sessionId: s.sessionId, data })
  })
  proc.onExit(({ exitCode }) => {
    if (s.killTimer) clearTimeout(s.killTimer)
    if (sessions.get(s.sessionId) === s) sessions.delete(s.sessionId)
    log('exited', s.sessionId, exitCode)
    broadcast({ type: 'exit', sessionId: s.sessionId, exitCode })
    exitIfIdle()
  })
}

function kill(s: Session, signals: string[] = ['SIGTERM']) {
  for (const signal of signals) {
    try {
      s.proc.kill(signal)
    } catch {
      // already gone
    }
  }
  s.killTimer ??= setTimeout(() => {
    try {
      s.proc.kill('SIGKILL')
    } catch {
      // already gone
    }
  }, KILL_GRACE_MS)
}

function shutdown() {
  log('stopping every session')
  stopping = true
  // SIGHUP too, as when a terminal window closes: interactive shells ignore SIGTERM.
  for (const s of sessions.values()) kill(s, ['SIGTERM', 'SIGHUP'])
  exitIfIdle()
  setTimeout(() => process.exit(0), KILL_GRACE_MS + 1000).unref()
}

function handle(msg: ClientMessage, socket: net.Socket) {
  switch (msg.type) {
    case 'spawn':
      socket.write(encode({ type: 'spawned', id: msg.id, error: spawnSession(msg) }))
      return
    case 'write': {
      const s = sessions.get(msg.sessionId)
      if (!s || typeof msg.data !== 'string') return
      s.proc.write(msg.data)
      if (STATUS_KEY.test(msg.data)) record(s, { input: msg.data, at: Date.now() })
      return
    }
    case 'resize': {
      const s = sessions.get(msg.sessionId)
      if (!s) return
      try {
        s.proc.resize(msg.cols, msg.rows)
      } catch {
        // The process may have just exited.
      }
      return
    }
    case 'kill': {
      const s = sessions.get(msg.sessionId)
      if (s) kill(s)
      return
    }
    case 'shutdown':
      shutdown()
      return
    case 'mcp-reply':
      relays.get(msg.id)?.settle(msg.reply)
      return
  }
}

// ---------------------------------------------------------------------------
// App connections

const server = net.createServer((socket) => {
  let greeted = false
  socket.on(
    'data',
    messageReader<ClientMessage>((msg) => {
      try {
        if (!greeted) {
          if (msg.type !== 'hello') return socket.destroy()
          greeted = true
          const sessionList = [...sessions.values()].map((s) => ({
            sessionId: s.sessionId,
            projectId: s.projectId,
            initial: s.initial,
            buffer: s.chunks.join(''),
            history: s.history,
            statusLine: s.statusLine
          }))
          socket.write(
            encode({ type: 'welcome', protocol: PROTOCOL, hookPort, hookToken, sessions: sessionList, mcp: true })
          )
          // An app on another protocol may only ask us to stop.
          if (msg.protocol === PROTOCOL) clients.add(socket)
          log('app connected', msg.protocol === PROTOCOL ? '' : `(protocol ${msg.protocol})`)
          return
        }
        if (clients.has(socket) || msg.type === 'shutdown') handle(msg, socket)
      } catch (err) {
        log('message failed', err)
      }
    })
  )
  socket.on('error', () => {})
  socket.on('close', () => {
    if (clients.delete(socket)) log('app disconnected')
    for (const r of relays.values()) if (r.client === socket) r.settle(undefined)
    // A probe from another host never says hello, and must not stop this one.
    if (greeted) exitIfIdle()
  })
})

// ---------------------------------------------------------------------------
// Hooks: the same endpoint hooks.ts registers with every claude process, and
// its status line.

const hookServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === MCP_PATH) {
    serveMcp(req, res).catch((err) => {
      log('mcp request failed', err)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
    return
  }
  if (req.method !== 'POST' || url.pathname !== '/hook' || url.searchParams.get('token') !== hookToken) {
    res.writeHead(404).end()
    req.resume()
    return
  }
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    res.writeHead(204).end()
    const event = url.searchParams.get('evt')
    const s = sessions.get(url.searchParams.get('sid') ?? '')
    if (!event || !s) return
    let payload: Record<string, unknown> = {}
    try {
      const body = Buffer.concat(chunks).toString('utf8')
      if (body) payload = JSON.parse(body)
    } catch {
      // Status still updates from the event name alone.
    }
    if (event === STATUS_LINE_EVENT) s.statusLine = { payload, at: Date.now() }
    else record(s, { hook: event, payload: slim(payload), at: Date.now() })
    broadcast({ type: 'hook', sessionId: s.sessionId, event, payload })
  })
})

// ---------------------------------------------------------------------------
// Board tools: the MCP server every claude process is given (boardTools.ts).
// The app answers its requests; they come through here so that, like hooks,
// they reach whichever app is running, and keep working across its restarts.

const RELAY_TIMEOUT_MS = 20_000
const MCP_MAX_BYTES = 1024 * 1024
const APP_CLOSED = 'Claude Nodes isn’t open, so the board can’t be reached right now.'

interface Relay {
  client: net.Socket
  settle(reply: unknown): void
}

const relays = new Map<number, Relay>()
let nextRelay = 1

interface RpcRequest {
  id: string | number | null
  method: string
}

const isRequest = (m: unknown): m is RpcRequest =>
  Boolean(m) && typeof m === 'object' && 'id' in m! && typeof (m as RpcRequest).method === 'string'

/** Passes a request on to the app. Resolves undefined when no app answers it. */
function relay(sessionId: string, message: RpcRequest): Promise<unknown> {
  // There's only ever one app; the newest connection is the live one.
  const client = [...clients].pop()
  if (!client) return Promise.resolve(undefined)
  const id = nextRelay++
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(undefined), RELAY_TIMEOUT_MS)
    const settle = (reply: unknown) => {
      clearTimeout(timer)
      relays.delete(id)
      resolve(reply)
    }
    relays.set(id, { client, settle })
    client.write(encode({ type: 'mcp', id, sessionId, message }))
  })
}

/** What a request gets when the app isn't there to answer it. A failed tool call tells Claude why. */
function unanswered(msg: RpcRequest) {
  return msg.method === 'tools/call'
    ? { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: APP_CLOSED }], isError: true } }
    : { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: APP_CLOSED } }
}

/** The MCP streamable HTTP transport, answering every request on its POST: there are no streams. */
async function serveMcp(req: http.IncomingMessage, res: http.ServerResponse) {
  const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
  const s = sessions.get(String(req.headers[MCP_SESSION_HEADER.toLowerCase()] ?? ''))
  if (token !== hookToken || !s || req.method !== 'POST') {
    req.resume()
    // There's no stream to open (GET) and no session to end (DELETE).
    const status = token !== hookToken || !s ? 401 : req.method === 'DELETE' ? 204 : 405
    return void res.writeHead(status, status === 405 ? { Allow: 'POST' } : {}).end()
  }

  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MCP_MAX_BYTES) return void res.writeHead(413).end()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return reply(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }
  const requests = (Array.isArray(parsed) ? parsed : [parsed]).filter(isRequest)
  // Notifications (no id) get no answer.
  if (requests.length === 0) return void res.writeHead(202).end()
  const answers = await Promise.all(requests.map(async (m) => (await relay(s.sessionId, m)) ?? unanswered(m)))
  reply(res, Array.isArray(parsed) ? answers : answers[0])
}

function reply(res: http.ServerResponse, value: unknown) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

// ---------------------------------------------------------------------------
// Startup

/** Whether another host already serves the socket. */
function alreadyServed(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
}

async function main() {
  if (!socketPath) throw new Error('usage: host <socket path>')

  // Two apps starting at once could each start a host; the second one leaves.
  if (await alreadyServed()) {
    log('another host is running')
    process.exit(0)
  }
  try {
    fs.unlinkSync(socketPath)
  } catch {
    // no stale socket
  }

  await new Promise<void>((resolve, reject) => {
    hookServer.once('error', reject)
    hookServer.listen(0, '127.0.0.1', () => {
      hookPort = (hookServer.address() as AddressInfo).port
      resolve()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  fs.chmodSync(socketPath, 0o600)
  log('listening', socketPath, 'hooks on', hookPort)

  setTimeout(() => {
    if (clients.size === 0) exitIfIdle()
  }, UNUSED_MS).unref()
}

// A crash would take every session with it, so log and carry on.
process.on('uncaughtException', (err) => log('uncaught', err))
process.on('unhandledRejection', (err) => log('unhandled', err))

main().catch((err) => {
  log('failed to start', err)
  process.exit(1)
})
