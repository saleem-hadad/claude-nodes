// Names a new section from the sessions grouped under it.
//
// A quick headless claude call: each session's title and opening prompt go
// in, a few words come out. Thinking, tools and MCP servers are off, and it
// runs outside the repo, so it answers in a couple of seconds.
import { spawn } from 'child_process'
import os from 'os'
import { requireClaude, spawnEnv } from './env'

const TIMEOUT_MS = 30_000
const MAX_PROMPT_CHARS = 280
const MAX_NAME_CHARS = 48

const SYSTEM_PROMPT = `You name groups of Claude Code sessions on a board. Reply with the group's name only: 1 to 4 words in Title Case that say what the sessions have in common. No quotes, no trailing punctuation, no preamble.`

export interface NamingSource {
  title: string
  firstPrompt?: string
}

const clip = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function buildPrompt(sources: NamingSource[]): string {
  const lines = sources.map((s, i) => {
    const prompt = s.firstPrompt && clip(s.firstPrompt, MAX_PROMPT_CHARS)
    return prompt && prompt !== s.title ? `${i + 1}. ${s.title}\n   Opening prompt: ${prompt}` : `${i + 1}. ${s.title}`
  })
  return `Name this group of sessions:\n\n${lines.join('\n')}`
}

/** The model's reply as a name: first line, without quotes, markdown or a trailing full stop. */
function cleanName(reply: string): string {
  const line = reply.trim().split('\n')[0] ?? ''
  const name = line
    .replace(/^(name|title)\s*:\s*/i, '')
    .replace(/[*_`#"“”]/g, '')
    .replace(/^'+|'+$/g, '')
    .replace(/[.!?:;,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return name.length > MAX_NAME_CHARS ? name.slice(0, MAX_NAME_CHARS).trimEnd() : name
}

export function nameSection(sources: NamingSource[]): Promise<string> {
  const claude = requireClaude()
  const args = [
    '-p',
    '--model',
    'haiku',
    '--settings',
    JSON.stringify({ alwaysThinkingEnabled: false }),
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--system-prompt',
    SYSTEM_PROMPT,
    '--output-format',
    'json',
    buildPrompt(sources)
  ]
  return new Promise((resolve, reject) => {
    // stdin is ignored, otherwise claude -p waits for piped input.
    const child = spawn(claude, args, { cwd: os.tmpdir(), env: spawnEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Naming timed out'))
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
      const name = parsed && !parsed.is_error && typeof parsed.result === 'string' ? cleanName(parsed.result) : ''
      if (name) {
        resolve(name)
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
