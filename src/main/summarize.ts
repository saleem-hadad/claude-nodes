// Builds handoff summaries for the "merge context" feature.
//
// Each session is resumed headlessly as a fork that is never written to disk,
// and asked to summarize itself. It has the full context, and the original
// session is left untouched.
import { spawn } from 'child_process'
import type { SummarizeProgress, SummaryResult } from '@shared/types'
import { requireClaude, spawnEnv } from './env'

const CONCURRENCY = 3
const TIMEOUT_MS = 5 * 60 * 1000

export const SUMMARY_PROMPT = `Write a handoff summary of this session so that a NEW Claude Code session, with no access to this conversation, can pick up the work.

Cover, under short markdown headings:
- Goal: what the user is trying to achieve.
- Key decisions: what was decided and why, including approaches that were rejected.
- Current state: files created or changed (with paths), what works, and what was verified.
- Open issues and next steps: unfinished work, known bugs, and the obvious next actions.
- Gotchas: important commands, conventions, environment details, or pitfalls discovered.

Answer from the conversation alone: do not call tools, run commands, or change files. Leave out environment notices that are not part of the work (for example connector or MCP authorization messages). Be concise but complete, and prefer specifics (paths, names, commands) over generalities. Output only the summary, with no preamble.`

export interface SummarizeTarget {
  sessionId: string
  title: string
}

function summarizeOne(claude: string, cwd: string, sessionId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--resume',
      sessionId,
      '--fork-session',
      '--no-session-persistence',
      '--output-format',
      'json',
      SUMMARY_PROMPT
    ]
    // stdin is ignored, otherwise claude -p waits for piped input.
    const child = spawn(claude, args, { cwd, env: spawnEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Timed out after 5 minutes'))
    }, TIMEOUT_MS)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let parsed: { result?: unknown; is_error?: boolean } | null = null
      try {
        parsed = JSON.parse(stdout.trim())
      } catch {
        // fall through
      }
      if (parsed && !parsed.is_error && typeof parsed.result === 'string' && parsed.result.trim()) {
        resolve(parsed.result.trim())
        return
      }
      const reason =
        (parsed && typeof parsed.result === 'string' && parsed.result) ||
        stderr.trim().split('\n').slice(-3).join(' ') ||
        `claude exited with code ${code}`
      reject(new Error(reason))
    })
  })
}

export async function summarizeSessions(
  cwd: string,
  targets: SummarizeTarget[],
  requestId: string,
  onProgress: (p: SummarizeProgress) => void
): Promise<SummaryResult[]> {
  const claude = requireClaude()
  const results: SummaryResult[] = targets.map((t) => ({ sessionId: t.sessionId, title: t.title, summary: '' }))
  for (const t of targets) onProgress({ requestId, sessionId: t.sessionId, phase: 'queued' })

  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const i = next++
      const { sessionId } = targets[i]
      onProgress({ requestId, sessionId, phase: 'running' })
      try {
        results[i].summary = await summarizeOne(claude, cwd, sessionId)
        onProgress({ requestId, sessionId, phase: 'done' })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        results[i].error = error
        onProgress({ requestId, sessionId, phase: 'error', error })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker))
  return results
}
