import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { AgentInfo, TranscriptMessage } from '@shared/types'
import { Modal } from '@renderer/components/Modal'
import { agentElapsed, useNow } from '@renderer/components/board/AgentDeck'
import { agentStatusLabel, agentStep, byUrgency, cardTitle, nestAgents, useApp, useCard } from '@renderer/store'
import { Message, Skeleton, formatTime } from './TranscriptPreview'
import './terminal.css'

/** How often the list, and a running agent's transcript, are read again. */
const POLL_MS = 1500
/** Scrolled this close to the bottom, the transcript follows new steps. */
const STICK_PX = 48

/** A session's agents: a list of every one it started, beside the selected agent's live transcript. */
export function AgentViewer() {
  const view = useApp((s) => s.agentView)
  const projectId = useApp((s) => s.board?.project.id)
  const closeAgents = useApp((s) => s.closeAgents)

  return (
    <Modal open={Boolean(view && projectId)} onClose={closeAgents} className="av-modal" labelledBy="av-title">
      {view && projectId && (
        <AgentsPanel key={view.sessionId} projectId={projectId} sessionId={view.sessionId} agentId={view.agentId} />
      )}
    </Modal>
  )
}

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; messages: TranscriptMessage[] }

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The one shown when none is picked: the most urgent still at work, else the latest. */
function defaultAgent(agents: AgentInfo[]): AgentInfo | undefined {
  const busy = agents.filter((a) => a.status !== 'done').sort(byUrgency)[0]
  return busy ?? agents.reduce<AgentInfo | undefined>((a, b) => (!a || b.startedAt > a.startedAt ? b : a), undefined)
}

function AgentsPanel({ projectId, sessionId, agentId }: { projectId: string; sessionId: string; agentId?: string }) {
  const card = useCard(sessionId)
  const closeAgents = useApp((s) => s.closeAgents)
  const openAgents = useApp((s) => s.openAgents)
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  // Keys typed here must never reach a terminal that had focus (Escape interrupts Claude).
  useEffect(() => {
    ;(document.activeElement as HTMLElement | null)?.blur()
  }, [])

  // The card carries the live statuses: read the list again when they change,
  // and every so often while an agent runs.
  const cardAgents = JSON.stringify(card?.agents?.map((a) => [a.agentId, a.status, a.updatedAt]) ?? [])
  useEffect(() => {
    let cancelled = false
    window.api.sessions.agents(projectId, sessionId).then(
      (list) => {
        if (cancelled) return
        setAgents(list)
        setListError(null)
      },
      (err: unknown) => !cancelled && setListError(errorText(err))
    )
    return () => {
      cancelled = true
    }
  }, [projectId, sessionId, cardAgents, tick])

  const running = agents?.some((a) => a.status !== 'done') ?? false
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setTick((n) => n + 1), POLL_MS)
    return () => window.clearInterval(timer)
  }, [running])

  const selected = (agentId && agents?.find((a) => a.agentId === agentId)) || (agents && defaultAgent(agents))
  const now = useNow(selected?.status === 'working' || selected?.status === 'waiting')

  return (
    <>
      <header className="tp-header">
        <div className="tp-heading">
          <h2 id="av-title" className="tp-title">
            {selected ? selected.description : 'Agents'}
          </h2>
          <div className="tp-sub">
            {selected && (
              <>
                <span className="av-status" data-status={selected.status}>
                  <span className="status-dot is-small" data-status={selected.status} />
                  {agentStatusLabel(selected)}
                </span>
                <span>{selected.agentType}</span>
                <span>
                  {formatTime(selected.startedAt)} · {agentElapsed(selected, now)}
                </span>
                {selected.toolCount > 0 && (
                  <span>
                    {selected.toolCount} tool {selected.toolCount === 1 ? 'call' : 'calls'}
                  </span>
                )}
              </>
            )}
            <span className="av-session" title="The session that started these agents">
              {cardTitle(card)}
            </span>
          </div>
        </div>
        <div className="tp-actions">
          <button className="btn btn-ghost btn-icon" onClick={closeAgents} title="Close (Esc)" aria-label="Close">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="av-body">
        <nav className="av-list" aria-label="Agents">
          {agents === null && !listError && <div className="av-list-note">Loading…</div>}
          {listError && <div className="av-list-note selectable">{listError}</div>}
          {agents && agents.length === 0 && <div className="av-list-note">No agents yet.</div>}
          {agents &&
            nestAgents(agents, true).map(({ agent: a, depth }) => (
              <button
                key={a.agentId}
                className="av-item"
                aria-current={a.agentId === selected?.agentId}
                style={depth > 0 ? { paddingLeft: 12 + Math.min(depth, 3) * 14 } : undefined}
                onClick={() => openAgents(sessionId, a.agentId)}
              >
                <span className="status-dot is-small" data-status={a.status} />
                <span className="av-item-text">
                  <span className="av-item-name">{a.description}</span>
                  <span className="av-item-sub">
                    {a.agentType} · {formatTime(a.startedAt)}
                  </span>
                </span>
              </button>
            ))}
        </nav>

        {selected ? (
          <AgentTranscript key={selected.agentId} projectId={projectId} sessionId={sessionId} agent={selected} />
        ) : (
          <div className="av-detail">
            <div className="tp-empty">{agents ? 'This session hasn’t started any agents.' : ''}</div>
          </div>
        )}
      </div>
    </>
  )
}

/** An agent's transcript, read again as it works and kept scrolled to its latest step unless you scroll up. */
function AgentTranscript({ projectId, sessionId, agent }: { projectId: string; sessionId: string; agent: AgentInfo }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    let cancelled = false
    window.api.sessions.agentTranscript(projectId, sessionId, agent.agentId).then(
      (messages) => !cancelled && setLoad({ state: 'ready', messages }),
      (err: unknown) => !cancelled && setLoad({ state: 'error', message: errorText(err) })
    )
    return () => {
      cancelled = true
    }
  }, [projectId, sessionId, agent.agentId, agent.updatedAt, agent.status])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (load.state === 'ready' && el && stick.current) el.scrollTop = el.scrollHeight
  }, [load])

  const onScroll = () => {
    const el = scrollRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
  }

  const atWork = agent.status !== 'done'

  return (
    <div className="av-detail">
      <div ref={scrollRef} className="tp-body" onScroll={onScroll}>
        {load.state === 'loading' && <Skeleton />}
        {load.state === 'error' && (
          <div className="tp-empty">
            <div>Couldn’t read this agent’s transcript.</div>
            <div className="tp-empty-detail selectable">{load.message}</div>
          </div>
        )}
        {load.state === 'ready' && load.messages.length === 0 && (
          <div className="tp-empty">{atWork ? 'Starting…' : 'This agent left no transcript.'}</div>
        )}
        {load.state === 'ready' && load.messages.length > 0 && (
          <ol className="tp-list">
            {load.messages.map((m, i) => (
              <Message
                key={i}
                message={m}
                author={
                  m.role === 'assistant' ? agent.agentType : m.notice ? 'Background task' : i === 0 ? 'Task' : 'Message'
                }
              />
            ))}
          </ol>
        )}
        {load.state === 'ready' && atWork && (
          <div className="av-live" data-status={agent.status}>
            <span className="status-dot is-small" data-status={agent.status} />
            <span className="av-live-text">{liveLine(agent)}</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** Under the transcript of an agent at work: what it's doing right now. */
function liveLine(agent: AgentInfo): string {
  const { tool, text } = agentStep(agent)
  if (tool) return text ? `${tool}: ${text}` : tool
  // Its last words are already the transcript's last message.
  return agent.background || agent.status === 'waiting' ? text ?? 'Working…' : 'Working…'
}
