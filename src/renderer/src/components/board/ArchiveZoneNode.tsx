import { memo, useContext } from 'react'
import { NodeResizer, useStore, type Node, type NodeProps, type OnResizeEnd } from '@xyflow/react'
import { Archive } from 'lucide-react'
import clsx from 'clsx'
import { ArchiveHotContext } from './BoardContext'
import { ARCHIVE_MIN_H, ARCHIVE_MIN_W } from './layout'

export type ArchiveNodeData = {
  count: number
  onResizeEnd: OnResizeEnd
}
export type ArchiveFlowNode = Node<ArchiveNodeData, 'archive'>

/** Keeps the label legible when zoomed out, like a Miro frame title. */
const labelScale = (zoom: number) => Math.min(2.2, Math.max(1, 1 / zoom))

function ArchiveZoneNodeComponent({ data, dragging }: NodeProps<ArchiveFlowNode>) {
  const hot = useContext(ArchiveHotContext)
  const scale = useStore((s) => labelScale(s.transform[2]))

  return (
    <div className={clsx('archive-zone', hot && 'is-hot', dragging && 'is-dragging')}>
      <NodeResizer
        minWidth={ARCHIVE_MIN_W}
        minHeight={ARCHIVE_MIN_H}
        handleClassName="archive-resize-handle"
        lineClassName="archive-resize-line"
        onResizeEnd={data.onResizeEnd}
      />
      <div className="archive-header" title="Drag to move the archive">
        <div className="archive-label" style={{ transform: `scale(${scale})` }}>
          <Archive size={15} strokeWidth={2} />
          <span>Archive</span>
          <span className="archive-count">{data.count}</span>
          <span className="archive-hint">
            {hot ? 'Drop to archive' : 'Drag cards out to reactivate'}
          </span>
        </div>
      </div>
    </div>
  )
}

export const ArchiveZoneNode = memo(ArchiveZoneNodeComponent)
