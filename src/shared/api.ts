// The typed bridge exposed on `window.api` by the preload script, plus the IPC
// channel names it maps to. Main-process handlers in src/main/ipc.ts implement
// exactly these channels.
import type {
  AppInfo,
  BoardSnapshot,
  CreateSessionOptions,
  FolderColor,
  NodePatch,
  OpenSessionResult,
  Project,
  ProjectStats,
  Rect,
  SessionCard,
  SessionStatus,
  SummarizeProgress,
  SummaryResult,
  TranscriptMessage,
  Viewport
} from './types'

export const IPC = {
  appInfo: 'app:info',

  projectsList: 'projects:list',
  projectsAdd: 'projects:add',
  projectsUpdate: 'projects:update',
  projectsRemove: 'projects:remove',
  projectsReveal: 'projects:reveal',
  projectsStats: 'projects:stats',

  boardLoad: 'board:load',
  boardSaveNodes: 'board:save-nodes',
  boardSaveArchive: 'board:save-archive',
  boardSaveViewport: 'board:save-viewport',
  boardRemoveNode: 'board:remove-node',

  sessionCreate: 'session:create',
  sessionOpen: 'session:open',
  sessionWrite: 'session:write',
  sessionResize: 'session:resize',
  sessionKill: 'session:kill',
  sessionTranscript: 'session:transcript',
  sessionSummarize: 'session:summarize',

  // main -> renderer events
  evPtyData: 'ev:pty-data',
  evPtyExit: 'ev:pty-exit',
  evStatus: 'ev:status',
  evBoardChanged: 'ev:board-changed',
  evSummarizeProgress: 'ev:summarize-progress',
  evMenu: 'ev:menu'
} as const

/**
 * Commands sent from the native application menu. The menu owns the
 * shortcuts so they work even while a terminal has keyboard focus.
 * - close:       Cmd+W — closes the open modal, else goes back to projects (never closes the window)
 * - new-session: Cmd+N — new Claude session on the open board
 * - new-project: Cmd+Shift+N — add a project folder
 */
export type MenuCommand = 'close' | 'new-session' | 'new-project'

export type Unsubscribe = () => void

export interface Api {
  appInfo(): Promise<AppInfo>
  /** Absolute path of a File from a drag-and-drop event ('' if it has none). */
  pathForFile(file: File): string

  projects: {
    list(): Promise<Project[]>
    /**
     * Adds a project for a local folder. Without a path, opens a native folder
     * picker and resolves null if the user cancels. Adding a folder that is
     * already a project returns the existing project.
     */
    add(repoPath?: string): Promise<Project | null>
    update(id: string, patch: { name?: string; color?: FolderColor }): Promise<Project>
    remove(id: string): Promise<void>
    revealInFinder(id: string): Promise<void>
    stats(): Promise<Record<string, ProjectStats>>
  }

  board: {
    /**
     * Loads the board for a project. Sessions found on disk that are not on the
     * board yet are added inside the archive area.
     */
    load(projectId: string): Promise<BoardSnapshot>
    saveNodes(projectId: string, patches: NodePatch[]): Promise<void>
    saveArchive(projectId: string, rect: Rect): Promise<void>
    saveViewport(projectId: string, viewport: Viewport): Promise<void>
    /** Removes a card from the board (the transcript on disk is untouched). */
    removeNode(projectId: string, sessionId: string): Promise<void>
  }

  sessions: {
    /** Creates a card and starts a new `claude` process for it. */
    create(projectId: string, opts: CreateSessionOptions): Promise<SessionCard>
    /** Ensures a process is running (resuming if needed) and returns output to replay. */
    open(projectId: string, sessionId: string, cols: number, rows: number): Promise<OpenSessionResult>
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    kill(sessionId: string): Promise<void>
    transcript(projectId: string, sessionId: string): Promise<TranscriptMessage[]>
    /** Asks a forked, non-persisted copy of each session to summarize itself. */
    summarize(projectId: string, sessionIds: string[], requestId: string): Promise<SummaryResult[]>
  }

  on: {
    ptyData(cb: (sessionId: string, data: string) => void): Unsubscribe
    ptyExit(cb: (sessionId: string, exitCode: number) => void): Unsubscribe
    status(cb: (sessionId: string, status: SessionStatus, live: boolean) => void): Unsubscribe
    /** Transcripts or board state changed on disk; the renderer should reload the board. */
    boardChanged(cb: (projectId: string) => void): Unsubscribe
    summarizeProgress(cb: (progress: SummarizeProgress) => void): Unsubscribe
    menu(cb: (command: MenuCommand) => void): Unsubscribe
  }
}
