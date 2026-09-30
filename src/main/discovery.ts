// Reads Claude Code transcripts from ~/.claude/projects/<encoded-repo-path>/.
//
// Transcripts are append-only JSONL, so parsed metadata is cached per file and
// updated incrementally from the last byte offset when the file grows.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SessionMeta, TranscriptMessage } from '@shared/types'

const LARGE_FILE = 4 * 1024 * 1024
const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 1024 * 1024
const TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024
const TRANSCRIPT_MAX_MESSAGES = 500

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

/** User-message text that is tooling noise rather than something the user typed. */
const NOISE_PREFIXES = [
  '<local-command-',
  '<system-reminder>',
  'Caveat:',
  '[Request interrupted',
  '<task-notification',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<user-prompt-submit-hook>',
  'Base directory for this skill',
  'This session is being continued from a previous conversation'
]

// ---------------------------------------------------------------------------
// Paths

export function realRepoPath(repoPath: string) {
  try {
    return fs.realpathSync(repoPath)
  } catch {
    return repoPath
  }
}

export function encodeRepoPath(repoPath: string) {
  return realRepoPath(repoPath).replace(/[^a-zA-Z0-9]/g, '-')
}

export function transcriptDir(repoPath: string) {
  return path.join(os.homedir(), '.claude', 'projects', encodeRepoPath(repoPath))
}

export function transcriptPath(repoPath: string, sessionId: string) {
  return path.join(transcriptDir(repoPath), `${sessionId}.jsonl`)
}

export function listSessionFiles(repoPath: string): { sessionId: string; file: string }[] {
  const dir = transcriptDir(repoPath)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => SESSION_FILE.test(n))
    .map((n) => ({ sessionId: n.slice(0, -'.jsonl'.length), file: path.join(dir, n) }))
}

// ---------------------------------------------------------------------------
// Line helpers

type Json = Record<string, any>

interface UserText {
  text: string
  isCommand: boolean
}

const PASTED_BLOCK = /<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g
const PASTED_TAG = /<\/?pasted_content[^>]*>/g

function stripReminders(text: string) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

/** Prompt text for titles and card previews: pasted blocks collapse to a placeholder. */
function promptSummary(text: string) {
  return text.replace(PASTED_BLOCK, '[Pasted text]').replace(PASTED_TAG, '')
}

/** Prompt text for the transcript preview: pasted content is kept, its tags dropped. */
function promptFull(text: string) {
  return text.replace(PASTED_TAG, '').trim()
}

function truncate(text: string, max: number) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** Returns the prompt the user typed, or null for tool results, meta and noise. */
function userText(line: Json): UserText | null {
  if (line.isMeta || line.isCompactSummary || line.isVisibleInTranscriptOnly) return null
  const origin = line.origin?.kind
  if (origin && origin !== 'human') return null

  const content = line.message?.content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    if (content.some((b) => b?.type === 'tool_result')) return null
    text = content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  text = text.trim()
  if (!text) return null

  if (text.startsWith('<command-name>') || text.startsWith('<command-message>')) {
    const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim()
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
    if (!name) return null
    return { text: [name.startsWith('/') ? name : `/${name}`, args].filter(Boolean).join(' '), isCommand: true }
  }
  if (NOISE_PREFIXES.some((p) => text.startsWith(p))) return null

  const cleaned = stripReminders(text)
  return cleaned ? { text: cleaned, isCommand: false } : null
}

function assistantParts(line: Json): { text: string; tools: string[] } {
  const content = line.message?.content
  if (typeof content === 'string') return { text: content.trim(), tools: [] }
  if (!Array.isArray(content)) return { text: '', tools: [] }
  const text = content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
  const tools = content
    .filter((b) => b?.type === 'tool_use' && typeof b.name === 'string')
    .map((b) => b.name as string)
  return { text, tools }
}

function timeOf(line: Json): number | undefined {
  if (typeof line.timestamp !== 'string') return undefined
  const t = Date.parse(line.timestamp)
  return Number.isNaN(t) ? undefined : t
}

// ---------------------------------------------------------------------------
// Chunked reading

/** Parses complete JSON lines from a byte range. Returns the offset after the last newline. */
function readLines(
  fd: number,
  start: number,
  end: number,
  skipFirstPartial: boolean,
  onLine: (line: Json) => void
): number {
  const length = end - start
  if (length <= 0) return start
  const buf = Buffer.allocUnsafe(length)
  let read = 0
  while (read < length) {
    const n = fs.readSync(fd, buf, read, length - read, start + read)
    if (n <= 0) break
    read += n
  }
  let from = 0
  if (skipFirstPartial) {
    const nl = buf.indexOf(0x0a)
    if (nl < 0 || nl >= read) return start
    from = nl + 1
  }
  const lastNl = buf.lastIndexOf(0x0a, read - 1)
  if (lastNl < from) return start + from
  const text = buf.toString('utf8', from, lastNl)
  for (const raw of text.split('\n')) {
    if (!raw) continue
    try {
      onLine(JSON.parse(raw))
    } catch {
      // Ignore malformed or partially written lines.
    }
  }
  return start + lastNl + 1
}

// ---------------------------------------------------------------------------
// Metadata

interface ParseState {
  size: number
  mtimeMs: number
  offset: number
  sidechain?: boolean
  customTitle?: string
  aiTitle?: string
  firstPrompt?: string
  firstCommand?: string
  lastPrompt?: string
  lastAssistantText?: string
  lastAssistantId?: string
  gitBranch?: string
  prompts: number
  replies: number
  hasAssistant: boolean
  createdAt?: number
  updatedAt?: number
}

const cache = new Map<string, ParseState>()

function freshState(size: number, mtimeMs: number): ParseState {
  return { size, mtimeMs, offset: 0, prompts: 0, replies: 0, hasAssistant: false }
}

function applyLine(s: ParseState, line: Json) {
  const t = timeOf(line)
  if (t !== undefined) {
    if (s.createdAt === undefined || t < s.createdAt) s.createdAt = t
    if (s.updatedAt === undefined || t > s.updatedAt) s.updatedAt = t
  }
  if (typeof line.gitBranch === 'string' && line.gitBranch) s.gitBranch = line.gitBranch

  switch (line.type) {
    case 'custom-title':
      if (typeof line.customTitle === 'string' && line.customTitle.trim()) s.customTitle = line.customTitle.trim()
      return
    case 'ai-title':
      if (typeof line.aiTitle === 'string' && line.aiTitle.trim()) s.aiTitle = line.aiTitle.trim()
      return
    case 'summary':
      // Older transcripts stored a generated title as a summary line.
      if (!s.aiTitle && typeof line.summary === 'string' && line.summary.trim()) s.aiTitle = line.summary.trim()
      return
    case 'user': {
      if (s.sidechain === undefined && typeof line.isSidechain === 'boolean') s.sidechain = line.isSidechain
      const u = userText(line)
      if (!u) return
      s.prompts++
      if (u.isCommand) {
        s.firstCommand ??= u.text
      } else {
        s.firstPrompt ??= promptSummary(u.text)
        s.lastPrompt = promptSummary(u.text)
      }
      return
    }
    case 'assistant': {
      if (s.sidechain === undefined && typeof line.isSidechain === 'boolean') s.sidechain = line.isSidechain
      const { text, tools } = assistantParts(line)
      if (text || tools.length) s.hasAssistant = true
      if (!text) return
      s.lastAssistantText = text
      // One API message can be split across several lines; count it once.
      const id = line.message?.id
      if (!id || id !== s.lastAssistantId) s.replies++
      if (id) s.lastAssistantId = id
      return
    }
  }
}

function parseFile(file: string): ParseState | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    cache.delete(file)
    return null
  }
  const cached = cache.get(file)
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached

  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return cached ?? null
  }
  try {
    if (cached && stat.size > cached.size) {
      // Append-only growth: parse just the new bytes.
      cached.offset = readLines(fd, cached.offset, stat.size, false, (l) => applyLine(cached, l))
      cached.size = stat.size
      cached.mtimeMs = stat.mtimeMs
      return cached
    }

    const s = freshState(stat.size, stat.mtimeMs)
    if (stat.size > LARGE_FILE) {
      // Big transcripts: the head has the first prompt, the tail has titles and the latest reply.
      readLines(fd, 0, HEAD_BYTES, false, (l) => applyLine(s, l))
      s.offset = readLines(fd, stat.size - TAIL_BYTES, stat.size, true, (l) => applyLine(s, l))
    } else {
      s.offset = readLines(fd, 0, stat.size, false, (l) => applyLine(s, l))
    }
    cache.set(file, s)
    return s
  } finally {
    fs.closeSync(fd)
  }
}

export interface DiscoveredSession {
  meta: SessionMeta
  /** Worth importing: a real conversation, not a sidechain or an empty/command-only file. */
  eligible: boolean
  /** Has at least a prompt or a title; otherwise the meta is not worth showing. */
  hasContent: boolean
}

export function readSession(sessionId: string, file: string): DiscoveredSession | null {
  const s = parseFile(file)
  if (!s) return null
  const mtime = s.mtimeMs
  const fallbackTitle = s.firstPrompt ?? s.firstCommand
  const meta: SessionMeta = {
    sessionId,
    title: s.customTitle || s.aiTitle || (fallbackTitle ? truncate(fallbackTitle, 80) : 'Untitled session'),
    firstPrompt: s.firstPrompt ? truncate(s.firstPrompt, 500) : undefined,
    lastPrompt: s.lastPrompt ? truncate(s.lastPrompt, 500) : undefined,
    lastAssistantText: s.lastAssistantText ? truncate(s.lastAssistantText, 400) : undefined,
    gitBranch: s.gitBranch,
    messageCount: s.prompts + s.replies,
    createdAt: s.createdAt ?? mtime,
    updatedAt: s.updatedAt ?? mtime,
    transcriptPath: file
  }
  const eligible = s.sidechain !== true && s.prompts > 0 && s.hasAssistant
  const hasContent = s.prompts > 0 || !!s.customTitle || !!s.aiTitle
  return { meta, eligible, hasContent }
}

/** All sessions on disk for a repo, keyed by session id. */
export function scanRepo(repoPath: string): Map<string, DiscoveredSession> {
  const out = new Map<string, DiscoveredSession>()
  for (const { sessionId, file } of listSessionFiles(repoPath)) {
    const found = readSession(sessionId, file)
    if (found) out.set(sessionId, found)
  }
  return out
}

/** A compact fingerprint used to detect meaningful changes for the watcher. */
export function metaSignature(meta: SessionMeta) {
  return [meta.title, meta.messageCount, meta.updatedAt, meta.gitBranch, meta.lastAssistantText?.length].join('|')
}

// ---------------------------------------------------------------------------
// Transcript for the archived preview

export function readTranscript(file: string): TranscriptMessage[] {
  let size: number
  try {
    size = fs.statSync(file).size
  } catch {
    return []
  }
  const messages: TranscriptMessage[] = []
  let turn: TranscriptMessage | null = null
  let lastAssistantId: string | undefined

  const fd = fs.openSync(file, 'r')
  try {
    const start = Math.max(0, size - TRANSCRIPT_MAX_BYTES)
    readLines(fd, start, size, start > 0, (line) => {
      if (line.isSidechain) return
      if (line.type === 'user') {
        const u = userText(line)
        if (!u) return
        turn = null
        messages.push({ role: 'user', text: promptFull(u.text), timestamp: timeOf(line) ?? 0 })
      } else if (line.type === 'assistant') {
        const { text, tools } = assistantParts(line)
        if (!text && !tools.length) return
        // Consecutive assistant lines (tool loops) form one turn in the preview.
        if (!turn) {
          turn = { role: 'assistant', text: '', timestamp: timeOf(line) ?? 0, tools: [] }
          messages.push(turn)
        }
        if (text) {
          const id = line.message?.id
          const sameMessage = id && id === lastAssistantId
          turn.text = turn.text ? `${turn.text}${sameMessage ? '\n' : '\n\n'}${text}` : text
        }
        lastAssistantId = line.message?.id
        for (const tool of tools) turn.tools!.push(tool)
      }
    })
  } finally {
    fs.closeSync(fd)
  }

  for (const m of messages) if (m.tools && m.tools.length === 0) delete m.tools
  return messages.slice(-TRANSCRIPT_MAX_MESSAGES)
}

// ---------------------------------------------------------------------------
// Watching

interface Watch {
  repoPath: string
  watcher: fs.FSWatcher | null
  poll: NodeJS.Timeout | null
  debounce: NodeJS.Timeout | null
  lastEmit: number
  signatures: Map<string, string>
}

const watches = new Map<string, Watch>()

function snapshotSignatures(repoPath: string) {
  const sigs = new Map<string, string>()
  for (const [id, s] of scanRepo(repoPath)) sigs.set(id, metaSignature(s.meta))
  return sigs
}

/**
 * Watches a project's transcript directory and calls onChange (throttled) when
 * a session's metadata changes or a new session appears.
 */
export function watchProject(projectId: string, repoPath: string, onChange: () => void) {
  const existing = watches.get(projectId)
  if (existing && existing.repoPath === repoPath) return
  if (existing) unwatchProject(projectId)

  const w: Watch = {
    repoPath,
    watcher: null,
    poll: null,
    debounce: null,
    lastEmit: 0,
    signatures: snapshotSignatures(repoPath)
  }
  watches.set(projectId, w)

  const check = () => {
    w.debounce = null
    const wait = w.lastEmit + 1500 - Date.now()
    if (wait > 0) {
      w.debounce = setTimeout(check, wait)
      return
    }
    const next = snapshotSignatures(repoPath)
    let changed = next.size !== w.signatures.size
    if (!changed) {
      for (const [id, sig] of next) {
        if (w.signatures.get(id) !== sig) {
          changed = true
          break
        }
      }
    }
    w.signatures = next
    if (changed) {
      w.lastEmit = Date.now()
      onChange()
    }
  }

  const schedule = () => {
    if (w.debounce) clearTimeout(w.debounce)
    w.debounce = setTimeout(check, 500)
  }

  const attach = () => {
    const dir = transcriptDir(repoPath)
    if (!fs.existsSync(dir)) return false
    try {
      w.watcher = fs.watch(dir, { persistent: false }, schedule)
      w.watcher.on('error', () => {
        w.watcher?.close()
        w.watcher = null
      })
      return true
    } catch {
      return false
    }
  }

  // The directory only exists after the first session in the repo; poll until then.
  if (!attach()) {
    w.poll = setInterval(() => {
      if (attach()) {
        clearInterval(w.poll!)
        w.poll = null
        schedule()
      }
    }, 3000)
  }
}

export function unwatchProject(projectId: string) {
  const w = watches.get(projectId)
  if (!w) return
  w.watcher?.close()
  if (w.poll) clearInterval(w.poll)
  if (w.debounce) clearTimeout(w.debounce)
  watches.delete(projectId)
}

export function unwatchAll() {
  for (const id of [...watches.keys()]) unwatchProject(id)
}
