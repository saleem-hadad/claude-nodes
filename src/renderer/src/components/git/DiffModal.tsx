import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import {
  GitBranch,
  RefreshCw,
  SquareArrowRight,
  SquareDot,
  SquareMinus,
  SquarePlus,
  TriangleAlert,
  X
} from 'lucide-react'
import clsx from 'clsx'
import type { GitFileChange, GitFileDiff, GitFileStatus } from '@shared/types'
import { Modal } from '@renderer/components/Modal'
import { useApp } from '@renderer/store'
import { parseDiff, type DiffLine, type ParsedDiff } from './diff'
import { GIT_POLL_MS, branchLabel } from './GitControls'
import './git.css'

/** The project's uncommitted changes: a file list beside the selected file's diff, like GitHub Desktop. */
export function DiffModal() {
  const open = useApp((s) => s.diffOpen)
  const projectId = useApp((s) => (s.route.view === 'board' ? s.route.projectId : null))
  const closeDiff = useApp((s) => s.closeDiff)

  return (
    <Modal open={open && Boolean(projectId)} onClose={closeDiff} className="diff-modal" labelledBy="diff-title">
      {open && projectId && <DiffPanel projectId={projectId} />}
    </Modal>
  )
}

type Loaded =
  | { file: GitFileChange; diff: GitFileDiff; parsed: ParsedDiff }
  | { file: GitFileChange; error: string }

const fileKey = (f: GitFileChange) => `${f.status}\0${f.oldPath ?? ''}\0${f.path}`

function DiffPanel({ projectId }: { projectId: string }) {
  const git = useApp((s) => s.git)
  const closeDiff = useApp((s) => s.closeDiff)
  const files = git?.files ?? []

  // The status may be a few seconds old: read it again before calling the folder clean.
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    useApp.getState().refreshGit().finally(() => setChecked(true))
  }, [])

  // Selection is by path; if that file drops out of the list, the one now at its index takes over.
  const [sel, setSel] = useState<{ path: string; index: number } | null>(null)
  const found = sel ? files.findIndex((f) => f.path === sel.path) : -1
  const index = found >= 0 ? found : Math.min(sel?.index ?? 0, files.length - 1)
  const file = index >= 0 ? files[index] : undefined
  const select = (i: number) => {
    const f = files[Math.max(0, Math.min(files.length - 1, i))]
    if (f) setSel({ path: f.path, index: files.indexOf(f) })
  }

  // Diffs are cached per file so moving through the list is instant, and the
  // selected one is re-read while it's showing, as sessions keep editing.
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [reloads, setReloads] = useState(0)
  const cache = useRef(new Map<string, Loaded>())
  const key = file ? fileKey(file) : null

  useEffect(() => {
    if (!file || !key) {
      setLoaded(null)
      return
    }
    const cached = cache.current.get(key)
    if (cached) setLoaded(cached)

    let cancelled = false
    const store = (next: Loaded) => {
      if (cancelled) return
      cache.current.set(key, next)
      setLoaded(next)
    }
    const read = () =>
      window.api.git.diff(projectId, file).then(
        (diff) => {
          const prev = cache.current.get(key)
          const same =
            prev && 'diff' in prev && prev.diff.patch === diff.patch && !prev.diff.binary === !diff.binary
          if (!same) store({ file, diff, parsed: parseDiff(diff.patch) })
        },
        (err: unknown) => store({ file, error: err instanceof Error ? err.message : String(err) })
      )
    read()
    const timer = window.setInterval(() => {
      if (document.hasFocus()) read()
    }, GIT_POLL_MS)
    window.addEventListener('focus', read)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', read)
    }
  }, [projectId, key, reloads])

  const refresh = () => {
    useApp.getState().refreshGit()
    setReloads((n) => n + 1)
  }

  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => listRef.current?.focus(), [])
  useEffect(() => {
    listRef.current?.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const onListKey = (e: React.KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key]
    const jump = { Home: 0, End: files.length - 1 }[e.key]
    if (step === undefined && jump === undefined) return
    e.preventDefault()
    select(jump ?? index + step!)
  }

  const count = files.length

  return (
    <>
      <header className="diff-header">
        <div className="diff-heading">
          <h2 id="diff-title" className="diff-title">
            Changes
          </h2>
          {git && (
            <div className="diff-sub">
              <span className="diff-sub-branch">
                <GitBranch size={12} strokeWidth={2.2} />
                {branchLabel(git)}
              </span>
              <span>{count ? `${count} changed ${count === 1 ? 'file' : 'files'}` : 'No changes'}</span>
            </div>
          )}
        </div>
        <div className="diff-actions">
          <button className="btn btn-ghost btn-icon" onClick={refresh} title="Refresh" aria-label="Refresh">
            <RefreshCw size={14} strokeWidth={2} />
          </button>
          <button className="btn btn-ghost btn-icon" onClick={closeDiff} title="Close (Esc)" aria-label="Close">
            <X size={16} />
          </button>
        </div>
      </header>

      {!git ? (
        <div className="diff-empty">
          {checked ? (
            <>
              <div className="diff-empty-title">Not a Git repository</div>
              <div>This project’s folder isn’t tracked by Git, so there are no changes to show.</div>
            </>
          ) : (
            <div>Reading changes…</div>
          )}
        </div>
      ) : count === 0 ? (
        <div className="diff-empty">
          <div className="diff-empty-title">No local changes</div>
          <div>
            There are no uncommitted changes on <span className="diff-mono">{branchLabel(git)}</span>.
          </div>
        </div>
      ) : (
        <div className="diff-body">
          <div
            ref={listRef}
            className="diff-files"
            role="listbox"
            aria-label="Changed files"
            tabIndex={0}
            onKeyDown={onListKey}
          >
            {files.map((f, i) => (
              <FileRow key={f.path} file={f} selected={i === index} onSelect={() => select(i)} />
            ))}
          </div>
          <section className="diff-pane">
            {loaded && <DiffView loaded={loaded} />}
          </section>
        </div>
      )}
    </>
  )
}

function splitPath(p: string) {
  const slash = p.lastIndexOf('/')
  return { dir: p.slice(0, slash + 1), name: p.slice(slash + 1) }
}

const STATUS_LABEL: Record<GitFileStatus, string> = {
  modified: 'Modified',
  added: 'Added',
  untracked: 'New',
  deleted: 'Deleted',
  renamed: 'Renamed',
  conflicted: 'Conflicted'
}

function StatusIcon({ status }: { status: GitFileStatus }) {
  const props = { size: 15, strokeWidth: 2, className: 'diff-status', 'data-status': status }
  const label = STATUS_LABEL[status]
  switch (status) {
    case 'added':
    case 'untracked':
      return <SquarePlus {...props} aria-label={label} />
    case 'deleted':
      return <SquareMinus {...props} aria-label={label} />
    case 'renamed':
      return <SquareArrowRight {...props} aria-label={label} />
    case 'conflicted':
      return <TriangleAlert {...props} aria-label={label} />
    default:
      return <SquareDot {...props} aria-label={label} />
  }
}

function FileRow({ file, selected, onSelect }: { file: GitFileChange; selected: boolean; onSelect: () => void }) {
  const { dir, name } = splitPath(file.path)
  return (
    <div
      role="option"
      aria-selected={selected}
      className={clsx('diff-file', selected && 'is-selected')}
      onPointerDown={onSelect}
      title={`${STATUS_LABEL[file.status]}: ${file.oldPath ? `${file.oldPath} → ` : ''}${file.path}`}
    >
      <span className="diff-file-path">
        {dir && <span className="diff-file-dir">{dir}</span>}
        <span className="diff-file-name">{name}</span>
      </span>
      <StatusIcon status={file.status} />
    </div>
  )
}

function DiffView({ loaded }: { loaded: Loaded }) {
  const { file } = loaded
  const { dir, name } = splitPath(file.path)
  const scrollRef = useRef<HTMLDivElement>(null)

  // A different file starts at the top; a re-read of the same file keeps its place.
  const key = fileKey(file)
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0 })
  }, [key])

  let body
  if ('error' in loaded) {
    body = <DiffNotice title="Couldn’t read this diff" detail={loaded.error} />
  } else if (loaded.diff.binary) {
    body = <DiffNotice title="Binary file not shown" />
  } else if (loaded.diff.tooLarge) {
    body = <DiffNotice title="This diff is too large to show" />
  } else if (loaded.parsed.summary) {
    body = <DiffNotice title={loaded.parsed.summary} />
  } else {
    body = <DiffLines parsed={loaded.parsed} />
  }

  return (
    <>
      <div className="diff-pane-head">
        <StatusIcon status={file.status} />
        <span className="diff-pane-path selectable">
          {dir && <span className="diff-file-dir">{dir}</span>}
          <span className="diff-pane-name">{name}</span>
        </span>
        {file.oldPath && <span className="diff-pane-from">from {file.oldPath}</span>}
      </div>
      <div ref={scrollRef} className="diff-scroll">
        {body}
      </div>
    </>
  )
}

function DiffNotice({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="diff-notice">
      <div>{title}</div>
      {detail && <div className="diff-notice-detail selectable">{detail}</div>}
    </div>
  )
}

const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '-', context: ' ', hunk: '', note: '' }

/** Memoized: the panel re-renders on every status poll, and a diff can run to thousands of lines. */
const DiffLines = memo(function DiffLines({ parsed }: { parsed: ParsedDiff }) {
  const digits = String(parsed.maxLineNo).length
  return (
    <div className="diff-lines" style={{ '--diff-num-w': `${Math.max(2, digits)}ch` } as CSSProperties}>
      {parsed.lines.map((line, i) => (
        <div key={i} className="diff-line" data-kind={line.kind}>
          <span className="diff-num">{line.oldNo}</span>
          <span className="diff-num">{line.newNo}</span>
          <span className="diff-sign">{SIGN[line.kind]}</span>
          <span className="diff-text">
            <LineText line={line} />
          </span>
        </div>
      ))}
    </div>
  )
})

function LineText({ line }: { line: DiffLine }) {
  if (!line.changed) return <>{line.text}</>
  const [start, end] = line.changed
  return (
    <>
      {line.text.slice(0, start)}
      <mark className="diff-word">{line.text.slice(start, end)}</mark>
      {line.text.slice(end)}
    </>
  )
}
