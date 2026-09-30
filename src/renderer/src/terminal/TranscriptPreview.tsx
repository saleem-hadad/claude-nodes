import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArchiveRestore, X } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { cardTitle, useApp, useCard } from '@renderer/store'
import { STACK_ROWS, stackZone } from '@renderer/components/board/layout'
import type { BoardSnapshot, TranscriptMessage } from '@shared/types'
import './terminal.css'

const CARD_W = 288
const CARD_H = 216
const GAP = 40

export function TranscriptPreview() {
  const sessionId = useApp((s) => s.previewSessionId)
  const projectId = useApp((s) => s.board?.project.id)
  const closePreview = useApp((s) => s.closePreview)

  return (
    <Modal
      open={Boolean(sessionId && projectId)}
      onClose={closePreview}
      className="tp-modal"
      labelledBy="tp-title"
    >
      {sessionId && projectId && (
        <PreviewPanel key={sessionId} sessionId={sessionId} projectId={projectId} />
      )}
    </Modal>
  )
}

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; messages: TranscriptMessage[] }

function PreviewPanel({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  const card = useCard(sessionId)
  const closePreview = useApp((s) => s.closePreview)
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const scrollRef = useRef<HTMLDivElement>(null)

  const fetchTranscript = useCallback(() => {
    let cancelled = false
    setLoad({ state: 'loading' })
    window.api.sessions.transcript(projectId, sessionId).then(
      (messages) => !cancelled && setLoad({ state: 'ready', messages }),
      (err: unknown) =>
        !cancelled &&
        setLoad({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    )
    return () => {
      cancelled = true
    }
  }, [projectId, sessionId])

  useEffect(fetchTranscript, [fetchTranscript])

  // Most recent messages first in view: start scrolled to the bottom.
  useLayoutEffect(() => {
    if (load.state === 'ready' && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [load])

  const restore = () => {
    const { board, patchCards, closePreview, openTerminal } = useApp.getState()
    if (!board) return
    const { x, y } = freeSlotBesideArchive(board, sessionId)
    patchCards([{ sessionId, archived: false, x, y }])
    closePreview()
    openTerminal(sessionId)
  }

  const meta = card?.meta
  const messageCount = load.state === 'ready' ? load.messages.length : meta?.messageCount

  return (
    <>
      <header className="tp-header">
        <div className="tp-heading">
          <h2 id="tp-title" className="tp-title">
            {cardTitle(card)}
          </h2>
          <div className="tp-sub">
            {meta && <span>{formatRange(meta.createdAt, meta.updatedAt)}</span>}
            {messageCount !== undefined && (
              <span>
                {messageCount} {messageCount === 1 ? 'message' : 'messages'}
              </span>
            )}
            {meta?.gitBranch && <span className="tp-mono">{meta.gitBranch}</span>}
          </div>
        </div>
        <div className="tp-actions">
          <button className="btn btn-primary" onClick={restore}>
            <ArchiveRestore size={14} />
            Restore &amp; Open
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={closePreview}
            title="Close (Esc)"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="tp-body">
        {load.state === 'loading' && <Skeleton />}
        {load.state === 'error' && (
          <div className="tp-empty">
            <div>Couldn’t read this transcript.</div>
            <div className="tp-empty-detail selectable">{load.message}</div>
            <button className="btn" onClick={fetchTranscript}>
              Try again
            </button>
          </div>
        )}
        {load.state === 'ready' && load.messages.length === 0 && (
          <div className="tp-empty">No messages in this session.</div>
        )}
        {load.state === 'ready' && load.messages.length > 0 && (
          <ol className="tp-list">
            {load.messages.map((m, i) => (
              <Message key={i} message={m} />
            ))}
          </ol>
        )}
      </div>
    </>
  )
}

const COLLAPSE_LINES = 12
const COLLAPSE_CHARS = 1200

function Message({ message }: { message: TranscriptMessage }) {
  const text = message.text.trim()
  const long = text.split('\n').length > COLLAPSE_LINES || text.length > COLLAPSE_CHARS
  const [expanded, setExpanded] = useState(false)
  const isUser = message.role === 'user'

  return (
    <li className="tp-msg" data-role={message.role}>
      <div className="tp-msg-meta">
        <span className="tp-msg-author">{isUser ? 'You' : 'Claude'}</span>
        {message.timestamp > 0 && <time>{formatTime(message.timestamp)}</time>}
      </div>
      {text && (
        <div className="tp-msg-content">
          <div className={long && !expanded ? 'tp-text is-collapsed' : 'tp-text'}>
            <div className="selectable">{text}</div>
          </div>
          {long && (
            <button className="tp-more" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
      {message.tools && message.tools.length > 0 && (
        <div className="tp-tools">
          {message.tools.map((tool, i) => (
            <span key={i} className="tp-tool">
              {tool}
            </span>
          ))}
        </div>
      )}
    </li>
  )
}

function Skeleton() {
  return (
    <div className="tp-skeleton" aria-label="Loading transcript">
      {[72, 94, 58, 86, 40].map((w, i) => (
        <div key={i} className="tp-skel-row">
          <div className="tp-skel-line is-short" />
          <div className="tp-skel-line" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  )
}

/**
 * First spot to the right of the archive, filling columns top to bottom,
 * that doesn't overlap an active card.
 */
function freeSlotBesideArchive(board: BoardSnapshot, sessionId: string) {
  // Clear of the archive panel at its largest: it may be open behind this preview.
  const archive = stackZone(board.archive, STACK_ROWS * 2)
  const others = board.cards.filter((c) => !c.archived && c.sessionId !== sessionId)
  const rows = Math.max(3, Math.floor(archive.h / (CARD_H + GAP)))
  const overlaps = (x: number, y: number) =>
    others.some(
      (c) => x < c.x + CARD_W + GAP && x + CARD_W + GAP > c.x && y < c.y + CARD_H + GAP && y + CARD_H + GAP > c.y
    )

  for (let i = 0; i < rows * 40; i++) {
    const x = archive.x + archive.w + 80 + Math.floor(i / rows) * (CARD_W + GAP)
    const y = archive.y + (i % rows) * (CARD_H + GAP)
    if (!overlaps(x, y)) return { x, y }
  }
  return { x: archive.x + archive.w + 80, y: archive.y + others.length * 24 }
}

const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const yearFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
})
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function formatDay(ts: number) {
  const sameYear = new Date(ts).getFullYear() === new Date().getFullYear()
  return (sameYear ? dayFmt : yearFmt).format(ts)
}

function formatRange(start: number, end: number) {
  if (new Date(start).toDateString() === new Date(end).toDateString()) {
    return `${formatDay(start)}, ${timeFmt.format(start)} – ${timeFmt.format(end)}`
  }
  return `${formatDay(start)} – ${formatDay(end)}`
}

function formatTime(ts: number) {
  const isToday = new Date(ts).toDateString() === new Date().toDateString()
  return isToday ? timeFmt.format(ts) : `${formatDay(ts)}, ${timeFmt.format(ts)}`
}
