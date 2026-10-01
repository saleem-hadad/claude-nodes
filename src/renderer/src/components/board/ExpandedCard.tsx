import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { AppWindowMac, LoaderCircle, Minimize2, Play, RotateCcw, SquareTerminal } from 'lucide-react'
import type { SessionCard } from '@shared/types'
import { useApp } from '@renderer/store'
import * as registry from '@renderer/terminal/registry'
import { useAttachedTerminal } from '@renderer/terminal/useAttachedTerminal'
import '@renderer/terminal/terminal.css'
import { useBoardActions } from './BoardContext'

/** Sessions asked to start before their card has rendered expanded. */
const pendingWake = new Set<string>()
/** Expanded cards on the board, by session. */
const wakers = new Map<string, () => void>()
/** A card takes focus only right after it was asked to show its session. */
const FOCUS_WINDOW_MS = 1500

/**
 * Shows the session in its expanded card: starts (or resumes) it if it isn't
 * running, and focuses its terminal. Works before the card has expanded.
 */
export function wakeCardTerminal(sessionId: string) {
  const wake = wakers.get(sessionId)
  if (wake) wake()
  else pendingWake.add(sessionId)
}

const stop = (e: MouseEvent) => e.stopPropagation()

/** The inside of an expanded card: its title bar over the session's live terminal. */
export function ExpandedCard({ card, heading }: { card: SessionCard; heading: ReactNode }) {
  const id = card.sessionId
  const kind = card.kind ?? 'claude'
  const shell = kind === 'terminal'
  const projectId = useApp((s) => s.board?.project.id ?? '')
  const openTerminal = useApp((s) => s.openTerminal)
  // A terminal shows in one place at a time; the modal has it while it's open.
  const inModal = useApp((s) => s.terminalSessionId === id)
  const { expand } = useBoardActions()

  // A card that comes back expanded (after a restart, say) waits to be asked
  // before it starts Claude or a shell; one expanded just now starts right away.
  const [started, setStarted] = useState(
    () => card.live || !registry.needsOpen(id) || pendingWake.has(id)
  )
  const wokeAt = useRef(pendingWake.has(id) ? performance.now() : -Infinity)
  // Labels the loading state by how it started, so it doesn't flip when the session goes live.
  const startedLive = useRef(card.live)
  const [wakes, setWakes] = useState(0)
  const enabled = started && !inModal && Boolean(projectId)
  const { containerRef, phase, error, reattach } = useAttachedTerminal(id, projectId, kind, {
    enabled,
    focus: false
  })
  const bodyRef = useRef<HTMLDivElement>(null)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const wake = useRef(() => {})
  wake.current = () => {
    wokeAt.current = performance.now()
    startedLive.current = card.live
    if (!started) setStarted(true)
    else if (registry.needsOpen(id) && phase !== 'loading') reattach()
    setWakes((n) => n + 1)
  }

  // Started from elsewhere (the modal, say): show it here too, and keep showing it once it exits.
  useEffect(() => {
    if (card.live) setStarted(true)
  }, [card.live])

  useEffect(() => {
    pendingWake.delete(id)
    const run = () => wake.current()
    wakers.set(id, run)
    return () => {
      if (wakers.get(id) === run) wakers.delete(id)
    }
  }, [id])

  // Runs after the terminal attaches (the hook's effect comes first).
  useEffect(() => {
    if (enabled && performance.now() - wokeAt.current < FOCUS_WINDOW_MS) registry.focus(id)
  }, [id, enabled, wakes])

  // Scrolling over the terminal scrolls it, not the board; a pinch still zooms the board.
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const onWheel = (e: WheelEvent) => {
      if (enabledRef.current && !e.ctrlKey) e.stopPropagation()
    }
    body.addEventListener('wheel', onWheel)
    return () => body.removeEventListener('wheel', onWheel)
  }, [])

  const canResume = started && !card.live && phase !== 'loading'

  return (
    <>
      <header className="card-xhead">
        {heading}
        <div className="card-tools nodrag" onClick={stop} onDoubleClick={stop}>
          {canResume && (
            <button
              className="card-tool is-labelled"
              onClick={() => wake.current()}
              title={shell ? 'Start a new shell in the project folder' : 'Resume the session'}
            >
              {shell ? <RotateCcw size={12} strokeWidth={2.2} /> : <Play size={12} strokeWidth={2.2} />}
              {shell ? 'Restart' : 'Resume'}
            </button>
          )}
          <button
            className="card-tool"
            onClick={() => openTerminal(id)}
            title="Open in a window"
            aria-label="Open in a window"
          >
            <AppWindowMac size={14} strokeWidth={2} />
          </button>
          <button
            className="card-tool"
            onClick={() => expand([id], false)}
            title={shell ? 'Collapse (E). The shell keeps running.' : 'Collapse (E). The session keeps running.'}
            aria-label="Collapse"
          >
            <Minimize2 size={14} strokeWidth={2} />
          </button>
        </div>
      </header>

      <div
        ref={bodyRef}
        className="card-term nodrag"
        onClick={stop}
        onDoubleClick={stop}
        onPointerDown={() => enabled && registry.focus(id)}
      >
        <div ref={containerRef} className="term-container" />
        {!started && (
          <div className="term-overlay is-blocking">
            <button className="btn" onClick={() => wake.current()}>
              {shell ? <SquareTerminal size={13} /> : <Play size={13} />}
              {shell ? 'Start shell' : 'Resume session'}
            </button>
          </div>
        )}
        {enabled && phase === 'loading' && (
          <div className="term-overlay" aria-live="polite">
            <div className="term-overlay-pill">
              <LoaderCircle className="term-spin" size={14} />
              {shell ? 'Starting shell…' : startedLive.current ? 'Starting Claude…' : 'Resuming session…'}
            </div>
          </div>
        )}
        {enabled && phase === 'error' && (
          <div className="term-overlay is-blocking">
            <div className="term-error">
              <div className="term-error-title">
                {shell ? 'Couldn’t start the shell' : 'Couldn’t start Claude'}
              </div>
              {error && <div className="term-error-detail selectable">{error}</div>}
              <button className="btn btn-primary" onClick={reattach}>
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
