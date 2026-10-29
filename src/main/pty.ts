// Runs `claude` (or a plain shell, for terminal cards) in pseudo-terminals,
// one per session card.
//
// The pseudo-terminals live in the session host (host.ts), a background
// process that outlives the app, so sessions keep running after it quits.
// This is the app's side: it keeps each live session's recent output for
// replaying into terminals, and passes input, resizes and hooks along.
import { spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import path from 'path'
import { app, dialog } from 'electron'
import type { SessionKind, SessionStatus } from '@shared/types'
import { requireClaude, spawnEnv, userShell } from './env'
import { hookEnv, hookSettings, markProcess, noteUserInput, receiveHook, setHookEndpoint } from './hooks'
import {
  PROTOCOL,
  STATUS_LINE_EVENT,
  encode,
  ensurePrivateDir,
  hostPaths,
  messageReader,
  type ClientMessage,
  type HostMessage,
  type HostPaths
} from './hostProtocol'

const BUFFER_LIMIT = 2 * 1024 * 1024
const FLUSH_MS = 16
/** The host sends SIGKILL after its own 3s grace period. */
const KILL_WAIT_MS = 4000
const HOST_START_MS = 10_000
/** A host that accepts a connection but never answers is treated as gone. */
const WELCOME_MS = 5000

export interface PtyCallbacks {
  onData(sessionId: string, data: string): void
  onExit(sessionId: string, exitCode: number): void
}

interface Running {
  sessionId: string
  projectId: string
  /** Output kept for replaying into a freshly created terminal. */
  chunks: string[]
  size: number
  pending: string
  flushTimer: NodeJS.Timeout | null
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

interface PendingSpawn {
  sessionId: string
  projectId: string
  initial: SessionStatus
  resolve(): void
  reject(err: Error): void
}

const running = new Map<string, Running>()
const spawning = new Map<string, Promise<void>>()
const pendingSpawns = new Map<number, PendingSpawn>()
const exitWaiters = new Map<string, (() => void)[]>()
let callbacks: PtyCallbacks = { onData() {}, onExit() {} }
let host: net.Socket | null = null
let connecting: Promise<void> | null = null
let nextRequest = 1
let quitting = false

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

function track(sessionId: string, projectId: string, initial: SessionStatus, buffer = '') {
  running.set(sessionId, {
    sessionId,
    projectId,
    chunks: buffer ? [buffer] : [],
    size: buffer.length,
    pending: '',
    flushTimer: null
  })
  markProcess(sessionId, true, initial)
}

function exited(sessionId: string, exitCode: number) {
  const r = running.get(sessionId)
  if (r) {
    flush(r)
    running.delete(sessionId)
    markProcess(sessionId, false)
    callbacks.onExit(sessionId, exitCode)
  }
  for (const resolve of exitWaiters.get(sessionId) ?? []) resolve()
  exitWaiters.delete(sessionId)
}

function send(msg: ClientMessage) {
  host?.write(encode(msg))
}

// ---------------------------------------------------------------------------
// The host connection

function handle(msg: HostMessage) {
  switch (msg.type) {
    case 'spawned': {
      const pending = pendingSpawns.get(msg.id)
      if (!pending) return
      pendingSpawns.delete(msg.id)
      if (msg.error) return pending.reject(new Error(msg.error))
      // Before any output, which may follow in the same read.
      track(pending.sessionId, pending.projectId, pending.initial)
      return pending.resolve()
    }
    case 'data': {
      const r = running.get(msg.sessionId)
      if (r) append(r, msg.data)
      return
    }
    case 'exit':
      return exited(msg.sessionId, msg.exitCode)
    case 'hook':
      return receiveHook(msg.event, msg.sessionId, msg.payload)
  }
}

/** Takes on the sessions a host is already running, with what has happened in them. */
function adopt(welcome: Extract<HostMessage, { type: 'welcome' }>) {
  setHookEndpoint(welcome.hookPort, welcome.hookToken)
  for (const s of welcome.sessions) {
    track(s.sessionId, s.projectId, s.initial, s.buffer)
    // Replaying them through the status machine brings its status up to date.
    for (const entry of s.history) {
      if ('hook' in entry) receiveHook(entry.hook, s.sessionId, entry.payload, entry.at)
      else noteUserInput(s.sessionId, entry.input, entry.at)
    }
    if (s.statusLine) receiveHook(STATUS_LINE_EVENT, s.sessionId, s.statusLine.payload, s.statusLine.at)
  }
}

/** The host went away, and its sessions with it. */
function lost(socket: net.Socket) {
  if (host !== socket) return
  host = null
  for (const pending of pendingSpawns.values()) pending.reject(new Error('The session host stopped'))
  pendingSpawns.clear()
  if (quitting) return
  for (const sessionId of [...running.keys()]) exited(sessionId, -1)
}

function tryConnect(socketPath: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath)
    socket.once('connect', () => {
      socket.removeAllListeners('error')
      resolve(socket)
    })
    socket.once('error', () => resolve(null))
  })
}

/** Says hello. Resolves false if the host speaks another protocol. */
function greet(socket: net.Socket): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let welcomed = false
    const timeout = setTimeout(() => socket.destroy(), WELCOME_MS)
    socket.on(
      'data',
      messageReader<HostMessage>((msg) => {
        if (welcomed) return handle(msg)
        welcomed = true
        clearTimeout(timeout)
        if (msg.type !== 'welcome' || msg.protocol !== PROTOCOL) return resolve(false)
        // In the same read as the welcome, before any message that follows it.
        host = socket
        adopt(msg)
        resolve(true)
      })
    )
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(timeout)
      if (!welcomed) reject(new Error('The session host didn’t answer'))
      lost(socket)
    })
    socket.write(encode({ type: 'hello', protocol: PROTOCOL }))
  })
}

function startHost(paths: HostPaths) {
  ensurePrivateDir(paths.dir)
  const out = fs.openSync(paths.log, 'w')
  const child = spawn(process.execPath, [path.join(__dirname, 'host.js'), paths.socket], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: paths.dir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  child.unref()
  fs.closeSync(out)
}

async function startAndConnect(paths: HostPaths): Promise<net.Socket> {
  startHost(paths)
  for (let waited = 0; waited < HOST_START_MS; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const socket = await tryConnect(paths.socket)
    if (socket) return socket
  }
  throw new Error(`The session host didn't start. See ${paths.log}`)
}

/** Stops a host from an older or newer version of the app, once the user agrees. */
async function replaceHost(socket: net.Socket) {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: 'Sessions from another version of Claude Nodes are still running',
    detail: 'This version can’t connect to them. Stop them to carry on, or quit and let them finish.',
    buttons: ['Stop Sessions', 'Quit'],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 1) {
    socket.destroy()
    app.exit(0)
    return
  }
  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve())
    socket.write(encode({ type: 'shutdown' }))
  })
}

async function connect(start: boolean) {
  const paths = hostPaths(app.getPath('userData'))
  let socket = await tryConnect(paths.socket)
  if (socket && !(await greet(socket))) {
    await replaceHost(socket)
    socket = null
  }
  if (socket || !start) return
  if (!(await greet(await startAndConnect(paths)))) throw new Error('The session host speaks another protocol')
}

/**
 * Connects to the session host and takes on its sessions. With `start`, starts
 * a host if none is running; without, a missing host just means no sessions.
 */
export function connectHost(start = true): Promise<void> {
  if (host) return Promise.resolve()
  connecting ??= connect(start).finally(() => {
    connecting = null
  })
  return connecting
}

/** Leaves the host and its sessions running, for when the app quits. */
export function disconnect() {
  quitting = true
  host?.end()
}

/** Stops every session and the host. */
export async function stopAll(): Promise<void> {
  const socket = host
  if (!socket) return
  quitting = true
  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve())
    send({ type: 'shutdown' })
    setTimeout(resolve, KILL_WAIT_MS + 1000)
  })
}

// ---------------------------------------------------------------------------
// Sessions

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

async function startSession(opts: SpawnOptions) {
  // Connected first: the hook endpoint in the command comes from the host.
  await connectHost()
  const { file, args, env } = commandFor(opts)
  // With a first message the turn starts immediately; show it as working right away.
  const initial: SessionStatus = opts.initialPrompt ? 'working' : 'done'
  const id = nextRequest++
  await new Promise<void>((resolve, reject) => {
    pendingSpawns.set(id, { sessionId: opts.sessionId, projectId: opts.projectId, initial, resolve, reject })
    send({
      type: 'spawn',
      id,
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      initial,
      file,
      args,
      env,
      cwd: opts.cwd,
      cols: Math.max(20, opts.cols ?? 120),
      rows: Math.max(5, opts.rows ?? 36)
    })
  })
}

export function spawnSession(opts: SpawnOptions): Promise<void> {
  if (running.has(opts.sessionId)) return Promise.resolve()
  let starting = spawning.get(opts.sessionId)
  if (!starting) {
    starting = startSession(opts).finally(() => spawning.delete(opts.sessionId))
    spawning.set(opts.sessionId, starting)
  }
  return starting
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
  if (!running.has(sessionId)) return
  noteUserInput(sessionId, data)
  send({ type: 'write', sessionId, data })
}

export function resize(sessionId: string, cols: number, rows: number) {
  if (!running.has(sessionId) || !Number.isFinite(cols) || !Number.isFinite(rows)) return
  send({ type: 'resize', sessionId, cols: Math.max(20, Math.floor(cols)), rows: Math.max(5, Math.floor(rows)) })
}

export function kill(sessionId: string): Promise<void> {
  if (!running.has(sessionId)) return Promise.resolve()
  return new Promise((resolve) => {
    exitWaiters.set(sessionId, [...(exitWaiters.get(sessionId) ?? []), resolve])
    send({ type: 'kill', sessionId })
    setTimeout(resolve, KILL_WAIT_MS)
  })
}

export function killProject(projectId: string) {
  for (const r of running.values()) if (r.projectId === projectId) kill(r.sessionId)
}
