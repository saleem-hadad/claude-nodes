import { create } from 'zustand'
import type {
  BoardSection,
  BoardSnapshot,
  NodePatch,
  Project,
  ProjectStats,
  Rect,
  GitStatus,
  SessionCard,
  SessionStatus
} from '@shared/types'
import { dispose as disposeTerminal } from './terminal/registry'

export type Route = { view: 'projects' } | { view: 'board'; projectId: string }

interface AppState {
  route: Route
  projects: Project[]
  stats: Record<string, ProjectStats>

  /** Board of the project in the current route, or null on the projects view. */
  board: BoardSnapshot | null
  boardLoading: boolean
  /** Branch and changes of the open board's repository; null when it isn't one (or not loaded yet). */
  git: GitStatus | null
  /** The Changes (diff) modal is open. */
  diffOpen: boolean

  /** Session whose terminal modal is open. */
  terminalSessionId: string | null
  /** Archived session whose read-only transcript preview is open. */
  previewSessionId: string | null
  /** Session ids currently selected on the board. */
  selection: string[]
  /** The Settings dialog is open. It survives navigation. */
  settingsOpen: boolean

  navigate(route: Route): void
  refreshProjects(): Promise<void>
  loadBoard(projectId: string): Promise<void>
  /** Optimistically applies card patches locally and persists them. */
  patchCards(patches: NodePatch[]): void
  /** Inserts or replaces a card (e.g. after creating a session). */
  upsertCard(card: SessionCard): void
  removeCard(sessionId: string): Promise<void>
  setArchive(rect: Rect): void
  /** Creates or updates a section and persists it. */
  saveSection(section: BoardSection): void
  /** Deletes a section; its cards stay on the board, ungrouped. */
  removeSection(sectionId: string): void
  setStatus(sessionId: string, status: SessionStatus, live: boolean): void
  /** Re-reads the open board's git status. */
  refreshGit(): Promise<void>
  openDiff(): void
  closeDiff(): void

  openTerminal(sessionId: string): void
  closeTerminal(): void
  openPreview(sessionId: string): void
  closePreview(): void
  setSelection(ids: string[]): void
  openSettings(): void
  closeSettings(): void
}

const projectIdOf = (route: Route) => (route.view === 'board' ? route.projectId : null)

/** The git status read in flight, if any. */
let gitRead: { projectId: string; promise: Promise<void> } | null = null

export const useApp = create<AppState>((set, get) => ({
  route: { view: 'projects' },
  projects: [],
  stats: {},
  board: null,
  boardLoading: false,
  git: null,
  diffOpen: false,
  terminalSessionId: null,
  previewSessionId: null,
  selection: [],
  settingsOpen: false,

  navigate(route) {
    set({
      route,
      board: null,
      selection: [],
      terminalSessionId: null,
      previewSessionId: null,
      git: null,
      diffOpen: false
    })
    if (route.view === 'board') get().loadBoard(route.projectId)
    else get().refreshProjects()
  },

  async refreshProjects() {
    const [projects, stats] = await Promise.all([
      window.api.projects.list(),
      window.api.projects.stats()
    ])
    set({ projects, stats })
  },

  async loadBoard(projectId) {
    set({ boardLoading: get().board?.project.id !== projectId })
    try {
      const board = await window.api.board.load(projectId)
      // Ignore stale responses if the user navigated away meanwhile.
      if (projectIdOf(get().route) === projectId) set({ board })
    } finally {
      set({ boardLoading: false })
    }
  },

  patchCards(patches) {
    const board = get().board
    if (!board || patches.length === 0) return
    const byId = new Map(patches.map((p) => [p.sessionId, p]))
    set({
      board: {
        ...board,
        cards: board.cards.map((c) => {
          const p = byId.get(c.sessionId)
          if (!p) return c
          const { sectionId, ...rest } = p
          const next: SessionCard = { ...c, ...rest }
          if (sectionId !== undefined) next.sectionId = sectionId ?? undefined
          // Archived sessions always read as done.
          if (p.archived) next.status = 'done'
          if (p.archived && !c.archived) next.archivedAt = Date.now()
          // …leave their section, and fold back to a card.
          if (next.archived) {
            next.sectionId = undefined
            next.expanded = undefined
          }
          return next
        })
      }
    })
    window.api.board.saveNodes(board.project.id, patches)
  },

  upsertCard(card) {
    const board = get().board
    if (!board) return
    const exists = board.cards.some((c) => c.sessionId === card.sessionId)
    set({
      board: {
        ...board,
        cards: exists
          ? board.cards.map((c) => (c.sessionId === card.sessionId ? card : c))
          : [...board.cards, card]
      }
    })
  },

  async removeCard(sessionId) {
    const board = get().board
    if (!board) return
    set({
      board: { ...board, cards: board.cards.filter((c) => c.sessionId !== sessionId) },
      selection: get().selection.filter((id) => id !== sessionId)
    })
    disposeTerminal(sessionId)
    await window.api.board.removeNode(board.project.id, sessionId)
  },

  setArchive(rect) {
    const board = get().board
    if (!board) return
    set({ board: { ...board, archive: rect } })
    window.api.board.saveArchive(board.project.id, rect)
  },

  saveSection(section) {
    const board = get().board
    if (!board) return
    const exists = board.sections.some((s) => s.id === section.id)
    set({
      board: {
        ...board,
        sections: exists
          ? board.sections.map((s) => (s.id === section.id ? section : s))
          : [...board.sections, section]
      }
    })
    window.api.board.saveSection(board.project.id, section)
  },

  removeSection(sectionId) {
    const board = get().board
    if (!board) return
    set({
      board: {
        ...board,
        sections: board.sections.filter((s) => s.id !== sectionId),
        cards: board.cards.map((c) => (c.sectionId === sectionId ? { ...c, sectionId: undefined } : c))
      }
    })
    window.api.board.removeSection(board.project.id, sectionId)
  },

  setStatus(sessionId, status, live) {
    const board = get().board
    if (!board) return
    set({
      board: {
        ...board,
        cards: board.cards.map((c) =>
          c.sessionId === sessionId
            ? { ...c, status: c.archived ? 'done' : status, live }
            : c
        )
      }
    })
  },

  refreshGit() {
    const projectId = projectIdOf(get().route)
    if (!projectId) return Promise.resolve()
    // Focus, status and the poll timer often fire together: share one read.
    if (gitRead?.projectId === projectId) return gitRead.promise
    const promise = window.api.git
      .status(projectId)
      .catch(() => null)
      .then((git) => {
        if (projectIdOf(get().route) !== projectId) return
        // Polled every few seconds: keep the old object when nothing changed, so nothing re-renders.
        if (JSON.stringify(git) !== JSON.stringify(get().git)) set({ git })
      })
      .finally(() => {
        if (gitRead?.promise === promise) gitRead = null
      })
    gitRead = { projectId, promise }
    return promise
  },

  openTerminal: (sessionId) => set({ terminalSessionId: sessionId, previewSessionId: null }),
  closeTerminal: () => set({ terminalSessionId: null }),
  openPreview: (sessionId) => set({ previewSessionId: sessionId, terminalSessionId: null }),
  closePreview: () => set({ previewSessionId: null }),
  openDiff: () => set({ diffOpen: true }),
  closeDiff: () => set({ diffOpen: false }),
  setSelection: (ids) => set({ selection: ids }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false })
}))

/** The card for a session on the current board, if any. */
export function useCard(sessionId: string | null): SessionCard | undefined {
  return useApp((s) =>
    sessionId ? s.board?.cards.find((c) => c.sessionId === sessionId) : undefined
  )
}

export function isTerminal(card: SessionCard | undefined): boolean {
  return card?.kind === 'terminal'
}

/** Abbreviates the home directory to ~, as a shell prompt does. */
export function tildePath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~')
}

/** Title shown for a card: user override > transcript title > placeholder. */
export function cardTitle(card: SessionCard | undefined): string {
  return card?.title || card?.meta?.title || (isTerminal(card) ? 'Terminal' : 'New session')
}
