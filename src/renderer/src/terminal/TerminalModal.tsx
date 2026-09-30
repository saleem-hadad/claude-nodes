import { useEffect, useRef, useState } from 'react'
import { Archive, Check, GitBranch, LoaderCircle, Play, Square, X } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { cardTitle, useApp, useCard } from '@renderer/store'
import type { SessionCard } from '@shared/types'
import * as registry from './registry'
import './terminal.css'

export function TerminalModal() {
  const sessionId = useApp((s) => s.terminalSessionId)
  const projectId = useApp((s) => s.board?.project.id)
  const closeTerminal = useApp((s) => s.closeTerminal)
  const open = Boolean(sessionId && projectId)

  return (
    <Modal
      open={open}
      onClose={closeTerminal}
      // Escape belongs to Claude (it interrupts the current turn).
      closeOnEscape={false}
      className="term-modal"
      labelledBy="term-modal-title"
    >
      {sessionId && projectId && (
        <TerminalPanel key={sessionId} sessionId={sessionId} projectId={projectId} />
      )}
    </Modal>
  )
}

type Phase = 'loading' | 'ready' | 'error'

function TerminalPanel({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  const card = useCard(sessionId)
  const containerRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>(() =>
    registry.hasOutput(sessionId) && !registry.needsOpen(sessionId) ? 'ready' : 'loading'
  )
  const [error, setError] = useState<string | null>(null)
  // Bumped by "Resume" to re-run the attach effect.
  const [attachKey, setAttachKey] = useState(0)
  // Label the loading state by how the modal was opened, so it doesn't flip
  // mid-load when the status event marks the session live.
  const startedLive = useRef(card?.live ?? false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let cancelled = false

    if (registry.needsOpen(sessionId) || !registry.hasOutput(sessionId)) setPhase('loading')
    setError(null)

    const attaching = registry.attach(sessionId, projectId, container)
    const offOutput = registry.onOutput(sessionId, () => {
      if (!cancelled) setPhase('ready')
    })
    attaching.then(
      () => {
        if (cancelled) return
        if (registry.hasOutput(sessionId)) setPhase('ready')
        registry.focus(sessionId)
      },
      (err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
      }
    )
    registry.focus(sessionId)

    return () => {
      cancelled = true
      offOutput()
      registry.detach(sessionId)
    }
  }, [sessionId, projectId, attachKey])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
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
  }, [sessionId])

  const resume = () => {
    startedLive.current = false
    setAttachKey((k) => k + 1)
  }

  return (
    <>
      <TerminalHeader
        card={card}
        sessionId={sessionId}
        canResume={!card?.live && phase !== 'loading'}
        onResume={resume}
      />
      <div className="term-body" onPointerDown={() => registry.focus(sessionId)}>
        <div ref={containerRef} className="term-container" />
        {phase === 'loading' && (
          <div className="term-overlay" aria-live="polite">
            <div className="term-overlay-pill">
              <LoaderCircle className="term-spin" size={14} />
              {startedLive.current ? 'Starting Claude…' : 'Resuming session…'}
            </div>
          </div>
        )}
        {phase === 'error' && (
          <div className="term-overlay is-blocking">
            <div className="term-error">
              <div className="term-error-title">Couldn’t start Claude</div>
              {error && <div className="term-error-detail selectable">{error}</div>}
              <button className="btn btn-primary" onClick={resume}>
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function statusLabel(card: SessionCard | undefined): string {
  if (!card) return ''
  if (card.status === 'working') return 'Working'
  if (card.status === 'waiting') return 'Needs you'
  return card.live ? 'Idle' : 'Not running'
}

function TerminalHeader({
  card,
  sessionId,
  canResume,
  onResume
}: {
  card: SessionCard | undefined
  sessionId: string
  canResume: boolean
  onResume: () => void
}) {
  const closeTerminal = useApp((s) => s.closeTerminal)
  const patchCards = useApp((s) => s.patchCards)
  const [copied, setCopied] = useState(false)
  const status = card?.status ?? 'done'
  const branch = card?.meta?.gitBranch

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copyId = () => {
    navigator.clipboard.writeText(sessionId).then(() => setCopied(true), () => {})
  }

  const archive = () => {
    patchCards([{ sessionId, archived: true }])
    closeTerminal()
  }

  return (
    <header className="term-header">
      <div className="term-status" title={statusLabel(card)}>
        <span className="status-dot" data-status={status} />
        <span className="term-status-label" data-status={status}>
          {statusLabel(card)}
        </span>
      </div>

      <div className="term-heading">
        <h2 id="term-modal-title" className="term-title">
          {cardTitle(card)}
        </h2>
        <div className="term-sub">
          {branch && (
            <span className="term-branch">
              <GitBranch size={12} />
              {branch}
            </span>
          )}
          <button
            className="term-id"
            onClick={copyId}
            title="Copy session ID"
            aria-label="Copy session ID"
          >
            {copied ? (
              <>
                <Check size={11} /> Copied
              </>
            ) : (
              sessionId.slice(0, 8)
            )}
          </button>
        </div>
      </div>

      <div className="term-actions">
        {canResume && (
          <button className="btn" onClick={onResume}>
            <Play size={13} />
            Resume
          </button>
        )}
        {card?.live && (
          <button
            className="btn"
            onClick={() => window.api.sessions.kill(sessionId)}
            title="Stop the Claude process (the session can be resumed later)"
          >
            <Square size={12} />
            Stop
          </button>
        )}
        <button className="btn" onClick={archive} title="Stop and move to the archive">
          <Archive size={13} />
          Archive
        </button>
        <span className="term-divider" />
        <button
          className="btn btn-ghost btn-icon"
          onClick={closeTerminal}
          title="Close (⌘W). The session keeps running."
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>
    </header>
  )
}
