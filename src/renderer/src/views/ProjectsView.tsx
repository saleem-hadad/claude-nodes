import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { FolderOpen, FolderPlus, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import type { FolderColor, Project } from '@shared/types'
import { useApp } from '@renderer/store'
import { ContextMenu, type MenuItem } from '@renderer/components/ContextMenu'
import { Modal } from '@renderer/components/Modal'
import { TitleBarActions } from '@renderer/components/TitleBarActions'
import { FolderIcon } from '@renderer/components/FolderIcon'
import { ColorSwatches } from '@renderer/components/ColorSwatches'
import { FolderItem } from '@renderer/components/projects/FolderItem'
import {
  addProject,
  sortProjects,
  useProjectsUi
} from '@renderer/components/projects/projectsUi'
import './ProjectsView.css'

interface MenuState {
  x: number
  y: number
  projectId: string
}

const openProject = (id: string) => useApp.getState().navigate({ view: 'board', projectId: id })

export function ProjectsView() {
  const projects = useApp((s) => s.projects)
  const stats = useApp((s) => s.stats)
  const selectedId = useProjectsUi((s) => s.selectedId)
  const select = useProjectsUi((s) => s.select)
  const toast = useProjectsUi((s) => s.toast)

  const [loaded, setLoaded] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [removeTarget, setRemoveTarget] = useState<Project | null>(null)
  const [dragging, setDragging] = useState(false)
  const [newIds, setNewIds] = useState<Set<string>>(new Set())

  const gridRef = useRef<HTMLDivElement>(null)
  const dragDepth = useRef(0)
  const seenIds = useRef<Set<string> | null>(null)

  const sorted = useMemo(() => sortProjects(projects), [projects])

  useEffect(() => {
    useApp
      .getState()
      .refreshProjects()
      .finally(() => setLoaded(true))
  }, [])

  // Folders that appear after the first load animate in.
  useEffect(() => {
    if (!loaded) return
    const ids = projects.map((p) => p.id)
    if (!seenIds.current) {
      seenIds.current = new Set(ids)
      return
    }
    const fresh = ids.filter((id) => !seenIds.current!.has(id))
    ids.forEach((id) => seenIds.current!.add(id))
    if (fresh.length === 0) return
    setNewIds((prev) => new Set([...prev, ...fresh]))
    const timer = window.setTimeout(() => {
      setNewIds((prev) => {
        const next = new Set(prev)
        fresh.forEach((id) => next.delete(id))
        return next
      })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [projects, loaded])

  // Drop a stale selection when its project disappears.
  useEffect(() => {
    if (selectedId && loaded && !projects.some((p) => p.id === selectedId)) select(null)
  }, [projects, selectedId, loaded, select])

  // Keep the selected folder visible.
  useEffect(() => {
    if (!selectedId) return
    gridRef.current
      ?.querySelector(`[data-project-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const commitRename = useCallback(async (id: string, name: string | null) => {
    setRenamingId(null)
    if (!name) return
    await window.api.projects.update(id, { name })
    await useApp.getState().refreshProjects()
  }, [])

  const setColor = useCallback(async (id: string, color: FolderColor) => {
    await window.api.projects.update(id, { color })
    await useApp.getState().refreshProjects()
  }, [])

  const confirmRemove = useCallback(async () => {
    const target = removeTarget
    setRemoveTarget(null)
    if (!target) return
    await window.api.projects.remove(target.id)
    if (useProjectsUi.getState().selectedId === target.id) select(null)
    await useApp.getState().refreshProjects()
  }, [removeTarget, select])

  // Finder keyboard semantics.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (menu || removeTarget || renamingId) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return

      const current = useProjectsUi.getState().selectedId
      const index = sorted.findIndex((p) => p.id === current)
      const project = index >= 0 ? sorted[index] : undefined

      if (e.metaKey && (e.key === 'o' || e.key === 'ArrowDown')) {
        if (project) {
          e.preventDefault()
          openProject(project.id)
        }
        return
      }
      if (e.metaKey && e.key === 'Backspace') {
        if (project) {
          e.preventDefault()
          setRemoveTarget(project)
        }
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === 'Enter' && project) {
        e.preventDefault()
        setRenamingId(project.id)
      } else if (e.key === 'Escape') {
        select(null)
      } else if (e.key.startsWith('Arrow') && sorted.length > 0) {
        e.preventDefault()
        if (index < 0) {
          select(sorted[0].id)
          return
        }
        const cols = gridColumns(gridRef.current)
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key] ?? 0
        const next = index + step
        if (next >= 0 && next < sorted.length) select(sorted[next].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sorted, menu, removeTarget, renamingId, select])

  // Dropping folders from Finder adds them as projects.
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')
  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = async (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((file) => window.api.pathForFile(file))
      .filter(Boolean)
    for (const path of paths) await addProject(path)
  }

  const menuProject = menu ? projects.find((p) => p.id === menu.projectId) : undefined
  const menuItems: MenuItem[] = menuProject
    ? [
        {
          label: 'Open',
          icon: <FolderOpen />,
          hint: '⌘O',
          onSelect: () => openProject(menuProject.id)
        },
        {
          label: 'Rename',
          icon: <Pencil />,
          hint: '↩',
          onSelect: () => setRenamingId(menuProject.id)
        },
        'separator',
        {
          custom: (
            <ColorSwatches
              value={menuProject.color}
              label="Folder colour"
              onPick={(color) => {
                setMenu(null)
                setColor(menuProject.id, color)
              }}
            />
          )
        },
        'separator',
        {
          label: 'Reveal in Finder',
          icon: <Search />,
          onSelect: () => window.api.projects.revealInFinder(menuProject.id)
        },
        'separator',
        {
          label: 'Remove from Claude Nodes…',
          icon: <Trash2 />,
          danger: true,
          onSelect: () => setRemoveTarget(menuProject)
        }
      ]
    : []

  return (
    <div
      className="pv"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <TitleBarActions>
        <button className="btn" onClick={() => addProject()} title="New Project (⇧⌘N)">
          <Plus size={15} strokeWidth={2.2} />
          New Project
        </button>
      </TitleBarActions>

      {loaded && sorted.length === 0 && <EmptyState />}

      {sorted.length > 0 && (
        <div
          className="pv-scroll"
          onPointerDown={(e) => {
            if (!(e.target as HTMLElement).closest('.pv-item')) select(null)
          }}
        >
          <header className="pv-header">
            <h1>Projects</h1>
            <span className="pv-count">{sorted.length}</span>
          </header>
          <div ref={gridRef} className="pv-grid" role="listbox" aria-label="Projects">
            {sorted.map((project) => (
              <FolderItem
                key={project.id}
                project={project}
                stats={stats[project.id]}
                selected={selectedId === project.id}
                renaming={renamingId === project.id}
                isNew={newIds.has(project.id)}
                onSelect={() => select(project.id)}
                onOpen={() => openProject(project.id)}
                onContextMenu={(e) => setMenu({ x: e.clientX, y: e.clientY, projectId: project.id })}
                onRename={(name) => commitRename(project.id, name)}
              />
            ))}
          </div>
        </div>
      )}

      {dragging && (
        <div className="pv-drop" aria-hidden="true">
          <div className="pv-drop-inner">
            <FolderIcon size={88} glyph={Plus} />
            <span>Drop a folder to add it as a project</span>
          </div>
        </div>
      )}

      {toast && (
        <div className="pv-toast" role="status">
          {toast}
        </div>
      )}

      {menu && menuProject && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}

      <Modal
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        className="pv-confirm"
        labelledBy="pv-confirm-title"
      >
        {removeTarget && (
          <>
            <div className="pv-confirm-body">
              <FolderIcon size={56} color={removeTarget.color} />
              <div>
                <h2 id="pv-confirm-title">Remove “{removeTarget.name}”?</h2>
                <p>
                  The project and its board layout are removed from Claude Nodes. The repository
                  and its Claude session transcripts stay on disk, untouched.
                </p>
                <p className="pv-confirm-path selectable">{removeTarget.repoPath}</p>
              </div>
            </div>
            <div className="pv-confirm-actions">
              <button className="btn" onClick={() => setRemoveTarget(null)}>
                Cancel
              </button>
              <button className="btn pv-btn-danger" onClick={confirmRemove} autoFocus>
                Remove
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="pv-empty">
      <FolderIcon size={148} glyph={FolderPlus} className="pv-empty-icon" />
      <h2>Add your first project</h2>
      <p>Link a local repository to organize its Claude sessions on a board.</p>
      <button className="btn btn-primary" onClick={() => addProject()}>
        Choose Folder…
      </button>
      <span className="pv-empty-hint">or drop a folder anywhere in this window</span>
    </div>
  )
}


/** Number of items in the first row of the grid. */
function gridColumns(grid: HTMLElement | null): number {
  const items = grid ? Array.from(grid.children) as HTMLElement[] : []
  if (items.length === 0) return 1
  const top = items[0].offsetTop
  const cols = items.filter((el) => el.offsetTop === top).length
  return Math.max(1, cols)
}
