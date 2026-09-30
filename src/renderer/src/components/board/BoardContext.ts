import { createContext, useContext } from 'react'

export interface BoardActions {
  /** Commits a new title for a card (empty clears the override). */
  rename(sessionId: string, title: string): void
  /** Starts or stops inline renaming of a card or section. */
  setRenaming(id: string | null): void
  /** Commits a new name for a section (empty leaves it untitled). */
  renameSection(sectionId: string, name: string): void
}

export const BoardActionsContext = createContext<BoardActions | null>(null)

export function useBoardActions(): BoardActions {
  const ctx = useContext(BoardActionsContext)
  if (!ctx) throw new Error('useBoardActions must be used inside the board')
  return ctx
}

/** Session or section id currently being renamed inline, if any. */
export const RenamingContext = createContext<string | null>(null)

/** True while a dragged card hovers over the archive zone. */
export const ArchiveHotContext = createContext(false)

/** The section a dragged card would join if dropped now, if any. */
export const SectionHotContext = createContext<string | null>(null)

/** UI state of the archive stack. */
export interface ArchiveStack {
  /** The search panel is open with results fanned out of the stack. */
  open: boolean
  /** The pointer is over the stack, which reveals the search field. */
  hover: boolean
  query: string
  resultCount: number
  setQuery(query: string): void
  openStack(): void
  closeStack(): void
  /** Opens the first result (Enter in the search field). */
  submit(): void
}

export const ArchiveStackContext = createContext<ArchiveStack>({
  open: false,
  hover: false,
  query: '',
  resultCount: 0,
  setQuery: () => {},
  openStack: () => {},
  closeStack: () => {},
  submit: () => {}
})
