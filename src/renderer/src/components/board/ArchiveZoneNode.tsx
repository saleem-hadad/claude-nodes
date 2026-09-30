import { memo, useContext, useEffect, useRef } from 'react'
import { useStore, type Node, type NodeProps } from '@xyflow/react'
import { Archive, Search, X } from 'lucide-react'
import clsx from 'clsx'
import { ArchiveHotContext, ArchiveStackContext } from './BoardContext'
import {
  ARCHIVE_HEADER_H,
  ARCHIVE_PAD,
  CARD_H,
  CARD_W,
  STACK_RESULTS_X,
  STACK_SEARCH_H,
  STACK_SEARCH_Y
} from './layout'

export type ArchiveNodeData = { count: number }
export type ArchiveFlowNode = Node<ArchiveNodeData, 'archive'>

/** Keeps the label legible when zoomed out, like a Miro frame title. */
const labelScale = (zoom: number) => Math.min(2.2, Math.max(1, 1 / zoom))

function ArchiveZoneNodeComponent({ data, dragging }: NodeProps<ArchiveFlowNode>) {
  const hot = useContext(ArchiveHotContext)
  const stack = useContext(ArchiveStackContext)
  const scale = useStore((s) => labelScale(s.transform[2]))
  const empty = data.count === 0
  const searching = !empty && (stack.hover || stack.open || stack.query !== '')

  return (
    <div
      className={clsx(
        'archive-zone',
        hot && 'is-hot',
        dragging && 'is-dragging',
        stack.open && 'is-open',
        searching && 'is-searching'
      )}
      onClick={stack.open ? undefined : stack.openStack}
    >
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

      {empty && (
        <div
          className="archive-placeholder"
          style={{ left: ARCHIVE_PAD, top: ARCHIVE_HEADER_H, width: CARD_W, height: CARD_H }}
        >
          Drag a card here to archive it
        </div>
      )}
      <StackSearch visible={searching} count={data.count} />
      <div
        className="archive-divider"
        style={{ left: STACK_RESULTS_X - 20, top: ARCHIVE_HEADER_H, bottom: ARCHIVE_PAD }}
      />
      {stack.open && stack.resultCount === 0 && (
        <p
          className="archive-empty"
          style={{ left: STACK_RESULTS_X, top: ARCHIVE_HEADER_H, width: CARD_W, height: CARD_H }}
        >
          No archived sessions match “{stack.query.trim()}”
        </p>
      )}
    </div>
  )
}

/**
 * Search field under the stack. It appears (and takes focus, so you can just
 * type) while the pointer is over the stack; typing or clicking fans results out.
 */
function StackSearch({ visible, count }: { visible: boolean; count: number }) {
  const stack = useContext(ArchiveStackContext)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!visible) {
      if (document.activeElement === el) el.blur()
      return
    }
    // Never steal focus from another field, e.g. a card being renamed.
    const active = document.activeElement
    if (active && active !== document.body && active.closest('input, textarea, select, [contenteditable="true"]')) {
      return
    }
    el.focus({ preventScroll: true })
  }, [visible, stack.open])

  return (
    <div
      className="archive-search nodrag nopan"
      style={{ left: ARCHIVE_PAD, top: STACK_SEARCH_Y, width: CARD_W, height: STACK_SEARCH_H }}
      onClick={(e) => {
        e.stopPropagation()
        stack.openStack()
        ref.current?.focus()
      }}
    >
      <Search size={13} strokeWidth={2.2} className="archive-search-icon" />
      <input
        ref={ref}
        value={stack.query}
        placeholder={`Search ${count} sessions`}
        spellCheck={false}
        tabIndex={visible ? 0 : -1}
        aria-label="Search archived sessions"
        onChange={(e) => stack.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            stack.closeStack()
            e.currentTarget.blur()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (stack.open) stack.submit()
            else stack.openStack()
          } else if (e.key === 'ArrowDown' && !stack.open) {
            e.preventDefault()
            stack.openStack()
          }
        }}
      />
      {stack.query && (
        <button
          className="archive-search-clear"
          aria-label="Clear search"
          tabIndex={-1}
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            stack.setQuery('')
            ref.current?.focus()
          }}
        >
          <X size={9} strokeWidth={3} />
        </button>
      )}
    </div>
  )
}

export const ArchiveZoneNode = memo(ArchiveZoneNodeComponent)
