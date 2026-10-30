import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import clsx from 'clsx'
import type { AppSettings, ThemePreference, VoiceKeySource } from '@shared/types'
import { useApp } from '@renderer/store'
import { Modal } from './Modal'
import './SettingsDialog.css'

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

/** App-wide preferences, opened with Cmd+, (Claude Nodes › Settings…). */
export function SettingsDialog() {
  const open = useApp((s) => s.settingsOpen)
  const close = useApp((s) => s.closeSettings)

  return (
    // The panel handles Escape itself, so the key never reaches the views underneath.
    <Modal open={open} onClose={close} className="settings-dialog" labelledBy="settings-title" closeOnEscape={false}>
      <SettingsPanel onClose={close} />
    </Modal>
  )
}

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    window.api.settings.get().then((s) => !cancelled && setSettings(s))
    return () => {
      cancelled = true
    }
  }, [])

  // Take focus from whatever had it (often a terminal) and hand it back on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    return () => previous?.focus()
  }, [])

  const update = (patch: Partial<AppSettings>) => {
    setSettings((s) => s && { ...s, ...patch })
    window.api.settings.update(patch).then(setSettings)
  }

  return (
    <div
      ref={panelRef}
      className="settings-inner"
      tabIndex={-1}
      onKeyDown={(e) => {
        // Board and Projects shortcuts listen on window; keep them from firing underneath.
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
        else if (e.key === 'Tab') trapTab(e, e.currentTarget)
      }}
    >
      <header className="settings-head">
        <h2 id="settings-title" className="settings-title">
          Settings
        </h2>
        <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <X size={16} />
        </button>
      </header>

      <div className="settings-body">
        <fieldset className="settings-group">
          <legend className="settings-label">Appearance</legend>
          <div className="settings-themes">
            {THEMES.map((t) => (
              <label key={t.value} className="settings-theme">
                <input
                  type="radio"
                  name="theme"
                  className="settings-theme-input"
                  value={t.value}
                  checked={settings?.theme === t.value}
                  disabled={!settings}
                  onChange={() => update({ theme: t.value })}
                />
                <ThemePreview theme={t.value} />
                <span className="settings-theme-name">{t.label}</span>
              </label>
            ))}
          </div>
          <p className="settings-hint">System follows the appearance set in macOS.</p>
        </fieldset>

        <VoiceSettings />
      </div>
    </div>
  )
}

/**
 * The xAI key behind the board's mic button. The key itself never comes back
 * from the main process; only where it's from.
 */
function VoiceSettings() {
  /** undefined while loading. */
  const [source, setSource] = useState<VoiceKeySource | undefined>(undefined)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    window.api.voice.keySource().then((s) => !cancelled && setSource(s))
    return () => {
      cancelled = true
    }
  }, [])

  const save = async (value: string | null) => {
    setError(null)
    try {
      setSource(await window.api.voice.setKey(value))
      setKey('')
      // Save goes disabled and Remove goes away; keep focus in the dialog so Esc still closes it.
      inputRef.current?.focus()
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    }
  }

  return (
    <fieldset className="settings-group">
      <legend className="settings-label">Voice prompts</legend>
      <form
        className="settings-key"
        onSubmit={(e) => {
          e.preventDefault()
          if (key.trim()) void save(key)
        }}
      >
        <input
          ref={inputRef}
          type="password"
          className="settings-input"
          placeholder={source === 'settings' ? 'Replace the saved xAI API key' : 'xAI API key'}
          aria-label="xAI API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={source === undefined}
        />
        <button type="submit" className="btn" disabled={!key.trim()}>
          Save
        </button>
      </form>
      <p className="settings-hint">
        {source === 'settings' ? (
          <>
            Saved in your Keychain.{' '}
            <button type="button" className="settings-link" onClick={() => void save(null)}>
              Remove
            </button>
          </>
        ) : source === 'env' ? (
          'Using XAI_API_KEY from your shell. A key saved here takes its place.'
        ) : (
          <>
            Add a key to speak prompts with the mic button. Get one at{' '}
            <a href="https://console.x.ai" target="_blank" rel="noreferrer">
              console.x.ai
            </a>
            .
          </>
        )}
      </p>
      <p className="settings-hint">Recordings are sent to xAI to be turned into text.</p>
      {error && <p className="settings-error">{error}</p>}
    </fieldset>
  )
}

/** Keeps Tab cycling inside the dialog instead of escaping to the page behind it. */
function trapTab(e: KeyboardEvent<HTMLElement>, panel: HTMLElement) {
  const stops = Array.from(panel.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')).filter(
    (el) => !el.disabled && (el.type !== 'radio' || (el as HTMLInputElement).checked)
  )
  if (stops.length === 0) return
  const first = stops[0]
  const last = stops[stops.length - 1]
  const active = document.activeElement
  if (e.shiftKey ? active === first || active === panel : active === last) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
  }
}

/** A miniature board window in the theme's colours; System shows both, split diagonally. */
function ThemePreview({ theme }: { theme: ThemePreference }) {
  return (
    <span className="settings-preview" aria-hidden="true">
      {theme !== 'dark' && <MiniWindow tone="light" />}
      {theme !== 'light' && <MiniWindow tone="dark" split={theme === 'system'} />}
    </span>
  )
}

function MiniWindow({ tone, split }: { tone: 'light' | 'dark'; split?: boolean }) {
  return (
    <span className={clsx('mini-window', `is-${tone}`, split && 'is-split')}>
      <span className="mini-bar">
        <span className="mini-light" />
        <span className="mini-light" />
        <span className="mini-light" />
      </span>
      <span className="mini-canvas">
        {(['working', 'done'] as const).map((status) => (
          <span key={status} className="mini-card">
            <span className="mini-dot" data-status={status} />
            <span className="mini-line" />
            <span className="mini-line is-short" />
          </span>
        ))}
      </span>
    </span>
  )
}
