import { memo, useContext, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useStore, type Node, type NodeProps } from '@xyflow/react'
import clsx from 'clsx'
import { Sparkles } from 'lucide-react'
import type { BoardSection } from '@shared/types'
import { FOLDER_HUES } from '../FolderIcon'
import { RenamingContext, SectionHotContext, SectionNamingContext, useBoardActions } from './BoardContext'
import { CARD_H, CARD_W } from './layout'
import { SECTION_HEADER_H, SECTION_PAD } from './sections'

export type SectionNodeData = {
  section: BoardSection
  count: number
  /** Shown as a status dot so a section reads at a glance when zoomed out. */
  status?: 'working' | 'waiting'
}
export type SectionFlowNode = Node<SectionNodeData, 'section'>

const STATUS_LABEL = {
  working: 'A session in this section is working',
  waiting: 'A session in this section needs you'
} as const

/** Keeps the label legible when zoomed out, like the archive's. */
const labelScale = (zoom: number) => Math.min(2.2, Math.max(1, 1 / zoom))

function SectionNodeComponent({ id, data, dragging }: NodeProps<SectionFlowNode>) {
  const hot = useContext(SectionHotContext) === id
  const renaming = useContext(RenamingContext) === id
  /** null while Claude names the section, then the name it gave while that lands. */
  const naming = useContext(SectionNamingContext).get(id)
  const scale = useStore((s) => labelScale(s.transform[2]))
  const { section, count, status } = data

  return (
    <div
      className={clsx('section-zone', hot && 'is-hot', dragging && 'is-dragging')}
      style={{ '--section-hue': FOLDER_HUES[section.color].backBottom } as CSSProperties}
    >
      {naming !== undefined && (
        <div className={clsx('section-glow', naming !== null && 'is-fading')} aria-hidden>
          <div className="section-glow-halo">
            <div className="section-glow-ring" />
          </div>
          <div className="section-glow-ring" />
        </div>
      )}
      <div className="section-header" title="Drag to move the section and its cards">
        {/* Scaled up when zoomed out, so its max width shrinks to still fit the header. */}
        <div
          className="section-label"
          style={{ transform: `scale(${scale})`, maxWidth: `${100 / scale}%` }}
        >
          {renaming ? (
            <NameEditor sectionId={id} initial={section.name} />
          ) : naming === null ? (
            <span className="section-name is-naming" title="Claude is naming this section">
              <Sparkles className="section-sparkle" size={13} strokeWidth={2} aria-hidden />
              <span className="section-naming-text">Naming…</span>
            </span>
          ) : naming ? (
            <RevealName name={naming} />
          ) : (
            <span className={clsx('section-name', !section.name && 'is-untitled')}>
              {section.name || 'Untitled section'}
            </span>
          )}
          <span className="section-count">{count}</span>
          {status && <span className="status-dot" data-status={status} title={STATUS_LABEL[status]} />}
        </div>
      </div>

      {count === 0 && (
        <div
          className="section-placeholder"
          style={{ left: SECTION_PAD, top: SECTION_HEADER_H, width: CARD_W, height: CARD_H }}
        >
          Drag cards here
        </div>
      )}
    </div>
  )
}

/** Delay between the letters of a name Claude gave, capped so long names still land quickly. */
const REVEAL_STEP_MS = 28
const REVEAL_SPREAD_MS = 480

/** A name from Claude, fading in letter by letter. */
function RevealName({ name }: { name: string }) {
  const letters = Array.from(name)
  const step = Math.min(REVEAL_STEP_MS, REVEAL_SPREAD_MS / Math.max(1, letters.length - 1))
  return (
    <span className="section-name is-revealing" aria-label={name}>
      {letters.map((ch, i) => (
        <span key={i} aria-hidden style={{ animationDelay: `${Math.round(i * step)}ms` }}>
          {ch}
        </span>
      ))}
    </span>
  )
}

function NameEditor({ sectionId, initial }: { sectionId: string; initial: string }) {
  const { renameSection, setRenaming } = useBoardActions()
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const commit = () => {
    if (done.current) return
    done.current = true
    if (value.trim() !== initial) renameSection(sectionId, value.trim())
    setRenaming(null)
  }

  return (
    <input
      ref={ref}
      className="section-name-input nodrag nopan"
      value={value}
      placeholder="Section name"
      size={Math.max(14, value.length + 1)}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') {
          done.current = true
          setRenaming(null)
        }
      }}
    />
  )
}

export const SectionNode = memo(SectionNodeComponent)
