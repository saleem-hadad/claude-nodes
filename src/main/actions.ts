// Project actions: the buttons in the board's Actions dock.
//
// Claude drafts each one from what the user describes, in a quick headless
// call that may look around the repository (read-only) to fit the prompt to
// it. A run is an ordinary session started on the action's prompt, in auto
// mode and with the session tools on top of every session's note tools
// (boardTools.ts). It isn't drawn on the board, and goes when its turn ends
// (see finishRun in ipc.ts).
import { spawn } from 'child_process'
import crypto from 'crypto'
import { ACTION_ICONS, DEFAULT_ACTION_ICON, isActionIcon } from '@shared/actions'
import type { ActionDraft, ProjectAction } from '@shared/types'
import { requireClaude, spawnEnv } from './env'

const DRAFT_TIMEOUT_MS = 2 * 60 * 1000
const MAX_NAME_CHARS = 40
const MAX_DESCRIPTION_CHARS = 4000
const MAX_PROMPT_CHARS = 20_000

const DRAFT_SYSTEM_PROMPT = `You design action buttons for Claude Nodes, a board of Claude Code sessions for one project. Pressing a button starts a fresh Claude Code session in the project's repository on the button's prompt. Nobody watches the session while it works, and it goes away when its turn ends, so the prompt has to stand on its own. It runs in auto mode: Claude Code approves routine steps by itself and blocks risky ones.

Besides the usual tools (reading and editing files, running commands), a run has these board tools:
- list_sessions: the board's sessions, with their status (working, waiting for the user, or done), whether they are archived, their section, Claude's last reply and when they were last active.
- archive_sessions: archives sessions by id. It skips ones that are working or waiting unless forced.
- create_note, update_note and list_notes: write sticky notes on the board, change them, and read the notes there. A note is short plain text, which suits a report the user should find on the board.

From the user's description, write:
- name: 1 to 3 words in Title Case, for the button.
- icon: the best fit from the list.
- prompt: the run's instructions, addressed to the session ("you"). Say what to do, step by step: what to check first, when to stop without changing anything, and how to handle the likely failures. If the run may need the user to decide something, tell it to ask with AskUserQuestion. Don't add requirements the user didn't ask for.

You can read the repository to fit the prompt to it (for example, to find the real test command), but be quick about it.`

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    icon: { type: 'string', enum: ACTION_ICONS },
    prompt: { type: 'string' }
  },
  required: ['name', 'icon', 'prompt'],
  additionalProperties: false
}

const runSystemPrompt = (action: ProjectAction) =>
  `You are running "${action.name}", an action button the user pressed on the Claude Nodes board for this project. Nobody is watching while you work, so do the job in the prompt without stopping to chat. If you need the user to decide something, ask with AskUserQuestion: that turns the action's button red to call them. When you are done, end with one line saying what you did. The user is shown that line, and this session then goes away. The mcp__claude-nodes__* tools let you list and archive the board's sessions, and write sticky notes on the board.`

const clip = (s: unknown, max: number) => (typeof s === 'string' ? s.trim().slice(0, max) : '')

/** An action from the renderer, checked and trimmed. Throws if it has no prompt. */
export function normalizeAction(raw: Partial<ProjectAction>, existing?: ProjectAction): ProjectAction {
  const prompt = clip(raw.prompt, MAX_PROMPT_CHARS)
  if (!prompt) throw new Error('An action needs a prompt')
  return {
    id: existing?.id ?? (typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID()),
    name: clip(raw.name, MAX_NAME_CHARS) || 'Action',
    icon: isActionIcon(raw.icon) ? raw.icon : DEFAULT_ACTION_ICON,
    description: clip(raw.description, MAX_DESCRIPTION_CHARS),
    prompt,
    global: raw.global === true || undefined,
    createdAt: existing?.createdAt ?? Date.now()
  }
}

/**
 * Asks Claude to turn a description into an action for the user to review. A
 * global action is pressed in every project, so its prompt can't lean on this
 * repository's commands or layout.
 */
export function draftAction(repoPath: string, description: string, global: boolean): Promise<ActionDraft> {
  const what = clip(description, MAX_DESCRIPTION_CHARS)
  if (!what) return Promise.reject(new Error('Describe what the button should do'))
  const claude = requireClaude()
  const readOnly = ['Read', 'Glob', 'Grep']
  const args = [
    '-p',
    '--model',
    'sonnet',
    '--tools',
    readOnly.join(','),
    '--allowedTools',
    readOnly.join(','),
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--json-schema',
    JSON.stringify(DRAFT_SCHEMA),
    '--output-format',
    'json',
    '--append-system-prompt',
    DRAFT_SYSTEM_PROMPT,
    global
      ? `Draft a button that does this:\n\n${what}\n\nThe button is global: it shows in every project, so the prompt has to work in any repository. Don't rely on this one's commands, paths or tools; tell the run how to find them.`
      : `Draft a button that does this:\n\n${what}`
  ]
  return new Promise((resolve, reject) => {
    // stdin is ignored, otherwise claude -p waits for piped input.
    const child = spawn(claude, args, { cwd: repoPath, env: spawnEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Drafting the button took too long'))
    }, DRAFT_TIMEOUT_MS)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let parsed: { result?: unknown; is_error?: boolean; structured_output?: Partial<ActionDraft> } | null = null
      try {
        parsed = JSON.parse(stdout.trim())
      } catch {
        // fall through
      }
      const draft = parsed && !parsed.is_error ? parsed.structured_output : undefined
      const prompt = clip(draft?.prompt, MAX_PROMPT_CHARS)
      if (draft && prompt) {
        resolve({
          name: clip(draft.name, MAX_NAME_CHARS) || 'Action',
          icon: isActionIcon(draft.icon) ? draft.icon : DEFAULT_ACTION_ICON,
          prompt
        })
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

/** Extra `claude` arguments for a run: a note on how a run should behave. */
export function runArgs(action: ProjectAction): string[] {
  return ['--append-system-prompt', runSystemPrompt(action)]
}
