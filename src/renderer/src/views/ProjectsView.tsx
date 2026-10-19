import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import clsx from 'clsx'
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plus,
  Search,
  Trash2
} from 'lucide-react'
import type { FolderColor, Project, ProjectGroup } from '@shared/types'
import { useApp } from '@renderer/store'
import { ContextMenu, type MenuItem } from '@renderer/components/ContextMenu'
import { Modal } from '@renderer/components/Modal'
import { TitleBarActions } from '@renderer/components/TitleBarActions'
import { FolderIcon } from '@renderer/components/FolderIcon'
import { ColorSwatches } from '@renderer/components/ColorSwatches'
import { FolderItem, RenameField } from '@renderer/components/projects/FolderItem'
import { GroupPicker } from '@renderer/components/projects/GroupPicker'
import {
  addProject,
  groupProjects,
  moveToGroup,
  sortProjects,
  updateGroup,
  useProjectsUi
} from '@renderer/components/projects/projectsUi'
import './ProjectsView.css'

/** A context menu for a project folder or for a group's header. */
interface MenuState {
  x: number
  y: number
  projectId?: string
  groupId?: string
}

/** Drop-target key of the ungrouped section; group sections use their group id. */
const UNGROUPED = 'ungrouped'

const openProject = (id: string) => useApp.getState().navigate({ view: 'board', projectId: id })

export function ProjectsView() {
  const projects = useApp((s) => s.projects)
  const groups = useApp((s) => s.groups)
  const stats = useApp((s) => s.stats)
  const selectedId = useProjectsUi((s) => s.selectedId)
  const select = useProjectsUi((s) => s.select)
  const toast = useProjectsUi((s) => s.toast)

  const [loaded, setLoaded] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [removeTarget, setRemoveTarget] = useState<Project | null>(null)
  const [moveTarget, setMoveTarget] = useState<Project | null>(null)
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  // A folder being dragged onto another section, and the section under the pointer.
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  const [newIds, setNewIds] = useState<Set<string>>(new Set())

  const scrollRef = useRef<HTMLDivElement>(null)
  const dragDepth = useRef(0)
  const seenIds = useRef<Set<string> | null>(null)

  const sorted = useMemo(() => sortProjects(projects), [projects])
  const active = useMemo(() => sorted.filter((p) => !p.archived), [sorted])
  const archived = useMemo(() => sorted.filter((p) => p.archived), [sorted])
  const { ungrouped, byGroup } = useMemo(() => groupProjects(active, groups), [active, groups])
  // Reading order across all the grids, for keyboard navigation.
  const ordered = useMemo(
    () => [
      ...ungrouped,
      ...byGroup.flatMap(({ group, projects }) => (group.collapsed ? [] : projects)),
      ...archived
    ],
    [ungrouped, byGroup, archived]
  )

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
    scrollRef.current
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

  const setArchived = useCallback(async (id: string, archived: boolean) => {
    await window.api.projects.update(id, { archived })
    await useApp.getState().refreshProjects()
  }, [])

  const commitGroupRename = useCallback((id: string, name: string | null) => {
    setRenamingGroupId(null)
    if (name) updateGroup(id, { name })
  }, [])

  const deleteGroup = useCallback(async (id: string) => {
    await window.api.groups.remove(id)
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
      if (menu || removeTarget || moveTarget || renamingId || renamingGroupId) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return

      const current = useProjectsUi.getState().selectedId
      const index = ordered.findIndex((p) => p.id === current)
      const project = index >= 0 ? ordered[index] : undefined

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
      } else if (e.key.startsWith('Arrow') && ordered.length > 0) {
        e.preventDefault()
        if (index < 0) {
          select(ordered[0].id)
          return
        }
        let next: string | undefined
        if (e.key === 'ArrowLeft') next = ordered[index - 1]?.id
        else if (e.key === 'ArrowRight') next = ordered[index + 1]?.id
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          next = folderInNextRow(scrollRef.current, ordered[index].id, e.key === 'ArrowDown' ? 1 : -1)
        }
        if (next) select(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ordered, menu, removeTarget, moveTarget, renamingId, renamingGroupId, select])

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

  // Dragging a folder onto another section moves it to that group.
  const dragProject = dragId ? projects.find((p) => p.id === dragId) : undefined
  const sectionOf = (project: Project) =>
    byGroup.some(({ group }) => group.id === project.groupId) ? project.groupId! : UNGROUPED
  const dragFrom = dragProject ? sectionOf(dragProject) : null
  const isDropTarget = (key: string) => dropKey === key && dragFrom !== null && dragFrom !== key
  const endDrag = () => {
    setDragId(null)
    setDropKey(null)
  }
  const dropProps = (key: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragId) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropKey(key)
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
      setDropKey((current) => (current === key ? null : current))
    },
    onDrop: (e: DragEvent) => {
      if (!dragId) return
      e.preventDefault()
      endDrag()
      if (dragFrom !== key) moveToGroup(dragId, key === UNGROUPED ? null : key)
    }
  })

  const menuProject = menu?.projectId ? projects.find((p) => p.id === menu.projectId) : undefined
  const menuGroup = menu?.groupId ? groups.find((g) => g.id === menu.groupId) : undefined
  const groupMenu = (group: ProjectGroup): MenuItem[] => [
    { label: 'Rename Group', icon: <Pencil />, onSelect: () => setRenamingGroupId(group.id) },
    'separator',
    {
      label: 'Delete Group',
      icon: <Trash2 />,
      danger: true,
      onSelect: () => deleteGroup(group.id)
    }
  ]
  const menuItems: MenuItem[] = menuGroup
    ? groupMenu(menuGroup)
    : menuProject
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
        ...(menuProject.archived
          ? []
          : [
              {
                label: 'Move to Group…',
                icon: <FolderInput />,
                onSelect: () => setMoveTarget(menuProject)
              }
            ]),
        {
          label: 'Reveal in Finder',
          icon: <Search />,
          onSelect: () => window.api.projects.revealInFinder(menuProject.id)
        },
        'separator',
        {
          label: menuProject.archived ? 'Unarchive' : 'Archive',
          icon: menuProject.archived ? <ArchiveRestore /> : <Archive />,
          onSelect: () => setArchived(menuProject.id, !menuProject.archived)
        },
        {
          label: 'Remove from Claude Nodes…',
          icon: <Trash2 />,
          danger: true,
          onSelect: () => setRemoveTarget(menuProject)
        }
      ]
    : []

  const renderFolder = (project: Project) => (
    <FolderItem
      key={project.id}
      project={project}
      stats={stats[project.id]}
      selected={selectedId === project.id}
      renaming={renamingId === project.id}
      isNew={newIds.has(project.id)}
      draggable={!project.archived}
      onSelect={() => select(project.id)}
      onOpen={() => openProject(project.id)}
      onContextMenu={(e) => setMenu({ x: e.clientX, y: e.clientY, projectId: project.id })}
      onRename={(name) => commitRename(project.id, name)}
      onDragStart={() => setDragId(project.id)}
      onDragEnd={endDrag}
    />
  )

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
          ref={scrollRef}
          className="pv-scroll"
          onPointerDown={(e) => {
            if (!(e.target as HTMLElement).closest('.pv-item')) select(null)
          }}
        >
          <section
            className={clsx('pv-section', isDropTarget(UNGROUPED) && 'is-drop')}
            {...dropProps(UNGROUPED)}
          >
            <header className="pv-header">
              <h1>Projects</h1>
              <span className="pv-count">{active.length}</span>
            </header>
            {ungrouped.length > 0 ? (
              <div className="pv-grid" role="listbox" aria-label="Projects">
                {ungrouped.map(renderFolder)}
              </div>
            ) : dragFrom && dragFrom !== UNGROUPED ? (
              <div className="pv-group-empty">Drop here to take it out of its group</div>
            ) : active.length === 0 ? (
              <p className="pv-none">All projects are archived.</p>
            ) : null}
          </section>

          {byGroup.map(({ group, projects: members }) => (
            <section
              key={group.id}
              className={clsx('pv-section', 'pv-group', isDropTarget(group.id) && 'is-drop')}
              {...dropProps(group.id)}
            >
              <header
                className="pv-header pv-group-header"
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, groupId: group.id })
                }}
              >
                {renamingGroupId === group.id ? (
                  <RenameField
                    className="pv-group-rename"
                    label="Group name"
                    initial={group.name}
                    onDone={(name) => commitGroupRename(group.id, name)}
                  />
                ) : (
                  <button
                    className="pv-group-toggle"
                    aria-expanded={!group.collapsed}
                    title={group.collapsed ? 'Show projects' : 'Hide projects'}
                    onClick={() => updateGroup(group.id, { collapsed: !group.collapsed })}
                  >
                    <ChevronDown size={16} strokeWidth={2.2} className="pv-group-chevron" />
                    <span className="pv-group-name">{group.name}</span>
                  </button>
                )}
                <span className="pv-count">{members.length}</span>
              </header>
              {!group.collapsed &&
                (members.length > 0 ? (
                  <div className="pv-grid" role="listbox" aria-label={group.name}>
                    {members.map(renderFolder)}
                  </div>
                ) : (
                  <div className="pv-group-empty">Drag projects here</div>
                ))}
            </section>
          ))}

          {archived.length > 0 && (
            <>
              <header className="pv-header pv-header-archived">
                <h2>Archived</h2>
                <span className="pv-count">{archived.length}</span>
              </header>
              <div className="pv-grid" role="listbox" aria-label="Archived projects">
                {archived.map(renderFolder)}
              </div>
            </>
          )}
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

      {menu && menuItems.length > 0 && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}

      <GroupPicker project={moveTarget} groups={groups} onClose={() => setMoveTarget(null)} />

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

/** The folder in the next row up (-1) or down (1) that lines up best with `fromId`, across all grids. */
function folderInNextRow(root: HTMLElement | null, fromId: string, dir: 1 | -1): string | undefined {
  const items = Array.from(root?.querySelectorAll<HTMLElement>('[data-project-id]') ?? []).map(
    (el) => ({ id: el.dataset.projectId!, rect: el.getBoundingClientRect() })
  )
  const from = items.find((item) => item.id === fromId)
  if (!from) return undefined
  const beyond = items.filter((item) => (item.rect.top - from.rect.top) * dir > 1)
  if (beyond.length === 0) return undefined
  const tops = beyond.map((item) => item.rect.top)
  const rowTop = dir > 0 ? Math.min(...tops) : Math.max(...tops)
  const row = beyond.filter((item) => Math.abs(item.rect.top - rowTop) < 1)
  const offset = (item: (typeof row)[number]) => Math.abs(item.rect.left - from.rect.left)
  return row.reduce((best, item) => (offset(item) < offset(best) ? item : best)).id
}
