import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent
} from 'react'
import clsx from 'clsx'
import { Globe, Pencil, Play, Plus } from 'lucide-react'
import type { ProjectAction, SessionCard } from '@shared/types'
import { ContextMenu } from '@renderer/components/ContextMenu'
import { ConfirmDialog, type ConfirmRequest } from '@renderer/components/board/ConfirmDialog'
import { useNow } from '@renderer/components/board/AgentDeck'
import { truncate } from '@renderer/components/board/layout'
import { formatDuration, useApp } from '@renderer/store'
import { ActionDialog } from './ActionDialog'
import { ActionIcon } from './ActionIcon'
import '@renderer/components/projects/ProjectRail.css'
import './actions.css'

interface Hint {
  /** The hovered action, or null for the New Action button. */
  actionId: string | null
  top: number
}

// Timing matches the project rail on the left.
const REVEAL_DELAY = 100
const HIDE_DELAY = 300
/** Space kept between the fan and the window's top and bottom. */
const FAN_MARGIN = 8

const runLabel = { working: 'Working', waiting: 'Needs you', done: 'Finishing' } as const

/**
 * The project's action buttons, then the global ones, in a rail on the board's
 * right edge that auto-hides like the project rail on the left. A running action's session
 * fans out beside its button, to open it when it needs a look. While the rail
 * is hidden, a mark on the edge says something is running, or needs you.
 */
export function ActionRail({
  onRun,
  onOverlayChange
}: {
  onRun: (action: ProjectAction) => void
  /** Whether a dialog or menu of the rail is open, so the board can hold its shortcuts. */
  onOverlayChange: (open: boolean) => void
}) {
  const project = useApp((s) => s.board?.project)
  const globalActions = useApp((s) => s.globalActions)
  const cards = useApp((s) => s.board?.cards)
  const openTerminal = useApp((s) => s.openTerminal)
  // The project's own first, then the global ones, each block closed by a divider.
  const blocks = useMemo(
    () => [project?.actions ?? [], globalActions].filter((b) => b.length > 0),
    [project, globalActions]
  )
  const actions = useMemo(() => blocks.flat(), [blocks])
  /** Each action's run, by action id. */
  const runs = useMemo(() => {
    const out = new Map<string, SessionCard>()
    for (const c of cards ?? []) if (c.runOf && !c.archived) out.set(c.runOf, c)
    return out
  }, [cards])

  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState<Hint | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; action: ProjectAction } | null>(null)
  const [editing, setEditing] = useState<{ action?: ProjectAction } | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  // The rail stays out while its context menu is up; a dialog takes over from it.
  const shown = open || Boolean(menu)

  const overlay = Boolean(editing || menu || confirm)
  useEffect(() => onOverlayChange(overlay), [overlay, onOverlayChange])
  useEffect(
    () => () => {
      onOverlayChange(false)
      window.clearTimeout(timer.current)
    },
    [onOverlayChange]
  )

  const keepOpen = () => {
    window.clearTimeout(timer.current)
    timer.current = undefined
  }
  const reveal = (e: PointerEvent) => {
    if (open) return keepOpen()
    // Not while dragging a card or panning the board into the edge.
    if (e.buttons !== 0 || timer.current !== undefined) return
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      setOpen(true)
    }, REVEAL_DELAY)
  }
  const hide = () => {
    keepOpen()
    timer.current = window.setTimeout(
      () => {
        timer.current = undefined
        setOpen(false)
        setHint(null)
      },
      open ? HIDE_DELAY : 0
    )
  }
  const close = () => {
    keepOpen()
    setOpen(false)
    setHint(null)
  }

  const showHint = (actionId: string | null) => (e: PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setHint({ actionId, top: r.top + r.height / 2 })
  }
  const hinted = hint?.actionId ? actions.find((a) => a.id === hint.actionId) : undefined

  const press = (action: ProjectAction) => {
    const run = runs.get(action.id)
    if (run) {
      close()
      openTerminal(run.sessionId)
    } else {
      onRun(action)
    }
  }
  const edit = (action?: ProjectAction) => {
    close()
    setEditing({ action })
  }
  const remove = (action: ProjectAction) =>
    setConfirm({
      title: `Delete “${action.name}”?`,
      message: action.global
        ? 'It’s a global button, so it goes from every project. A run already going keeps going.'
        : 'The button and its prompt are deleted. A run already going keeps going.',
      confirmLabel: 'Delete',
      danger: true,
      resolve: (ok) => {
        setConfirm(null)
        if (ok) useApp.getState().removeAction(project!.id, action.id)
      }
    })

  const running = actions.filter((a) => runs.has(a.id))
  const edgeStatus = [...runs.values()].some((c) => c.status === 'waiting')
    ? 'waiting'
    : runs.size > 0
      ? 'working'
      : undefined

  if (!project) return null

  return (
    <>
      <div
        className="rail-edge is-right"
        aria-hidden="true"
        onPointerEnter={reveal}
        onPointerMove={reveal}
        onPointerLeave={hide}
      >
        {edgeStatus && !shown && <span className="action-rail-mark" data-status={edgeStatus} />}
      </div>

      <nav
        className={clsx('rail is-right', shown && 'is-open')}
        aria-label="Actions"
        inert={!shown}
        onPointerEnter={keepOpen}
        onPointerLeave={hide}
        onScroll={() => setHint(null)}
      >
        {blocks.map((block) => (
          <Fragment key={block[0].id}>
            {block.map((action) => {
              const run = runs.get(action.id)
              return (
                <button
                  key={action.id}
                  ref={(el) => {
                    if (el) buttons.current.set(action.id, el)
                    else buttons.current.delete(action.id)
                  }}
                  className={clsx('rail-item', run && 'is-running')}
                  aria-label={action.name}
                  onClick={() => press(action)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setHint(null)
                    setMenu({ x: e.clientX, y: e.clientY, action })
                  }}
                  // A run says what it's doing in the fan beside it instead.
                  onPointerEnter={run ? undefined : showHint(action.id)}
                  onPointerLeave={() => setHint(null)}
                >
                  <span className="action-tile">
                    <ActionIcon name={action.icon} size={17} />
                    {action.global && (
                      <span className="action-global" aria-hidden="true">
                        <Globe size={9} strokeWidth={2.4} />
                      </span>
                    )}
                  </span>
                  {run && (
                    <span className="status-dot rail-dot" data-status={run.status === 'waiting' ? 'waiting' : 'working'} />
                  )}
                </button>
              )
            })}
            <div className="rail-sep" aria-hidden="true" />
          </Fragment>
        ))}
        <button
          className="rail-item rail-add"
          aria-label="New Action"
          onClick={() => edit()}
          onPointerEnter={showHint(null)}
          onPointerLeave={() => setHint(null)}
        >
          <Plus size={18} strokeWidth={2} />
        </button>
      </nav>

      {/* Outside the rail: its transform and backdrop blur would trap fixed positioning. */}
      {shown && hint && (hint.actionId === null || hinted) && (
        <div className="rail-hint is-right" style={{ top: hint.top }} role="tooltip">
          <span className="rail-hint-name">{hinted ? hinted.name : 'New Action'}</span>
          <span className="rail-hint-detail">
            {hinted
              ? [hinted.global && 'Every project', truncate(hinted.description || 'Right-click to edit', 80)]
                  .filter(Boolean)
                  .join(' · ')
              : 'Describe a button, and Claude makes it'}
          </span>
        </div>
      )}

      {shown && running.length > 0 && (
        <RunFan
          runs={running.map((a) => ({ action: a, card: runs.get(a.id)! }))}
          anchor={buttons.current.get(running[0].id)}
          onPointerEnter={keepOpen}
          onPointerLeave={hide}
          onOpen={(sessionId) => {
            close()
            openTerminal(sessionId)
          }}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: runs.has(menu.action.id) ? 'Show Run' : 'Run',
              icon: <Play size={14} />,
              onSelect: () => press(menu.action)
            },
            { label: 'Edit…', icon: <Pencil size={14} />, onSelect: () => edit(menu.action) },
            'separator',
            { label: 'Delete…', danger: true, onSelect: () => remove(menu.action) }
          ]}
        />
      )}
      {editing && <ActionDialog projectId={project.id} action={editing.action} onClose={() => setEditing(null)} />}
      <ConfirmDialog request={confirm} />
    </>
  )
}

/**
 * Running actions' sessions, dealt out beside the rail from the first running
 * button down. Each says what its session is doing; a click opens it.
 */
function RunFan({
  runs,
  anchor,
  onPointerEnter,
  onPointerLeave,
  onOpen
}: {
  runs: { action: ProjectAction; card: SessionCard }[]
  anchor: HTMLElement | undefined
  onPointerEnter: () => void
  onPointerLeave: () => void
  onOpen: (sessionId: string) => void
}) {
  const now = useNow(true)
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState<number | null>(null)
  const ids = runs.map((r) => r.card.sessionId).join()

  // Level with the first running button, kept inside the window.
  useLayoutEffect(() => {
    const fan = ref.current
    if (!fan || !anchor) return
    const wanted = anchor.getBoundingClientRect().top - 4
    const max = window.innerHeight - fan.offsetHeight - FAN_MARGIN
    setTop(Math.max(FAN_MARGIN, Math.min(wanted, max)))
  }, [anchor, ids])

  return (
    <div
      ref={ref}
      className="action-fan"
      style={{ top: top ?? undefined, visibility: top === null ? 'hidden' : undefined }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      aria-label="Running actions"
    >
      {runs.map(({ action, card }, i) => {
        const step =
          card.status === 'waiting'
            ? 'It needs you. Open it to answer'
            : card.meta?.lastAssistantText
              ? truncate(card.meta.lastAssistantText, 140)
              : 'Starting…'
        return (
          <button
            key={card.sessionId}
            className="fan-card"
            data-status={card.status}
            style={{ '--i': i } as CSSProperties}
            onClick={() => onOpen(card.sessionId)}
            title={`Open ${action.name}`}
          >
            <span className="fan-card-head">
              <span className="status-dot is-small" data-status={card.status} />
              <span className="fan-card-name">{action.name}</span>
            </span>
            <span className="fan-card-step">
              <span className="fan-card-detail">{step}</span>
            </span>
            <span className="fan-card-meta">
              <span className="fan-card-status" data-status={card.status}>
                {runLabel[card.status]}
              </span>
              <span>{formatDuration(now - card.createdAt)}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
