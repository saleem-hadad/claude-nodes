import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Circle, Loader2, RotateCcw, Sparkles } from 'lucide-react'
import clsx from 'clsx'
import type { SummarizePhase, SummaryResult } from '@shared/types'
import { Modal } from '../Modal'
import { truncate } from './layout'

export interface MergeSource {
  sessionId: string
  title: string
}

export interface MergeStartOptions {
  name: string
  initialPrompt: string
  parents: string[]
}

interface Props {
  projectId: string
  sources: MergeSource[]
  onClose: () => void
  /** Creates the session. Rejects with an error to keep the dialog open. */
  onStart: (opts: MergeStartOptions) => Promise<void>
}

interface ItemState {
  phase: SummarizePhase
  title: string
  summary?: string
  error?: string
  skipped?: boolean
}

const DEFAULT_INSTRUCTION =
  'Read the context above, confirm briefly what you understand, then wait for my instructions.'

function defaultName(sources: MergeSource[]): string {
  const titles = sources.map((s) => truncate(s.title, 28))
  const joined =
    titles.length <= 2
      ? titles.join(' + ')
      : `${titles.slice(0, 2).join(' + ')} + ${titles.length - 2} more`
  return truncate(`From: ${joined}`, 64)
}

function section(index: number, title: string, summary: string) {
  return `## Session ${index} — ${title}\n${summary.trim()}`
}

function compose(sources: MergeSource[], items: Record<string, ItemState>): string {
  const ok = sources
    .map((s) => items[s.sessionId])
    .filter((it) => it.phase === 'done' && it.summary && !it.skipped)
  if (ok.length === 0) return ''
  const n = ok.length
  const head =
    `I'm continuing work from ${n} earlier Claude Code session${n === 1 ? '' : 's'} ` +
    `in this repository. Here is a handoff summary of ${n === 1 ? 'it' : 'each'}:`
  return [head, ...ok.map((it, i) => section(i + 1, it.title, it.summary!))].join('\n\n')
}

export function MergeDialog({ projectId, sources, onClose, onStart }: Props) {
  const [items, setItems] = useState<Record<string, ItemState>>(() =>
    Object.fromEntries(sources.map((s) => [s.sessionId, { phase: 'queued', title: s.title }]))
  )
  const [step, setStep] = useState<'gathering' | 'review'>('gathering')
  const [context, setContext] = useState('')
  const [contextDirty, setContextDirty] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [name, setName] = useState(() => defaultName(sources))
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)

  const alive = useRef(true)
  const started = useRef(false)
  const requests = useRef(new Set<string>())
  const dirtyRef = useRef(false)
  dirtyRef.current = contextDirty
  const itemsRef = useRef(items)
  itemsRef.current = items

  // Progress events for our own requests only.
  useEffect(() => {
    alive.current = true
    const off = window.api.on.summarizeProgress((p) => {
      if (!requests.current.has(p.requestId)) return
      setItems((prev) => {
        const cur = prev[p.sessionId]
        if (!cur || cur.phase === 'done') return prev
        return { ...prev, [p.sessionId]: { ...cur, phase: p.phase, error: p.error } }
      })
    })
    return () => {
      alive.current = false
      off()
    }
  }, [])

  const run = async (ids: string[]) => {
    const requestId = crypto.randomUUID()
    requests.current.add(requestId)
    setItems((prev) => {
      const next = { ...prev }
      for (const id of ids) next[id] = { ...next[id], phase: 'queued', error: undefined, skipped: false }
      return next
    })

    let results: SummaryResult[]
    try {
      results = await window.api.sessions.summarize(projectId, ids, requestId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      results = ids.map((sessionId) => ({ sessionId, title: '', summary: '', error: message }))
    }
    // Closed meanwhile: the summaries are simply dropped.
    if (!alive.current) return

    // If the user already edited the context, append retried summaries instead of recomposing.
    if (dirtyRef.current) {
      const added = results.filter((r) => !r.error && r.summary?.trim())
      if (added.length) {
        const base = Object.values(itemsRef.current).filter((it) => it.phase === 'done').length
        const titleOf = (r: SummaryResult) => r.title || itemsRef.current[r.sessionId]?.title || ''
        setContext((c) =>
          [c.trimEnd(), ...added.map((r, i) => section(base + i + 1, titleOf(r), r.summary))].join(
            '\n\n'
          )
        )
      }
    }

    setItems((prev) => {
      const next = { ...prev }
      for (const r of results) {
        const cur = next[r.sessionId]
        if (!cur) continue
        const failed = Boolean(r.error) || !r.summary?.trim()
        next[r.sessionId] = failed
          ? { ...cur, phase: 'error', error: r.error || 'The session returned an empty summary.' }
          : { ...cur, phase: 'done', summary: r.summary, title: r.title || cur.title, error: undefined }
      }
      return next
    })
  }

  // Kick off summarization once (guarded against StrictMode's double effects).
  useEffect(() => {
    if (started.current) return
    started.current = true
    run(sources.map((s) => s.sessionId))
  }, [])

  const list = sources.map((s) => ({ ...s, ...items[s.sessionId] }))
  const pending = list.filter((it) => it.phase === 'queued' || it.phase === 'running')
  const blocking = list.filter((it) => it.phase === 'error' && !it.skipped)
  const succeeded = list.filter((it) => it.phase === 'done' && !it.skipped)

  // Move to review once every session has settled.
  useEffect(() => {
    if (step === 'gathering' && pending.length === 0) setStep('review')
  }, [step, pending.length])

  // Keep the generated context in sync until the user edits it.
  const generated = useMemo(() => compose(sources, items), [sources, items])
  useEffect(() => {
    if (!contextDirty) setContext(generated)
  }, [generated, contextDirty])

  useEffect(() => {
    if (step !== 'gathering') return
    const t0 = Date.now()
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [step])

  const canStart =
    step === 'review' &&
    !starting &&
    pending.length === 0 &&
    blocking.length === 0 &&
    (context.trim().length > 0 || instruction.trim().length > 0)

  const start = async () => {
    if (!canStart) return
    setStarting(true)
    setStartError(null)
    const body = instruction.trim() || DEFAULT_INSTRUCTION
    const initialPrompt = context.trim() ? `${context.trim()}\n\n---\n\n${body}` : body
    try {
      await onStart({
        name: name.trim() || defaultName(sources),
        initialPrompt,
        parents: succeeded.map((it) => it.sessionId)
      })
    } catch (err) {
      if (!alive.current) return
      setStartError(err instanceof Error ? err.message : String(err))
      setStarting(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      closeOnBackdrop={false}
      className={clsx('merge-dialog', step === 'gathering' && 'is-gathering')}
      labelledBy="merge-title"
    >
      <div
        className="merge-inner"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.metaKey) {
            e.preventDefault()
            start()
          }
        }}
      >
        <header className="merge-head">
          <div className="merge-head-icon">
            <Sparkles size={16} strokeWidth={2.2} />
          </div>
          <div>
            <h2 id="merge-title" className="merge-title">
              {step === 'gathering' ? 'Gathering context' : 'New session from context'}
            </h2>
            <p className="merge-subtitle">
              {step === 'gathering'
                ? 'Each session summarizes itself in a forked copy. The originals stay untouched.'
                : 'Review and edit the handoff, then tell the new session what to do.'}
            </p>
          </div>
        </header>

        {step === 'gathering' ? (
          <div className="merge-body">
            <ul className="merge-progress">
              {list.map((it) => (
                <li key={it.sessionId} className="merge-progress-row" data-phase={it.phase}>
                  <PhaseIcon phase={it.phase} />
                  <span className="merge-progress-title">{it.title}</span>
                  <span className="merge-progress-state">
                    {it.phase === 'queued' && 'Queued'}
                    {it.phase === 'running' && 'Summarizing…'}
                    {it.phase === 'done' && 'Ready'}
                    {it.phase === 'error' && 'Failed'}
                  </span>
                </li>
              ))}
            </ul>
            <p className="merge-elapsed">
              {elapsed > 0 ? `${elapsed}s elapsed · ` : ''}Usually 10–30 seconds per session
            </p>
          </div>
        ) : (
          <div className="merge-body merge-review">
            <div className="merge-sources">
              {list.map((it) => (
                <div
                  key={it.sessionId}
                  className={clsx('merge-source', it.skipped && 'is-skipped')}
                  data-phase={it.phase}
                >
                  <div className="merge-source-row">
                    <PhaseIcon phase={it.skipped ? 'queued' : it.phase} />
                    <span className="merge-source-title">{it.title}</span>
                    {it.phase === 'error' && !it.skipped && (
                      <span className="merge-source-actions">
                        <button className="btn btn-ghost merge-mini" onClick={() => run([it.sessionId])}>
                          <RotateCcw size={12} strokeWidth={2.2} />
                          Retry
                        </button>
                        <button
                          className="btn btn-ghost merge-mini"
                          onClick={() =>
                            setItems((prev) => ({
                              ...prev,
                              [it.sessionId]: { ...prev[it.sessionId], skipped: true }
                            }))
                          }
                        >
                          Skip
                        </button>
                      </span>
                    )}
                    {it.skipped && <span className="merge-source-note">Skipped</span>}
                  </div>
                  {it.phase === 'error' && !it.skipped && it.error && (
                    <p className="merge-source-error selectable">{it.error}</p>
                  )}
                </div>
              ))}
            </div>

            <label className="merge-field merge-field-grow">
              <span className="merge-label">
                Context
                {contextDirty && (
                  <button
                    className="merge-reset"
                    onClick={(e) => {
                      e.preventDefault()
                      setContextDirty(false)
                    }}
                  >
                    Reset to generated
                  </button>
                )}
              </span>
              <textarea
                className="merge-context"
                value={context}
                spellCheck={false}
                placeholder="No summaries yet. Retry the failed sessions or write the context yourself."
                onChange={(e) => {
                  setContext(e.target.value)
                  setContextDirty(true)
                }}
              />
            </label>

            <label className="merge-field">
              <span className="merge-label">What should the new session do?</span>
              <textarea
                className="merge-instruction"
                rows={3}
                value={instruction}
                autoFocus
                placeholder="e.g. Combine both approaches and implement …"
                onChange={(e) => setInstruction(e.target.value)}
              />
            </label>

            <label className="merge-field">
              <span className="merge-label">Name</span>
              <input
                className="merge-name"
                value={name}
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          </div>
        )}

        <footer className="merge-foot">
          <span className="merge-foot-note">
            {startError ? (
              <span className="merge-error">{startError}</span>
            ) : blocking.length > 0 ? (
              'Retry or skip the failed sessions to continue.'
            ) : step === 'review' ? (
              <>
                <kbd>⌘</kbd>
                <kbd>↩</kbd> to start
              </>
            ) : null}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!canStart} onClick={start}>
            {starting ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} strokeWidth={2.2} />}
            Start session
          </button>
        </footer>
      </div>
    </Modal>
  )
}

function PhaseIcon({ phase }: { phase: SummarizePhase }) {
  switch (phase) {
    case 'running':
      return <Loader2 size={15} className="phase-icon spin" data-phase={phase} />
    case 'done':
      return <CheckCircle2 size={15} className="phase-icon" data-phase={phase} />
    case 'error':
      return <AlertCircle size={15} className="phase-icon" data-phase={phase} />
    default:
      return <Circle size={15} className="phase-icon" data-phase={phase} />
  }
}
