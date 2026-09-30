import { createContext, useContext } from 'react'

export interface BoardActions {
  /** Commits a new title for a card (empty clears the override). */
  rename(sessionId: string, title: string): void
  /** Starts or stops inline renaming of a card. */
  setRenaming(sessionId: string | null): void
}

export const BoardActionsContext = createContext<BoardActions | null>(null)

export function useBoardActions(): BoardActions {
  const ctx = useContext(BoardActionsContext)
  if (!ctx) throw new Error('useBoardActions must be used inside the board')
  return ctx
}

/** Session id currently being renamed inline, if any. */
export const RenamingContext = createContext<string | null>(null)

/** True while a dragged card hovers over the archive zone. */
export const ArchiveHotContext = createContext(false)
