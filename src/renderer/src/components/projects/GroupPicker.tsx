import { useState, type FormEvent } from 'react'
import clsx from 'clsx'
import { Check, FolderMinus, Folders } from 'lucide-react'
import type { Project, ProjectGroup } from '@shared/types'
import { Modal } from '../Modal'
import { moveToGroup, sortGroups } from './projectsUi'
import './GroupPicker.css'

interface Props {
  /** The project being moved; the picker is closed while null. */
  project: Project | null
  groups: ProjectGroup[]
  onClose: () => void
}

/** "Move to Group…": pick one of the groups, take the project out of its group, or file it under a new one. */
export function GroupPicker({ project, groups, onClose }: Props) {
  return (
    <Modal open={!!project} onClose={onClose} className="gp" labelledBy="gp-title">
      {project && <PickerBody key={project.id} project={project} groups={groups} onClose={onClose} />}
    </Modal>
  )
}

function PickerBody({ project, groups, onClose }: Props & { project: Project }) {
  const [name, setName] = useState('')
  const current = project.groupId && groups.some((g) => g.id === project.groupId) ? project.groupId : null

  const pick = (groupId: string | null) => {
    onClose()
    if (groupId !== current) moveToGroup(project.id, groupId)
  }

  const create = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    onClose()
    const group = await window.api.groups.create(trimmed)
    await moveToGroup(project.id, group.id)
  }

  const rows: { id: string | null; name: string }[] = [
    ...sortGroups(groups).map((g) => ({ id: g.id, name: g.name })),
    { id: null, name: 'No Group' }
  ]

  return (
    <>
      <h2 id="gp-title" className="gp-title">
        Move “{project.name}” to
      </h2>

      {groups.length > 0 && (
        <div className="gp-list">
          {rows.map((row) => (
            <button
              key={row.id ?? ''}
              className={clsx('gp-row', row.id === current && 'is-current')}
              aria-pressed={row.id === current}
              onClick={() => pick(row.id)}
            >
              {row.id ? <Folders size={15} /> : <FolderMinus size={15} />}
              <span className="gp-row-name">{row.name}</span>
              {row.id === current && <Check size={15} strokeWidth={2.4} className="gp-check" />}
            </button>
          ))}
        </div>
      )}

      <form className="gp-new" onSubmit={create}>
        <input
          className="gp-input"
          value={name}
          placeholder="New group name"
          spellCheck={false}
          aria-label="New group name"
          autoFocus={groups.length === 0}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={!name.trim()}>
          Create
        </button>
      </form>
    </>
  )
}
