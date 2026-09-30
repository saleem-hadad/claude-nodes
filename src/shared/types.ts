// Domain types shared by the main process, preload bridge and renderer.

/**
 * Live state of a Claude session, driven by Claude Code hooks.
 * - working: Claude is processing a turn (orange)
 * - waiting: Claude is blocked on the user, e.g. a permission prompt or a question (pulsing red)
 * - done:    the last turn finished, the process is gone, or the card is archived (blue)
 */
export type SessionStatus = 'working' | 'waiting' | 'done'

export type FolderColor = 'blue' | 'purple' | 'pink' | 'red' | 'orange' | 'yellow' | 'green' | 'graphite'

export interface Project {
  id: string
  name: string
  /** Absolute path to the local repository the sessions run in. */
  repoPath: string
  color: FolderColor
  createdAt: number
  /** Last time the project board was opened; used for "recent" ordering. */
  openedAt?: number
}

export interface ProjectStats {
  total: number
  active: number
  working: number
  waiting: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** Metadata read from a Claude Code transcript (~/.claude/projects/<encoded-path>/<id>.jsonl). */
export interface SessionMeta {
  sessionId: string
  /** custom-title > ai-title > first prompt (truncated). */
  title: string
  firstPrompt?: string
  lastPrompt?: string
  /** Last plain-text reply from Claude, truncated; shown as the card preview. */
  lastAssistantText?: string
  gitBranch?: string
  /** Number of user + assistant messages (tool noise excluded). */
  messageCount: number
  createdAt: number
  updatedAt: number
  transcriptPath: string
}

/** Board-level state the app owns for a session card. */
export interface BoardNode {
  sessionId: string
  x: number
  y: number
  archived: boolean
  /** User-provided title; overrides the transcript title. */
  title?: string
  /** Session ids whose context was merged to create this one (drawn as edges). */
  parents?: string[]
  /** True when the session was started from Claude Nodes (vs. imported). */
  createdByApp?: boolean
  createdAt: number
}

/** Everything the renderer needs to draw a card. */
export interface SessionCard extends BoardNode {
  meta?: SessionMeta
  status: SessionStatus
  /** Whether a claude process is currently running for this session. */
  live: boolean
}

export interface BoardSnapshot {
  project: Project
  cards: SessionCard[]
  archive: Rect
  viewport?: Viewport
}

export interface NodePatch {
  sessionId: string
  x?: number
  y?: number
  archived?: boolean
  title?: string
}

export interface CreateSessionOptions {
  x: number
  y: number
  /** Display name passed to `claude --name`. */
  name?: string
  /** First message sent to the new session (used by the merge feature). */
  initialPrompt?: string
  parents?: string[]
}

export interface SummaryResult {
  sessionId: string
  title: string
  summary: string
  error?: string
}

export type SummarizePhase = 'queued' | 'running' | 'done' | 'error'

export interface SummarizeProgress {
  requestId: string
  sessionId: string
  phase: SummarizePhase
  error?: string
}

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp: number
  /** Names of tools Claude called in this message, if any. */
  tools?: string[]
}

export interface OpenSessionResult {
  /** Buffered terminal output to replay into a fresh xterm instance. */
  replay: string
  live: boolean
}

export interface AppInfo {
  claudePath: string | null
  claudeVersion: string | null
  platform: string
}
