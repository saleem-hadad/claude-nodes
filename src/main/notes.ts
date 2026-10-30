// Sticky notes that sessions write on the board with their board tools
// (boardTools.ts). A session's notes go up beside its card, one under another.
import crypto from 'crypto'
import {
  GAP,
  NOTE_H,
  NOTE_W,
  cardSize,
  dockRect,
  findFreeSpot,
  noteSize,
  type Point,
  type Size
} from '@shared/geometry'
import type { BoardNode, BoardNote } from '@shared/types'
import type { NotePatch } from './boardTools'
import { getBoard, save, type BoardState } from './store'

/** How much text a note keeps. */
export const NOTE_MAX_CHARS = 20_000

/** Bounds for a note's size, in board units. */
export const clampNoteSize = (n: number) => Math.round(Math.min(1200, Math.max(120, n)))

/** A note Claude writes grows to fit its text up to this, and scrolls past it. */
const FIT_MAX_W = 360
const FIT_MAX_H = 480
/** Note text is 15px with a 1.4 line height, inside 16px by 18px of padding (board.css). */
const LINE_H = 21
const CHAR_W = 7.4
const PAD_X = 36
const PAD_Y = 32
/** The line naming the session that wrote it. */
const FROM_H = 22

const clamp = (n: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, n)))

/** A size that shows `text` whole, as far as a note grows by itself. A short note stays square. */
function fitNote(text: string): Size {
  const lines = text.split('\n')
  const longest = Math.max(...lines.map((line) => line.length))
  const w = clamp(longest * CHAR_W + PAD_X, NOTE_W, FIT_MAX_W)
  // Lines wrap at words, so they fit fewer characters than the width holds.
  const perLine = Math.max(1, Math.floor(((w - PAD_X) / CHAR_W) * 0.9))
  const rows = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0)
  return { w, h: clamp(rows * LINE_H + PAD_Y + FROM_H, NOTE_H, FIT_MAX_H) }
}

/**
 * Where a session's next note goes: under the last one it wrote, or beside
 * its card, in the nearest free spot. A run isn't on the board, nor is an
 * archived card, so their notes go beside the rightmost card instead.
 */
function placeNote(board: BoardState, from: string, size: Size): Point {
  const cards = Object.values(board.nodes).filter((n) => !n.archived && !n.runOf)
  const free = Object.values(board.notes!).filter((n) => !n.sessionId)
  const obstacles = [
    ...cards.map((n) => ({ x: n.x, y: n.y, ...cardSize(n) })),
    ...free.map((n) => ({ x: n.x, y: n.y, ...noteSize(n) }))
  ]
  const dock = dockRect(board.archive)

  const last = free.filter((n) => n.from === from).sort((a, b) => b.createdAt - a.createdAt)[0]
  const card = cards.find((n) => n.sessionId === from) ?? cards.reduce<BoardNode | undefined>((a, b) => (a && a.x >= b.x ? a : b), undefined)
  const preferred = last
    ? { x: last.x, y: last.y + noteSize(last).h + GAP }
    : card
      ? { x: card.x + cardSize(card).w + GAP, y: card.y }
      : { x: dock.x + dock.w + 80, y: dock.y }
  return findFreeSpot(preferred, obstacles, dock, size)
}

const noteText = (text: string | undefined) => text?.trim().slice(0, NOTE_MAX_CHARS) ?? ''

export function createNote(projectId: string, from: string, { text, color }: NotePatch): BoardNote {
  const body = noteText(text)
  if (!body) throw new Error('A note needs some text')
  const board = getBoard(projectId)
  const size = fitNote(body)
  const note: BoardNote = {
    id: crypto.randomUUID(),
    text: body,
    color: color ?? 'yellow',
    ...placeNote(board, from, size),
    w: size.w !== NOTE_W ? size.w : undefined,
    h: size.h !== NOTE_H ? size.h : undefined,
    from,
    createdAt: Date.now()
  }
  board.notes![note.id] = note
  save()
  return note
}

/** Changes a note's text or colour. It keeps its size, which may be the user's. */
export function updateNote(projectId: string, noteId: string, { text, color }: NotePatch): BoardNote {
  const note = getBoard(projectId).notes![noteId]
  if (!note) throw new Error('There’s no note with that id on this board')
  if (text !== undefined) {
    const body = noteText(text)
    if (!body) throw new Error('A note needs some text')
    note.text = body
  }
  if (color) note.color = color
  save()
  return note
}

export function listNotes(projectId: string, self: string) {
  return Object.values(getBoard(projectId).notes!)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((n) => ({ id: n.id, text: n.text, color: n.color, writtenByYou: n.from === self || undefined }))
}
