import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import './Modal.css'

interface Props {
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
  style?: CSSProperties
  /**
   * Close on Escape. Leave this off for modals that host a terminal:
   * Claude Code uses Escape to interrupt.
   */
  closeOnEscape?: boolean
  /** Close when clicking the dimmed backdrop. */
  closeOnBackdrop?: boolean
  labelledBy?: string
}

/** Centered panel over a dimmed, blurred backdrop. Content and sizing come from the caller. */
export function Modal({
  open,
  onClose,
  children,
  className,
  style,
  closeOnEscape = true,
  closeOnBackdrop = true,
  labelledBy
}: Props) {
  useEffect(() => {
    if (!open || !closeOnEscape) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeOnEscape, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={clsx('modal-panel', className)}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}
