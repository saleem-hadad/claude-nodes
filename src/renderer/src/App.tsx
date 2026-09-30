import { useEffect } from 'react'
import { useApp } from './store'
import { TitleBar } from './components/TitleBar'
import { ProjectsView } from './views/ProjectsView'
import { BoardView } from './views/BoardView'
import { TerminalModal } from './terminal/TerminalModal'
import { TranscriptPreview } from './terminal/TranscriptPreview'

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

    return () => {
      offStatus()
      offStatsRefresh()
      offBoard()
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
    </div>
  )
}
