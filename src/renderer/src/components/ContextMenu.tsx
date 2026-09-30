import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import './ContextMenu.css'

export type MenuItem =
  | 'separator'
  | {
      label: string
      icon?: ReactNode
      /** Right-aligned hint, e.g. a shortcut like "⌘O". */
      hint?: string
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
    }
  | {
      /** A custom row (e.g. colour swatches) rendered as-is. */
      custom: ReactNode
    }

interface Props {
  /** Viewport coordinates, usually from a contextmenu event. */
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/** A macOS-style context menu rendered in a portal and kept inside the window. */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      x: Math.min(x, window.innerWidth - width - 8),
      y: Math.min(y, window.innerHeight - height - 8)
    })
  }, [x, y])

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item === 'separator') return <div key={i} className="ctx-sep" role="separator" />
        if ('custom' in item) return <div key={i}>{item.custom}</div>
        return (
          <button
            key={i}
            role="menuitem"
            className={clsx('ctx-item', item.danger && 'is-danger')}
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            <span className="ctx-icon">{item.icon}</span>
            <span className="ctx-label">{item.label}</span>
            {item.hint && <span className="ctx-hint">{item.hint}</span>}
          </button>
        )
      })}
    </div>,
    document.body
  )
}
