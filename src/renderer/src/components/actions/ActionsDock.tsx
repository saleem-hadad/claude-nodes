import { useEffect, useState } from 'react'
import { ChevronRight, Ellipsis, LoaderCircle, Pencil, Play, Plus, Zap } from 'lucide-react'
import type { Project, ProjectAction } from '@shared/types'
import { ContextMenu } from '@renderer/components/ContextMenu'
import { ConfirmDialog, type ConfirmRequest } from '@renderer/components/board/ConfirmDialog'
import { useApp } from '@renderer/store'
import { ActionDialog } from './ActionDialog'
import { ActionIcon } from './ActionIcon'
import './actions.css'

const COLLAPSED_KEY = 'claude-nodes.actions-dock.collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // Only a convenience.
  }
}

/**
 * The project's action buttons, docked on the board's right edge. Pressing one
 * runs it; while a run is on the board, pressing it again opens that run.
 */
export function ActionsDock({
  project,
  runs,
  onRun,
  onShowRun,
  onOverlayChange
}: {
  project: Project
  /** The session of each action's run in progress, by action id. */
  runs: Map<string, string>
  onRun: (action: ProjectAction) => void
  onShowRun: (sessionId: string) => void
  /** Whether a dialog or menu of the dock is open, so the board can hold its shortcuts. */
  onOverlayChange: (open: boolean) => void
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [editing, setEditing] = useState<{ action?: ProjectAction } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; action: ProjectAction } | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const actions = project.actions ?? []

  const overlay = Boolean(editing || menu || confirm)
  useEffect(() => onOverlayChange(overlay), [overlay, onOverlayChange])
  useEffect(() => () => onOverlayChange(false), [onOverlayChange])

  const collapse = (next: boolean) => {
    setCollapsed(next)
    writeCollapsed(next)
  }

  const press = (action: ProjectAction) => {
    const running = runs.get(action.id)
    if (running) onShowRun(running)
    else onRun(action)
  }

  const remove = (action: ProjectAction) =>
    setConfirm({
      title: `Delete “${action.name}”?`,
      message: 'The button and its prompt are deleted. A run already on the board keeps going.',
      confirmLabel: 'Delete',
      danger: true,
      resolve: (ok) => {
        setConfirm(null)
        if (ok) useApp.getState().removeAction(project.id, action.id)
      }
    })

  const openMenu = (action: ProjectAction, x: number, y: number) => setMenu({ x, y, action })

  return (
    <>
      {collapsed ? (
        <button className="actions-dock-tab" onClick={() => collapse(false)} title="Show actions">
          <Zap size={14} strokeWidth={2.2} />
          {actions.length > 0 && <span>{actions.length}</span>}
        </button>
      ) : (
        <aside className="actions-dock" aria-label="Actions">
          <header className="actions-dock-head">
            <span className="actions-dock-title">Actions</span>
            <button
              className="btn btn-ghost btn-icon actions-dock-collapse"
              onClick={() => collapse(true)}
              title="Hide actions"
              aria-label="Hide actions"
            >
              <ChevronRight size={14} strokeWidth={2.2} />
            </button>
          </header>

          {actions.length === 0 ? (
            <p className="actions-dock-empty">
              Buttons that hand Claude a job, like pulling and pushing, or tidying up the board.
            </p>
          ) : (
            <ul className="actions-dock-list">
              {actions.map((action) => {
                const running = runs.has(action.id)
                return (
                  <li
                    key={action.id}
                    className="actions-dock-row"
                    onContextMenu={(e) => {
                      e.preventDefault()
                      openMenu(action, e.clientX, e.clientY)
                    }}
                  >
                    <button
                      className="actions-dock-item"
                      onClick={() => press(action)}
                      title={running ? `${action.name} is running. Click to watch it` : action.description || action.name}
                    >
                      <span className="actions-dock-icon" data-running={running || undefined}>
                        {running ? (
                          <LoaderCircle className="spin" size={15} strokeWidth={2} />
                        ) : (
                          <ActionIcon name={action.icon} />
                        )}
                      </span>
                      <span className="actions-dock-name">{action.name}</span>
                    </button>
                    <button
                      className="actions-dock-more"
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect()
                        openMenu(action, r.left, r.bottom + 4)
                      }}
                      title="More"
                      aria-label={`More for ${action.name}`}
                    >
                      <Ellipsis size={14} strokeWidth={2} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          <button className="actions-dock-add" onClick={() => setEditing({})}>
            <Plus size={14} strokeWidth={2.2} />
            Add action
          </button>
        </aside>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: runs.has(menu.action.id) ? 'Show run' : 'Run',
              icon: <Play size={14} />,
              onSelect: () => press(menu.action)
            },
            { label: 'Edit…', icon: <Pencil size={14} />, onSelect: () => setEditing({ action: menu.action }) },
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
