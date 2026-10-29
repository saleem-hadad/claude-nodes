// Geometry for sticky notes, and the pad under the archive they're peeled off.
import type { Node } from '@xyflow/react'
import type { BoardNote, FolderColor, Rect, SessionCard } from '@shared/types'
import { ARCHIVE_HEADER_H, ARCHIVE_PAD, CARD_H, STACK_W, isInArchive, stackZone, type Point, type Size } from './layout'
import type { NoteFlowNode } from './NoteNode'
import type { NotePadFlowNode } from './NotePadNode'

/** A note starts square, as tall as a card so the two line up in rows. */
export const NOTE_W = CARD_H
export const NOTE_H = CARD_H
export const NOTE_SIZE: Size = { w: NOTE_W, h: NOTE_H }
export const NOTE_MIN = 120
/** Notes come off the pad in classic yellow. */
export const NOTE_COLOR: FolderColor = 'yellow'

export const NOTEPAD_ID = '__notepad__'
/** The pad sits under the archive stack, as wide as it, with a header like the archive's. */
export const PAD_HEADER_H = ARCHIVE_HEADER_H
export const PAD_W = STACK_W
const PAD_GAP = 24
/** Room under the top sheet for the sheets beneath it to show. */
const PAD_BOTTOM = ARCHIVE_PAD
/** Where the top sheet sits on the pad, centred under the archive's top card. */
export const PAD_SHEET_X = (PAD_W - NOTE_W) / 2

/** Notes sit on top of the cards they're stuck to, and under the open archive panel. */
const NOTE_Z = 2

export function noteSize(note: Pick<BoardNote, 'w' | 'h'>): Size {
  return { w: note.w ?? NOTE_W, h: note.h ?? NOTE_H }
}

/** Obstacle rectangles for the notes on the board (stickers ride on their cards). */
export function noteObstacles(notes: BoardNote[]): Rect[] {
  return notes.filter((n) => !n.sessionId).map((n) => ({ x: n.x, y: n.y, ...noteSize(n) }))
}

/**
 * Notes on the board, and the ones stuck on cards as stickers, by session. A
 * note whose card isn't on the board (yet, or any more) stays on the board.
 */
export function splitNotes(notes: BoardNote[], cards: SessionCard[]) {
  const onBoard = new Set(cards.map((c) => c.sessionId))
  const free: BoardNote[] = []
  const stuck = new Map<string, BoardNote[]>()
  for (const note of notes) {
    if (note.sessionId && onBoard.has(note.sessionId)) {
      stuck.set(note.sessionId, [...(stuck.get(note.sessionId) ?? []), note])
    } else {
      free.push(note)
    }
  }
  return { free, stuck }
}

/** The pad under the archive's stack. It goes by the folded stack, so the open panel floats over it. */
export function notePadRect(archive: Rect): Rect {
  const stack = stackZone(archive)
  return { x: stack.x, y: stack.y + stack.h + PAD_GAP, w: PAD_W, h: PAD_HEADER_H + NOTE_H + PAD_BOTTOM }
}

/** Where the pad's top sheet sits, ready to be peeled off. */
export function padSheetSpot(pad: Rect): Point {
  return { x: pad.x + PAD_SHEET_X, y: pad.y + PAD_HEADER_H }
}

/** A note dropped with its center on the pad goes back onto it. */
export function isOnPad(position: Point, pad: Rect, size: Size = NOTE_SIZE): boolean {
  return isInArchive(position, pad, size)
}

const sameNote = (a: BoardNote, b: BoardNote) => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * React Flow nodes for the notes. One being dragged or resized keeps its live
 * position and size; otherwise it sits where it was saved.
 */
export function buildNoteNodes(notes: BoardNote[], prevById: Map<string, Node>, busy: Set<string>): NoteFlowNode[] {
  return notes.map((note) => {
    const p = prevById.get(note.id) as NoteFlowNode | undefined
    // The pad's top sheet becomes the note it was peeled off as.
    const prev = p && !p.data.draft ? p : undefined
    const held = Boolean(p && (p.dragging || p.resizing || busy.has(note.id)))
    const size = p?.resizing ? { w: p.width!, h: p.height! } : noteSize(note)
    const position = held ? p!.position : { x: note.x, y: note.y }
    const data = prev && sameNote(prev.data.note, note) ? prev.data : { note }
    if (
      prev &&
      prev.data === data &&
      prev.position.x === position.x &&
      prev.position.y === position.y &&
      prev.width === size.w &&
      prev.height === size.h
    ) {
      return prev
    }
    return {
      ...p,
      id: note.id,
      type: 'note',
      position,
      width: size.w,
      height: size.h,
      data,
      zIndex: NOTE_Z,
      selectable: true,
      deletable: false
    }
  })
}

/**
 * The pad, and the note waiting on top of it as its top sheet. That note is
 * `draftId`, the id the next note peeled off the pad will have, so dropping it
 * on the board turns it into that note where it lies. The pad draws the same
 * sheet underneath, so it never runs out.
 */
export function buildPadNodes(
  pad: Rect,
  draftId: string,
  prevById: Map<string, Node>,
  busy: Set<string>
): [NotePadFlowNode, NoteFlowNode] {
  const pp = prevById.get(NOTEPAD_ID) as NotePadFlowNode | undefined
  const padPosition = pp && busy.has(NOTEPAD_ID) ? pp.position : { x: pad.x, y: pad.y }
  const padNode: NotePadFlowNode =
    pp && pp.position.x === padPosition.x && pp.position.y === padPosition.y
      ? pp
      : {
          ...pp,
          id: NOTEPAD_ID,
          type: 'notepad',
          position: padPosition,
          width: pad.w,
          height: pad.h,
          data: {},
          zIndex: -1,
          draggable: false,
          selectable: false,
          focusable: false,
          deletable: false
        }

  const dp = prevById.get(draftId) as NoteFlowNode | undefined
  const spot = padSheetSpot(pad)
  const position = dp && (dp.dragging || busy.has(draftId)) ? dp.position : spot
  const draft: NoteFlowNode =
    dp && dp.position.x === position.x && dp.position.y === position.y
      ? dp
      : {
          ...dp,
          id: draftId,
          type: 'note',
          position,
          width: NOTE_W,
          height: NOTE_H,
          data: dp?.data ?? {
            note: { id: draftId, text: '', color: NOTE_COLOR, ...spot, createdAt: 0 },
            draft: true
          },
          zIndex: NOTE_Z,
          // Peeled off, never picked: it only joins a selection once it's a note.
          selectable: false,
          focusable: false,
          deletable: false
        }
  return [padNode, draft]
}
