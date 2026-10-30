import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { AlertCircle, Loader2, Mic, RotateCcw, Settings, Square, X } from 'lucide-react'
import clsx from 'clsx'
import type { TranscribeResult } from '@shared/types'
import { useApp } from '@renderer/store'
import { BANDS, startRecording, type Recording } from './recorder'
import './voice.css'

/** A recording stops by itself after this long. */
const MAX_MS = 5 * 60_000
/** Anything shorter is a double click, not a prompt. */
const MIN_MS = 600
/** Which band each meter bar shows: the loudest, lowest one in the middle. */
const BAR_BANDS = [3, 1, 0, 2, 4].filter((band) => band < BANDS)

type Phase = 'idle' | 'opening' | 'recording' | 'transcribing'

interface Notice {
  message: string
  /** Offers Settings, for a missing or refused key. */
  settings?: boolean
  /** Offers System Settings, for a microphone the user turned down. */
  microphone?: boolean
  /** Offers to send the same recording again. */
  retry?: boolean
}

export interface VoiceHandle {
  /** Starts recording, or stops and transcribes: the board's V key. */
  toggle(): void
}

interface Props {
  projectId: string
  /** Starts a session on the reviewed prompt. */
  onStart: (text: string) => void
  ref?: Ref<VoiceHandle>
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The mic button in the board's bottom-right corner. Speak, stop, and what was
 * said opens for review; Enter starts a session on it.
 */
export function VoicePrompt({ projectId, onStart, ref }: Props) {
  const openSettings = useApp((s) => s.openSettings)
  const [phase, setPhase] = useState<Phase>('idle')
  /** The transcript under review; null when there's none. */
  const [draft, setDraft] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [elapsed, setElapsed] = useState(0)

  const recording = useRef<Recording | null>(null)
  const startedAt = useRef(0)
  /** Bumped by every start and cancel, so an answer that arrives too late is dropped. */
  const run = useRef(0)
  /** A recording xAI couldn't transcribe, kept for Retry so nothing has to be said twice. */
  const failed = useRef<Blob | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  const textRef = useRef<HTMLTextAreaElement>(null)

  const transcribe = useCallback(
    async (audio: Blob) => {
      const id = ++run.current
      setPhase('transcribing')
      setNotice(null)
      let result: TranscribeResult
      try {
        result = await window.api.voice.transcribe(projectId, new Uint8Array(await audio.arrayBuffer()), audio.type)
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) }
      }
      if (id !== run.current) return
      setPhase('idle')
      if ('error' in result) {
        failed.current = audio
        setNotice({ message: result.error, settings: result.keyProblem, retry: true })
        return
      }
      failed.current = null
      const text = result.text
      if (!text) setNotice({ message: 'Didn’t catch anything. Try again, a little closer to the mic.' })
      // Speaking again while reviewing adds to what's there.
      else setDraft((d) => (d?.trim() ? `${d.trimEnd()} ${text}` : text))
    },
    [projectId]
  )

  const record = useCallback(async () => {
    const id = ++run.current
    setNotice(null)
    setPhase('opening')
    const fail = (n: Notice | null) => {
      if (id !== run.current) return
      setPhase('idle')
      setNotice(n)
    }
    if (!(await window.api.voice.keySource())) {
      fail(null)
      if (id === run.current) openSettings()
      return
    }
    if (!(await window.api.voice.microphone())) {
      return fail({ message: 'Claude Nodes isn’t allowed to use the microphone.', microphone: true })
    }
    let rec: Recording
    try {
      rec = await startRecording()
    } catch (err) {
      return fail({ message: `Couldn’t open the microphone: ${err instanceof Error ? err.message : String(err)}` })
    }
    // Cancelled while the microphone was opening.
    if (id !== run.current) return rec.cancel()
    recording.current = rec
    startedAt.current = Date.now()
    setElapsed(0)
    setPhase('recording')
  }, [openSettings])

  const stop = useCallback(async () => {
    const rec = recording.current
    if (!rec) return
    recording.current = null
    const id = run.current
    const audio = await rec.stop()
    if (id !== run.current) return
    if (Date.now() - startedAt.current < MIN_MS) setPhase('idle')
    else void transcribe(audio)
  }, [transcribe])

  const cancel = useCallback(() => {
    run.current++
    recording.current?.cancel()
    recording.current = null
    setPhase('idle')
  }, [])

  const discard = () => {
    failed.current = null
    setNotice(null)
    setDraft(null)
  }

  const submit = () => {
    const text = draft?.trim()
    if (!text || phase !== 'idle') return
    onStart(text)
    setNotice(null)
    setDraft(null)
  }

  const retry = () => {
    if (failed.current) void transcribe(failed.current)
  }

  useImperativeHandle(
    ref,
    () => ({
      toggle() {
        if (phase === 'recording') void stop()
        else if (phase === 'idle' && draft === null) void record()
      }
    }),
    [phase, draft, stop, record]
  )

  // While recording: the clock, the meter, and the time limit.
  useEffect(() => {
    if (phase !== 'recording') return
    let frame = 0
    const draw = () => {
      const levels = recording.current?.levels()
      if (levels) {
        BAR_BANDS.forEach((band, i) => bars.current[i]?.style.setProperty('--level', levels[band].toFixed(3)))
        rootRef.current?.style.setProperty('--level', Math.max(...levels).toFixed(3))
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    const ticker = window.setInterval(() => setElapsed(Date.now() - startedAt.current), 250)
    const limit = window.setTimeout(() => void stop(), MAX_MS)
    return () => {
      cancelAnimationFrame(frame)
      window.clearInterval(ticker)
      window.clearTimeout(limit)
      rootRef.current?.style.removeProperty('--level')
    }
  }, [phase, stop])

  // Esc stops listening (or waiting) and keeps nothing new; it comes before the board's own Esc.
  useEffect(() => {
    if (phase === 'idle') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const target = e.target as HTMLElement | null
      // Another field's Esc (a terminal's, say) is its own.
      if (target !== textRef.current && target?.closest('input, textarea, [contenteditable="true"]')) return
      e.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase, cancel])

  // A notice with nothing to act on goes away by itself.
  useEffect(() => {
    if (!notice || notice.settings || notice.microphone || notice.retry) return
    const t = window.setTimeout(() => setNotice((n) => (n === notice ? null : n)), 4200)
    return () => window.clearTimeout(t)
  }, [notice])

  // The review box takes the keyboard, with the caret after the last word, whenever it's ready for it.
  const reviewing = draft !== null
  useEffect(() => {
    const el = textRef.current
    if (!reviewing || phase !== 'idle' || !el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [reviewing, phase])

  // Leaving the board stops the microphone.
  useEffect(
    () => () => {
      run.current++
      recording.current?.cancel()
    },
    []
  )

  const listening = phase === 'recording'
  const busy = phase !== 'idle'

  const status =
    phase === 'recording' ? (
      <span className="voice-status">
        <span className="voice-rec-dot" />
        <span className="voice-time">{clock(elapsed)}</span>
        <span className="voice-meter" aria-hidden>
          {BAR_BANDS.map((band, i) => (
            <span
              key={band}
              className="voice-bar"
              ref={(el) => {
                bars.current[i] = el
              }}
            />
          ))}
        </span>
      </span>
    ) : phase === 'transcribing' ? (
      <span className="voice-status">
        <Loader2 size={13} className="spin" />
        Transcribing…
      </span>
    ) : null

  const noticeView = notice && (
    <div className="voice-notice" role="alert">
      <AlertCircle size={14} className="voice-notice-icon" />
      <span className="voice-notice-text">{notice.message}</span>
      {notice.settings && (
        <button className="btn voice-notice-action" onClick={openSettings}>
          <Settings size={12} />
          Settings
        </button>
      )}
      {notice.microphone && (
        <button className="btn voice-notice-action" onClick={() => void window.api.voice.openMicrophoneSettings()}>
          Open System Settings
        </button>
      )}
      {notice.retry && (
        <button className="btn voice-notice-action" onClick={retry} title="Send the same recording again">
          <RotateCcw size={12} />
          Retry
        </button>
      )}
      <button className="voice-icon-btn" onClick={() => setNotice(null)} title="Dismiss" aria-label="Dismiss">
        <X size={13} />
      </button>
    </div>
  )

  return (
    <div className={clsx('voice', listening && 'is-recording')} ref={rootRef}>
      {reviewing ? (
        <div className="voice-review" role="group" aria-label="Spoken prompt">
          <textarea
            ref={textRef}
            className="voice-text"
            value={draft}
            readOnly={busy}
            placeholder="Say or type a prompt"
            aria-label="Prompt"
            spellCheck
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                discard()
              }
            }}
          />
          {noticeView}
          <div className="voice-review-foot">
            {busy ? (
              <>
                {listening && (
                  <button className="voice-stop" onClick={() => void stop()} title="Stop (V)" aria-label="Stop">
                    <Square size={9} fill="currentColor" strokeWidth={0} />
                  </button>
                )}
                {status}
                {phase !== 'opening' && (
                  <button className="voice-icon-btn" onClick={cancel} title="Cancel (Esc)" aria-label="Cancel">
                    <X size={13} />
                  </button>
                )}
              </>
            ) : (
              <button className="btn btn-ghost voice-more" onClick={() => void record()} title="Say more; it’s added to the end">
                <Mic size={14} />
                Keep talking
              </button>
            )}
            <span className="voice-spacer" />
            <button className="btn btn-ghost" onClick={discard} title="Discard (Esc)">
              Discard
            </button>
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={busy || !draft.trim()}
              title="Start a session on this prompt (Return)"
            >
              Start session <span className="voice-key">↩</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="voice-dock">
          {noticeView ??
            (status && (
              <div className="voice-pill">
                {status}
                <button className="voice-icon-btn" onClick={cancel} title="Cancel (Esc)" aria-label="Cancel">
                  <X size={13} />
                </button>
              </div>
            ))}
          <button
            className={clsx('voice-button', listening && 'is-recording')}
            onClick={() => void (listening ? stop() : record())}
            disabled={phase === 'opening' || phase === 'transcribing'}
            title={listening ? 'Stop and review (V)' : 'Speak a prompt (V)'}
            aria-label={listening ? 'Stop recording' : 'Speak a prompt'}
          >
            {listening ? (
              <Square size={16} fill="currentColor" strokeWidth={0} />
            ) : phase === 'transcribing' ? (
              <Loader2 size={22} className="spin" />
            ) : (
              <Mic size={22} strokeWidth={2} />
            )}
          </button>
        </div>
      )}
    </div>
  )
}
