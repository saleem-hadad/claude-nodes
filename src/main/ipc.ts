// IPC handlers implementing the contract in src/shared/api.ts.
import { dialog, ipcMain, nativeTheme, shell, type BrowserWindow } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { IPC } from '@shared/api'
import type {
  AppInfo,
  AppSettings,
  BoardNode,
  BoardSection,
  CreateSessionOptions,
  FolderColor,
  GitFileChange,
  NodePatch,
  OpenSessionResult,
  Project,
  ProjectStats,
  Rect,
  SessionCard,
  SummarizeProgress,
  SummaryResult,
  Viewport
} from '@shared/types'
import { hasTranscript, loadBoard, projectStats, toCard } from './board'
import {
  readSession,
  readTranscript,
  realRepoPath,
  transcriptPath,
  unwatchAll,
  unwatchProject,
  watchProject
} from './discovery'
import { getClaudePath, getClaudeVersion, initEnv } from './env'
import { gitDiff, gitStatus } from './git'
import { configureStatus, forgetStatus, startHookServer, stopHookServer } from './hooks'
import { installMenu } from './menu'
import { nameSection, type NamingSource } from './naming'
import * as ptys from './pty'
import { flush, getBoard, getProject, getState, loadState, normalizeSettings, save } from './store'
import { summarizeSessions } from './summarize'

const FOLDER_COLORS: FolderColor[] = ['blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'graphite']

/** Bounds for an expanded card's size, in board units. */
const clampSize = (n: number) => Math.round(Math.min(4000, Math.max(200, n)))

/**
 * Applies settings that live outside the renderer. The theme goes through
 * nativeTheme so the renderer's prefers-color-scheme, native menus and dialogs
 * all follow it.
 */
function applySettings(settings: AppSettings) {
  nativeTheme.themeSource = settings.theme
}

export async function registerIpc(getWindow: () => BrowserWindow | null) {
  loadState()
  // Before the window exists, so it opens in the chosen theme.
  applySettings(getState().settings)

  // Capturing the login-shell env can take a few seconds; don't block the window on it.
  const envReady = initEnv().catch((err) => console.error('[env] init failed', err))
  await startHookServer()

  const send = (channel: string, ...args: unknown[]) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  ptys.configurePty({
    onData: (sessionId, data) => send(IPC.evPtyData, sessionId, data),
    onExit: (sessionId, exitCode) => send(IPC.evPtyExit, sessionId, exitCode)
  })
  configureStatus({
    onChange: (sessionId, status, live) => send(IPC.evStatus, sessionId, status, live),
    isLive: ptys.isLive
  })
  installMenu((command) => send(IPC.evMenu, command))

  // --- App -----------------------------------------------------------------

  ipcMain.handle(IPC.appInfo, async (): Promise<AppInfo> => {
    await envReady
    return { claudePath: getClaudePath(), claudeVersion: getClaudeVersion(), platform: process.platform }
  })

  ipcMain.handle(IPC.settingsGet, (): AppSettings => getState().settings)

  ipcMain.handle(IPC.settingsUpdate, (_e, patch: Partial<AppSettings>): AppSettings => {
    const state = getState()
    state.settings = normalizeSettings({ ...state.settings, ...patch })
    applySettings(state.settings)
    save()
    return state.settings
  })

  // --- Projects ------------------------------------------------------------

  ipcMain.handle(IPC.projectsList, (): Project[] => getState().projects)

  ipcMain.handle(IPC.projectsAdd, async (_e, repoPath?: string): Promise<Project | null> => {
    let target = repoPath
    if (!target) {
      const win = getWindow()
      const options: Electron.OpenDialogOptions = {
        title: 'Add Project',
        buttonLabel: 'Add Project',
        message: 'Choose the local repository for this project',
        properties: ['openDirectory', 'createDirectory']
      }
      const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (res.canceled || !res.filePaths[0]) return null
      target = res.filePaths[0]
    }

    let real: string
    try {
      real = fs.realpathSync(target)
    } catch {
      throw new Error(`Folder not found: ${target}`)
    }
    if (!fs.statSync(real).isDirectory()) throw new Error(`Not a folder: ${real}`)

    const state = getState()
    const existing = state.projects.find((p) => realRepoPath(p.repoPath) === real)
    if (existing) return existing

    const project: Project = {
      id: crypto.randomUUID(),
      name: path.basename(real),
      repoPath: real,
      color: 'blue',
      createdAt: Date.now()
    }
    state.projects.push(project)
    save()
    return project
  })

  ipcMain.handle(
    IPC.projectsUpdate,
    (_e, id: string, patch: { name?: string; color?: FolderColor }): Project => {
      const project = getProject(id)
      const name = patch.name?.trim()
      if (name) project.name = name
      if (patch.color && FOLDER_COLORS.includes(patch.color)) project.color = patch.color
      save()
      return project
    }
  )

  ipcMain.handle(IPC.projectsRemove, (_e, id: string) => {
    const state = getState()
    ptys.killProject(id)
    unwatchProject(id)
    state.projects = state.projects.filter((p) => p.id !== id)
    delete state.boards[id]
    save()
  })

  ipcMain.handle(IPC.projectsReveal, (_e, id: string) => {
    shell.showItemInFolder(getProject(id).repoPath)
  })

  ipcMain.handle(IPC.projectsStats, (): Record<string, ProjectStats> => {
    const out: Record<string, ProjectStats> = {}
    for (const project of getState().projects) out[project.id] = projectStats(project)
    return out
  })

  // --- Board ---------------------------------------------------------------

  ipcMain.handle(IPC.boardLoad, (_e, projectId: string) => {
    const project = getProject(projectId)
    const snapshot = loadBoard(project)
    watchProject(projectId, project.repoPath, () => send(IPC.evBoardChanged, projectId))
    return snapshot
  })

  ipcMain.handle(IPC.boardSaveNodes, (_e, projectId: string, patches: NodePatch[]) => {
    const board = getBoard(projectId)
    for (const patch of patches) {
      const node = board.nodes[patch.sessionId]
      if (!node) continue
      if (typeof patch.x === 'number' && Number.isFinite(patch.x)) node.x = patch.x
      if (typeof patch.y === 'number' && Number.isFinite(patch.y)) node.y = patch.y
      if (typeof patch.title === 'string') node.title = patch.title.trim() || undefined
      // Terminals have no transcript to keep, so they are removed instead of archived.
      if (typeof patch.archived === 'boolean' && node.kind !== 'terminal') {
        // Archiving stops the session's process.
        if (patch.archived && !node.archived) {
          ptys.kill(node.sessionId)
          node.archivedAt = Date.now()
        }
        node.archived = patch.archived
      }
      if (patch.sectionId === null) delete node.sectionId
      else if (typeof patch.sectionId === 'string' && board.sections![patch.sectionId]) {
        node.sectionId = patch.sectionId
      }
      if (typeof patch.expanded === 'boolean') {
        if (patch.expanded) node.expanded = true
        else delete node.expanded
      }
      if (typeof patch.w === 'number' && Number.isFinite(patch.w)) node.w = clampSize(patch.w)
      if (typeof patch.h === 'number' && Number.isFinite(patch.h)) node.h = clampSize(patch.h)
      // An archived card leaves its section, and folds back to a card.
      if (node.archived) {
        delete node.sectionId
        delete node.expanded
      }
    }
    save()
  })

  ipcMain.handle(IPC.boardSaveSection, (_e, projectId: string, section: BoardSection) => {
    if (typeof section?.id !== 'string' || !Number.isFinite(section.x) || !Number.isFinite(section.y)) return
    const board = getBoard(projectId)
    board.sections![section.id] = {
      id: section.id,
      name: typeof section.name === 'string' ? section.name.trim() : '',
      color: FOLDER_COLORS.includes(section.color) ? section.color : 'blue',
      x: section.x,
      y: section.y,
      createdAt: board.sections![section.id]?.createdAt ?? Date.now()
    }
    save()
  })

  ipcMain.handle(IPC.boardRemoveSection, (_e, projectId: string, sectionId: string) => {
    const board = getBoard(projectId)
    delete board.sections![sectionId]
    for (const node of Object.values(board.nodes)) {
      if (node.sectionId === sectionId) delete node.sectionId
    }
    save()
  })

  ipcMain.handle(IPC.boardNameSection, async (_e, projectId: string, sessionIds: string[]) => {
    await envReady
    const project = getProject(projectId)
    const board = getBoard(projectId)
    const sources: NamingSource[] = []
    for (const sessionId of sessionIds) {
      const node = board.nodes[sessionId]
      // A shell says nothing about what the group is for.
      if (!node || node.kind === 'terminal') continue
      const found = readSession(sessionId, transcriptPath(project.repoPath, sessionId))
      const meta = found?.hasContent ? found.meta : undefined
      const title = node.title || meta?.title
      if (title) sources.push({ title, firstPrompt: meta?.firstPrompt })
    }
    if (sources.length === 0) throw new Error('These sessions have nothing to name the section after yet')
    return nameSection(sources)
  })

  ipcMain.handle(IPC.boardSaveArchive, (_e, projectId: string, rect: Rect) => {
    getBoard(projectId).archive = rect
    save()
  })

  ipcMain.handle(IPC.boardSaveViewport, (_e, projectId: string, viewport: Viewport) => {
    getBoard(projectId).viewport = viewport
    save()
  })

  ipcMain.handle(IPC.boardRemoveNode, async (_e, projectId: string, sessionId: string) => {
    const board = getBoard(projectId)
    const isTerminal = board.nodes[sessionId]?.kind === 'terminal'
    delete board.nodes[sessionId]
    // Terminals are never discovered on disk, so there is nothing to hide.
    if (!isTerminal && !board.hidden!.includes(sessionId)) board.hidden!.push(sessionId)
    save()
    await ptys.kill(sessionId)
    forgetStatus(sessionId)
  })

  // --- Git -----------------------------------------------------------------

  // Both wait for the login-shell env so git resolves from the user's PATH.
  ipcMain.handle(IPC.gitStatus, async (_e, projectId: string) => {
    await envReady
    return gitStatus(getProject(projectId).repoPath)
  })

  ipcMain.handle(IPC.gitDiff, async (_e, projectId: string, file: GitFileChange) => {
    await envReady
    return gitDiff(getProject(projectId).repoPath, file)
  })

  // --- Sessions ------------------------------------------------------------

  ipcMain.handle(
    IPC.sessionCreate,
    async (_e, projectId: string, opts: CreateSessionOptions): Promise<SessionCard> => {
      await envReady
      const project = getProject(projectId)
      const board = getBoard(projectId)
      const sessionId = crypto.randomUUID()
      const terminal = opts.kind === 'terminal'
      const node: BoardNode = {
        sessionId,
        kind: terminal ? 'terminal' : undefined,
        x: opts.x,
        y: opts.y,
        archived: false,
        title: opts.name?.trim() || undefined,
        parents: !terminal && opts.parents?.length ? opts.parents : undefined,
        createdByApp: true,
        createdAt: Date.now()
      }
      board.nodes[sessionId] = node
      try {
        ptys.spawnSession({
          sessionId,
          projectId,
          cwd: project.repoPath,
          kind: node.kind,
          resume: false,
          name: terminal ? undefined : opts.name?.trim() || undefined,
          initialPrompt: terminal ? undefined : opts.initialPrompt?.trim() || undefined
        })
      } catch (err) {
        delete board.nodes[sessionId]
        throw err
      }
      save()
      return toCard(node)
    }
  )

  ipcMain.handle(
    IPC.sessionOpen,
    async (_e, projectId: string, sessionId: string, cols: number, rows: number): Promise<OpenSessionResult> => {
      if (ptys.isLive(sessionId)) {
        ptys.resize(sessionId, cols, rows)
        return { replay: ptys.snapshot(sessionId), live: true }
      }
      await envReady
      const project = getProject(projectId)
      ptys.spawnSession({
        sessionId,
        projectId,
        cwd: project.repoPath,
        // A terminal whose shell exited always starts a fresh one.
        kind: getBoard(projectId).nodes[sessionId]?.kind,
        // A card created in the app but never used has no transcript to resume.
        resume: hasTranscript(project, sessionId),
        cols,
        rows
      })
      return { replay: '', live: true }
    }
  )

  ipcMain.on(IPC.sessionWrite, (_e, sessionId: string, data: string) => {
    if (typeof data === 'string') ptys.write(sessionId, data)
  })

  ipcMain.on(IPC.sessionResize, (_e, sessionId: string, cols: number, rows: number) => {
    ptys.resize(sessionId, cols, rows)
  })

  ipcMain.handle(IPC.sessionKill, (_e, sessionId: string) => ptys.kill(sessionId))

  ipcMain.handle(IPC.sessionTranscript, (_e, projectId: string, sessionId: string) => {
    const project = getProject(projectId)
    return readTranscript(transcriptPath(project.repoPath, sessionId))
  })

  ipcMain.handle(
    IPC.sessionSummarize,
    async (_e, projectId: string, sessionIds: string[], requestId: string): Promise<SummaryResult[]> => {
      await envReady
      const project = getProject(projectId)
      const board = getBoard(projectId)
      const progress = (p: SummarizeProgress) => send(IPC.evSummarizeProgress, p)

      const withTranscript: { sessionId: string; title: string }[] = []
      const results = new Map<string, SummaryResult>()
      for (const sessionId of sessionIds) {
        const file = transcriptPath(project.repoPath, sessionId)
        const meta = readSession(sessionId, file)?.meta
        const title = board.nodes[sessionId]?.title || meta?.title || 'New session'
        if (!meta || !fs.existsSync(file)) {
          const error = 'This session has no conversation yet'
          results.set(sessionId, { sessionId, title, summary: '', error })
          progress({ requestId, sessionId, phase: 'error', error })
        } else {
          withTranscript.push({ sessionId, title })
        }
      }

      const summaries = await summarizeSessions(project.repoPath, withTranscript, requestId, progress)
      for (const r of summaries) results.set(r.sessionId, r)
      return sessionIds.map((id) => results.get(id)!)
    }
  )
}

export function shutdown() {
  ptys.killAll()
  unwatchAll()
  stopHookServer()
  flush()
}
