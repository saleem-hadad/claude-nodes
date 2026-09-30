import { useEffect, useRef, useState, type MouseEvent } from 'react'
import clsx from 'clsx'
import type { Project, ProjectStats } from '@shared/types'
import { FolderIcon } from '../FolderIcon'
import { projectGlyph } from './projectsUi'

interface Props {
  project: Project
  stats?: ProjectStats
  selected: boolean
  renaming: boolean
  isNew: boolean
  onSelect: () => void
  onOpen: () => void
  onContextMenu: (e: MouseEvent) => void
  onRename: (name: string | null) => void
}

function subtitle(stats?: ProjectStats): string {
  // Keep the line's height while stats are loading.
  if (!stats) return '\u00a0'
  if (stats.total === 0) return 'No sessions'
  const total = `${stats.total} ${stats.total === 1 ? 'session' : 'sessions'}`
  return stats.active > 0 ? `${total} · ${stats.active} active` : total
}

/** One folder in the Finder-style grid: icon, live badges, label and a subtitle. */
export function FolderItem({
  project,
  stats,
  selected,
  renaming,
  isNew,
  onSelect,
  onOpen,
  onContextMenu,
  onRename
}: Props) {
  return (
    <div
      className={clsx('pv-item', selected && 'is-selected', isNew && 'is-new')}
      role="option"
      aria-selected={selected}
      data-project-id={project.id}
      title={project.repoPath}
      onPointerDown={(e) => {
        if (e.button === 0) onSelect()
      }}
      onDoubleClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault()
        onSelect()
        onContextMenu(e)
      }}
    >
      <div className="pv-icon">
        <FolderIcon size={112} color={project.color} glyph={projectGlyph(project.name)} />
        {stats && (stats.working > 0 || stats.waiting > 0) && (
          <div className="pv-badges">
            {stats.waiting > 0 && (
              <span className="pv-badge" title={`${stats.waiting} waiting for you`}>
                <span className="status-dot" data-status="waiting" />
                {stats.waiting}
              </span>
            )}
            {stats.working > 0 && (
              <span className="pv-badge" title={`${stats.working} working`}>
                <span className="status-dot" data-status="working" />
                {stats.working}
              </span>
            )}
          </div>
        )}
      </div>

      {renaming ? (
        <RenameField initial={project.name} onDone={onRename} />
      ) : (
        <div className="pv-label">
          <span>{project.name}</span>
        </div>
      )}
      <div className="pv-sub">{subtitle(stats)}</div>
    </div>
  )
}

function RenameField({
  initial,
  onDone
}: {
  initial: string
  onDone: (name: string | null) => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const finished = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const finish = (name: string | null) => {
    if (finished.current) return
    finished.current = true
    const trimmed = name?.trim()
    onDone(trimmed && trimmed !== initial ? trimmed : null)
  }

  return (
    <input
      ref={ref}
      className="pv-rename"
      value={value}
      spellCheck={false}
      aria-label="Project name"
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(value)
        else if (e.key === 'Escape') finish(null)
      }}
    />
  )
}
