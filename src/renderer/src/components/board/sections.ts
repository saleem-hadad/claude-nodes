// Geometry for sections: named frames drawn around the cards grouped under them.
import type { BoardSection, Rect, SessionCard } from '@shared/types'
import { CARD_H, CARD_W, GAP, cardRect, containsPoint, findFreeSpot, intersects, type Point } from './layout'

/** Height of a section's header strip, its drag handle. */
export const SECTION_HEADER_H = 44
export const SECTION_PAD = 24
/** Grouping lays cards out at most this many to a row. */
const GROUP_MAX_COLS = 4

/** A section with its frame and the active cards grouped under it. */
export interface SectionView {
  section: BoardSection
  frame: Rect
  members: SessionCard[]
}

/** The frame around the given card positions; with none, an empty one-card frame at `corner`. */
export function frameAround(corner: Point, cards: Point[]): Rect {
  if (cards.length === 0) {
    return {
      x: corner.x,
      y: corner.y,
      w: SECTION_PAD * 2 + CARD_W,
      h: SECTION_HEADER_H + CARD_H + SECTION_PAD
    }
  }
  const left = Math.min(...cards.map((c) => c.x))
  const top = Math.min(...cards.map((c) => c.y))
  const right = Math.max(...cards.map((c) => c.x)) + CARD_W
  const bottom = Math.max(...cards.map((c) => c.y)) + CARD_H
  return {
    x: left - SECTION_PAD,
    y: top - SECTION_HEADER_H,
    w: right - left + SECTION_PAD * 2,
    h: bottom - top + SECTION_HEADER_H + SECTION_PAD
  }
}

/** Every section with its frame and cards, oldest first (so newer ones draw on top). */
export function sectionViews(sections: BoardSection[], cards: SessionCard[]): SectionView[] {
  const members = new Map<string, SessionCard[]>(sections.map((s) => [s.id, []]))
  for (const c of cards) {
    if (!c.archived && c.sectionId) members.get(c.sectionId)?.push(c)
  }
  return sections.map((section) => {
    const own = members.get(section.id)!
    return { section, members: own, frame: frameAround(section, own) }
  })
}

/**
 * The section a card at `position` belongs to: the one whose frame holds the
 * card's center. Where frames overlap, the card's current section wins, then
 * the newest.
 */
export function sectionAt(position: Point, views: SectionView[], current?: string): string | null {
  const center = { x: position.x + CARD_W / 2, y: position.y + CARD_H / 2 }
  const hits = views.filter((v) => containsPoint(v.frame, center))
  const hit = hits.find((v) => v.section.id === current) ?? hits[hits.length - 1]
  return hit?.section.id ?? null
}

/** The most urgent status among a section's cards, when one needs attention. */
export function sectionStatus(members: SessionCard[]): 'working' | 'waiting' | undefined {
  if (members.some((c) => c.status === 'waiting')) return 'waiting'
  if (members.some((c) => c.status === 'working')) return 'working'
  return undefined
}

/**
 * Lays out a new section for `cards`. It wraps them where they are when that
 * frame is clear of the other cards and zones; otherwise the cards are tidied
 * into a grid in a free spot nearby, and `positions` says where each one goes.
 */
export function layoutGroup(
  cards: SessionCard[],
  others: Rect[],
  zones: Rect[]
): { frame: Rect; positions: Map<string, Point> } {
  const around = frameAround(cards[0], cards)
  const clear =
    !others.some((o) => intersects(o, around)) && !zones.some((z) => intersects(z, around, GAP))
  if (clear) return { frame: around, positions: new Map() }

  const cols = Math.min(GROUP_MAX_COLS, Math.ceil(Math.sqrt(cards.length)))
  const rows = Math.ceil(cards.length / cols)
  const size = {
    w: SECTION_PAD * 2 + cols * CARD_W + (cols - 1) * GAP,
    h: SECTION_HEADER_H + rows * CARD_H + (rows - 1) * GAP + SECTION_PAD
  }
  const corner = findFreeSpot({ x: around.x, y: around.y }, [...others, ...zones], undefined, size)
  // Keep the cards' reading order: rows top to bottom, then left to right.
  const row = (c: Point) => Math.round(c.y / (CARD_H + GAP))
  const sorted = [...cards].sort((a, b) => row(a) - row(b) || a.x - b.x)
  const positions = new Map(
    sorted.map((c, i) => [
      c.sessionId,
      {
        x: Math.round(corner.x + SECTION_PAD + (i % cols) * (CARD_W + GAP)),
        y: Math.round(corner.y + SECTION_HEADER_H + Math.floor(i / cols) * (CARD_H + GAP))
      }
    ])
  )
  return { frame: { ...corner, ...size }, positions }
}

/** A free card slot inside a section's frame, or just right of its cards when it is full. */
export function spotInSection({ frame }: SectionView, obstacles: Rect[]): Point {
  const stepX = CARD_W + GAP
  const stepY = CARD_H + GAP
  const cols = Math.max(1, Math.floor((frame.w - SECTION_PAD * 2 + GAP) / stepX))
  const rows = Math.max(1, Math.floor((frame.h - SECTION_HEADER_H - SECTION_PAD + GAP) / stepY))
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const p = { x: frame.x + SECTION_PAD + col * stepX, y: frame.y + SECTION_HEADER_H + row * stepY }
      if (!obstacles.some((o) => intersects(cardRect(p), o, GAP / 2 - 1))) return p
    }
  }
  return findFreeSpot(
    { x: frame.x + frame.w - SECTION_PAD + GAP, y: frame.y + SECTION_HEADER_H },
    obstacles
  )
}
