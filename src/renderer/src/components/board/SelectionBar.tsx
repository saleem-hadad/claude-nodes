import { Archive, Sparkles, X } from 'lucide-react'

interface Props {
  count: number
  /** How many of the selected cards are not archived yet. */
  activeCount: number
  onMerge: () => void
  onArchive: () => void
  onClear: () => void
}

/** Floating pill at the bottom of the board that acts on the current selection. */
export function SelectionBar({ count, activeCount, onMerge, onArchive, onClear }: Props) {
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selection actions">
      <span className="selection-count">
        {count} selected
      </span>
      <span className="selection-sep" />
      <button className="btn btn-primary selection-merge" onClick={onMerge}>
        <Sparkles size={14} strokeWidth={2.2} />
        New session from context
      </button>
      <button
        className="btn btn-ghost"
        onClick={onArchive}
        disabled={activeCount === 0}
        title="Archive selected (⌫)"
      >
        <Archive size={14} strokeWidth={2} />
        Archive
      </button>
      <button className="btn btn-ghost btn-icon" onClick={onClear} title="Clear selection (Esc)">
        <X size={15} strokeWidth={2} />
      </button>
    </div>
  )
}
