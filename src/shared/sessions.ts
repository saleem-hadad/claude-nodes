// Shared by the main process, which removes empty sessions rather than
// archiving them, and the renderer, which takes their cards off the board
// straight away.
import type { SessionMeta } from './types'

/** Nothing was said in the session: no prompt typed (slash commands aside), and no reply. */
export function isEmptySession(meta: SessionMeta | undefined): boolean {
  return !meta?.firstPrompt && !meta?.lastAssistantText
}
