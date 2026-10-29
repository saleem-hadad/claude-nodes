import { memo, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { NodeResizer, type Node, type NodeProps, type OnResizeEnd } from '@xyflow/react'
import { Play, X } from 'lucide-react'
import clsx from 'clsx'
import type { BoardNote } from '@shared/types'
import { useApp } from '@renderer/store'
import { FOLDER_HUES } from '../FolderIcon'
import { RenamingContext, useBoardActions } from './BoardContext'
import { NOTE_MIN } from './notes'

export type NoteNodeData = {
  note: BoardNote
  /** The pad's top sheet, waiting to be peeled off onto the board. */
  draft?: boolean
}
export type NoteFlowNode = Node<NoteNodeData, 'note'>

/** How long typing rests before it's saved, so a note is never lost to a closed board. */
const SAVE_DELAY_MS = 500

const stop = (e: MouseEvent) => e.stopPropagation()

function NoteNodeComponent({ id, data, selected, dragging }: NodeProps<NoteFlowNode>) {
  const { note, draft } = data
  const editing = useContext(RenamingContext) === id && !draft
  const { startNote } = useBoardActions()
  const saveNote = useApp((s) => s.saveNote)
  const noteRef = useRef(note)
  noteRef.current = note
  // Stable, so React Flow doesn't rebind the resize handles on every render.
  const onResizeEnd = useCallback<OnResizeEnd>(
    (_e, r) =>
      saveNote({
        ...noteRef.current,
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height)
      }),
    [saveNote]
  )

  return (
    <>
      <div
        className={clsx(
          'note',
          draft && 'is-draft',
          selected && 'is-selected',
          dragging && 'is-dragging',
          editing && 'is-editing'
        )}
        style={{ '--note-hue': FOLDER_HUES[note.color].frontTop } as CSSProperties}
        title={draft ? 'Drag a note onto the board, or click for one beside the pad' : undefined}
      >
        {editing ? (
          <NoteEditor note={note} />
        ) : (
          <p className={clsx('note-text', !note.text && 'is-empty')}>
            {note.text || (draft ? '' : 'Double-click to write')}
          </p>
        )}
        {!draft && !editing && note.text.trim() && (
          <button
            className="note-play nodrag"
            onClick={(e) => {
              e.stopPropagation()
              startNote(note.id)
            }}
            onDoubleClick={stop}
            title="Start a Claude session on this note"
            aria-label="Start a Claude session on this note"
          >
            <Play size={12} strokeWidth={2.5} fill="currentColor" />
          </button>
        )}
      </div>
      {!draft && (
        <NodeResizer
          isVisible={selected && !editing}
          minWidth={NOTE_MIN}
          minHeight={NOTE_MIN}
          lineClassName="note-resize-line"
          handleClassName="note-resize-handle"
          onResizeEnd={onResizeEnd}
        />
      )}
    </>
  )
}

/**
 * The note's text, being written. Enter starts a new line; Escape, ⌘Enter or
 * a click away puts the note down.
 */
function NoteEditor({ note }: { note: BoardNote }) {
  const { editNote, setRenaming } = useBoardActions()
  const [value, setValue] = useState(note.text)
  const ref = useRef<HTMLTextAreaElement>(null)
  const timer = useRef<number | undefined>(undefined)
  // Read by the save timer and the unmount cleanup, which outlive the render that set them.
  const latest = useRef({ note, value, saved: note.text, editNote })
  latest.current.note = note
  latest.current.value = value
  latest.current.editNote = editNote

  const flush = useCallback(() => {
    window.clearTimeout(timer.current)
    const l = latest.current
    if (l.value === l.saved) return
    l.saved = l.value
    l.editNote(l.note, l.value)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (el) {
      el.focus({ preventScroll: true })
      el.setSelectionRange(el.value.length, el.value.length)
    }
    // Leaving the board while typing never blurs the field: keep what was typed.
    return flush
  }, [flush])

  return (
    <textarea
      ref={ref}
      className="note-input nodrag nopan nowheel"
      value={value}
      placeholder="Type a note…"
      onChange={(e) => {
        setValue(e.target.value)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(flush, SAVE_DELAY_MS)
      }}
      onBlur={() => {
        flush()
        setRenaming(null)
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && e.metaKey)) {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
    />
  )
}

export const NoteNode = memo(NoteNodeComponent)

/**
 * A note stuck on the card of the session it started, as a reminder of what
 * was asked. `landing` plays it sticking on, for a session just started.
 */
export function NoteSticker({ note, index, landing }: { note: BoardNote; index: number; landing: boolean }) {
  const removeNotes = useApp((s) => s.removeNotes)

  return (
    <div
      className={clsx('note-sticker', landing && 'is-landing')}
      style={{ '--note-hue': FOLDER_HUES[note.color].frontTop, '--i': index } as CSSProperties}
      title={note.text}
    >
      <p className="note-sticker-text">{note.text}</p>
      <button
        className="note-sticker-remove nodrag"
        // Nothing to lose: the note's text is the session's first prompt.
        onClick={(e) => {
          e.stopPropagation()
          removeNotes([note.id])
        }}
        onDoubleClick={stop}
        title="Delete note"
        aria-label="Delete note"
      >
        <X size={9} strokeWidth={3} />
      </button>
    </div>
  )
}
