import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC, type Api } from '@shared/api'

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void) {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: Api = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  pathForFile: (file) => webUtils.getPathForFile(file),

  projects: {
    list: () => ipcRenderer.invoke(IPC.projectsList),
    add: (repoPath) => ipcRenderer.invoke(IPC.projectsAdd, repoPath),
    update: (id, patch) => ipcRenderer.invoke(IPC.projectsUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(IPC.projectsRemove, id),
    revealInFinder: (id) => ipcRenderer.invoke(IPC.projectsReveal, id),
    stats: () => ipcRenderer.invoke(IPC.projectsStats)
  },

  board: {
    load: (projectId) => ipcRenderer.invoke(IPC.boardLoad, projectId),
    saveNodes: (projectId, patches) => ipcRenderer.invoke(IPC.boardSaveNodes, projectId, patches),
    saveArchive: (projectId, rect) => ipcRenderer.invoke(IPC.boardSaveArchive, projectId, rect),
    saveViewport: (projectId, viewport) =>
      ipcRenderer.invoke(IPC.boardSaveViewport, projectId, viewport),
    removeNode: (projectId, sessionId) =>
      ipcRenderer.invoke(IPC.boardRemoveNode, projectId, sessionId),
    saveSection: (projectId, section) =>
      ipcRenderer.invoke(IPC.boardSaveSection, projectId, section),
    removeSection: (projectId, sectionId) =>
      ipcRenderer.invoke(IPC.boardRemoveSection, projectId, sectionId)
  },

  sessions: {
    create: (projectId, opts) => ipcRenderer.invoke(IPC.sessionCreate, projectId, opts),
    open: (projectId, sessionId, cols, rows) =>
      ipcRenderer.invoke(IPC.sessionOpen, projectId, sessionId, cols, rows),
    // Keystrokes and resizes are fire-and-forget to keep typing latency low.
    write: (sessionId, data) => ipcRenderer.send(IPC.sessionWrite, sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send(IPC.sessionResize, sessionId, cols, rows),
    kill: (sessionId) => ipcRenderer.invoke(IPC.sessionKill, sessionId),
    transcript: (projectId, sessionId) =>
      ipcRenderer.invoke(IPC.sessionTranscript, projectId, sessionId),
    summarize: (projectId, sessionIds, requestId) =>
      ipcRenderer.invoke(IPC.sessionSummarize, projectId, sessionIds, requestId)
  },

  on: {
    ptyData: (cb) => subscribe(IPC.evPtyData, cb),
    ptyExit: (cb) => subscribe(IPC.evPtyExit, cb),
    status: (cb) => subscribe(IPC.evStatus, cb),
    boardChanged: (cb) => subscribe(IPC.evBoardChanged, cb),
    summarizeProgress: (cb) => subscribe(IPC.evSummarizeProgress, cb),
    menu: (cb) => subscribe(IPC.evMenu, cb)
  }
}

contextBridge.exposeInMainWorld('api', api)
