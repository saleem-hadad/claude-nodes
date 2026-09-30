// Geometry helpers for placing session cards on the board.
import type { Rect, SessionCard } from '@shared/types'

/** Card size in flow units; matches --card-w / --card-h (4:3). */
export const CARD_W = 288
export const CARD_H = 216
export const GAP = 32

export const ARCHIVE_ID = '__archive__'
export const ARCHIVE_MIN_W = 600
export const ARCHIVE_MIN_H = 400
/** Height of the archive header strip; cards are never placed under it. */
export const ARCHIVE_HEADER_H = 52
const ARCHIVE_PAD = 28

export interface Point {
  x: number
  y: number
}

export function cardRect(p: Point): Rect {
  return { x: p.x, y: p.y, w: CARD_W, h: CARD_H }
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
export function isInArchive(position: Point, archive: Rect): boolean {
  return containsPoint(archive, { x: position.x + CARD_W / 2, y: position.y + CARD_H / 2 })
}

/**
 * Finds a free spot for a card near `preferred` that overlaps neither the given
 * obstacles nor (optionally) the archive zone. It searches rings of grid cells
 * around the preferred position, closest first.
 */
export function findFreeSpot(preferred: Point, obstacles: Rect[], avoid?: Rect): Point {
  const stepX = CARD_W + GAP
  const stepY = CARD_H + GAP
  const blocked = (p: Point) => {
    const r = cardRect(p)
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
  return cards.filter((c) => !exclude.has(c.sessionId)).map((c) => cardRect(c))
}

/**
 * Finds free slots inside the archive zone for `count` cards, scanning its grid
 * row by row. If the zone is full, it grows the zone downwards.
 */
export function archiveSlots(
  archive: Rect,
  cards: SessionCard[],
  count: number,
  exclude: Set<string>
): { slots: Point[]; archive: Rect } {
  const obstacles = cardObstacles(
    cards.filter((c) => c.archived),
    exclude
  )
  const slots: Point[] = []
  const stepX = CARD_W + GAP
  const stepY = CARD_H + GAP
  const cols = Math.max(1, Math.floor((archive.w - ARCHIVE_PAD * 2 + GAP) / stepX))
  let next = { ...archive }

  for (let row = 0; slots.length < count && row < 500; row++) {
    for (let col = 0; col < cols && slots.length < count; col++) {
      const p = {
        x: archive.x + ARCHIVE_PAD + col * stepX,
        y: archive.y + ARCHIVE_HEADER_H + row * stepY
      }
      const r = cardRect(p)
      if (obstacles.some((o) => intersects(r, o, GAP / 2 - 1))) continue
      slots.push(p)
      obstacles.push(r)
      const bottom = p.y + CARD_H + ARCHIVE_PAD
      if (bottom > next.y + next.h) next = { ...next, h: bottom - next.y }
    }
  }
  return { slots, archive: next }
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
    { x: rightmost.x + CARD_W + GAP * 2, y: rightmost.y },
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
