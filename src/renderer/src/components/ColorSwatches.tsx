import clsx from 'clsx'
import { Check } from 'lucide-react'
import type { FolderColor } from '@shared/types'
import { FOLDER_COLORS, FOLDER_HUES } from './FolderIcon'
import './ColorSwatches.css'

/** A row of colour swatches, sized for a context menu's custom row. */
export function ColorSwatches({
  value,
  label,
  onPick
}: {
  value: FolderColor
  /** Accessible name of the group, e.g. "Folder colour". */
  label: string
  onPick: (color: FolderColor) => void
}) {
  return (
    <div className="swatches" role="group" aria-label={label}>
      {FOLDER_COLORS.map((color) => (
        <button
          key={color}
          className={clsx('swatch', color === value && 'is-current')}
          style={{
            background: `linear-gradient(${FOLDER_HUES[color].frontTop}, ${FOLDER_HUES[color].frontBottom})`
          }}
          title={color[0].toUpperCase() + color.slice(1)}
          aria-label={color}
          aria-pressed={color === value}
          onClick={() => onPick(color)}
        >
          {color === value && <Check size={10} strokeWidth={3.5} />}
        </button>
      ))}
    </div>
  )
}
