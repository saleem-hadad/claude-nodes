import { create } from 'zustand'
import type { Project } from '@shared/types'
import { useApp } from '@renderer/store'

interface ProjectsUiState {
  /** Selected folder in the projects grid. */
  selectedId: string | null
  /** Transient message shown at the bottom of the projects view. */
  toast: string | null
  select(id: string | null): void
  showToast(message: string): void
}

let toastTimer: number | undefined

export const useProjectsUi = create<ProjectsUiState>((set) => ({
  selectedId: null,
  toast: null,
  select: (id) => set({ selectedId: id }),
  showToast(message) {
    window.clearTimeout(toastTimer)
    set({ toast: message })
    toastTimer = window.setTimeout(() => set({ toast: null }), 3500)
  }
}))

const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

/**
 * Adds a project (from a path, or via the native folder picker when omitted),
 * selects it and shows it in the projects grid.
 */
export async function addProject(repoPath?: string): Promise<Project | null> {
  const ui = useProjectsUi.getState()
  let project: Project | null
  try {
    project = await window.api.projects.add(repoPath)
  } catch {
    ui.showToast(
      repoPath
        ? `Couldn’t add “${folderName(repoPath)}”. Only folders can be projects.`
        : 'Couldn’t add that folder.'
    )
    return null
  }
  if (!project) return null

  ui.select(project.id)
  const app = useApp.getState()
  if (app.route.view !== 'projects') app.navigate({ view: 'projects' })
  else await app.refreshProjects()
  return project
}

/** Sort order of the grid: most recently opened first, then newest. */
export function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort(
    (a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0) || b.createdAt - a.createdAt
  )
}

/** The letter embossed on a project's folder. */
export function projectGlyph(name: string): string | undefined {
  return name.match(/[\p{L}\p{N}]/u)?.[0]
}
