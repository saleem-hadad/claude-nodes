import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import clsx from 'clsx'
import type { ProjectStats } from '@shared/types'
import { useApp } from '@renderer/store'
import { FolderIcon } from '../FolderIcon'
import { projectGlyph } from './projectsUi'
import './ProjectRail.css'

interface Hint {
  projectId: string
  top: number
}

/** Resting on the edge this long reveals the rail, so sweeping out of the window doesn't flash it. */
const REVEAL_DELAY = 100
/** Grace period after the pointer leaves, to cross the gap between the edge and the rail. */
const HIDE_DELAY = 300

function activity(stats?: ProjectStats): string | undefined {
  if (!stats) return undefined
  const parts = []
  if (stats.waiting > 0) parts.push(`${stats.waiting} waiting`)
  if (stats.working > 0) parts.push(`${stats.working} working`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * Project folders in a floating rail that auto-hides like the Dock: pointing at the
 * window's left edge slides it in over the board, to jump straight to another project.
 */
export function ProjectRail({ activeId }: { activeId: string }) {
  const projects = useApp((s) => s.projects)
  const stats = useApp((s) => s.stats)
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState<Hint | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const hinted = hint && projects.find((p) => p.id === hint.projectId)
  const hintDetail = hint && activity(stats[hint.projectId])

  // Opening a board bumps its openedAt, so keep the order the projects were added in:
  // icons must not jump around while switching between them.
  const sorted = useMemo(() => [...projects].sort((a, b) => a.createdAt - b.createdAt), [projects])

  // The badges need fresh stats; the projects view isn't there to load them.
  useEffect(() => {
    useApp.getState().refreshProjects()
    return () => window.clearTimeout(timer.current)
  }, [])

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
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      setOpen(false)
      setHint(null)
    }, open ? HIDE_DELAY : 0)
  }

  return (
    <>
      <div
        className="rail-edge"
        aria-hidden="true"
        onPointerEnter={reveal}
        onPointerMove={reveal}
        onPointerLeave={hide}
      />

      <nav
        className={clsx('rail', open && 'is-open')}
        aria-label="Projects"
        inert={!open}
        onPointerEnter={keepOpen}
        onPointerLeave={hide}
        onScroll={() => setHint(null)}
      >
        {sorted.map((project) => {
          const active = project.id === activeId
          const s = stats[project.id]
          const status = s?.waiting ? 'waiting' : s?.working ? 'working' : undefined
          return (
            <button
              key={project.id}
              className={clsx('rail-item', active && 'is-active')}
              aria-label={project.name}
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                if (!active) useApp.getState().navigate({ view: 'board', projectId: project.id })
              }}
              onPointerEnter={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setHint({ projectId: project.id, top: r.top + r.height / 2 })
              }}
              onPointerLeave={() => setHint(null)}
            >
              <FolderIcon size={34} color={project.color} glyph={projectGlyph(project.name)} />
              {status && <span className="status-dot rail-dot" data-status={status} />}
            </button>
          )
        })}
      </nav>

      {/* Outside the rail: its transform and backdrop blur would trap a fixed tooltip. */}
      {open && hint && hinted && (
        <div className="rail-hint" style={{ top: hint.top }} role="tooltip">
          <span className="rail-hint-name">{hinted.name}</span>
          {hintDetail && <span className="rail-hint-detail">{hintDetail}</span>}
        </div>
      )}
    </>
  )
}
