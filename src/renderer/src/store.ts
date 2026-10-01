import { create } from 'zustand'
import type {
  BoardSection,
  BoardSnapshot,
  NodePatch,
  Project,
  ProjectStats,
  Rect,
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

  /** Session whose terminal modal is open. */
  terminalSessionId: string | null
  /** Archived session whose read-only transcript preview is open. */
  previewSessionId: string | null
  /** Session ids currently selected on the board. */
  selection: string[]

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

  openTerminal(sessionId: string): void
  closeTerminal(): void
  openPreview(sessionId: string): void
  closePreview(): void
  setSelection(ids: string[]): void
}

const projectIdOf = (route: Route) => (route.view === 'board' ? route.projectId : null)

export const useApp = create<AppState>((set, get) => ({
  route: { view: 'projects' },
  projects: [],
  stats: {},
  board: null,
  boardLoading: false,
  terminalSessionId: null,
  previewSessionId: null,
  selection: [],

  navigate(route) {
    set({
      route,
      board: null,
      selection: [],
      terminalSessionId: null,
      previewSessionId: null
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

  openTerminal: (sessionId) => set({ terminalSessionId: sessionId, previewSessionId: null }),
  closeTerminal: () => set({ terminalSessionId: null }),
  openPreview: (sessionId) => set({ previewSessionId: sessionId, terminalSessionId: null }),
  closePreview: () => set({ previewSessionId: null }),
  setSelection: (ids) => set({ selection: ids })
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
