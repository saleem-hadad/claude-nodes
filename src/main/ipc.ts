// IPC handlers implementing the contract in src/shared/api.ts.
import { dialog, ipcMain, nativeTheme, shell, type BrowserWindow } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { IPC } from '@shared/api'
import type {
  ActionLists,
  ActionRunResult,
  AppInfo,
  AppSettings,
  BoardNode,
  BoardNote,
  BoardSection,
  CreateSessionOptions,
  FolderColor,
  GitFileChange,
  NodePatch,
  OpenSessionResult,
  Project,
  ProjectAction,
  ProjectGroup,
  ProjectStats,
  Rect,
  SessionCard,
  SummarizeProgress,
  SummaryResult,
  Viewport
} from '@shared/types'
import { draftAction, normalizeAction, runArgs } from './actions'
import { hasPendingWork, readAgents } from './agents'
import { archiveNode, dropNode, hasTranscript, isEmpty, loadBoard, projectStats, toCard, unstickNotes } from './board'
import { revokeBoardTools, startBoardTools } from './boardTools'
import {
  AGENT_ID,
  readSession,
  readTranscript,
  realRepoPath,
  subagentsDir,
  transcriptPath,
  unwatchAll,
  unwatchProject,
  watchProject
} from './discovery'
import { getClaudePath, getClaudeVersion, initEnv } from './env'
import { gitDiff, gitStatus } from './git'
import { configureStatus, forgetStatus, getStatus } from './hooks'
import { installMenu } from './menu'
import { nameSection, type NamingSource } from './naming'
import * as ptys from './pty'
import {
  flush,
  getBoard,
  getGroup,
  getProject,
  getState,
  loadState,
  normalizeSettings,
  projectIdForSession,
  save
} from './store'
import { summarizeSessions } from './summarize'

/**
 * Whether terminal input to a run is the user stepping in: an interrupt (Esc,
 * Ctrl+C), or text and Enter unless the run is waiting on them, when keys
 * answer its question. Replies the terminal sends by itself (focus changes,
 * cursor, mouse and colour reports) don't count.
 */
function isTakeover(sessionId: string, data: string): boolean {
  if (data === '\x1b' || data === '\x03') return true
  if (getStatus(sessionId) === 'waiting') return false
  const typed = data
    .replace(/\x1b[P\]^_][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
  return /[^\x00-\x1f\x7f]|\r/.test(typed)
}

/** One of the project's own actions, or a global one. */
function findAction(project: Project, actionId: string): ProjectAction | undefined {
  return [...(project.actions ?? []), ...(getState().actions ?? [])].find((a) => a.id === actionId)
}

const FOLDER_COLORS: FolderColor[] = ['blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'graphite']

/** A random folder colour, favouring the ones fewest projects use so neighbours tend to differ. */
function pickFolderColor(projects: Project[]): FolderColor {
  const uses = (color: FolderColor) => projects.filter((p) => p.color === color).length
  const fewest = Math.min(...FOLDER_COLORS.map(uses))
  const candidates = FOLDER_COLORS.filter((c) => uses(c) === fewest)
  return candidates[Math.floor(Math.random() * candidates.length)]
}

/** Bounds for an expanded card's size, in board units. */
const clampSize = (n: number) => Math.round(Math.min(4000, Math.max(200, n)))
/** Bounds for a sticky note's size, and how much text it keeps. */
const clampNoteSize = (n: number) => Math.round(Math.min(1200, Math.max(120, n)))
const NOTE_MAX_CHARS = 20_000

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

  const send = (channel: string, ...args: unknown[]) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  ptys.configurePty({
    onData: (sessionId, data) => send(IPC.evPtyData, sessionId, data),
    onExit: (sessionId, exitCode) => send(IPC.evPtyExit, sessionId, exitCode)
  })
  /**
   * An action run whose turn has ended is removed, and its transcript hidden
   * like a removed card's. The renderer is told what Claude said last, which
   * the prompt asks to be a one-line summary.
   */
  const finishRun = (sessionId: string) => {
    const projectId = projectIdForSession(sessionId)
    const board = projectId ? getBoard(projectId) : undefined
    const node = board?.nodes[sessionId]
    if (!projectId || !board || !node?.runOf) return
    const project = getProject(projectId)
    const action = findAction(project, node.runOf)
    const meta = readSession(sessionId, transcriptPath(project.repoPath, sessionId))?.meta

    delete board.nodes[sessionId]
    if (!board.hidden!.includes(sessionId)) board.hidden!.push(sessionId)
    save()
    revokeBoardTools(sessionId)
    void ptys.kill(sessionId).then(() => forgetStatus(sessionId))
    const result: ActionRunResult = {
      projectId,
      sessionId,
      actionName: action?.name ?? node.title ?? 'Action',
      message: meta?.lastAssistantText
    }
    send(IPC.evRunFinished, result)
    send(IPC.evBoardChanged, projectId)
  }

  /** A run the user typed into or interrupted is theirs: it joins the board as an ordinary session. */
  const claimRun = (sessionId: string) => {
    const projectId = projectIdForSession(sessionId)
    const board = projectId ? getBoard(projectId) : undefined
    const node = board?.nodes[sessionId]
    if (!projectId || !board || !node?.runOf) return
    delete node.runOf
    save()
    revokeBoardTools(sessionId)
    send(IPC.evBoardChanged, projectId)
  }

  configureStatus({
    onChange: (sessionId, status, live) => {
      send(IPC.evStatus, sessionId, status, live)
      if (status === 'done') finishRun(sessionId)
    },
    onAgentChange: (sessionId, agentId, status) => send(IPC.evAgentStatus, sessionId, agentId, status),
    onUsage: (sessionId, usage) => send(IPC.evUsage, sessionId, usage),
    isLive: ptys.isLive,
    hasPendingWork
  })
  installMenu((command) => send(IPC.evMenu, command))
  // Sessions still running from before the app last quit. A host is only started for a new session.
  await ptys.connectHost(false).catch((err) => console.error('[host] connect failed', err))

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
    if (existing) {
      // Adding an archived project's folder again brings it back.
      if (existing.archived) {
        delete existing.archived
        save()
      }
      return existing
    }

    const project: Project = {
      id: crypto.randomUUID(),
      name: path.basename(real),
      repoPath: real,
      color: pickFolderColor(state.projects),
      createdAt: Date.now()
    }
    state.projects.push(project)
    save()
    return project
  })

  ipcMain.handle(
    IPC.projectsUpdate,
    (
      _e,
      id: string,
      patch: { name?: string; color?: FolderColor; archived?: boolean; groupId?: string | null }
    ): Project => {
      const project = getProject(id)
      const name = patch.name?.trim()
      if (name) project.name = name
      if (patch.color && FOLDER_COLORS.includes(patch.color)) project.color = patch.color
      if (patch.archived === true) project.archived = true
      else if (patch.archived === false) delete project.archived
      if (patch.groupId === null) delete project.groupId
      else if (patch.groupId) project.groupId = getGroup(patch.groupId).id
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

  // --- Groups --------------------------------------------------------------

  ipcMain.handle(IPC.groupsList, (): ProjectGroup[] => getState().groups)

  ipcMain.handle(IPC.groupsCreate, (_e, name: string): ProjectGroup => {
    const group: ProjectGroup = {
      id: crypto.randomUUID(),
      name: name.trim() || 'New Group',
      createdAt: Date.now()
    }
    getState().groups.push(group)
    save()
    return group
  })

  ipcMain.handle(
    IPC.groupsUpdate,
    (_e, id: string, patch: { name?: string; collapsed?: boolean }): ProjectGroup => {
      const group = getGroup(id)
      const name = patch.name?.trim()
      if (name) group.name = name
      if (patch.collapsed === true) group.collapsed = true
      else if (patch.collapsed === false) delete group.collapsed
      save()
      return group
    }
  )

  ipcMain.handle(IPC.groupsRemove, (_e, id: string) => {
    const state = getState()
    state.groups = state.groups.filter((g) => g.id !== id)
    for (const project of state.projects) if (project.groupId === id) delete project.groupId
    save()
  })

  // --- Board ---------------------------------------------------------------

  ipcMain.handle(IPC.boardLoad, (_e, projectId: string) => {
    const project = getProject(projectId)
    // A run whose process ended while the app was closed never reported back.
    for (const node of Object.values(getBoard(projectId).nodes)) {
      if (node.runOf && !ptys.isLive(node.sessionId)) finishRun(node.sessionId)
    }
    const snapshot = loadBoard(project)
    watchProject(projectId, project.repoPath, () => send(IPC.evBoardChanged, projectId))
    return snapshot
  })

  ipcMain.handle(IPC.boardSaveNodes, (_e, projectId: string, patches: NodePatch[]) => {
    const project = getProject(projectId)
    const board = getBoard(projectId)
    let dropped = false
    for (const patch of patches) {
      const node = board.nodes[patch.sessionId]
      if (!node) continue
      // A session nothing was said in is removed rather than archived; its
      // note falls off where the card was before it moved.
      if (patch.archived === true && !node.archived && isEmpty(project, node)) {
        dropNode(board, node)
        dropped = true
        continue
      }
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
    // The renderer drops empty cards itself, by what it last read of their
    // transcripts; one it archived instead goes when it reloads.
    if (dropped) send(IPC.evBoardChanged, projectId)
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

  ipcMain.handle(IPC.boardSaveNote, (_e, projectId: string, note: BoardNote) => {
    if (typeof note?.id !== 'string' || !Number.isFinite(note.x) || !Number.isFinite(note.y)) return
    const board = getBoard(projectId)
    board.notes![note.id] = {
      id: note.id,
      text: typeof note.text === 'string' ? note.text.slice(0, NOTE_MAX_CHARS) : '',
      color: FOLDER_COLORS.includes(note.color) ? note.color : 'yellow',
      x: Math.round(note.x),
      y: Math.round(note.y),
      w: Number.isFinite(note.w) ? clampNoteSize(note.w!) : undefined,
      h: Number.isFinite(note.h) ? clampNoteSize(note.h!) : undefined,
      // Only a card on this board can wear it.
      sessionId: typeof note.sessionId === 'string' && board.nodes[note.sessionId] ? note.sessionId : undefined,
      createdAt: board.notes![note.id]?.createdAt ?? Date.now()
    }
    save()
  })

  ipcMain.handle(IPC.boardRemoveNotes, (_e, projectId: string, noteIds: string[]) => {
    const board = getBoard(projectId)
    for (const id of noteIds) delete board.notes![id]
    save()
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
    if (board.nodes[sessionId]) unstickNotes(board, board.nodes[sessionId])
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

  // --- Actions -------------------------------------------------------------

  /** Stores a project's actions and the global ones, leaving out lists that are empty. */
  const setActions = (project: Project, own: ProjectAction[], global: ProjectAction[]): ActionLists => {
    const state = getState()
    if (own.length) project.actions = own
    else delete project.actions
    if (global.length) state.actions = global
    else delete state.actions
    save()
    return { project, global }
  }

  ipcMain.handle(IPC.actionsGlobal, (): ProjectAction[] => getState().actions ?? [])

  ipcMain.handle(IPC.actionsSave, (_e, projectId: string, raw: ProjectAction): ActionLists => {
    const project = getProject(projectId)
    const own = project.actions ?? []
    const global = getState().actions ?? []
    const existing = [...own, ...global].find((a) => a.id === raw?.id)
    const action = normalizeAction(raw ?? {}, existing)
    // Into the list its scope says, in place if it was there already; out of the other one.
    const put = (list: ProjectAction[], belongs: boolean) =>
      !belongs
        ? list.filter((a) => a.id !== action.id)
        : list.some((a) => a.id === action.id)
          ? list.map((a) => (a.id === action.id ? action : a))
          : [...list, action]
    return setActions(project, put(own, !action.global), put(global, Boolean(action.global)))
  })

  ipcMain.handle(IPC.actionsRemove, (_e, projectId: string, actionId: string): ActionLists => {
    const project = getProject(projectId)
    const drop = (list: ProjectAction[] = []) => list.filter((a) => a.id !== actionId)
    return setActions(project, drop(project.actions), drop(getState().actions))
  })

  ipcMain.handle(IPC.actionsDraft, async (_e, projectId: string, description: string, global: boolean) => {
    await envReady
    return draftAction(getProject(projectId).repoPath, description, global === true)
  })

  // What an action run can see and do on its board (boardTools.ts).
  startBoardTools({
    listSessions(projectId, self, includeArchived) {
      const { cards, sections } = loadBoard(getProject(projectId))
      const sectionNames = new Map(sections.map((s) => [s.id, s.name || 'Untitled section']))
      return cards
        .filter((c) => c.sessionId !== self && (includeArchived || !c.archived))
        .map((c) => ({
          id: c.sessionId,
          title: c.title || c.meta?.title || (c.kind === 'terminal' ? 'Terminal' : 'New session'),
          kind: c.kind ?? 'claude',
          status: c.archived ? 'archived' : c.status === 'waiting' ? 'waiting for the user' : c.status,
          running: c.live,
          section: c.sectionId ? sectionNames.get(c.sectionId) : undefined,
          actionRun: c.runOf ? true : undefined,
          branch: c.meta?.gitBranch,
          lastReply: c.meta?.lastAssistantText,
          lastActive: new Date(c.meta?.updatedAt ?? c.createdAt).toISOString()
        }))
    },
    archiveSessions(projectId, self, sessionIds, force) {
      const project = getProject(projectId)
      const board = getBoard(projectId)
      const archived: string[] = []
      const removed: string[] = []
      const skipped: { id: string; reason: string }[] = []
      for (const id of sessionIds) {
        const node = board.nodes[id]
        const status = getStatus(id)
        const reason = !node
          ? 'not on the board'
          : id === self
            ? 'it is the session running this action'
            : node.kind === 'terminal'
              ? 'terminals can’t be archived'
              : node.archived
                ? 'already archived'
                : status !== 'done' && !force
                  ? status === 'waiting'
                    ? 'it is waiting for the user'
                    : 'it is working'
                  : null
        if (reason) {
          skipped.push({ id, reason })
          continue
        }
        // Nothing was said in it, so there is nothing to keep.
        if (isEmpty(project, node!)) {
          dropNode(board, node!)
          removed.push(id)
          continue
        }
        archiveNode(board, node!)
        archived.push(id)
      }
      if (archived.length || removed.length) {
        save()
        send(IPC.evBoardChanged, projectId)
      }
      return { archived, removed, skipped }
    }
  }).catch((err) => console.error('[board-tools] failed to start', err))

  // --- Sessions ------------------------------------------------------------

  ipcMain.handle(
    IPC.sessionCreate,
    async (_e, projectId: string, opts: CreateSessionOptions): Promise<SessionCard> => {
      await envReady
      const project = getProject(projectId)
      const board = getBoard(projectId)
      const sessionId = crypto.randomUUID()
      const terminal = opts.kind === 'terminal'
      const action = terminal || !opts.actionId ? undefined : findAction(project, opts.actionId)
      if (opts.actionId && !action) throw new Error('That action no longer exists')
      const node: BoardNode = {
        sessionId,
        kind: terminal ? 'terminal' : undefined,
        x: opts.x,
        y: opts.y,
        archived: false,
        title: opts.name?.trim() || undefined,
        parents: !terminal && opts.parents?.length ? opts.parents : undefined,
        createdByApp: true,
        runOf: action?.id,
        createdAt: Date.now()
      }
      if (action) node.title = action.name
      board.nodes[sessionId] = node
      try {
        await ptys.spawnSession({
          sessionId,
          projectId,
          cwd: project.repoPath,
          kind: node.kind,
          resume: false,
          name: terminal ? undefined : node.title,
          initialPrompt: terminal ? undefined : action?.prompt ?? (opts.initialPrompt?.trim() || undefined),
          permissionMode: action ? 'auto' : undefined,
          extraArgs: action ? await runArgs(projectId, sessionId, action) : undefined
        })
      } catch (err) {
        delete board.nodes[sessionId]
        if (action) revokeBoardTools(sessionId)
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
      await ptys.spawnSession({
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
    if (typeof data !== 'string') return
    // Before the write: an interrupt would otherwise end the run's turn and remove it.
    if (isTakeover(sessionId, data)) claimRun(sessionId)
    ptys.write(sessionId, data)
  })

  ipcMain.on(IPC.sessionResize, (_e, sessionId: string, cols: number, rows: number) => {
    ptys.resize(sessionId, cols, rows)
  })

  ipcMain.handle(IPC.sessionKill, (_e, sessionId: string) => ptys.kill(sessionId))

  ipcMain.handle(IPC.sessionTranscript, (_e, projectId: string, sessionId: string) => {
    const project = getProject(projectId)
    return readTranscript(transcriptPath(project.repoPath, sessionId))
  })

  ipcMain.handle(IPC.sessionAgents, (_e, projectId: string, sessionId: string) => {
    return readAgents(getProject(projectId).repoPath, sessionId)
  })

  ipcMain.handle(IPC.sessionAgentTranscript, (_e, projectId: string, sessionId: string, agentId: string) => {
    // Both ids end up in a path.
    if (!AGENT_ID.test(agentId) || !AGENT_ID.test(sessionId)) throw new Error('Not an agent of this session')
    const dir = subagentsDir(getProject(projectId).repoPath, sessionId)
    return readTranscript(path.join(dir, `agent-${agentId}.jsonl`), { agent: true })
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

/** Sessions keep running in the session host; the app just lets go of them. */
export function shutdown() {
  ptys.disconnect()
  unwatchAll()
  flush()
}
