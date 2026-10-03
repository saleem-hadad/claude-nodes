import { useEffect } from 'react'
import { FileDiff, GitBranch } from 'lucide-react'
import type { GitStatus } from '@shared/types'
import { useApp } from '@renderer/store'
import './git.css'

/** How often the branch and change count are re-read while the window has focus. */
export const GIT_POLL_MS = 4000

/** Branch chip and Changes button, shown next to the project name in the title bar. */
export function GitControls({ projectId }: { projectId: string }) {
  const git = useApp((s) => s.git)
  const openDiff = useApp((s) => s.openDiff)

  useEffect(() => {
    const refresh = () => useApp.getState().refreshGit()
    refresh()
    // Claude edits files during a turn, so a status change usually means new changes.
    const offStatus = window.api.on.status(refresh)
    window.addEventListener('focus', refresh)
    // Catches branch switches and edits made in terminals or other apps.
    const timer = window.setInterval(() => {
      if (document.hasFocus()) refresh()
    }, GIT_POLL_MS)
    return () => {
      offStatus()
      window.removeEventListener('focus', refresh)
      window.clearInterval(timer)
    }
  }, [projectId])

  if (!git) return null
  const count = git.files.length

  return (
    <>
      <span className="git-branch no-drag" title={branchTooltip(git)}>
        <GitBranch size={13} strokeWidth={2.2} />
        <span className="git-branch-name">{branchLabel(git)}</span>
        {git.ahead > 0 && <span className="git-branch-ab">↑{git.ahead}</span>}
        {git.behind > 0 && <span className="git-branch-ab">↓{git.behind}</span>}
      </span>
      <button
        className="git-changes no-drag"
        onClick={openDiff}
        title={count ? `Show ${count} changed ${count === 1 ? 'file' : 'files'}` : 'No local changes'}
      >
        <FileDiff size={14} strokeWidth={2} />
        Changes
        {count > 0 && <span className="git-count">{count > 999 ? '999+' : count}</span>}
      </button>
    </>
  )
}

export function branchLabel(git: GitStatus): string {
  return git.branch ?? git.oid?.slice(0, 7) ?? 'HEAD'
}

function branchTooltip(git: GitStatus): string {
  if (!git.branch) return `Detached HEAD at ${git.oid?.slice(0, 7) ?? 'unknown commit'}`
  const lines = [`On branch ${git.branch}`]
  if (git.upstream) {
    const ab = [git.ahead && `${git.ahead} ahead`, git.behind && `${git.behind} behind`].filter(Boolean)
    lines.push(`Tracking ${git.upstream}${ab.length ? ` · ${ab.join(', ')}` : ', up to date'}`)
  } else if (git.oid) {
    lines.push('Not published to a remote')
  } else {
    lines.push('No commits yet')
  }
  return lines.join('\n')
}
