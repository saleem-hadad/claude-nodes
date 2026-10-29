import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Sparkles } from 'lucide-react'
import clsx from 'clsx'
import { ACTION_ICONS, DEFAULT_ACTION_ICON } from '@shared/actions'
import type { ActionDraft, ProjectAction } from '@shared/types'
import { Modal } from '@renderer/components/Modal'
import { useApp } from '@renderer/store'
import { ACTION_ICON_COMPONENTS } from './ActionIcon'

/** Descriptions to start from. Clicking one fills the box, ready to adjust. */
const EXAMPLES = [
  {
    label: 'Pull and push',
    text: 'Pull the latest changes from the remote, then push my local commits. If the pull conflicts, resolve the conflicts so both sides’ changes are kept, finish the merge, and push. Never force-push, and stop if there are uncommitted changes that would get in the way.'
  },
  {
    label: 'Tidy the board',
    text: 'Clean up the board: archive the sessions that are done and haven’t been active for a day. Leave anything that is working or waiting for me alone.'
  },
  {
    label: 'Run the tests',
    text: 'Run the project’s tests. If any fail, fix them, run the tests again, and tell me what you changed.'
  },
  {
    label: 'Commit my changes',
    text: 'Look at the uncommitted changes, split them into sensible commits with clear messages, and commit them. Don’t push.'
  },
  {
    label: 'Review the diff',
    text: 'Review the uncommitted changes for bugs and risky edits, and tell me what you found. Don’t change any files.'
  }
]

type Step = 'describe' | 'review'

/**
 * Adds or edits an action. The user describes what it should do, Claude
 * drafts the name, icon and prompt, and the user reviews them.
 */
export function ActionDialog({
  projectId,
  action,
  onClose
}: {
  projectId: string
  /** The action being edited; a new one when unset. */
  action?: ProjectAction
  onClose: () => void
}) {
  const [step, setStep] = useState<Step>(action ? 'review' : 'describe')
  const [description, setDescription] = useState(action?.description ?? '')
  const [name, setName] = useState(action?.name ?? '')
  const [icon, setIcon] = useState(action?.icon ?? DEFAULT_ACTION_ICON)
  const [prompt, setPrompt] = useState(action?.prompt ?? '')
  const [global, setGlobal] = useState(action?.global ?? false)
  const [drafting, setDrafting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A draft that lands after the dialog closed, or after a newer request, is dropped.
  const request = useRef(0)
  useEffect(() => () => void (request.current = -1), [])

  const draft = async () => {
    const what = description.trim()
    if (!what || drafting) return
    const id = ++request.current
    setDrafting(true)
    setError(null)
    try {
      const d: ActionDraft = await window.api.actions.draft(projectId, what, global)
      if (request.current !== id) return
      setName(d.name)
      setIcon(d.icon)
      setPrompt(d.prompt)
      setStep('review')
    } catch (err) {
      if (request.current === id) setError(`Claude couldn’t draft it: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (request.current === id) setDrafting(false)
    }
  }

  const save = async () => {
    if (!prompt.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      await useApp.getState().saveAction(projectId, {
        id: action?.id ?? crypto.randomUUID(),
        name: name.trim() || 'Action',
        icon,
        description: description.trim(),
        prompt: prompt.trim(),
        global: global || undefined,
        createdAt: action?.createdAt ?? Date.now()
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  const scope = (
    <label className="action-scope">
      <span className="action-scope-text">
        <span className="action-scope-title">Use in every project</span>
        <span className="action-scope-hint">
          {global
            ? 'A global button, in the actions rail of all your projects. Claude writes its prompt to work in any repository.'
            : 'Only this project has it.'}
        </span>
      </span>
      <input
        type="checkbox"
        role="switch"
        className="action-switch"
        checked={global}
        disabled={drafting || saving}
        onChange={(e) => setGlobal(e.target.checked)}
      />
    </label>
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || !e.metaKey) return
    e.preventDefault()
    if (step === 'describe') draft()
    else save()
  }

  return (
    <Modal open onClose={onClose} className="action-dialog" labelledBy="action-title">
      <div className="action-inner" onKeyDown={onKeyDown}>
        <header className="action-head">
          <div className="action-head-icon">
            <Sparkles size={16} strokeWidth={2.2} />
          </div>
          <div>
            <h2 id="action-title" className="action-title">
              {action ? 'Edit action' : 'New action'}
            </h2>
            <p className="action-subtitle">
              {step === 'describe'
                ? 'Say what the button should do. Claude writes the prompt each press runs.'
                : 'Each press runs a session on this prompt in auto mode, beside its button. It goes when it’s done.'}
            </p>
          </div>
        </header>

        {step === 'describe' ? (
          <div className="action-body">
            <textarea
              className="action-input action-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="For example: archive the sessions that are done, so the board only shows what’s still going on."
              rows={5}
              autoFocus
              disabled={drafting}
            />
            <div className="action-examples">
              <span className="action-label">Start from an example</span>
              <div className="action-chips">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex.label}
                    className={clsx('action-chip', description === ex.text && 'is-active')}
                    onClick={() => setDescription(ex.text)}
                    disabled={drafting}
                    title={ex.text}
                  >
                    {ex.label}
                  </button>
                ))}
              </div>
            </div>
            {scope}
          </div>
        ) : (
          <div className="action-body">
            <label className="action-field">
              <span className="action-label">Name</span>
              <input
                className="action-input action-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                autoFocus
              />
            </label>
            <div className="action-field">
              <span className="action-label">Icon</span>
              <div className="action-icons" role="radiogroup" aria-label="Icon">
                {ACTION_ICONS.map((key) => {
                  const Icon = ACTION_ICON_COMPONENTS[key]
                  return (
                    <button
                      key={key}
                      className={clsx('action-icon-option', icon === key && 'is-selected')}
                      onClick={() => setIcon(key)}
                      role="radio"
                      aria-checked={icon === key}
                      aria-label={key}
                      title={key}
                    >
                      <Icon size={15} strokeWidth={2} />
                    </button>
                  )
                })}
              </div>
            </div>
            <label className="action-field action-field-grow">
              <span className="action-label">Prompt</span>
              <textarea
                className="action-input action-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
            {scope}
          </div>
        )}

        {error && <p className="action-error selectable">{error}</p>}

        <footer className="action-foot">
          {step === 'review' ? (
            <button className="btn btn-ghost" onClick={() => setStep('describe')} disabled={saving}>
              {action ? 'Redraft…' : 'Back'}
            </button>
          ) : (
            prompt && (
              <button className="btn btn-ghost" onClick={() => setStep('review')} disabled={drafting}>
                Back to the draft
              </button>
            )
          )}
          <span className="action-foot-spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {step === 'describe' ? (
            <button className="btn btn-primary" onClick={draft} disabled={!description.trim() || drafting}>
              {drafting ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} strokeWidth={2.2} />}
              {drafting ? 'Drafting…' : 'Draft with Claude'}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={save} disabled={!prompt.trim() || saving}>
              {action ? 'Save' : 'Add action'}
            </button>
          )}
        </footer>
      </div>
    </Modal>
  )
}
