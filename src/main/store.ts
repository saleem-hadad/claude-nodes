// Persistent app state (projects + per-project boards) in userData/state.json.
import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { BoardNode, Project, Rect, Viewport } from '@shared/types'

export interface BoardState {
  nodes: Record<string, BoardNode>
  archive: Rect
  viewport?: Viewport
  /** Sessions removed from the board; never re-imported. */
  hidden?: string[]
}

export interface State {
  projects: Project[]
  boards: Record<string, BoardState>
}

let state: State = { projects: [], boards: {} }
let saveTimer: NodeJS.Timeout | null = null

function statePath() {
  return path.join(app.getPath('userData'), 'state.json')
}

export function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Partial<State>
    state = {
      projects: Array.isArray(raw.projects) ? raw.projects : [],
      boards: raw.boards && typeof raw.boards === 'object' ? raw.boards : {}
    }
  } catch {
    state = { projects: [], boards: {} }
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
    board = { nodes: {}, archive: { x: 0, y: 0, w: 1344, h: 320 }, hidden: [] }
    state.boards[projectId] = board
  }
  if (!board.hidden) board.hidden = []
  return board
}

/** Finds the project that owns a session card. */
export function projectIdForSession(sessionId: string): string | null {
  for (const [projectId, board] of Object.entries(state.boards)) {
    if (board.nodes[sessionId]) return projectId
  }
  return null
}
