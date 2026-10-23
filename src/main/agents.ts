// Subagents a session started with Claude's Agent tool.
//
// Claude Code keeps each agent's transcript beside the session's, in
// <session id>/subagents/agent-<id>.jsonl, next to an agent-<id>.meta.json with
// its type and the description Claude gave it. The meta file is rewritten with
// `finished` (or `stoppedByUser`) when the agent ends. Transcripts are parsed
// incrementally, like the sessions' own in discovery.ts.
//
// An agent can end its turn with a command still running in the background;
// a task notification wakes it when that finishes. Until then it isn't done,
// though its SubagentStop has fired and its meta file says `finished`.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AgentInfo, SessionCard, SessionStatus } from '@shared/types'
import {
  assistantParts,
  describeToolUse,
  isTaskNotification,
  listAgentFiles,
  messageText,
  readLines,
  timeOf,
  truncate,
  type AgentFile,
  type Json
} from './discovery'
import { getAgentHook, holdAgent, settleAgent } from './hooks'
import { isLive } from './pty'

/** Read in chunks this big, so a long agent transcript doesn't need one huge buffer. */
const CHUNK_BYTES = 4 * 1024 * 1024

interface AgentMetaFile {
  agentType?: string
  description?: string
  name?: string
  parentAgentId?: string
  finished?: boolean
  stoppedByUser?: boolean
}

interface MetaState {
  mtimeMs: number
  meta: AgentMetaFile
}

interface AgentParse {
  size: number
  mtimeMs: number
  offset: number
  startedAt?: number
  updatedAt?: number
  toolCount: number
  /** The latest step: a tool call, or a reply. */
  last?: { tool?: string; text?: string }
  /** When the agent finished its work, by its transcript: a final reply or a handback. */
  endedAt?: number
  /** Background tasks it started that haven't reported back yet, by task id. */
  pending: Set<string>
}

const metas = new Map<string, MetaState>()
const parses = new Map<string, AgentParse>()

function readMeta(file: string): MetaState | null {
  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    metas.delete(file)
    return null
  }
  const cached = metas.get(file)
  if (cached && cached.mtimeMs === mtimeMs) return cached
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as AgentMetaFile
    const state = { mtimeMs, meta: meta && typeof meta === 'object' ? meta : {} }
    metas.set(file, state)
    return state
  } catch {
    // Mid-rewrite: keep what we had.
    return cached ?? null
  }
}

/** First line of a reply, without the markdown headings agents like to open their reports with. */
function replyLine(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim() && !/^\s{0,3}#{1,6}\s/.test(l))
  return truncate((lines.join(' ') || text).replace(/(\*\*|__|`)/g, ''), 200)
}

const TASK_ID = /<task-id>([^<]+)<\/task-id>/g

function applyLine(s: AgentParse, line: Json) {
  const t = timeOf(line)
  if (t !== undefined) {
    if (s.startedAt === undefined || t < s.startedAt) s.startedAt = t
    if (s.updatedAt === undefined || t > s.updatedAt) s.updatedAt = t
  }
  if (line.type === 'user') {
    // A command it sent to the background, and later the notification that it ended.
    const taskId = line.toolUseResult?.backgroundTaskId
    if (typeof taskId === 'string' && taskId) s.pending.add(taskId)
    // The notification wakes the agent to deal with what finished.
    if (isTaskNotification(line)) {
      for (const m of messageText(line).matchAll(TASK_ID)) s.pending.delete(m[1].trim())
      s.endedAt = undefined
    }
    // A new message (the session writing to a resumed agent) starts more work.
    const content = line.message?.content
    const isPrompt =
      typeof content === 'string' || (Array.isArray(content) && !content.some((b) => b?.type === 'tool_result'))
    if (isPrompt && !line.isMeta && s.endedAt !== undefined) s.endedAt = undefined
    return
  }
  if (line.type !== 'assistant') return
  const { text, uses, handback } = assistantParts(line)
  s.toolCount += uses.length
  if (uses.length > 0) {
    const call = describeToolUse(uses[uses.length - 1])
    s.last = { tool: call.name, text: call.detail }
    s.endedAt = undefined
  } else if (text) {
    s.last = { text: replyLine(text) }
  }
  if (handback || (line.message?.stop_reason === 'end_turn' && uses.length === 0)) s.endedAt = t ?? Date.now()
}

function parseAgent(file: string): AgentParse | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    parses.delete(file)
    return null
  }
  const cached = parses.get(file)
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached
  // Append-only growth continues from where we stopped; anything else starts over.
  const s: AgentParse =
    cached && stat.size > cached.size ? cached : { size: 0, mtimeMs: 0, offset: 0, toolCount: 0, pending: new Set() }

  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return cached ?? null
  }
  try {
    let chunk = CHUNK_BYTES
    while (s.offset < stat.size) {
      const end = Math.min(stat.size, s.offset + chunk)
      const next = readLines(fd, s.offset, end, false, (l) => applyLine(s, l))
      if (next > s.offset) {
        s.offset = next
        chunk = CHUNK_BYTES
      } else if (end < stat.size) {
        // One line longer than the chunk: widen it.
        chunk *= 2
      } else {
        // The last line is still being written.
        break
      }
    }
    s.size = stat.size
    s.mtimeMs = stat.mtimeMs
    parses.set(file, s)
    return s
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Hooks decide while the session's process runs; an agent we heard nothing
 * from belongs to an earlier process, so it's done. One that ended its turn
 * with background work in flight will be woken by it, so it's still working.
 * When the transcript or the meta file says the agent ended after its last
 * hook, it ended without a SubagentStop reaching us.
 */
function statusOf(sessionId: string, agentId: string, parse: AgentParse, endedAt: number | undefined): SessionStatus {
  if (!isLive(sessionId)) return 'done'
  const hook = getAgentHook(sessionId, agentId)
  if (!hook) return 'done'
  if (parse.endedAt !== undefined && parse.pending.size > 0) {
    holdAgent(sessionId, agentId)
    return 'working'
  }
  if (hook.status === 'done') return 'done'
  if (endedAt !== undefined && endedAt >= hook.at) {
    settleAgent(sessionId, agentId)
    return 'done'
  }
  return hook.status
}

function readAgent(sessionId: string, { agentId, file, metaFile }: AgentFile): AgentInfo | null {
  const parse = parseAgent(file)
  if (!parse) return null
  const metaState = readMeta(metaFile)
  const meta = metaState?.meta ?? {}
  const stopped = meta.stoppedByUser === true
  const metaEnded = meta.finished === true || stopped ? metaState!.mtimeMs : undefined
  const endedAt =
    parse.endedAt !== undefined || metaEnded !== undefined
      ? Math.max(parse.endedAt ?? 0, metaEnded ?? 0)
      : undefined
  const startedAt = parse.startedAt ?? parse.mtimeMs
  const status = statusOf(sessionId, agentId, parse, endedAt)
  const waitingOn = status === 'working' && parse.endedAt !== undefined ? parse.pending.size : 0
  return {
    agentId,
    agentType: meta.agentType || 'agent',
    description: meta.description || meta.name || 'Agent',
    status,
    parentAgentId: meta.parentAgentId || undefined,
    stopped: stopped || undefined,
    tool: parse.last?.tool,
    activity: parse.last?.text,
    background: waitingOn || undefined,
    toolCount: parse.toolCount,
    startedAt,
    updatedAt: parse.updatedAt ?? startedAt
  }
}

const projectsRoot = path.join(os.homedir(), '.claude', 'projects') + path.sep

/**
 * Whether the agent with this transcript has background work that will wake
 * it again. Asked when its SubagentStop arrives, so it doesn't read as done meanwhile.
 */
export function hasPendingWork(transcriptPath: string): boolean {
  const file = path.resolve(transcriptPath)
  if (!file.startsWith(projectsRoot) || !file.endsWith('.jsonl')) return false
  return (parseAgent(file)?.pending.size ?? 0) > 0
}

/** Every subagent the session has started, oldest first. */
export function readAgents(repoPath: string, sessionId: string, files = listAgentFiles(repoPath, sessionId)) {
  const agents: AgentInfo[] = []
  for (const f of files) {
    const agent = readAgent(sessionId, f)
    if (agent) agents.push(agent)
  }
  return agents.sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * Adds a session's subagents to its card: how many it has started, and on an
 * active card the current run's, which are those still running and those that
 * finished since the user's last prompt.
 */
export function attachAgents(card: SessionCard, repoPath: string, lastPromptAt = 0) {
  if (card.kind === 'terminal') return
  const files = listAgentFiles(repoPath, card.sessionId)
  if (files.length === 0) return
  card.agentCount = files.length
  if (card.archived) return
  const current = readAgents(repoPath, card.sessionId, files).filter(
    (a) => a.status !== 'done' || a.updatedAt >= lastPromptAt
  )
  if (current.length > 0) card.agents = current
}
