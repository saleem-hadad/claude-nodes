import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import clsx from 'clsx'
import type { AppSettings, ThemePreference } from '@shared/types'
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
      </div>
    </div>
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
