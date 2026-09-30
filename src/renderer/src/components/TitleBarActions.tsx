import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const TITLEBAR_ACTIONS_ID = 'titlebar-actions'

/**
 * Renders its children into the right-hand side of the title bar, so each view
 * can contribute its own toolbar buttons. TitleBar must render an element with
 * id={TITLEBAR_ACTIONS_ID}.
 */
export function TitleBarActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setTarget(document.getElementById(TITLEBAR_ACTIONS_ID))
  }, [])

  return target ? createPortal(children, target) : null
}
