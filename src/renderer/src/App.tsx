import { useEffect } from 'react'
import { useApp } from './store'
import { TitleBar } from './components/TitleBar'
import { ProjectsView } from './views/ProjectsView'
import { BoardView } from './views/BoardView'
import { TerminalModal } from './terminal/TerminalModal'
import { TranscriptPreview } from './terminal/TranscriptPreview'
import { DiffModal } from './components/git/DiffModal'
import { SettingsDialog } from './components/SettingsDialog'

export function App() {
  const route = useApp((s) => s.route)

  useEffect(() => {
    useApp.getState().refreshProjects()

    const offStatus = window.api.on.status((sessionId, status, live) => {
      useApp.getState().setStatus(sessionId, status, live)
    })

    // Folder badges show live counts, so refresh stats when statuses change.
    let statsTimer: number | undefined
    const offStatsRefresh = window.api.on.status(() => {
      window.clearTimeout(statsTimer)
      statsTimer = window.setTimeout(() => {
        const { route } = useApp.getState()
        if (route.view === 'projects') useApp.getState().refreshProjects()
      }, 250)
    })

    const offBoard = window.api.on.boardChanged((projectId) => {
      const { route, loadBoard } = useApp.getState()
      if (route.view === 'board' && route.projectId === projectId) loadBoard(projectId)
    })

    // Cmd+W closes the top-most layer and never the window itself.
    const offMenu = window.api.on.menu((command) => {
      if (command === 'settings') useApp.getState().openSettings()
      if (command !== 'close') return
      const s = useApp.getState()
      if (s.settingsOpen) s.closeSettings()
      else if (s.terminalSessionId) s.closeTerminal()
      else if (s.previewSessionId) s.closePreview()
      else if (s.diffOpen) s.closeDiff()
      else if (s.route.view === 'board') s.navigate({ view: 'projects' })
    })

    // Files dropped outside a drop target must not navigate the window to file://.
    const blockDrop = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', blockDrop)
    window.addEventListener('drop', blockDrop)

    return () => {
      window.removeEventListener('dragover', blockDrop)
      window.removeEventListener('drop', blockDrop)
      offStatus()
      offStatsRefresh()
      offBoard()
      offMenu()
      window.clearTimeout(statsTimer)
    }
  }, [])

  return (
    <div className="app">
      <TitleBar />
      <main className="app-main">
        {route.view === 'projects' ? (
          <ProjectsView />
        ) : (
          <BoardView key={route.projectId} projectId={route.projectId} />
        )}
      </main>
      <TerminalModal />
      <TranscriptPreview />
      <DiffModal />
      <SettingsDialog />
    </div>
  )
}
