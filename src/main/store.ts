// Persistent app state (projects + per-project boards) in userData/state.json.
import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { AppSettings, BoardNode, BoardSection, Project, Rect, Viewport } from '@shared/types'

/** Six 288px card columns with 24px gaps and 40px side padding. */
const DEFAULT_ARCHIVE_W = 2 * 40 + 6 * 288 + 5 * 24

const THEMES: AppSettings['theme'][] = ['system', 'light', 'dark']

/** Fills in defaults and drops values this version doesn't understand. */
export function normalizeSettings(raw: unknown): AppSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppSettings>
  return {
    theme: s.theme && THEMES.includes(s.theme) ? s.theme : 'system'
  }
}

export interface BoardState {
  nodes: Record<string, BoardNode>
  archive: Rect
  sections?: Record<string, BoardSection>
  viewport?: Viewport
  /** Sessions removed from the board; never re-imported. */
  hidden?: string[]
}

export interface State {
  projects: Project[]
  boards: Record<string, BoardState>
  settings: AppSettings
}

let state: State = { projects: [], boards: {}, settings: normalizeSettings(null) }
let saveTimer: NodeJS.Timeout | null = null

function statePath() {
  return path.join(app.getPath('userData'), 'state.json')
}

export function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Partial<State>
    state = {
      projects: Array.isArray(raw.projects) ? raw.projects : [],
      boards: raw.boards && typeof raw.boards === 'object' ? raw.boards : {},
      settings: normalizeSettings(raw.settings)
    }
  } catch {
    state = { projects: [], boards: {}, settings: normalizeSettings(null) }
  }
}

export function getState(): State {
  return state
}

function writeNow() {
  const file = statePath()
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, file)
}

/** Debounced atomic save. */
export function save() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      writeNow()
    } catch (err) {
      console.error('[store] save failed', err)
    }
  }, 300)
}

/** Writes pending changes synchronously (used on quit). */
export function flush() {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  try {
    writeNow()
  } catch (err) {
    console.error('[store] flush failed', err)
  }
}

export function getProject(id: string): Project {
  const project = state.projects.find((p) => p.id === id)
  if (!project) throw new Error(`Unknown project ${id}`)
  return project
}

export function getBoard(projectId: string): BoardState {
  let board = state.boards[projectId]
  if (!board) {
    board = { nodes: {}, archive: { x: 0, y: 0, w: DEFAULT_ARCHIVE_W, h: 320 }, hidden: [] }
    state.boards[projectId] = board
  }
  if (!board.hidden) board.hidden = []
  if (!board.sections) board.sections = {}
  return board
}

/** Finds the project that owns a session card. */
export function projectIdForSession(sessionId: string): string | null {
  for (const [projectId, board] of Object.entries(state.boards)) {
    if (board.nodes[sessionId]) return projectId
  }
  return null
}
