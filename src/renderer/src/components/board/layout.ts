// Geometry helpers for placing session cards on the board. What the main
// process needs too (sizes and the free-spot search) is in @shared/geometry.
import type { Rect, SessionCard } from '@shared/types'
import {
  ARCHIVE_HEADER_H,
  ARCHIVE_PAD,
  CARD_H,
  CARD_SIZE,
  CARD_W,
  GAP,
  STACK_H,
  STACK_W,
  cardSize,
  findFreeSpot,
  type Point,
  type Size
} from '@shared/geometry'

export {
  ARCHIVE_HEADER_H,
  ARCHIVE_PAD,
  CARD_H,
  CARD_SIZE,
  CARD_W,
  EXPANDED_H,
  EXPANDED_W,
  GAP,
  STACK_SEARCH_H,
  STACK_SEARCH_Y,
  STACK_W,
  cardSize,
  findFreeSpot,
  intersects,
  isExpanded
} from '@shared/geometry'
export type { Point, Size } from '@shared/geometry'

/** An expanded card can't shrink past a usable terminal. */
export const EXPANDED_MIN_W = 360
export const EXPANDED_MIN_H = 240

/**
 * The archive is a single stack of cards anchored at the archive's corner (its
 * stored x/y). Its search fans matching cards out into a panel beside it.
 */
export const ARCHIVE_ID = '__archive__'

/** Rows of results the open panel shows at once, two cards each; the rest scroll. */
export const STACK_ROWS = 2
/** Height of the band the open panel's results scroll through. */
export const STACK_BAND_H = STACK_ROWS * CARD_H + (STACK_ROWS - 1) * GAP
/** Cards drawn in the folded stack: the top one plus two peeking out behind it. */
export const STACK_DEPTH = 3
/** Where the fanned-out results start, relative to the archive's corner. */
export const STACK_RESULTS_X = ARCHIVE_PAD + CARD_W + 40

export function cardRect(p: Point, size: Size = CARD_SIZE): Rect {
  return { x: p.x, y: p.y, w: size.w, h: size.h }
}

export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

/** The smallest rectangle holding all of `rects`. */
export function boundsOf(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y
  }
}

/** A card counts as archived when its center lies inside the archive zone. */
export function isInArchive(position: Point, archive: Rect, size: Size = CARD_SIZE): boolean {
  return containsPoint(archive, { x: position.x + size.w / 2, y: position.y + size.h / 2 })
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

/** A spot just right of the archive zone, clear of other cards and of `others` (e.g. notes). */
export function spotRightOfArchive(
  archive: Rect,
  cards: SessionCard[],
  exclude = new Set<string>(),
  size: Size = CARD_SIZE,
  others: Rect[] = []
) {
  return findFreeSpot(
    { x: archive.x + archive.w + 80, y: archive.y },
    [...cardObstacles(cards, exclude), ...others],
    archive,
    size
  )
}

/** Default spot for a brand-new session (of `size`): right of the rightmost active card. */
export function spotForNewSession(
  archive: Rect,
  cards: SessionCard[],
  size: Size = CARD_SIZE,
  others: Rect[] = []
): Point {
  const active = cards.filter((c) => !c.archived)
  if (active.length === 0) return spotRightOfArchive(archive, cards, undefined, size, others)
  const rightmost = active.reduce((a, b) => (b.x > a.x ? b : a))
  return findFreeSpot(
    { x: rightmost.x + cardSize(rightmost).w + GAP * 2, y: rightmost.y },
    [...cardObstacles(cards), ...others],
    archive,
    size
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
