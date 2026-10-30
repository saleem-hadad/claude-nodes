// Speech to text for the board's mic button, through xAI's API.
//
// The key stays in the main process. It is either saved from Settings
// (encrypted with safeStorage, so the macOS Keychain holds the secret) or the
// XAI_API_KEY in the user's shell; a saved one wins.
import { safeStorage, shell, systemPreferences } from 'electron'
import path from 'path'
import type { Project, TranscribeResult, VoiceKeySource } from '@shared/types'
import { envVar } from './env'
import { gitStatus } from './git'
import { getState, save } from './store'

const STT_URL = 'https://api.x.ai/v1/stt'
const MODEL = 'grok-voice-transcribe-2.0'
/** xAI takes up to 100 hint terms of up to 50 characters each. */
const MAX_KEYTERMS = 100
const MAX_KEYTERM_CHARS = 50
const TIMEOUT_MS = 90_000

function savedKey(): string | null {
  const sealed = getState().voiceKey
  if (!sealed) return null
  try {
    return safeStorage.decryptString(Buffer.from(sealed, 'base64')) || null
  } catch (err) {
    console.error('[voice] could not decrypt the saved key', err)
    return null
  }
}

const shellKey = () => envVar('XAI_API_KEY')?.trim() || null

export function keySource(): VoiceKeySource {
  if (getState().voiceKey) return 'settings'
  return shellKey() ? 'env' : null
}

export function setKey(key: string | null): VoiceKeySource {
  const state = getState()
  const trimmed = key?.trim()
  if (trimmed) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('The Keychain isn’t available, so the key can’t be saved. Set XAI_API_KEY in your shell instead.')
    }
    state.voiceKey = safeStorage.encryptString(trimmed).toString('base64')
  } else {
    delete state.voiceKey
  }
  save()
  return keySource()
}

/** Asks for the microphone if macOS hasn't yet; false when the user turned it down. */
export async function microphone(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'granted') return true
  if (status === 'not-determined') return systemPreferences.askForMediaAccess('microphone')
  return false
}

export function openMicrophoneSettings() {
  return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
}

/**
 * Words to expect: the project's name, its branch and the files it has
 * changed, so code names like "BoardView" come back spelled as in the repo
 * rather than as "board view".
 */
async function keyterms(project: Project): Promise<string[]> {
  const terms = [project.name]
  const status = await gitStatus(project.repoPath).catch(() => null)
  if (status?.branch) terms.push(status.branch)
  for (const file of status?.files ?? []) terms.push(path.parse(file.path).name)
  const usable = terms.map((t) => t.trim()).filter((t) => t.length >= 3 && t.length <= MAX_KEYTERM_CHARS)
  return [...new Set(usable)].slice(0, MAX_KEYTERMS)
}

/** xAI's own message, without its trailing diagnostic code. */
function errorText(body: unknown, status: number): string {
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  const message = typeof error === 'string' ? error.replace(/\s*\[WKE=[^\]]*\]/g, '').trim() : ''
  return message || `xAI answered with an error (${status}).`
}

export async function transcribe(project: Project, audio: Uint8Array, mimeType: string): Promise<TranscribeResult> {
  const key = savedKey() ?? shellKey()
  if (!key) return { error: 'Add an xAI API key in Settings to speak prompts.', keyProblem: true }

  // xAI tells the format from the file itself; the type only names it.
  const type = mimeType.split(';')[0] || 'audio/webm'
  const form = new FormData()
  form.append('model', MODEL)
  for (const term of await keyterms(project)) form.append('keyterm', term)
  form.append('file', new Blob([new Uint8Array(audio)], { type }), `prompt.${type.split('/')[1] ?? 'webm'}`)

  let res: Response
  try {
    res = await fetch(STT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    return { error: timedOut ? 'xAI didn’t answer in time.' : 'Couldn’t reach xAI. Check your connection.' }
  }

  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message = errorText(body, res.status)
    // A wrong key comes back as a 400 that says so; a missing or revoked one as a 401 or 403.
    const keyProblem = res.status === 401 || res.status === 403 || /api key/i.test(message)
    return keyProblem ? { error: 'xAI didn’t accept the API key.', keyProblem } : { error: message }
  }
  const text = body && typeof body === 'object' ? (body as { text?: unknown }).text : undefined
  return { text: typeof text === 'string' ? text.trim() : '' }
}
