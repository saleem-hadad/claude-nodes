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
  /** Archived projects are listed apart on the projects grid and left out of the board's project rail. */
  archived?: boolean
  /** The group the project is filed under; ungrouped when unset. */
  groupId?: string
  /** The project's action buttons, in the order the dock lists them. */
  actions?: ProjectAction[]
}

/**
 * A button in the board's actions rail. Claude drafts it from what the user
 * describes; each press starts a session on its prompt, in auto mode, that
 * shows beside the button rather than on the board and goes once it finishes.
 */
export interface ProjectAction {
  id: string
  name: string
  /** One of ACTION_ICONS (src/shared/actions.ts). */
  icon: string
  /** What the user asked for, kept so the action can be redrafted. */
  description: string
  /** The run's first prompt. */
  prompt: string
  /** In every project's rail, and kept app-wide rather than with one project. */
  global?: boolean
  createdAt: number
}

/** A project's own actions, and the global ones every project shares. */
export interface ActionLists {
  project: Project
  global: ProjectAction[]
}

/** Claude's draft of an action, for the user to review before saving. */
export type ActionDraft = Pick<ProjectAction, 'name' | 'icon' | 'prompt'>

/** An action run that finished and left the board, with Claude's last word on it. */
export interface ActionRunResult {
  projectId: string
  sessionId: string
  actionName: string
  message?: string
}

/** A named set of projects (e.g. infra repos), shown as its own section on the projects grid. */
export interface ProjectGroup {
  id: string
  name: string
  createdAt: number
  /** Folded away on the projects grid. */
  collapsed?: boolean
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

/**
 * What a card runs:
 * - claude:   a Claude Code session (the default)
 * - terminal: a plain login shell in the project folder; never archived, no transcript
 */
export type SessionKind = 'claude' | 'terminal'

/** Board-level state the app owns for a session card. */
export interface BoardNode {
  sessionId: string
  /** Absent on cards saved before terminals existed; those are Claude sessions. */
  kind?: SessionKind
  x: number
  y: number
  archived: boolean
  /** When the card was last archived; puts it on top of the archive stack. */
  archivedAt?: number
  /** User-provided title; overrides the transcript title. */
  title?: string
  /** Session ids whose context was merged to create this one (drawn as edges). */
  parents?: string[]
  /** True when the session was started from Claude Nodes (vs. imported). */
  createdByApp?: boolean
  /** Section the card is grouped under. Archived cards never belong to one. */
  sectionId?: string
  /** The card is expanded in place, showing its terminal on the board. Active cards only. */
  expanded?: boolean
  /** Size of the expanded card, once it has been resized. */
  w?: number
  h?: number
  /**
   * The action this session is a run of. Runs aren't drawn on the board, and
   * go when their turn ends; one the user takes over joins the board.
   */
  runOf?: string
  createdAt: number
}

/**
 * A named frame grouping active cards on the board. The frame is drawn around
 * its cards, so it grows and shrinks with them; x/y is its top-left corner,
 * which is where it stays while it has no cards.
 */
export interface BoardSection {
  id: string
  /** Empty until the user names it. */
  name: string
  color: FolderColor
  x: number
  y: number
  createdAt: number
}

/** A sticky note on the board: a reminder or scratch text, with no session behind it. */
export interface BoardNote {
  id: string
  text: string
  color: FolderColor
  x: number
  y: number
  /** Size of the note, once it has been resized. */
  w?: number
  h?: number
  /**
   * The session started from the note. It's drawn as a sticker on that
   * session's card, rather than on the board, until the card leaves.
   */
  sessionId?: string
  createdAt: number
}

/**
 * A subagent a session started with Claude's Agent tool. Claude Code keeps its
 * transcript beside the session's, in <session id>/subagents/agent-<id>.jsonl.
 */
export interface AgentInfo {
  agentId: string
  /** e.g. general-purpose, Explore, fork, or a custom agent's name. */
  agentType: string
  /** The short task description Claude gave the agent. */
  description: string
  /** Driven by the hooks Claude runs inside the agent; done once the session's process is gone. */
  status: SessionStatus
  /** Set when the agent was started by another agent rather than by the session. */
  parentAgentId?: string
  /** The user stopped it before it finished. */
  stopped?: boolean
  /** The tool it is running (or last ran), when its latest step was a tool call. */
  tool?: string
  /** One line on its latest step: what the tool acted on, or what it said. */
  activity?: string
  /**
   * Background commands it is waiting on, having ended its turn. Each wakes it
   * when it finishes, so it reads as working meanwhile.
   */
  background?: number
  toolCount: number
  startedAt: number
  updatedAt: number
}

/** Everything the renderer needs to draw a card. */
export interface SessionCard extends BoardNode {
  meta?: SessionMeta
  status: SessionStatus
  /** Whether a claude process is currently running for this session. */
  live: boolean
  /**
   * Subagents of the current run, oldest first: those still running, and those
   * that finished since the last prompt. Active Claude cards only.
   */
  agents?: AgentInfo[]
  /** How many subagents the session has started in all. */
  agentCount?: number
  /** What Claude last reported about the session's model, context and cost. Claude cards only. */
  usage?: SessionUsage
}

/**
 * What Claude Code reports to its status line, which sessions started from
 * the app send to us instead of drawing in the terminal.
 */
export interface SessionUsage {
  /** e.g. Opus 5.5 */
  model?: string
  /** Share of the context window in use, 0–100. Unknown before the first reply. */
  contextPercent?: number
  /** Tokens in the context window, and its size. */
  contextTokens?: number
  contextSize?: number
  costUsd?: number
  /**
   * Time the session has been running as of `at`, carried across resumes.
   * It keeps counting while the process is live.
   */
  durationMs?: number
  at: number
}

export interface BoardSnapshot {
  project: Project
  cards: SessionCard[]
  archive: Rect
  sections: BoardSection[]
  notes: BoardNote[]
  viewport?: Viewport
}

export interface NodePatch {
  sessionId: string
  x?: number
  y?: number
  archived?: boolean
  title?: string
  /** null takes the card out of its section. */
  sectionId?: string | null
  expanded?: boolean
  w?: number
  h?: number
}

export interface CreateSessionOptions {
  x: number
  y: number
  /** Defaults to 'claude'. Terminals ignore name, initialPrompt and parents. */
  kind?: SessionKind
  /** Display name passed to `claude --name`. */
  name?: string
  /** First message sent to the new session (used by the merge feature). */
  initialPrompt?: string
  parents?: string[]
  /** Runs this project action: its prompt, auto mode and board tools. Claude sessions only. */
  actionId?: string
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

export interface ToolCall {
  name: string
  /** What the call acted on, in one line: a command, a file name, a pattern. */
  detail?: string
}

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp: number
  /** Names of tools Claude called in this message, if any. */
  tools?: string[]
  /** The same calls with what each acted on; agent transcripts only. */
  calls?: ToolCall[]
  /** A note from Claude Code rather than a message, such as a background task finishing. */
  notice?: boolean
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

/** 'system' follows the macOS appearance; the others pin the app to it. */
export type ThemePreference = 'system' | 'light' | 'dark'

/** App-wide preferences, persisted with the rest of the state. */
export interface AppSettings {
  theme: ThemePreference
}

/**
 * How a changed file differs from HEAD. Untracked files are new files git
 * doesn't know about yet; they read as added in the UI.
 */
export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted' | 'untracked'

export interface GitFileChange {
  /** Path relative to the repository root. */
  path: string
  /** For renames, the path in HEAD. */
  oldPath?: string
  status: GitFileStatus
}

/** The project's repository: its branch and uncommitted changes. */
export interface GitStatus {
  /** Null on a detached HEAD. */
  branch: string | null
  /** The commit HEAD points at; null before the first commit. */
  oid: string | null
  upstream?: string
  /** Commits ahead of / behind the upstream branch. */
  ahead: number
  behind: number
  files: GitFileChange[]
}

export interface GitFileDiff {
  /** Unified diff of the file against HEAD; empty for binary or oversized diffs. */
  patch: string
  binary?: boolean
  tooLarge?: boolean
}
