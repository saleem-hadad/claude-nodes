import { memo, useCallback, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Handle, NodeResizer, Position, type Node, type NodeProps, type OnResizeEnd } from '@xyflow/react'
import { Bot, GitBranch, GitMerge, Maximize2, MessageSquare, SquareTerminal } from 'lucide-react'
import clsx from 'clsx'
import type { BoardNote, SessionCard } from '@shared/types'
import { cardTitle, isTerminal, tildePath, useApp } from '@renderer/store'
import { AgentDeck, useDeck } from './AgentDeck'
import { RenamingContext, useBoardActions } from './BoardContext'
import { ExpandedCard } from './ExpandedCard'
import { EXPANDED_MIN_H, EXPANDED_MIN_W, isExpanded, timeAgo } from './layout'
import { NoteSticker } from './NoteNode'

export type SessionNodeData = {
  card: SessionCard
  /** Title characters matched by the archive search, highlighted. */
  match?: number[]
  /** Notes the session was started from, stuck on the card. Active cards only. */
  stickers?: BoardNote[]
}

/** A sticker plays landing on a card this new: one just started from its note. */
const LANDING_MS = 4000
export type SessionFlowNode = Node<SessionNodeData, 'session'>

const STATUS_LABEL = {
  working: 'Working',
  waiting: 'Needs you',
  done: 'Done'
} as const

const stop = (e: MouseEvent) => e.stopPropagation()

function SessionCardNodeComponent({ data, selected, dragging }: NodeProps<SessionFlowNode>) {
  const { card } = data
  const renaming = useContext(RenamingContext) === card.sessionId
  const { expand } = useBoardActions()
  const patchCards = useApp((s) => s.patchCards)
  const openAgents = useApp((s) => s.openAgents)
  const id = card.sessionId
  // Stable, so React Flow doesn't rebind the resize handles on every render.
  const onResizeEnd = useCallback<OnResizeEnd>(
    (_e, r) =>
      patchCards([
        { sessionId: id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      ]),
    [id, patchCards]
  )
  const repoPath = useApp((s) => s.board?.project.repoPath)
  const meta = card.meta
  const title = cardTitle(card)
  const updated = meta?.updatedAt ?? card.createdAt
  const shell = isTerminal(card)
  const statusLabel = shell ? (card.live ? 'Running' : 'Exited') : STATUS_LABEL[card.status]

  // The current run's agents make a deck behind the card.
  const nodeRef = useRef<HTMLDivElement>(null)
  const deck = useDeck(nodeRef)
  const agents = !card.archived ? card.agents ?? [] : []
  const hasDeck = agents.length > 0
  const running = agents.filter((a) => a.status !== 'done').length
  useEffect(() => {
    if (dragging || !hasDeck) deck.close()
  }, [dragging, hasDeck, deck.close])

  let preview: { text: string; kind: 'reply' | 'prompt' | 'empty' | 'path' }
  if (shell) preview = { text: repoPath ? tildePath(repoPath) : '', kind: 'path' }
  else if (meta?.lastAssistantText) preview = { text: stripMarkdown(meta.lastAssistantText), kind: 'reply' }
  else if (meta?.firstPrompt) preview = { text: meta.firstPrompt, kind: 'prompt' }
  else preview = { text: 'No messages yet', kind: 'empty' }

  const heading = (
    <>
      {shell ? (
        <span className="card-shell" data-live={card.live} title={`Terminal · ${statusLabel}`}>
          <SquareTerminal size={14} strokeWidth={2} />
        </span>
      ) : (
        <span className="status-dot" data-status={card.status} title={statusLabel} />
      )}
      {renaming ? (
        <TitleEditor sessionId={card.sessionId} initial={card.title || meta?.title || ''} />
      ) : (
        <h3 className="card-title" title={title}>
          {data.match?.length ? highlight(title, data.match) : title}
        </h3>
      )}
      {card.live && !shell && (
        <span className="card-live" title="Claude process running">
          <SquareTerminal size={13} strokeWidth={2} />
        </span>
      )}
    </>
  )

  const className = clsx(
    'session-card',
    shell && 'is-terminal',
    card.archived && 'is-archived',
    selected && 'is-selected',
    dragging && 'is-dragging'
  )
  const handles = (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="card-handle" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="card-handle" />
    </>
  )

  // Points at the deck: pointing fans it out, a click pins it.
  const deckTrigger = {
    onPointerEnter: deck.point,
    onClick: (e: MouseEvent) => {
      e.stopPropagation()
      deck.toggle()
    },
    onDoubleClick: stop,
    'aria-expanded': deck.open,
    title: running > 0 ? `${running} of ${agents.length} agents running` : `${agents.length} agents, all done`
  }

  const node = (body: ReactNode) => (
    <div
      ref={nodeRef}
      className="session-node"
      onPointerEnter={deck.open ? deck.stay : undefined}
      onPointerLeave={deck.open ? deck.leave : undefined}
    >
      {hasDeck && <AgentDeck sessionId={id} agents={agents} total={card.agentCount ?? agents.length} deck={deck} />}
      {body}
      {data.stickers?.map((note, i) => (
        <NoteSticker key={note.id} note={note} index={i} landing={Date.now() - card.createdAt < LANDING_MS} />
      ))}
    </div>
  )

  if (isExpanded(card)) {
    return (
      <>
        {node(
          <div
            className={clsx(className, 'is-expanded')}
            data-status={card.status}
            aria-label={`${title}, ${statusLabel}`}
          >
            {handles}
            <ExpandedCard
              card={card}
              heading={heading}
              tools={
                hasDeck && (
                  <button className="card-tool card-tool-agents" aria-label="Agents" {...deckTrigger}>
                    <Bot size={14} strokeWidth={2} />
                    {running > 0 && <span className="card-tool-badge">{running}</span>}
                  </button>
                )
              }
            />
          </div>
        )}
        <NodeResizer
          minWidth={EXPANDED_MIN_W}
          minHeight={EXPANDED_MIN_H}
          lineClassName="card-resize-line"
          handleClassName="card-resize-handle"
          onResizeEnd={onResizeEnd}
        />
      </>
    )
  }

  return node(
    <div className={className} data-status={card.status} aria-label={`${title}, ${statusLabel}`}>
      {handles}

      <header className="card-head">{heading}</header>
      {!card.archived && (
        <button
          className="card-expand nodrag"
          onClick={(e) => {
            e.stopPropagation()
            expand([card.sessionId], true)
          }}
          onDoubleClick={stop}
          title="Expand on the board (E)"
          aria-label="Expand on the board"
        >
          <Maximize2 size={13} strokeWidth={2} />
        </button>
      )}

      {card.parents && card.parents.length > 0 && (
        <div className="card-chip" title="Started from the context of earlier sessions">
          <GitMerge size={11} strokeWidth={2.2} />
          merged from {card.parents.length}
        </div>
      )}

      <p className={clsx('card-preview', `is-${preview.kind}`)}>{preview.text}</p>

      <footer className="card-foot">
        {meta?.gitBranch && (
          <span className="card-foot-item card-branch" title={meta.gitBranch}>
            <GitBranch size={11} strokeWidth={2.2} />
            <span className="card-branch-name">{meta.gitBranch}</span>
          </span>
        )}
        {meta && meta.messageCount > 0 && (
          <span className="card-foot-item" title={`${meta.messageCount} messages`}>
            <MessageSquare size={11} strokeWidth={2.2} />
            {meta.messageCount}
          </span>
        )}
        {hasDeck ? (
          <button className="card-foot-item card-foot-agents nodrag" {...deckTrigger}>
            <Bot size={11} strokeWidth={2.2} />
            {agents.length}
            {running > 0 && (
              <span className="card-foot-running">
                <span className="status-dot is-small" data-status={agents.some((a) => a.status === 'waiting') ? 'waiting' : 'working'} />
                {running}
              </span>
            )}
          </button>
        ) : !card.archived && card.agentCount ? (
          // No run on now: the count opens the agents viewer, to look back at earlier ones.
          <button
            className="card-foot-item card-foot-agents nodrag"
            onClick={(e) => {
              e.stopPropagation()
              openAgents(id)
            }}
            onDoubleClick={stop}
            title={`${card.agentCount} ${card.agentCount === 1 ? 'agent' : 'agents'}: show what they did`}
          >
            <Bot size={11} strokeWidth={2.2} />
            {card.agentCount}
          </button>
        ) : null}
        {shell && <span className="card-foot-item">{statusLabel}</span>}
        <span className="card-foot-item card-time">{timeAgo(updated)}</span>
      </footer>
    </div>
  )
}

function TitleEditor({ sessionId, initial }: { sessionId: string; initial: string }) {
  const { rename, setRenaming } = useBoardActions()
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const commit = () => {
    if (done.current) return
    done.current = true
    if (value.trim() !== initial.trim()) rename(sessionId, value.trim())
    setRenaming(null)
  }

  return (
    <input
      ref={ref}
      className="card-title-input nodrag nopan"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') {
          done.current = true
          setRenaming(null)
        }
      }}
    />
  )
}

export const SessionCardNode = memo(SessionCardNodeComponent)

/** Wraps each run of matched characters in a <mark>. */
function highlight(text: string, indices: number[]): ReactNode[] {
  const hit = new Set(indices)
  const parts: ReactNode[] = []
  let start = 0
  while (start < text.length) {
    const on = hit.has(start)
    let end = start + 1
    while (end < text.length && hit.has(end) === on) end++
    const run = text.slice(start, end)
    parts.push(on ? <mark key={start} className="card-title-match">{run}</mark> : run)
    start = end
  }
  return parts
}

/** Card previews are plain text: drop the markdown syntax Claude replies with. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/^\s{0,3}(#{1,6}|>)\s+/gm, '')
}
