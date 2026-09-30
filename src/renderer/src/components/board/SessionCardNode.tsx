import { memo, useContext, useEffect, useRef, useState } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { GitBranch, GitMerge, MessageSquare, SquareTerminal } from 'lucide-react'
import clsx from 'clsx'
import type { SessionCard } from '@shared/types'
import { cardTitle } from '@renderer/store'
import { RenamingContext, useBoardActions } from './BoardContext'
import { timeAgo } from './layout'

export type SessionNodeData = { card: SessionCard }
export type SessionFlowNode = Node<SessionNodeData, 'session'>

const STATUS_LABEL = {
  working: 'Working',
  waiting: 'Needs you',
  done: 'Done'
} as const

function SessionCardNodeComponent({ data, selected, dragging }: NodeProps<SessionFlowNode>) {
  const { card } = data
  const renaming = useContext(RenamingContext) === card.sessionId
  const meta = card.meta
  const title = cardTitle(card)
  const updated = meta?.updatedAt ?? card.createdAt

  let preview: { text: string; kind: 'reply' | 'prompt' | 'empty' }
  if (meta?.lastAssistantText) preview = { text: meta.lastAssistantText, kind: 'reply' }
  else if (meta?.firstPrompt) preview = { text: meta.firstPrompt, kind: 'prompt' }
  else preview = { text: 'No messages yet', kind: 'empty' }

  return (
    <div
      className={clsx(
        'session-card',
        card.archived && 'is-archived',
        selected && 'is-selected',
        dragging && 'is-dragging'
      )}
      data-status={card.status}
      aria-label={`${title}, ${STATUS_LABEL[card.status]}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className="card-handle" />
      <Handle type="source" position={Position.Right} isConnectable={false} className="card-handle" />

      <header className="card-head">
        <span
          className="status-dot"
          data-status={card.status}
          title={STATUS_LABEL[card.status]}
        />
        {renaming ? (
          <TitleEditor sessionId={card.sessionId} initial={card.title || meta?.title || ''} />
        ) : (
          <h3 className="card-title" title={title}>
            {title}
          </h3>
        )}
        {card.live && (
          <span className="card-live" title="Claude process running">
            <SquareTerminal size={13} strokeWidth={2} />
          </span>
        )}
      </header>

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
