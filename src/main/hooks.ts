// Session status driven by Claude Code hooks.
//
// Every claude process we spawn gets `--settings` registering hooks that POST
// the hook payload to a localhost server. The CLAUDE_NODES_* variables in the
// process env tell the hook which card it belongs to.
import http from 'http'
import crypto from 'crypto'
import type { AddressInfo } from 'net'
import type { SessionStatus } from '@shared/types'

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd'
] as const

type HookEvent = (typeof HOOK_EVENTS)[number]
type Json = Record<string, any>

export type StatusListener = (sessionId: string, status: SessionStatus, live: boolean) => void

let server: http.Server | null = null
let port = 0
const token = crypto.randomBytes(16).toString('hex')

const statuses = new Map<string, SessionStatus>()
const lastEmitted = new Map<string, string>()
const interruptTimers = new Map<string, NodeJS.Timeout>()
const lastHookAt = new Map<string, number>()

let listener: StatusListener = () => {}
let isLive: (sessionId: string) => boolean = () => false

export function configureStatus(opts: { onChange: StatusListener; isLive: (id: string) => boolean }) {
  listener = opts.onChange
  isLive = opts.isLive
}

export function getStatus(sessionId: string): SessionStatus {
  return isLive(sessionId) ? statuses.get(sessionId) ?? 'done' : 'done'
}

function emit(sessionId: string, liveOverride?: boolean) {
  const live = liveOverride ?? isLive(sessionId)
  const status: SessionStatus = live ? statuses.get(sessionId) ?? 'done' : 'done'
  const key = `${status}|${live}`
  if (lastEmitted.get(sessionId) === key) return
  lastEmitted.set(sessionId, key)
  listener(sessionId, status, live)
}

export function setStatus(sessionId: string, status: SessionStatus, liveOverride?: boolean) {
  statuses.set(sessionId, status)
  emit(sessionId, liveOverride)
}

/** Called when the process for a session starts or exits. */
export function markProcess(sessionId: string, live: boolean, initial: SessionStatus = 'done') {
  const timer = interruptTimers.get(sessionId)
  if (timer) clearTimeout(timer)
  interruptTimers.delete(sessionId)
  statuses.set(sessionId, live ? initial : 'done')
  emit(sessionId, live)
}

export function forgetStatus(sessionId: string) {
  statuses.delete(sessionId)
  lastEmitted.delete(sessionId)
  lastHookAt.delete(sessionId)
}

function handleHook(event: HookEvent, sessionId: string, payload: Json) {
  lastHookAt.set(sessionId, Date.now())
  const current = statuses.get(sessionId) ?? 'done'

  switch (event) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return setStatus(sessionId, 'working')
    case 'PreToolUse':
      return setStatus(sessionId, payload.tool_name === 'AskUserQuestion' ? 'waiting' : 'working')
    case 'PermissionRequest':
      return setStatus(sessionId, 'waiting')
    case 'Notification': {
      const type = String(payload.notification_type ?? '')
      const message = String(payload.message ?? '')
      if (type === 'permission_prompt' || type === 'elicitation_dialog' || /permission/i.test(message)) {
        setStatus(sessionId, 'waiting')
      }
      return
    }
    case 'Stop':
      return setStatus(sessionId, 'done')
    case 'SessionStart':
      if (current !== 'working') setStatus(sessionId, 'done')
      return
    case 'SessionEnd':
      // /clear ends one session and starts another in the same process.
      if (payload.reason === 'clear') return setStatus(sessionId, 'done')
      return setStatus(sessionId, 'done', false)
  }
}

/**
 * Keystroke heuristics for transitions that fire no hook: Stop does not run
 * when the user interrupts (Esc / Ctrl+C), and approving a permission prompt
 * fires nothing until the tool finishes.
 */
export function noteUserInput(sessionId: string, data: string) {
  const current = statuses.get(sessionId)
  if (current !== 'working' && current !== 'waiting') return

  if (data === '\x1b' || data === '\x03') {
    const at = Date.now()
    const prev = interruptTimers.get(sessionId)
    if (prev) clearTimeout(prev)
    interruptTimers.set(
      sessionId,
      setTimeout(() => {
        interruptTimers.delete(sessionId)
        // Any hook after the keypress means Claude kept going.
        if ((lastHookAt.get(sessionId) ?? 0) > at) return
        const now = statuses.get(sessionId)
        if (now === 'working' || now === 'waiting') setStatus(sessionId, 'done')
      }, 1200)
    )
    return
  }

  if (current === 'waiting' && (data === '\r' || /^[1-9]$/.test(data))) {
    setStatus(sessionId, 'working')
  }
}

// ---------------------------------------------------------------------------
// Server

export function startHookServer(): Promise<void> {
  if (server) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method !== 'POST' || url.pathname !== '/hook' || url.searchParams.get('token') !== token) {
        res.writeHead(404).end()
        req.resume()
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(204).end()
        const event = url.searchParams.get('evt') as HookEvent | null
        const sessionId = url.searchParams.get('sid')
        if (!event || !sessionId || !HOOK_EVENTS.includes(event)) return
        let payload: Json = {}
        try {
          const body = Buffer.concat(chunks).toString('utf8')
          if (body) payload = JSON.parse(body)
        } catch {
          // Status still updates from the event name alone.
        }
        handleHook(event, sessionId, payload)
      })
    })
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      port = (srv.address() as AddressInfo).port
      server = srv
      resolve()
    })
  })
}

export function stopHookServer() {
  server?.close()
  server = null
}

/** Env vars a spawned claude process needs so its hooks can reach us. */
export function hookEnv(sessionId: string): Record<string, string> {
  return {
    CLAUDE_NODES_PORT: String(port),
    CLAUDE_NODES_TOKEN: token,
    CLAUDE_NODES_SESSION: sessionId
  }
}

let settingsJson: string | null = null

/** The `--settings` JSON registering our hooks. Identical for every process. */
export function hookSettings(): string {
  if (settingsJson) return settingsJson
  const hooks: Record<string, unknown> = {}
  for (const event of HOOK_EVENTS) {
    // Output must stay empty: UserPromptSubmit stdout is injected into Claude's context.
    const command =
      `curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- ` +
      `"http://127.0.0.1:$CLAUDE_NODES_PORT/hook?evt=${event}&sid=$CLAUDE_NODES_SESSION&token=$CLAUDE_NODES_TOKEN" ` +
      `>/dev/null 2>&1; exit 0`
    hooks[event] = [{ hooks: [{ type: 'command', command, timeout: 5 }] }]
  }
  settingsJson = JSON.stringify({ hooks })
  return settingsJson
}
