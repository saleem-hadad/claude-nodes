// Resolves the user's login-shell environment and the `claude` binary.
//
// Apps launched from Finder/Dock get a minimal launchd environment (no PATH
// from ~/.zshrc etc.), so `claude` would not be found. We capture the full
// environment once from an interactive login shell at startup.
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const MARK_START = '__CLAUDE_NODES_ENV_START__'
const MARK_END = '__CLAUDE_NODES_ENV_END__'

let baseEnv: Record<string, string> = toStringEnv(process.env)
let claudePath: string | null = null
let claudeVersion: string | null = null

function toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v
  return out
}

/** Session markers set by a parent Claude Code process; claude refuses to start nested. */
const STRIP_EXACT = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'ELECTRON_RUN_AS_NODE'
])
const STRIP_PREFIXES = [
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_MESSAGING',
  'CLAUDE_CODE_SSE',
  'CLAUDE_AGENT_SDK',
  'CLAUDE_NODES_',
  'ELECTRON_'
]

function shouldStrip(key: string) {
  return STRIP_EXACT.has(key) || STRIP_PREFIXES.some((p) => key.startsWith(p))
}

function captureShellEnv(): Promise<Record<string, string> | null> {
  const shell = process.env.SHELL || '/bin/zsh'
  const script = `printf '%s' '${MARK_START}'; env -0; printf '%s' '${MARK_END}'`
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', script],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, env: process.env },
      (_err, stdout) => {
        // Interactive shells may exit non-zero or print noise; the markers are what matter.
        const start = stdout?.indexOf(MARK_START) ?? -1
        const end = stdout?.lastIndexOf(MARK_END) ?? -1
        if (start < 0 || end < 0 || end <= start) return resolve(null)
        const body = stdout.slice(start + MARK_START.length, end)
        const env: Record<string, string> = {}
        for (const entry of body.split('\0')) {
          const eq = entry.indexOf('=')
          if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
        }
        resolve(Object.keys(env).length ? env : null)
      }
    )
  })
}

function withFallbackPath(env: Record<string, string>) {
  const home = os.homedir()
  const extra = [
    path.join(home, '.local/bin'),
    path.join(home, '.claude/local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
  const parts = (env.PATH || '').split(':').filter(Boolean)
  for (const dir of extra) if (!parts.includes(dir)) parts.push(dir)
  env.PATH = parts.join(':')
}

function findOnPath(bin: string, pathVar: string): string | null {
  for (const dir of pathVar.split(':')) {
    if (!dir) continue
    const candidate = path.join(dir, bin)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // not here
    }
  }
  return null
}

function readVersion(bin: string, env: Record<string, string>): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 10_000, env }, (err, stdout) => {
      if (err) return resolve(null)
      resolve(stdout.trim().split('\n')[0] || null)
    })
  })
}

export async function initEnv() {
  const captured = await captureShellEnv()
  const env = captured ? { ...toStringEnv(process.env), ...captured } : toStringEnv(process.env)
  withFallbackPath(env)
  baseEnv = env
  claudePath = findOnPath('claude', env.PATH)
  claudeVersion = claudePath ? await readVersion(claudePath, spawnEnv()) : null
}

/** Environment for spawned claude processes: the user's shell env minus nesting markers. */
export function spawnEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(baseEnv)) if (!shouldStrip(k)) env[k] = v
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  if (!env.LANG) env.LANG = 'en_US.UTF-8'
  return { ...env, ...extra }
}

/** The user's login shell, for terminal cards. */
export function userShell(): string {
  const shell = baseEnv.SHELL || process.env.SHELL
  return shell && path.isAbsolute(shell) ? shell : '/bin/zsh'
}

export function getClaudePath() {
  return claudePath
}

export function getClaudeVersion() {
  return claudeVersion
}

export function requireClaude(): string {
  if (!claudePath) {
    throw new Error(
      'Claude Code CLI not found. Install it (npm i -g @anthropic-ai/claude-code) and restart Claude Nodes.'
    )
  }
  return claudePath
}
