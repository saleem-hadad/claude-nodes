import { memo, type CSSProperties } from 'react'
import { useStore, type Node } from '@xyflow/react'
import { StickyNote } from 'lucide-react'
import { FOLDER_HUES } from '../FolderIcon'
import { NOTE_COLOR, NOTE_H, NOTE_W, PAD_HEADER_H, PAD_SHEET_X } from './notes'

export type NotePadFlowNode = Node<Record<string, never>, 'notepad'>

/** Keeps the label legible when zoomed out, like the archive's. */
const labelScale = (zoom: number) => Math.min(2.2, Math.max(1, 1 / zoom))

/**
 * The pad of sticky notes under the archive. Its top sheet is a note node of
 * its own, laid over the one drawn here: peeling it off shows this one, and a
 * new top sheet takes its place, so the pad never runs out.
 */
function NotePadNodeComponent() {
  const scale = useStore((s) => labelScale(s.transform[2]))

  return (
    <div className="notepad" style={{ '--note-hue': FOLDER_HUES[NOTE_COLOR].frontTop } as CSSProperties}>
      <div className="notepad-header">
        <div className="notepad-label" style={{ transform: `scale(${scale})` }}>
          <StickyNote size={15} strokeWidth={2} />
          <span>Notes</span>
          <span className="notepad-hint">Drag one onto the board</span>
        </div>
      </div>
      <div
        className="notepad-sheets"
        style={{ left: PAD_SHEET_X, top: PAD_HEADER_H, width: NOTE_W, height: NOTE_H }}
        aria-hidden
      >
        <div className="note notepad-sheet" data-depth="2" />
        <div className="note notepad-sheet" data-depth="1" />
        <div className="note notepad-sheet" />
      </div>
    </div>
  )
}

export const NotePadNode = memo(NotePadNodeComponent)
