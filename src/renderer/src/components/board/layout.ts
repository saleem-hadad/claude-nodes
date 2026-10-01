// Geometry helpers for placing session cards on the board.
import type { Rect, SessionCard } from '@shared/types'

/** Card size in flow units; matches --card-w / --card-h (4:3). */
export const CARD_W = 288
export const CARD_H = 216
export const GAP = 32

/** An expanded card starts with room for an 80-column terminal, and can't shrink past a usable one. */
export const EXPANDED_W = 720
export const EXPANDED_H = 480
export const EXPANDED_MIN_W = 360
export const EXPANDED_MIN_H = 240

/**
 * The archive is a single stack of cards anchored at the archive's corner (its
 * stored x/y). Its search fans matching cards out into a panel beside it.
 */
export const ARCHIVE_ID = '__archive__'
/** Height of the archive header strip. */
export const ARCHIVE_HEADER_H = 52
export const ARCHIVE_PAD = 28

/** Rows of results the open panel shows at once, two cards each; the rest scroll. */
export const STACK_ROWS = 2
/** Height of the band the open panel's results scroll through. */
export const STACK_BAND_H = STACK_ROWS * CARD_H + (STACK_ROWS - 1) * GAP
/** Cards drawn in the folded stack: the top one plus two peeking out behind it. */
export const STACK_DEPTH = 3
/** The search field sits under the stack, below the peeking cards. */
export const STACK_SEARCH_Y = ARCHIVE_HEADER_H + CARD_H + 38
export const STACK_SEARCH_H = 34
/** Where the fanned-out results start, relative to the archive's corner. */
export const STACK_RESULTS_X = ARCHIVE_PAD + CARD_W + 40
const STACK_W = ARCHIVE_PAD * 2 + CARD_W
const STACK_H = STACK_SEARCH_Y + STACK_SEARCH_H + 22

export interface Point {
  x: number
  y: number
}

export interface Size {
  w: number
  h: number
}

export const CARD_SIZE: Size = { w: CARD_W, h: CARD_H }

/** Whether a card is drawn expanded, with its terminal on the board. Archived cards never are. */
export function isExpanded(card: Pick<SessionCard, 'expanded' | 'archived'> | undefined): boolean {
  return Boolean(card?.expanded && !card.archived)
}

/** A card's size on the board: compact, or as big as it was last expanded to. */
export function cardSize(card: Pick<SessionCard, 'expanded' | 'archived' | 'w' | 'h'> | undefined): Size {
  if (!isExpanded(card)) return CARD_SIZE
  return { w: card!.w ?? EXPANDED_W, h: card!.h ?? EXPANDED_H }
}

export function cardRect(p: Point, size: Size = CARD_SIZE): Rect {
  return { x: p.x, y: p.y, w: size.w, h: size.h }
}

export function intersects(a: Rect, b: Rect, margin = 0): boolean {
  return (
    a.x < b.x + b.w + margin &&
    a.x + a.w + margin > b.x &&
    a.y < b.y + b.h + margin &&
    a.y + a.h + margin > b.y
  )
}

export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

/** A card counts as archived when its center lies inside the archive zone. */
export function isInArchive(position: Point, archive: Rect, size: Size = CARD_SIZE): boolean {
  return containsPoint(archive, { x: position.x + size.w / 2, y: position.y + size.h / 2 })
}

/**
 * Finds a free spot for a card (or anything of `size`) near `preferred` that
 * overlaps neither the given obstacles nor (optionally) the archive zone. It
 * searches rings of card-sized grid cells around the preferred position,
 * closest first.
 */
export function findFreeSpot(
  preferred: Point,
  obstacles: Rect[],
  avoid?: Rect,
  size = { w: CARD_W, h: CARD_H }
): Point {
  const stepX = CARD_W + GAP
  const stepY = CARD_H + GAP
  const blocked = (p: Point) => {
    const r = { ...p, ...size }
    if (avoid && intersects(r, avoid, GAP)) return true
    return obstacles.some((o) => intersects(r, o, GAP / 2))
  }
  if (!blocked(preferred)) return preferred

  for (let ring = 1; ring < 40; ring++) {
    const candidates: Point[] = []
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        candidates.push({ x: preferred.x + dx * stepX, y: preferred.y + dy * stepY })
      }
    }
    // Prefer spots to the right of / below the preferred point, then nearest.
    candidates.sort((a, b) => score(a) - score(b))
    const hit = candidates.find((c) => !blocked(c))
    if (hit) return hit
  }
  return { x: preferred.x, y: preferred.y + 40 * stepY }

  function score(p: Point) {
    const dx = p.x - preferred.x
    const dy = p.y - preferred.y
    const behind = (dx < 0 ? 1.4 : 1) * (dy < 0 ? 1.2 : 1)
    return Math.hypot(dx, dy) * behind
  }
}

/** Obstacle rectangles for all cards except the excluded ids. */
export function cardObstacles(cards: SessionCard[], exclude: Set<string> = new Set()): Rect[] {
  return cards.filter((c) => !exclude.has(c.sessionId)).map((c) => cardRect(c, cardSize(c)))
}

/**
 * The archive as drawn: the stack, or with `results` (the panel is open) the
 * panel holding that many fanned-out cards, two per row, up to STACK_ROWS rows.
 */
export function stackZone(archive: Rect, results?: number): Rect {
  if (results === undefined) return { x: archive.x, y: archive.y, w: STACK_W, h: STACK_H }
  const cols = results > 1 ? 2 : 1
  const rows = Math.min(STACK_ROWS, Math.max(1, Math.ceil(results / 2)))
  return {
    x: archive.x,
    y: archive.y,
    w: STACK_RESULTS_X + cols * CARD_W + (cols - 1) * GAP + ARCHIVE_PAD,
    h: Math.max(STACK_H, ARCHIVE_HEADER_H + rows * CARD_H + (rows - 1) * GAP + ARCHIVE_PAD)
  }
}

/** Where every card in the stack sits; depth is drawn by the card itself. */
export function stackTop(archive: Rect): Point {
  return { x: archive.x + ARCHIVE_PAD, y: archive.y + ARCHIVE_HEADER_H }
}

/** Where a result sits in the open panel, with the results scrolled up by `scroll`. */
export function stackResultSpot(archive: Rect, slot: number, scroll = 0): Point {
  return {
    x: archive.x + STACK_RESULTS_X + (slot % 2) * (CARD_W + GAP),
    y: archive.y + ARCHIVE_HEADER_H + Math.floor(slot / 2) * (CARD_H + GAP) - scroll
  }
}

/** The band of the open panel the results scroll through (flow y). */
export function stackResultsBand(archive: Rect): { top: number; bottom: number } {
  const top = archive.y + ARCHIVE_HEADER_H
  return { top, bottom: top + STACK_BAND_H }
}

/** How far the results can scroll: the height of the rows below the band. */
export function stackScrollMax(results: number): number {
  return Math.max(0, (Math.ceil(results / 2) - STACK_ROWS) * (CARD_H + GAP))
}

/** Stack order: most recently archived or active first. */
export function stackRank(card: SessionCard): number {
  return Math.max(card.archivedAt ?? 0, card.meta?.updatedAt ?? card.createdAt)
}

/** A spot just right of the archive zone, clear of other cards. */
export function spotRightOfArchive(archive: Rect, cards: SessionCard[], exclude = new Set<string>()) {
  return findFreeSpot(
    { x: archive.x + archive.w + 80, y: archive.y },
    cardObstacles(cards, exclude),
    archive
  )
}

/** Default spot for a brand-new session: right of the rightmost active card. */
export function spotForNewSession(archive: Rect, cards: SessionCard[]): Point {
  const active = cards.filter((c) => !c.archived)
  if (active.length === 0) return spotRightOfArchive(archive, cards)
  const rightmost = active.reduce((a, b) => (b.x > a.x ? b : a))
  return findFreeSpot(
    { x: rightmost.x + cardSize(rightmost).w + GAP * 2, y: rightmost.y },
    cardObstacles(cards),
    archive
  )
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function timeAgo(ts: number | undefined, now = Date.now()): string {
  if (!ts) return ''
  const diff = Math.max(0, now - ts)
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: now - ts > 300 * DAY ? 'numeric' : undefined
  })
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…'
}
