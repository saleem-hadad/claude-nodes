// Session status driven by Claude Code hooks.
//
// Every claude process we spawn gets `--settings` registering hooks that POST
// the hook payload to a localhost server. The CLAUDE_NODES_* variables in the
// process env tell the hook which card it belongs to.
//
// Hooks fired inside a subagent carry its agent_id. Those drive the agent's own
// status, and a card reads as working (or waiting) while its main thread or any
// of its agents is.
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
  'SessionEnd',
  'SubagentStart',
  'SubagentStop'
] as const

type HookEvent = (typeof HOOK_EVENTS)[number]
type Json = Record<string, any>

export type StatusListener = (sessionId: string, status: SessionStatus, live: boolean) => void
export type AgentStatusListener = (sessionId: string, agentId: string, status: SessionStatus) => void

let server: http.Server | null = null
let port = 0
const token = crypto.randomBytes(16).toString('hex')

/** Status of each session's main thread. */
const statuses = new Map<string, SessionStatus>()
const lastEmitted = new Map<string, string>()
const interruptTimers = new Map<string, NodeJS.Timeout>()
/** Last hook from a session's main thread; agents' hooks don't count. */
const lastHookAt = new Map<string, number>()

interface AgentHook {
  status: SessionStatus
  /** When the agent's last hook arrived. */
  at: number
  /** When it took on this status. */
  since: number
}

/** Agents seen through hooks in each session's current process, by agent id. */
const agentHooks = new Map<string, Map<string, AgentHook>>()

let listener: StatusListener = () => {}
let agentListener: AgentStatusListener = () => {}
let isLive: (sessionId: string) => boolean = () => false
let hasPendingWork: (transcriptPath: string) => boolean = () => false

export function configureStatus(opts: {
  onChange: StatusListener
  onAgentChange: AgentStatusListener
  isLive: (id: string) => boolean
  /** Whether an agent (by its transcript) has background work in flight that will wake it. */
  hasPendingWork: (transcriptPath: string) => boolean
}) {
  listener = opts.onChange
  agentListener = opts.onAgentChange
  isLive = opts.isLive
  hasPendingWork = opts.hasPendingWork
}

/** The main thread's status, raised by any agent that is working or waiting. */
function combined(sessionId: string): SessionStatus {
  const all = [statuses.get(sessionId) ?? 'done']
  for (const agent of agentHooks.get(sessionId)?.values() ?? []) all.push(agent.status)
  if (all.includes('waiting')) return 'waiting'
  if (all.includes('working')) return 'working'
  return 'done'
}

export function getStatus(sessionId: string): SessionStatus {
  return isLive(sessionId) ? combined(sessionId) : 'done'
}

function emit(sessionId: string, liveOverride?: boolean) {
  const live = liveOverride ?? isLive(sessionId)
  const status: SessionStatus = live ? combined(sessionId) : 'done'
  const key = `${status}|${live}`
  if (lastEmitted.get(sessionId) === key) return
  lastEmitted.set(sessionId, key)
  listener(sessionId, status, live)
}

export function setStatus(sessionId: string, status: SessionStatus, liveOverride?: boolean) {
  statuses.set(sessionId, status)
  emit(sessionId, liveOverride)
}

function setAgentStatus(sessionId: string, agentId: string, status: SessionStatus) {
  let agents = agentHooks.get(sessionId)
  if (!agents) agentHooks.set(sessionId, (agents = new Map()))
  const prev = agents.get(agentId)
  const now = Date.now()
  agents.set(agentId, { status, at: now, since: prev?.status === status ? prev.since : now })
  if (prev?.status !== status) agentListener(sessionId, agentId, status)
  emit(sessionId)
}

/** What hooks have said about an agent in the session's current process, if anything. */
export function getAgentHook(sessionId: string, agentId: string): { status: SessionStatus; at: number } | undefined {
  return agentHooks.get(sessionId)?.get(agentId)
}

/**
 * Marks an agent done that ended without its SubagentStop reaching us (one
 * stopped from Claude's task list, say). Its transcript is what tells.
 */
export function settleAgent(sessionId: string, agentId: string) {
  const agent = agentHooks.get(sessionId)?.get(agentId)
  if (agent && agent.status !== 'done') setAgentStatus(sessionId, agentId, 'done')
}

/**
 * Keeps an agent working that ended its turn with background work in flight:
 * its SubagentStop has fired, but that work will wake it again.
 */
export function holdAgent(sessionId: string, agentId: string) {
  const agent = agentHooks.get(sessionId)?.get(agentId)
  if (agent?.status === 'done') setAgentStatus(sessionId, agentId, 'working')
}

/** The agent that has been waiting on the user the longest, if any is. */
function longestWaitingAgent(sessionId: string): string | undefined {
  let found: { id: string; since: number } | undefined
  for (const [id, agent] of agentHooks.get(sessionId) ?? []) {
    if (agent.status === 'waiting' && (!found || agent.since < found.since)) found = { id, since: agent.since }
  }
  return found?.id
}

/** Called when the process for a session starts or exits. */
export function markProcess(sessionId: string, live: boolean, initial: SessionStatus = 'done') {
  const timer = interruptTimers.get(sessionId)
  if (timer) clearTimeout(timer)
  interruptTimers.delete(sessionId)
  statuses.set(sessionId, live ? initial : 'done')
  // Agents only run inside the process; a new one starts with none.
  agentHooks.delete(sessionId)
  emit(sessionId, live)
}

export function forgetStatus(sessionId: string) {
  statuses.delete(sessionId)
  lastEmitted.delete(sessionId)
  lastHookAt.delete(sessionId)
  agentHooks.delete(sessionId)
}

const isPermissionNotification = (payload: Json) => {
  const type = String(payload.notification_type ?? '')
  const message = String(payload.message ?? '')
  return type === 'permission_prompt' || type === 'elicitation_dialog' || /permission/i.test(message)
}

function handleAgentHook(event: HookEvent, sessionId: string, agentId: string, payload: Json) {
  switch (event) {
    case 'SubagentStop': {
      // An agent that ended its turn with a command still running in the background will be woken by it.
      const file = payload.agent_transcript_path
      const waking = typeof file === 'string' && hasPendingWork(file)
      return setAgentStatus(sessionId, agentId, waking ? 'working' : 'done')
    }
    case 'PermissionRequest':
      return setAgentStatus(sessionId, agentId, 'waiting')
    case 'PreToolUse':
      return setAgentStatus(sessionId, agentId, payload.tool_name === 'AskUserQuestion' ? 'waiting' : 'working')
    case 'Notification':
      if (isPermissionNotification(payload)) setAgentStatus(sessionId, agentId, 'waiting')
      return
    case 'SubagentStart':
    case 'PostToolUse':
    case 'UserPromptSubmit':
      return setAgentStatus(sessionId, agentId, 'working')
  }
}

function handleHook(event: HookEvent, sessionId: string, payload: Json) {
  const agentId = typeof payload.agent_id === 'string' && payload.agent_id ? payload.agent_id : null
  if (agentId) return handleAgentHook(event, sessionId, agentId, payload)

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
    case 'Notification':
      // An agent's permission prompt shows in the main terminal too, and that agent already reads as waiting.
      if (isPermissionNotification(payload) && !longestWaitingAgent(sessionId)) setStatus(sessionId, 'waiting')
      return
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
  const mainActive = current === 'working' || current === 'waiting'
  const waitingAgent = longestWaitingAgent(sessionId)
  if (!mainActive && !waitingAgent) return

  // Answering an agent's prompt, either way, lets it carry on. Prompts queue
  // up, so the answer is for the one that has waited longest.
  const isKey = data === '\r' || /^[1-9]$/.test(data) || data === '\x1b' || data === '\x03'
  if (current !== 'waiting' && waitingAgent && isKey) {
    setAgentStatus(sessionId, waitingAgent, 'working')
    return
  }

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
