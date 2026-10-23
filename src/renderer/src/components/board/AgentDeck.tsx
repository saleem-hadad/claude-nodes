import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type RefObject
} from 'react'
import { ArrowRight } from 'lucide-react'
import type { AgentInfo } from '@shared/types'
import { agentStatusLabel, agentStep, byUrgency, formatDuration, useApp } from '@renderer/store'

/** Agents peeking out under the card; the rest are only counted. */
const PEEK_LAYERS = 3
/** Agents the fan deals out before the rest wait behind "all agents". */
const FAN_MAX = 6
/** Time to move the pointer from the deck to the fan (or back) before it folds away. */
const CLOSE_DELAY_MS = 280

const stop = (e: MouseEvent) => e.stopPropagation()

/** The current time, ticking every second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

/** How long an agent has run, or ran. */
export function agentElapsed(agent: AgentInfo, now: number): string {
  return formatDuration((agent.status === 'done' ? agent.updatedAt : now) - agent.startedAt)
}

/**
 * Whether a card's deck is fanned out. Pointing at the deck (or the card's
 * agents button) fans it while the pointer stays on the card or the fan;
 * a click pins it open until a click elsewhere, or Escape.
 */
export function useDeck(nodeRef: RefObject<HTMLElement | null>) {
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const open = hover || pinned

  const point = useCallback(() => {
    window.clearTimeout(timer.current)
    setHover(true)
  }, [])
  /** The pointer is back on the card or the fan: keep an open deck open. */
  const stay = useCallback(() => window.clearTimeout(timer.current), [])
  const leave = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setHover(false), CLOSE_DELAY_MS)
  }, [])
  const close = useCallback(() => {
    window.clearTimeout(timer.current)
    setHover(false)
    setPinned(false)
  }, [])
  const toggle = useCallback(() => {
    window.clearTimeout(timer.current)
    setPinned((p) => !p)
    setHover(true)
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    if (!pinned) return
    const onDown = (e: PointerEvent) => {
      if (!nodeRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [pinned, nodeRef, close])

  return { open, pinned, point, stay, leave, close, toggle }
}

export type Deck = ReturnType<typeof useDeck>

/**
 * A session's current run of agents as a deck of cards behind its card, each
 * peeking out with its status colour. Fanned out, they line up beside the
 * card with what each is doing; a click opens one in the agents viewer.
 */
export function AgentDeck({
  sessionId,
  agents,
  total,
  deck
}: {
  sessionId: string
  agents: AgentInfo[]
  total: number
  deck: Deck
}) {
  const urgent = [...agents].sort(byUrgency)
  // The most urgent agent peeks out nearest the card. Deepest is drawn first.
  const layers = urgent.slice(0, PEEK_LAYERS).reverse()
  const running = agents.filter((a) => a.status !== 'done').length

  return (
    <>
      <div className="agent-deck" data-open={deck.open || undefined} aria-hidden>
        {layers.map((a, i) => (
          <span
            key={a.agentId}
            className="agent-deck-layer nodrag"
            data-depth={layers.length - i}
            data-status={a.status}
            onPointerEnter={deck.point}
            onClick={(e) => {
              e.stopPropagation()
              deck.toggle()
            }}
            onDoubleClick={stop}
          />
        ))}
      </div>
      {deck.open && (
        <AgentFan sessionId={sessionId} agents={agents} urgent={urgent} total={total} running={running} deck={deck} />
      )}
    </>
  )
}

function AgentFan({
  sessionId,
  agents,
  urgent,
  total,
  running,
  deck
}: {
  sessionId: string
  agents: AgentInfo[]
  urgent: AgentInfo[]
  total: number
  running: number
  deck: Deck
}) {
  const openAgents = useApp((s) => s.openAgents)
  const now = useNow(running > 0)
  // With more than fit, the most urgent are dealt out, still in the order they started.
  const picked = new Set(
    (agents.length > FAN_MAX ? urgent.slice(0, FAN_MAX - 1) : agents).map((a) => a.agentId)
  )
  const shown = agents.filter((a) => picked.has(a.agentId))
  const open = (agentId?: string) => {
    deck.close()
    openAgents(sessionId, agentId)
  }

  // Deals out to the right of the card, else to its left, whichever has room on
  // screen. With room on neither (a big expanded card, zoomed in), it floats
  // over the card's own right edge.
  const ref = useRef<HTMLDivElement>(null)
  const [side, setSide] = useState<'right' | 'left' | 'inside'>('right')
  useLayoutEffect(() => {
    const fan = ref.current
    const card = fan?.parentElement
    const board = fan?.closest('.board-canvas')
    if (!fan || !card || !board) return
    const f = fan.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    const b = board.getBoundingClientRect()
    const gap = f.left - c.right
    if (c.right + gap + f.width <= b.right) return
    setSide(c.left - gap - f.width >= b.left ? 'left' : 'inside')
  }, [])

  return (
    <div
      ref={ref}
      className="agent-fan nodrag nowheel"
      data-side={side}
      onPointerEnter={deck.stay}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      aria-label="Agents"
    >
      <div className="agent-fan-head">
        <span className="agent-fan-title">Agents</span>
        <span className="agent-fan-count">
          {running > 0 ? `${running} of ${agents.length} running` : 'All done'}
        </span>
      </div>
      {shown.map((a, i) => {
        const step = agentStep(a)
        return (
          <button
            key={a.agentId}
            className="fan-card"
            data-status={a.status}
            style={{ '--i': i } as CSSProperties}
            onClick={() => open(a.agentId)}
            title={a.description}
          >
            <span className="fan-card-head">
              <span className="status-dot is-small" data-status={a.status} />
              <span className="fan-card-name">{a.description}</span>
            </span>
            {step.text || step.tool ? (
              <span className="fan-card-step">
                {step.tool && <span className="fan-card-tool">{step.tool}</span>}
                {step.text && <span className="fan-card-detail">{step.text}</span>}
              </span>
            ) : null}
            <span className="fan-card-meta">
              <span className="fan-card-status" data-status={a.status}>
                {agentStatusLabel(a)}
              </span>
              <span>{a.agentType}</span>
              <span>{agentElapsed(a, now)}</span>
              {a.toolCount > 0 && (
                <span>
                  {a.toolCount} {a.toolCount === 1 ? 'tool' : 'tools'}
                </span>
              )}
            </span>
          </button>
        )
      })}
      <button className="fan-all" style={{ '--i': shown.length } as CSSProperties} onClick={() => open()}>
        {agents.length > shown.length
          ? `${agents.length - shown.length} more, and every agent so far`
          : `All ${total} ${total === 1 ? 'agent' : 'agents'} of this session`}
        <ArrowRight size={12} strokeWidth={2.2} />
      </button>
    </div>
  )
}
