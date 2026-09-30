import {
  BaseEdge,
  getBezierPath,
  Position,
  useInternalNode,
  type EdgeProps,
  type InternalNode
} from '@xyflow/react'

interface Anchor {
  x: number
  y: number
  position: Position
}

function center(node: InternalNode) {
  const { x, y } = node.internals.positionAbsolute
  const w = node.measured.width ?? 0
  const h = node.measured.height ?? 0
  return { x: x + w / 2, y: y + h / 2, w, h }
}

/** The midpoint of the side of `from` that faces `to`. */
function facingSide(from: InternalNode, to: InternalNode): Anchor {
  const a = center(from)
  const b = center(to)
  const dx = b.x - a.x
  const dy = b.y - a.y
  // Compare in card-proportional terms so a 4:3 card picks sides naturally.
  if (Math.abs(dx) / a.w > Math.abs(dy) / a.h) {
    return dx > 0
      ? { x: a.x + a.w / 2, y: a.y, position: Position.Right }
      : { x: a.x - a.w / 2, y: a.y, position: Position.Left }
  }
  return dy > 0
    ? { x: a.x, y: a.y + a.h / 2, position: Position.Bottom }
    : { x: a.x, y: a.y - a.h / 2, position: Position.Top }
}

/**
 * Parent → merged-child edge that attaches to whichever sides of the two cards
 * face each other, so lineage reads cleanly however the cards are arranged.
 */
export function LineageEdge({ id, source, target, style, markerEnd }: EdgeProps) {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  if (!sourceNode || !targetNode) return null

  const s = facingSide(sourceNode, targetNode)
  const t = facingSide(targetNode, sourceNode)
  const [path] = getBezierPath({
    sourceX: s.x,
    sourceY: s.y,
    sourcePosition: s.position,
    targetX: t.x,
    targetY: t.y,
    targetPosition: t.position
  })

  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
}
