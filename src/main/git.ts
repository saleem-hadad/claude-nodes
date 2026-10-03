// Read-only git queries behind the title bar's branch chip and the Changes modal.
import { execFile } from 'child_process'
import path from 'path'
import type { GitFileChange, GitFileDiff, GitFileStatus, GitStatus } from '@shared/types'
import { spawnEnv } from './env'

/** Diffs larger than this are not shown. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024

interface GitResult {
  stdout: string
  code: number
}

function git(cwd: string, args: string[], maxBuffer = 32 * 1024 * 1024): Promise<GitResult> {
  // --no-optional-locks: polling status must never take index.lock from under
  // a git command Claude is running in the same repo.
  const argv = ['--no-optional-locks', '-c', 'core.quotepath=false', ...args]
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      argv,
      { cwd, env: spawnEnv({ GIT_TERMINAL_PROMPT: '0' }), maxBuffer, encoding: 'utf8' },
      (err, stdout) => {
        if (!err) return resolve({ stdout, code: 0 })
        // A non-zero exit is an answer (e.g. "not a repository"); anything else is a failure.
        if (typeof err.code === 'number') return resolve({ stdout, code: err.code })
        reject(err)
      }
    )
  })
}

function statusOf(xy: string): GitFileStatus {
  const [x, y] = xy
  if (x === 'A') return 'added'
  if (x === 'D' || y === 'D') return 'deleted'
  return 'modified'
}

/** Branch and uncommitted changes, or null when the folder isn't in a git repository. */
export async function gitStatus(repoPath: string): Promise<GitStatus | null> {
  const res = await git(repoPath, [
    'status',
    '--porcelain=v2',
    '--branch',
    '--untracked-files=all',
    '-z'
  ])
  if (res.code !== 0) return null

  const status: GitStatus = { branch: null, oid: null, ahead: 0, behind: 0, files: [] }
  const records = res.stdout.split('\0')
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue
    if (rec.startsWith('# ')) {
      const [key, ...rest] = rec.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.head' && value !== '(detached)') status.branch = value
      else if (key === 'branch.oid' && value !== '(initial)') status.oid = value
      else if (key === 'branch.upstream') status.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          status.ahead = Number(m[1])
          status.behind = Number(m[2])
        }
      }
      continue
    }

    // Fields are space-separated; the path is last and may itself contain spaces.
    const fields = (n: number) => {
      const parts = rec.split(' ')
      return { parts, path: parts.slice(n).join(' ') }
    }
    const type = rec[0]
    let change: GitFileChange | null = null
    if (type === '1') {
      const { parts, path: p } = fields(8)
      change = { path: p, status: statusOf(parts[1]) }
    } else if (type === '2') {
      // A rename's original path is the next NUL-separated record.
      const { path: p } = fields(9)
      change = { path: p, oldPath: records[++i], status: 'renamed' }
    } else if (type === 'u') {
      change = { path: fields(10).path, status: 'conflicted' }
    } else if (type === '?') {
      change = { path: rec.slice(2), status: 'untracked' }
    }
    if (change) status.files.push(change)
  }
  status.files.sort((a, b) => a.path.localeCompare(b.path))
  return status
}

let emptyTree: string | null = null

/** A repository with no commits yet diffs against the empty tree. */
async function baseRevision(repoPath: string): Promise<string> {
  const head = await git(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (head.code === 0) return 'HEAD'
  if (!emptyTree) {
    const res = await git(repoPath, ['hash-object', '-t', 'tree', '/dev/null'])
    emptyTree = res.stdout.trim()
  }
  return emptyTree
}

/** The working-tree diff of one changed file against HEAD. */
export async function gitDiff(projectPath: string, file: GitFileChange): Promise<GitFileDiff> {
  // Status paths are relative to the repository root, which may sit above the project folder.
  const top = await git(projectPath, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) throw new Error('Not a git repository')
  const repoPath = top.stdout.trim()

  // Paths come from the renderer: never let one reach outside the repository.
  for (const p of [file.path, file.oldPath]) {
    if (p === undefined) continue
    const rel = path.relative(repoPath, path.resolve(repoPath, p))
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Not in the repository: ${p}`)
  }

  const common = ['--no-color', '--no-ext-diff']
  const args =
    file.status === 'untracked'
      ? ['diff', ...common, '--no-index', '--', '/dev/null', file.path]
      : [
          'diff',
          ...common,
          '-M',
          await baseRevision(repoPath),
          '--',
          ...(file.oldPath ? [file.oldPath] : []),
          file.path
        ]

  let res: GitResult
  try {
    res = await git(repoPath, args, MAX_DIFF_BYTES)
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { patch: '', tooLarge: true }
    }
    throw err
  }
  // `diff --no-index` exits 1 when the files differ.
  if (res.code !== 0 && !(file.status === 'untracked' && res.code === 1)) {
    throw new Error(`git diff failed for ${file.path}`)
  }
  const binary = /^(Binary files .* differ|GIT binary patch)$/m.test(res.stdout)
  return binary ? { patch: '', binary: true } : { patch: res.stdout }
}
