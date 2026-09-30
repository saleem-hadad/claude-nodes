// Merges sessions found on disk with the stored board and lays out new ones.
import fs from 'fs'
import type { BoardNode, BoardSnapshot, Project, ProjectStats, Rect, SessionCard } from '@shared/types'
import { scanRepo, transcriptDir, transcriptPath, type DiscoveredSession } from './discovery'
import { getStatus } from './hooks'
import { isLive } from './pty'
import { getBoard, save, type BoardState } from './store'

export const CARD_W = 288
export const CARD_H = 216
const GAP = 24
const PAD_X = 40
const PAD_TOP = 64
const PAD_BOTTOM = 40

function columnsFor(archive: Rect) {
  return Math.max(1, Math.floor((archive.w - 2 * PAD_X + GAP) / (CARD_W + GAP)))
}

function slotPosition(archive: Rect, index: number, cols: number) {
  return {
    x: archive.x + PAD_X + (index % cols) * (CARD_W + GAP),
    y: archive.y + PAD_TOP + Math.floor(index / cols) * (CARD_H + GAP)
  }
}

function slotIndexOf(archive: Rect, node: BoardNode, cols: number): number | null {
  const col = Math.round((node.x - archive.x - PAD_X) / (CARD_W + GAP))
  const row = Math.round((node.y - archive.y - PAD_TOP) / (CARD_H + GAP))
  if (col < 0 || col >= cols || row < 0) return null
  return row * cols + col
}

/** Grows the archive (never shrinks it) so every archived card fits inside. */
function growArchive(board: BoardState) {
  const a = board.archive
  let right = a.x + a.w
  let bottom = a.y + Math.max(a.h, PAD_TOP + CARD_H + PAD_BOTTOM)
  for (const node of Object.values(board.nodes)) {
    if (!node.archived) continue
    right = Math.max(right, node.x + CARD_W + PAD_X)
    bottom = Math.max(bottom, node.y + CARD_H + PAD_BOTTOM)
  }
  board.archive = { ...a, w: right - a.x, h: bottom - a.y }
}

/** Places newly discovered sessions in free grid slots inside the archive. */
function importSessions(board: BoardState, sessions: DiscoveredSession[]) {
  if (!sessions.length) return
  const cols = columnsFor(board.archive)
  const taken = new Set<number>()
  for (const node of Object.values(board.nodes)) {
    if (!node.archived) continue
    const slot = slotIndexOf(board.archive, node, cols)
    if (slot !== null) taken.add(slot)
  }
  let slot = 0
  for (const { meta } of sessions) {
    while (taken.has(slot)) slot++
    taken.add(slot)
    board.nodes[meta.sessionId] = {
      sessionId: meta.sessionId,
      ...slotPosition(board.archive, slot, cols),
      archived: true,
      createdAt: meta.createdAt
    }
  }
}

export function toCard(node: BoardNode, found?: DiscoveredSession): SessionCard {
  const live = isLive(node.sessionId)
  return {
    ...node,
    meta: found?.hasContent ? found.meta : undefined,
    status: node.archived ? 'done' : getStatus(node.sessionId),
    live
  }
}

export function loadBoard(project: Project): BoardSnapshot {
  const board = getBoard(project.id)
  const hidden = new Set(board.hidden)
  const disk = scanRepo(project.repoPath)

  // Forget imported cards whose transcript has been deleted (only when the
  // directory is readable, so a missing folder never wipes the layout).
  if (fs.existsSync(transcriptDir(project.repoPath))) {
    for (const [id, node] of Object.entries(board.nodes)) {
      if (!node.createdByApp && !disk.has(id) && !isLive(id)) delete board.nodes[id]
    }
  }

  const fresh = [...disk.values()]
    .filter((s) => s.eligible && !board.nodes[s.meta.sessionId] && !hidden.has(s.meta.sessionId))
    .sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
  importSessions(board, fresh)
  growArchive(board)

  // Only active cards belong to a section, and only to one that still exists.
  for (const node of Object.values(board.nodes)) {
    if (node.sectionId && (node.archived || !board.sections![node.sectionId])) delete node.sectionId
  }

  project.openedAt = Date.now()
  save()

  const cards = Object.values(board.nodes).map((node) => toCard(node, disk.get(node.sessionId)))
  const sections = Object.values(board.sections!).sort((a, b) => a.createdAt - b.createdAt)
  return { project, cards, archive: board.archive, sections, viewport: board.viewport }
}

export function projectStats(project: Project): ProjectStats {
  const board = getBoard(project.id)
  const hidden = new Set(board.hidden)
  const nodes = Object.values(board.nodes)
  const onBoard = new Set(nodes.map((n) => n.sessionId))
  // Parsed metadata is cached, so this is cheap after the first call.
  let undiscovered = 0
  for (const [id, found] of scanRepo(project.repoPath)) {
    if (found.eligible && !onBoard.has(id) && !hidden.has(id)) undiscovered++
  }
  let working = 0
  let waiting = 0
  for (const node of nodes) {
    if (node.archived || !isLive(node.sessionId)) continue
    const status = getStatus(node.sessionId)
    if (status === 'working') working++
    else if (status === 'waiting') waiting++
  }
  return {
    total: nodes.length + undiscovered,
    active: nodes.filter((n) => !n.archived).length,
    working,
    waiting
  }
}

export function hasTranscript(project: Project, sessionId: string) {
  return fs.existsSync(transcriptPath(project.repoPath, sessionId))
}
