import { useEffect } from 'react'
import { ChevronLeft, ChevronRight, Settings } from 'lucide-react'
import { useApp } from '@renderer/store'
import { FolderIcon } from './FolderIcon'
import { GitControls } from './git/GitControls'
import { TITLEBAR_ACTIONS_ID } from './TitleBarActions'
import { addProject } from './projects/projectsUi'
import './TitleBar.css'

export function TitleBar() {
  const route = useApp((s) => s.route)
  const project = useApp((s) =>
    s.route.view === 'board'
      ? (s.board?.project ?? s.projects.find((p) => p.id === (s.route as { projectId: string }).projectId))
      : undefined
  )

  // Cmd+Shift+N works from any view, so it is handled here rather than in ProjectsView.
  useEffect(
    () =>
      window.api.on.menu((command) => {
        if (command === 'new-project') addProject()
      }),
    []
  )

  const goToProjects = () => useApp.getState().navigate({ view: 'projects' })

  return (
    <header className="titlebar drag">
      <nav className="titlebar-crumbs" aria-label="Location">
        {route.view === 'board' ? (
          <>
            <button
              className="btn btn-ghost btn-icon titlebar-back no-drag"
              onClick={goToProjects}
              title="Back to Projects"
              aria-label="Back to Projects"
            >
              <ChevronLeft size={18} strokeWidth={2} />
            </button>
            <button className="titlebar-crumb-link no-drag" onClick={goToProjects}>
              Projects
            </button>
            <ChevronRight className="titlebar-crumb-sep" size={13} strokeWidth={2.2} />
            {/* no-drag: a drag region swallows double-clicks to zoom the window. */}
            <span
              className="titlebar-current no-drag"
              title={project && `${project.repoPath}\nDouble-click to reveal in Finder`}
              onDoubleClick={() => project && window.api.projects.revealInFinder(project.id)}
            >
              <FolderIcon size={18} color={project?.color} />
              <span className="titlebar-current-name">{project?.name ?? ''}</span>
            </span>
            <GitControls projectId={route.projectId} />
          </>
        ) : (
          <span className="titlebar-current">
            <span className="titlebar-current-name">Projects</span>
          </span>
        )}
      </nav>

      <div className="titlebar-end">
        <div id={TITLEBAR_ACTIONS_ID} className="titlebar-actions no-drag" />
        <button
          className="btn btn-ghost btn-icon titlebar-settings no-drag"
          onClick={() => useApp.getState().openSettings()}
          title="Settings (⌘,)"
          aria-label="Settings"
        >
          <Settings size={16} strokeWidth={2} />
        </button>
      </div>
    </header>
  )
}
