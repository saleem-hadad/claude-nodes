import { useEffect, useRef, useState } from 'react'
import type { SessionKind } from '@shared/types'
import * as registry from './registry'

export type TerminalPhase = 'loading' | 'ready' | 'error'

interface Options {
  /** Attach only while true; the terminal is parked otherwise. */
  enabled?: boolean
  /** Focus the terminal when it is attached (read at that moment). */
  focus?: boolean
}

/**
 * Shows the session's terminal in the returned container, starting (or
 * resuming) its process if needed, and keeps it fitted to the container.
 * `reattach` runs the attach again, which resumes an exited process.
 */
export function useAttachedTerminal(
  sessionId: string,
  projectId: string,
  kind: SessionKind,
  { enabled = true, focus = true }: Options = {}
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<TerminalPhase>(() =>
    registry.hasOutput(sessionId) && !registry.needsOpen(sessionId) ? 'ready' : 'loading'
  )
  const [error, setError] = useState<string | null>(null)
  // Bumped by reattach() to re-run the attach effect.
  const [attachKey, setAttachKey] = useState(0)
  const focusRef = useRef(focus)
  focusRef.current = focus

  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) return
    let cancelled = false
    const shouldFocus = focusRef.current

    if (registry.needsOpen(sessionId) || !registry.hasOutput(sessionId)) setPhase('loading')
    setError(null)

    const attaching = registry.attach(sessionId, projectId, container, kind)
    const offOutput = registry.onOutput(sessionId, () => {
      if (!cancelled) setPhase('ready')
    })
    attaching.then(
      () => {
        if (cancelled) return
        if (registry.hasOutput(sessionId)) setPhase('ready')
        if (shouldFocus) registry.focus(sessionId)
      },
      (err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
      }
    )
    if (shouldFocus) registry.focus(sessionId)

    return () => {
      cancelled = true
      offOutput()
      registry.detach(sessionId, container)
    }
  }, [sessionId, projectId, kind, attachKey, enabled])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => registry.refit(sessionId))
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [sessionId, enabled])

  return { containerRef, phase, error, reattach: () => setAttachKey((k) => k + 1) }
}
