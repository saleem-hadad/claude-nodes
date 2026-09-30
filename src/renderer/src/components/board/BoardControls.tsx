import { useReactFlow, useViewport } from '@xyflow/react'
import { Maximize, Minus, Plus } from 'lucide-react'

interface Props {
  onFit: () => void
}

/** Bottom-left zoom pill: −, zoom %, +, fit. Clicking the percentage resets to 100%. */
export function BoardControls({ onFit }: Props) {
  const { zoomIn, zoomOut, zoomTo } = useReactFlow()
  const { zoom } = useViewport()

  return (
    <div className="board-controls" role="group" aria-label="Zoom">
      <button className="board-control" onClick={() => zoomOut({ duration: 160 })} title="Zoom out">
        <Minus size={14} strokeWidth={2.2} />
      </button>
      <button
        className="board-control board-zoom"
        onClick={() => zoomTo(1, { duration: 200 })}
        title="Reset to 100%"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button className="board-control" onClick={() => zoomIn({ duration: 160 })} title="Zoom in">
        <Plus size={14} strokeWidth={2.2} />
      </button>
      <span className="board-control-sep" />
      <button className="board-control" onClick={onFit} title="Zoom to fit">
        <Maximize size={13} strokeWidth={2.2} />
      </button>
    </div>
  )
}
