import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from 'react'
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type NodeChange,
  type OnMove,
  type OnNodeDrag,
  type OnSelectionChangeFunc
} from '@xyflow/react'
import {
  Archive,
  ArchiveRestore,
  Eye,
  Group,
  Loader2,
  Maximize,
  PencilLine,
  Plus,
  Sparkles,
  SquareDashed,
  SquareTerminal,
  Square,
  Trash2,
  BoxSelect,
  Ungroup
} from 'lucide-react'
import clsx from 'clsx'
import type {
  BoardSection,
  BoardSnapshot,
  NodePatch,
  Rect,
  SessionCard,
  SessionKind
} from '@shared/types'
import { cardTitle, isTerminal, useApp } from '@renderer/store'
import { ContextMenu, type MenuItem } from '@renderer/components/ContextMenu'
import { ColorSwatches } from '@renderer/components/ColorSwatches'
import { FOLDER_COLORS, FOLDER_HUES } from '@renderer/components/FolderIcon'
import { TitleBarActions } from '@renderer/components/TitleBarActions'
import {
  ArchiveHotContext,
  ArchiveStackContext,
  BoardActionsContext,
  RenamingContext,
  SectionHotContext,
  type ArchiveStack,
  type BoardActions
} from '@renderer/components/board/BoardContext'
import {
  SectionNode,
  type SectionFlowNode
} from '@renderer/components/board/SectionNode'
import {
  SECTION_HEADER_H,
  SECTION_PAD,
  buildSectionNodes,
  frameAround,
  layoutGroup,
  sectionAt,
  sectionViews,
  spotInSection,
  type SectionView
} from '@renderer/components/board/sections'
import {
  SessionCardNode,
  type SessionFlowNode
} from '@renderer/components/board/SessionCardNode'
import { LineageEdge } from '@renderer/components/board/LineageEdge'
import {
  ArchiveZoneNode,
  type ArchiveFlowNode
} from '@renderer/components/board/ArchiveZoneNode'
import { SelectionBar } from '@renderer/components/board/SelectionBar'
import { BoardControls } from '@renderer/components/board/BoardControls'
import { ConfirmDialog, type ConfirmRequest } from '@renderer/components/board/ConfirmDialog'
import {
  MergeDialog,
  type MergeSource,
  type MergeStartOptions
} from '@renderer/components/board/MergeDialog'
import {
  ARCHIVE_ID,
  CARD_H,
  CARD_W,
  GAP,
  STACK_DEPTH,
  STACK_ROWS,
  cardObstacles,
  cardRect,
  containsPoint,
  findFreeSpot,
  intersects,
  isInArchive,
  spotForNewSession,
  spotRightOfArchive,
  stackRank,
  stackResultSpot,
  stackResultsBand,
  stackScrollMax,
  stackTop,
  stackZone,
  type Point
} from '@renderer/components/board/layout'
import { fuzzyMatch } from '@renderer/components/board/fuzzy'
import '@renderer/components/board/board.css'

type FlowNode = SessionFlowNode | ArchiveFlowNode | SectionFlowNode

const nodeTypes = { session: SessionCardNode, archive: ArchiveZoneNode, section: SectionNode }
const edgeTypes = { lineage: LineageEdge }

/** Home view when nothing is active: room right of the archive for new cards… */
const HOME_FREE_SPACE = 760
/** …and roughly the three most recent archive rows. */
const HOME_ARCHIVE_ROWS_H = 64 + 3 * 240

/** How long a card keeps flying after the stack deals it out or takes it back. */
const FLIGHT_MS = 700
/** Z-order of the open archive panel, above every card on the board. */
const RAISED_Z = 1500
/** How far a result cut off at the panel's edge still shows its shadow past the cut. */
const CLIP_BLEED = 24

const STATUS_COLOR = {
  working: 'var(--status-working)',
  waiting: 'var(--status-waiting)',
  done: 'var(--status-done)'
} as const

const sectionHue = (n: FlowNode) => FOLDER_HUES[(n as SectionFlowNode).data.section.color].backBottom

export function BoardView({ projectId }: { projectId: string }) {
  const board = useApp((s) => s.board)
  const loading = useApp((s) => s.boardLoading)

  if (!board || board.project.id !== projectId) {
    return (
      <div className="board-loading" aria-busy="true">
        {loading && <Loader2 size={20} className="spin" />}
      </div>
    )
  }

  return (
    <ReactFlowProvider>
      <BoardCanvas projectId={projectId} board={board} />
    </ReactFlowProvider>
  )
}

const sameCard = (a: SessionCard, b: SessionCard) => a === b || JSON.stringify(a) === JSON.stringify(b)
const sameList = (a?: number[], b?: number[]) => a === b || (a?.join() ?? '') === (b?.join() ?? '')

/** The archive stack as laid out for one render. */
interface StackView {
  /** Cards fanned out of the stack: their slot and the title characters the search matched. */
  results: Map<string, { slot: number; match?: number[] }>
  /** Archived cards left in the stack, top first. */
  pile: string[]
  open: boolean
  /** The panel floats above the board (while open, and while closing). */
  raised: boolean
  /** The stack (or the open panel) as drawn. */
  zone: Rect
  /** How far the results are scrolled up, and whether there are more than fit. */
  scroll: number
  scrollable: boolean
}

/**
 * A card mid-animation. `sink`: keep drawing a card that has gone under the
 * stack until it lands. `rise`: a card that was hidden in the stack plays its
 * fly-out from the stack top.
 */
interface Flight {
  kind: 'sink' | 'rise'
  until: number
  from?: Point
}

/**
 * Derives React Flow nodes from the board snapshot while preserving local
 * React Flow state (selection, measurements) and the live position of any node
 * that is mid-drag. Archived cards are placed by the stack, not their stored
 * positions.
 */
function buildNodes(
  board: BoardSnapshot,
  prev: FlowNode[],
  busy: Set<string>,
  archiveBusy: boolean,
  stack: StackView,
  flights: Map<string, Flight>,
  now: number
): FlowNode[] {
  const prevById = new Map(prev.map((n) => [n.id, n]))
  const archivedCount = board.cards.filter((c) => c.archived).length
  const flying = (id: string, kind: Flight['kind']) => {
    const f = flights.get(id)
    if (f?.kind === kind && f.until <= now) flights.delete(id)
    return f?.kind === kind && f.until > now
  }

  const pa = prevById.get(ARCHIVE_ID) as ArchiveFlowNode | undefined
  const keepArchive = pa && (archiveBusy || pa.dragging)
  const zone = stack.zone
  const archiveNode: ArchiveFlowNode = {
    ...pa,
    id: ARCHIVE_ID,
    type: 'archive',
    position: keepArchive ? pa.position : { x: zone.x, y: zone.y },
    width: zone.w,
    height: zone.h,
    // nowheel: scrolling over a panel with more results than fit scrolls them, not the board.
    className: clsx(stack.open && 'is-open', stack.scrollable && 'nowheel') || undefined,
    data: pa && pa.data.count === archivedCount ? pa.data : { count: archivedCount },
    zIndex: stack.raised ? RAISED_Z : -1,
    selectable: false,
    focusable: false,
    deletable: false,
    dragHandle: '.archive-header'
  }

  const top = stackTop(board.archive)
  const band = stackResultsBand(board.archive)
  const depthOf = new Map(stack.pile.map((id, i) => [id, i]))
  const base = stack.raised ? RAISED_Z : 0

  const sessionNodes = board.cards.map((card): SessionFlowNode => {
    const id = card.sessionId
    const p = prevById.get(id) as SessionFlowNode | undefined
    const folded = card.archived
    const result = folded ? stack.results.get(id) : undefined
    const depth = depthOf.get(id) ?? 0
    const held = Boolean(p && (p.dragging || busy.has(id)))

    let position = { x: card.x, y: card.y }
    if (result) position = stackResultSpot(board.archive, result.slot, stack.scroll)
    else if (folded) position = top
    if (held) position = p!.position

    // Results scroll through the panel's band: ones past it aren't drawn, and
    // ones across its edges are cut off there (their shadow still shows).
    let offscreen = false
    let clipPath: string | undefined
    if (result && !held) {
      const cutTop = band.top - position.y
      const cutBottom = position.y + CARD_H - band.bottom
      if (cutTop >= CARD_H || cutBottom >= CARD_H) offscreen = true
      else if (cutTop > 0 || cutBottom > 0) {
        const edge = (cut: number) => `${Math.max(cut, -CLIP_BLEED)}px`
        clipPath = `inset(${edge(cutTop)} ${-CLIP_BLEED}px ${edge(cutBottom)})`
      }
    }

    // Cards deep in the stack aren't drawn, except while they sink into it.
    let hidden = false
    if (folded && !result && depth >= STACK_DEPTH) {
      if (flights.get(id)?.kind === 'sink') hidden = !flying(id, 'sink')
      else if (p && !p.hidden) flights.set(id, { kind: 'sink', until: now + FLIGHT_MS })
      else hidden = true
    } else {
      if (flights.get(id)?.kind === 'sink') flights.delete(id)
      hidden = offscreen
      // A card leaving the depths of the stack flies out of it; one scrolling into view doesn't.
      if (p?.hidden && !offscreen && !p.className?.includes('is-result')) {
        flights.set(id, {
          kind: 'rise',
          until: now + FLIGHT_MS,
          from: { x: top.x - position.x, y: top.y - position.y }
        })
      }
    }
    const rise = flying(id, 'rise') ? flights.get(id)!.from! : null

    const className =
      clsx(
        folded && 'stack-card',
        result ? 'is-result' : folded && `stack-d${Math.min(depth, STACK_DEPTH)}`,
        result && stack.scrollable && 'nowheel',
        rise && 'stack-enter'
      ) || undefined
    const style: CSSProperties | undefined =
      result || rise
        ? ({
            // Stagger the deal-out across the first rows only; later ones start out of sight.
            '--stack-i': Math.min(result?.slot ?? 0, 2 * STACK_ROWS),
            '--fly-x': `${rise?.x ?? 0}px`,
            '--fly-y': `${rise?.y ?? 0}px`,
            clipPath
          } as CSSProperties)
        : undefined
    const zIndex = !folded ? undefined : result ? base + 10 : base + Math.max(0, STACK_DEPTH - depth)
    // Only the top card and the fanned-out results can be grabbed.
    const draggable = folded ? Boolean(result) || depth === 0 : undefined
    const selectable = folded ? Boolean(result) : undefined

    if (!p) {
      return {
        id,
        type: 'session',
        position,
        width: CARD_W,
        height: CARD_H,
        deletable: false,
        hidden,
        className,
        style,
        zIndex,
        draggable,
        selectable,
        data: { card, match: result?.match }
      }
    }
    const dataSame = sameCard(p.data.card, card) && sameList(p.data.match, result?.match)
    const selected = selectable === false ? false : p.selected
    if (
      dataSame &&
      position.x === p.position.x &&
      position.y === p.position.y &&
      hidden === Boolean(p.hidden) &&
      className === p.className &&
      JSON.stringify(style) === JSON.stringify(p.style) &&
      zIndex === p.zIndex &&
      draggable === p.draggable &&
      selectable === p.selectable &&
      selected === p.selected
    ) {
      return p
    }
    return {
      ...p,
      position,
      hidden,
      className,
      style,
      zIndex,
      draggable,
      selectable,
      selected,
      data: dataSame ? p.data : { card, match: result?.match }
    }
  })

  const sectionNodes = buildSectionNodes(sectionViews(board.sections, board.cards), prevById, busy)
  return [archiveNode, ...sectionNodes, ...sessionNodes]
}

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

function BoardCanvas({ projectId, board }: { projectId: string; board: BoardSnapshot }) {
  const rf = useReactFlow<FlowNode, Edge>()
  const patchCards = useApp((s) => s.patchCards)
  const upsertCard = useApp((s) => s.upsertCard)
  const removeCard = useApp((s) => s.removeCard)
  const setArchive = useApp((s) => s.setArchive)
  const saveSection = useApp((s) => s.saveSection)
  const removeSection = useApp((s) => s.removeSection)
  const setSelection = useApp((s) => s.setSelection)
  const openTerminal = useApp((s) => s.openTerminal)
  const openPreview = useApp((s) => s.openPreview)
  const selection = useApp((s) => s.selection)

  const { cards, archive, sections } = board
  const cardsRef = useRef(cards)
  cardsRef.current = cards
  const archiveRef = useRef(archive)
  archiveRef.current = archive
  /** Sections with their frames and cards. */
  const groups = useMemo(() => sectionViews(sections, cards), [sections, cards])
  const groupsRef = useRef(groups)
  groupsRef.current = groups

  // Nodes that must keep their local position while the store changes underneath.
  const busy = useRef(new Set<string>())
  const dragStart = useRef(new Map<string, Point>())
  const archiveBusy = useRef(false)
  const lastArchivePos = useRef<Point | null>(null)
  /** The section being dragged by its header, and the cards travelling with it. */
  const sectionDrag = useRef<{ id: string; last: Point; members: Set<string> } | null>(null)
  const titleClickTimer = useRef<number | undefined>(undefined)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const [renaming, setRenaming] = useState<string | null>(null)
  const [archiveHot, setArchiveHot] = useState(false)
  const [hotSection, setHotSection] = useState<string | null>(null)
  const [movingSection, setMovingSection] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)
  const [merge, setMerge] = useState<MergeSource[] | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const closeMenu = useCallback(() => setMenu(null), [])
  const overlayOpen = Boolean(menu || confirmReq || merge)
  const overlayOpenRef = useRef(overlayOpen)
  overlayOpenRef.current = overlayOpen

  // ---- archive stack ---------------------------------------------------------
  // The archive is one stack of cards. Its search fans the matching cards (all
  // of them, before anything is typed) out into a panel that scrolls when they
  // don't fit; they're the regular board nodes, so preview, drag-out and merge
  // keep working.

  const archivedSorted = useMemo(
    () => cards.filter((c) => c.archived).sort((a, b) => stackRank(b) - stackRank(a)),
    [cards]
  )
  const [stackOpenState, setStackOpen] = useState(false)
  const [stackQuery, setStackQuery] = useState('')
  const [stackHover, setStackHover] = useState(false)
  // Escape or a click away dismisses the search until the pointer leaves the stack.
  const [stackDismissed, setStackDismissed] = useState(false)
  const [stackRaised, setStackRaised] = useState(false)
  const [movingArchive, setMovingArchive] = useState(false)
  const [stackScrollState, setStackScroll] = useState(0)
  // While the results scroll, they follow the wheel directly instead of gliding.
  const [stackScrolling, setStackScrolling] = useState(false)
  const stackScrollTimer = useRef<number | undefined>(undefined)
  const stackOpen = stackOpenState && archivedSorted.length > 0

  const stackResults = useMemo(() => {
    if (!stackOpen) return []
    const q = stackQuery.trim()
    if (!q) return archivedSorted.map((c) => ({ id: c.sessionId, match: undefined }))
    const hits = archivedSorted
      .map((c, rank) => ({ id: c.sessionId, rank, m: fuzzyMatch(q, cardTitle(c)) }))
      .filter((r): r is { id: string; rank: number; m: NonNullable<typeof r.m> } => r.m !== null)
      .sort((a, b) => b.m.score - a.m.score || a.rank - b.rank)
    // Drop letters scattered across a title when there are much better matches.
    const floor = hits.length > 0 ? hits[0].m.score * 0.5 : 0
    return hits
      .filter((r) => r.m.score >= floor)
      .map((r) => ({ id: r.id, match: r.m.indices }))
  }, [stackOpen, stackQuery, archivedSorted])
  const stackResultsRef = useRef(stackResults)
  stackResultsRef.current = stackResults
  const scrollMax = stackScrollMax(stackResults.length)
  const stackScroll = Math.min(stackScrollState, scrollMax)

  /** The archive as drawn: the stack, or its open panel. */
  const zone = useMemo(
    () => stackZone(archive, stackOpen ? stackResults.length : undefined),
    [archive, stackOpen, stackResults.length]
  )
  const zoneRef = useRef(zone)
  zoneRef.current = zone

  const stackView = useMemo<StackView>(() => {
    const results = new Map(stackResults.map((r, slot) => [r.id, { slot, match: r.match }]))
    return {
      results,
      pile: archivedSorted.filter((c) => !results.has(c.sessionId)).map((c) => c.sessionId),
      open: stackOpen,
      raised: stackOpen || stackRaised,
      zone,
      scroll: stackScroll,
      scrollable: scrollMax > 0
    }
  }, [stackResults, archivedSorted, stackOpen, stackRaised, zone, stackScroll, scrollMax])
  const stackViewRef = useRef(stackView)
  stackViewRef.current = stackView

  // The panel stays above the board until the cards have flown back in.
  useEffect(() => {
    if (stackOpen) {
      setStackRaised(true)
      return
    }
    const t = window.setTimeout(() => setStackRaised(false), FLIGHT_MS)
    return () => window.clearTimeout(t)
  }, [stackOpen])

  const openStack = useCallback(() => {
    setStackDismissed(false)
    setStackOpen(true)
  }, [])
  const closeStack = useCallback(() => {
    setStackOpen(false)
    setStackQuery('')
    setStackScroll(0)
    setStackDismissed(true)
  }, [])

  const stackCtx = useMemo<ArchiveStack>(
    () => ({
      open: stackOpen,
      hover: stackHover && !stackDismissed,
      query: stackQuery,
      resultCount: stackResults.length,
      scroll: stackScroll,
      scrollMax,
      setQuery: (q) => {
        setStackQuery(q)
        setStackScroll(0)
        if (q.trim()) setStackOpen(true)
      },
      openStack,
      closeStack,
      submit: () => {
        const first = stackResultsRef.current[0]
        if (!first) return
        // Leave the field first so Escape closes the preview, not the panel.
        ;(document.activeElement as HTMLElement | null)?.blur()
        openPreview(first.id)
      }
    }),
    [
      stackOpen,
      stackHover,
      stackDismissed,
      stackQuery,
      stackResults.length,
      stackScroll,
      scrollMax,
      openStack,
      closeStack,
      openPreview
    ]
  )

  const onCanvasPointerMove = (e: ReactPointerEvent) => {
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const over = e.buttons === 0 && containsPoint(zoneRef.current, p)
    setStackHover(over)
    if (!over) setStackDismissed(false)
  }

  // Scrolling over the open panel scrolls its results. The panel and its cards
  // carry `nowheel` while there's anything to scroll, so the board stays put.
  const onCanvasWheel = (e: ReactWheelEvent) => {
    if (!stackOpen || scrollMax === 0 || e.ctrlKey) return
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    if (!containsPoint(zoneRef.current, p)) return
    const lines = e.deltaMode === 1 ? 16 : 1
    const dy = (e.deltaY * lines) / rf.getViewport().zoom
    setStackScroll((s) => Math.min(scrollMax, Math.max(0, Math.min(s, scrollMax) + dy)))
    setStackScrolling(true)
    window.clearTimeout(stackScrollTimer.current)
    stackScrollTimer.current = window.setTimeout(() => setStackScrolling(false), 160)
  }
  useEffect(() => () => window.clearTimeout(stackScrollTimer.current), [])

  // Clicking anywhere else on the board folds the results back into the stack.
  useEffect(() => {
    if (!stackOpen) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (!t || !wrapperRef.current?.contains(t)) return
      if (t.closest('.react-flow__node-archive, .react-flow__node.stack-card')) return
      closeStack()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [stackOpen, closeStack])

  // Cards animating into or out of the stack, and a timer to re-lay out once they land.
  const flights = useRef(new Map<string, Flight>())
  const [flightTick, setFlightTick] = useState(0)

  const [nodes, setNodes] = useState<FlowNode[]>(() =>
    buildNodes(board, [], busy.current, false, stackView, flights.current, performance.now())
  )
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  useEffect(() => {
    setNodes((prev) =>
      buildNodes(
        board,
        prev,
        busy.current,
        archiveBusy.current,
        stackView,
        flights.current,
        performance.now()
      )
    )
  }, [board, stackView, flightTick])

  // A section's corner follows its cards, so one that empties stays where it was.
  useEffect(() => {
    for (const { section, frame, members } of groups) {
      if (members.length > 0 && (section.x !== frame.x || section.y !== frame.y)) {
        saveSection({ ...section, x: frame.x, y: frame.y })
      }
    }
  }, [groups, saveSection])

  useEffect(() => {
    let next = Infinity
    for (const f of flights.current.values()) next = Math.min(next, f.until)
    if (next === Infinity) return
    const t = window.setTimeout(() => setFlightTick((n) => n + 1), Math.max(0, next - performance.now()) + 20)
    return () => window.clearTimeout(t)
  }, [nodes])

  const edges = useMemo<Edge[]>(() => {
    // Archived cards sit in a pile, so they draw no lineage.
    const ids = new Set(cards.filter((c) => !c.archived).map((c) => c.sessionId))
    return cards.flatMap((child) =>
      (ids.has(child.sessionId) ? (child.parents ?? []) : [])
        .filter((pid) => ids.has(pid))
        .map((pid) => ({
          id: `${pid}->${child.sessionId}`,
          type: 'lineage',
          source: pid,
          target: child.sessionId,
          animated: child.status === 'working',
          selectable: false,
          focusable: false,
          className: 'lineage-edge'
        }))
    )
  }, [cards])

  // ---- helpers -------------------------------------------------------------

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), 4200)
  }, [])

  const confirm = useCallback(
    (req: Omit<ConfirmRequest, 'resolve'>) =>
      new Promise<boolean>((resolve) => {
        setConfirmReq({
          ...req,
          resolve: (ok) => {
            setConfirmReq(null)
            resolve(ok)
          }
        })
      }),
    []
  )

  const confirmStopRunning = useCallback(
    (running: SessionCard[]) =>
      confirm({
        title:
          running.length === 1
            ? 'Archive a running session?'
            : `Archive ${running.length} running sessions?`,
        message:
          running.length === 1
            ? `“${cardTitle(running[0])}” is still ${running[0].status === 'waiting' ? 'waiting for you' : 'working'}. The Claude process will be stopped.`
            : 'Some of these sessions are still working. Their Claude processes will be stopped.',
        confirmLabel: 'Stop & Archive',
        danger: true
      }),
    [confirm]
  )

  const selectedIds = () =>
    nodesRef.current.filter((n) => n.type === 'session' && n.selected).map((n) => n.id)

  const clearSelection = useCallback(() => {
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)))
    setSelection([])
  }, [setSelection])

  const selectAllActive = useCallback(() => {
    setNodes((nds) =>
      nds.map((n) =>
        n.type === 'session' ? { ...n, selected: !(n as SessionFlowNode).data.card.archived } : n
      )
    )
  }, [])

  /** Pans so a newly placed card is on screen (keeps the current zoom). */
  const ensureVisible = useCallback(
    (p: Point) => {
      const el = wrapperRef.current
      if (!el) return
      const { x, y, zoom } = rf.getViewport()
      const left = -x / zoom
      const top = -y / zoom
      const view = { x: left, y: top, w: el.clientWidth / zoom, h: el.clientHeight / zoom }
      const inside =
        p.x >= view.x && p.y >= view.y && p.x + CARD_W <= view.x + view.w && p.y + CARD_H <= view.y + view.h
      if (!inside) rf.setCenter(p.x + CARD_W / 2, p.y + CARD_H / 2, { zoom, duration: 320 })
    },
    [rf]
  )

  const openCard = useCallback(
    (sessionId: string) => {
      const card = cardsRef.current.find((c) => c.sessionId === sessionId)
      if (!card) return
      if (card.archived) openPreview(sessionId)
      else openTerminal(sessionId)
    },
    [openPreview, openTerminal]
  )

  const createSession = useCallback(
    async (at?: Point, kind: SessionKind = 'claude', sectionId?: string) => {
      const all = cardsRef.current
      const zone = zoneRef.current
      const spot = at
        ? findFreeSpot(at, cardObstacles(all), zone)
        : spotForNewSession(zone, all)
      const pos = { x: Math.round(spot.x), y: Math.round(spot.y) }
      // A card started inside a section's frame joins it.
      const joins = sectionId ?? sectionAt(pos, groupsRef.current)
      try {
        const card = await window.api.sessions.create(projectId, { ...pos, kind })
        upsertCard(card)
        if (joins) patchCards([{ sessionId: card.sessionId, sectionId: joins }])
        ensureVisible(pos)
        openTerminal(card.sessionId)
      } catch (err) {
        const what = kind === 'terminal' ? 'a terminal' : 'a session'
        showToast(`Couldn't start ${what}: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [projectId, upsertCard, patchCards, openTerminal, ensureVisible, showToast]
  )

  const createTerminal = useCallback((at?: Point) => createSession(at, 'terminal'), [createSession])

  const archiveCards = useCallback(
    async (ids: string[]) => {
      const all = cardsRef.current
      // Terminals are never archived; they are removed from the board instead.
      const targets = all.filter((c) => ids.includes(c.sessionId) && !c.archived && !isTerminal(c))
      if (targets.length === 0) return
      const running = targets.filter((c) => c.live && c.status !== 'done')
      if (running.length > 0 && !(await confirmStopRunning(running))) return
      const moving = new Set(targets.map((t) => t.sessionId))
      // Archived cards are drawn by the stack; store them at its top.
      const top = stackTop(archiveRef.current)
      patchCards(targets.map((c) => ({ sessionId: c.sessionId, ...top, archived: true })))
      setNodes((nds) => nds.map((n) => (moving.has(n.id) && n.selected ? { ...n, selected: false } : n)))
    },
    [confirmStopRunning, patchCards]
  )

  const restoreCard = useCallback(
    (sessionId: string) => {
      const spot = spotRightOfArchive(zoneRef.current, cardsRef.current, new Set([sessionId]))
      patchCards([
        { sessionId, x: Math.round(spot.x), y: Math.round(spot.y), archived: false }
      ])
      ensureVisible(spot)
    },
    [patchCards, ensureVisible]
  )

  // ---- sections --------------------------------------------------------------

  /** Saves a new, untitled section at `corner` and starts naming it. */
  const addSection = useCallback(
    (corner: Point): BoardSection => {
      const used = new Set(groupsRef.current.map((g) => g.section.color))
      const section: BoardSection = {
        id: crypto.randomUUID(),
        name: '',
        color: FOLDER_COLORS.find((c) => !used.has(c)) ?? FOLDER_COLORS[used.size % FOLDER_COLORS.length],
        x: Math.round(corner.x),
        y: Math.round(corner.y),
        createdAt: Date.now()
      }
      saveSection(section)
      setRenaming(section.id)
      return section
    },
    [saveSection]
  )

  /** Groups the active cards among `ids` under a new section. */
  const groupCards = useCallback(
    (ids: string[]) => {
      const all = cardsRef.current
      const targets = all.filter((c) => ids.includes(c.sessionId) && !c.archived)
      if (targets.length === 0) return
      const moving = new Set(targets.map((c) => c.sessionId))
      const rest = all.filter((c) => !moving.has(c.sessionId))
      // Other sections as they will be once these cards have left them.
      const frames = sectionViews(groupsRef.current.map((g) => g.section), rest).map((g) => g.frame)
      const { frame, positions } = layoutGroup(
        targets,
        cardObstacles(rest.filter((c) => !c.archived)),
        [zoneRef.current, ...frames]
      )
      const section = addSection(frame)
      patchCards(
        targets.map((c) => ({ sessionId: c.sessionId, sectionId: section.id, ...positions.get(c.sessionId) }))
      )
      clearSelection()
      ensureVisible(frame)
    },
    [addSection, patchCards, clearSelection, ensureVisible]
  )

  /** An empty section with its header at `p`, nudged clear of cards and other zones. */
  const createSectionAt = useCallback(
    (p: Point) => {
      const empty = frameAround(p, [])
      const obstacles = [
        ...cardObstacles(cardsRef.current.filter((c) => !c.archived)),
        zoneRef.current,
        ...groupsRef.current.map((g) => g.frame)
      ]
      addSection(
        findFreeSpot({ x: p.x - SECTION_PAD, y: p.y - SECTION_HEADER_H / 2 }, obstacles, undefined, empty)
      )
    },
    [addSection]
  )

  /** Takes a card out of its section, moving it clear of the frame. */
  const leaveSection = useCallback(
    (sessionId: string) => {
      const card = cardsRef.current.find((c) => c.sessionId === sessionId)
      const group = groupsRef.current.find((g) => g.section.id === card?.sectionId)
      if (!card || !group) return
      const obstacles = [
        ...cardObstacles(cardsRef.current.filter((c) => !c.archived), new Set([sessionId])),
        zoneRef.current,
        ...groupsRef.current.filter((g) => g !== group).map((g) => g.frame)
      ]
      const spot = findFreeSpot({ x: group.frame.x + group.frame.w + GAP, y: card.y }, obstacles, group.frame)
      patchCards([{ sessionId, x: Math.round(spot.x), y: Math.round(spot.y), sectionId: null }])
      ensureVisible(spot)
    },
    [patchCards, ensureVisible]
  )

  const selectCards = useCallback((ids: Set<string>) => {
    setNodes((nds) => nds.map((n) => (n.type === 'session' ? { ...n, selected: ids.has(n.id) } : n)))
  }, [])

  const startMerge = useCallback((ids: string[]) => {
    const byId = new Map(cardsRef.current.map((c) => [c.sessionId, c]))
    const sources = ids
      .map((id) => byId.get(id))
      .filter((c): c is SessionCard => Boolean(c) && !isTerminal(c))
      .map((c) => ({ sessionId: c.sessionId, title: cardTitle(c) }))
    if (sources.length > 0) setMerge(sources)
  }, [])

  const onMergeStart = useCallback(
    async ({ name, initialPrompt, parents }: MergeStartOptions) => {
      const all = cardsRef.current
      const zone = zoneRef.current
      const sourceIds = new Set((merge ?? []).map((s) => s.sessionId))
      const sourceCards = all.filter((c) => sourceIds.has(c.sessionId))
      // The merged card sits centered below its parents so lineage edges fan in.
      let preferred: Point =
        sourceCards.length > 0
          ? {
              x: sourceCards.reduce((sum, c) => sum + c.x, 0) / sourceCards.length,
              y: Math.max(...sourceCards.map((c) => c.y)) + CARD_H + 96
            }
          : spotForNewSession(zone, all)
      // Merged sessions are active: never start them inside the archive.
      if (intersects(cardRect(preferred), zone, GAP)) {
        preferred = {
          x: zone.x + zone.w + 80,
          y: Math.min(Math.max(preferred.y, zone.y), zone.y + zone.h - CARD_H)
        }
      }
      const spot = findFreeSpot(preferred, cardObstacles(all), zone)
      const pos = { x: Math.round(spot.x), y: Math.round(spot.y) }

      const card = await window.api.sessions.create(projectId, {
        ...pos,
        name,
        initialPrompt,
        parents
      })
      upsertCard(card)
      setMerge(null)
      clearSelection()
      ensureVisible(pos)
      openTerminal(card.sessionId)
    },
    [merge, projectId, upsertCard, clearSelection, ensureVisible, openTerminal]
  )

  const actions = useMemo<BoardActions>(
    () => ({
      rename: (sessionId, title) => patchCards([{ sessionId, title }]),
      setRenaming,
      renameSection: (sectionId, name) => {
        const section = groupsRef.current.find((g) => g.section.id === sectionId)?.section
        if (section) saveSection({ ...section, name })
      }
    }),
    [patchCards, saveSection]
  )

  // ---- React Flow handlers -------------------------------------------------

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const relevant = changes.filter((c) => c.type !== 'remove')
    setNodes((nds) => applyNodeChanges(relevant, nds))
  }, [])

  const onNodeDragStart: OnNodeDrag<FlowNode> = useCallback((_e, node, dragged) => {
    setMenu(null)
    window.clearTimeout(titleClickTimer.current)
    if (node.id === ARCHIVE_ID) {
      archiveBusy.current = true
      setMovingArchive(true)
      lastArchivePos.current = { ...node.position }
      for (const c of cardsRef.current) if (c.archived) busy.current.add(c.sessionId)
      return
    }
    if (node.type === 'section') {
      const members = groupsRef.current.find((g) => g.section.id === node.id)?.members ?? []
      sectionDrag.current = {
        id: node.id,
        last: { ...node.position },
        members: new Set(members.map((c) => c.sessionId))
      }
      busy.current.add(node.id)
      for (const c of members) busy.current.add(c.sessionId)
      setMovingSection(true)
      return
    }
    dragStart.current.clear()
    for (const n of dragged) {
      if (n.type !== 'session') continue
      busy.current.add(n.id)
      dragStart.current.set(n.id, { ...n.position })
    }
  }, [])

  const onNodeDrag: OnNodeDrag<FlowNode> = useCallback((_e, node, dragged) => {
    if (node.id === ARCHIVE_ID) {
      const last = lastArchivePos.current
      if (!last) return
      const dx = node.position.x - last.x
      const dy = node.position.y - last.y
      if (dx === 0 && dy === 0) return
      lastArchivePos.current = { ...node.position }
      // Archived cards travel with the archive, like objects inside a frame.
      setNodes((nds) =>
        nds.map((n) =>
          n.type === 'session' && (n as SessionFlowNode).data.card.archived
            ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
            : n
        )
      )
      return
    }
    if (node.type === 'section') {
      const drag = sectionDrag.current
      if (!drag) return
      const dx = node.position.x - drag.last.x
      const dy = node.position.y - drag.last.y
      if (dx === 0 && dy === 0) return
      drag.last = { ...node.position }
      // Its cards travel with the section.
      setNodes((nds) =>
        nds.map((n) =>
          drag.members.has(n.id)
            ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
            : n
        )
      )
      return
    }
    const zone = zoneRef.current
    const overArchive = dragged.some(
      (n) =>
        n.type === 'session' &&
        !isTerminal((n as SessionFlowNode).data.card) &&
        isInArchive(n.position, zone)
    )
    setArchiveHot(overArchive)
    const card = (node as SessionFlowNode).data.card
    setHotSection(overArchive ? null : sectionAt(node.position, groupsRef.current, card.sectionId))
  }, [])

  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback(
    async (_e, node, dragged) => {
      setArchiveHot(false)
      setHotSection(null)

      if (node.type === 'section') {
        const drag = sectionDrag.current
        sectionDrag.current = null
        setMovingSection(false)
        const group = groupsRef.current.find((g) => g.section.id === node.id)
        if (group) {
          const dx = Math.round(node.position.x - group.frame.x)
          const dy = Math.round(node.position.y - group.frame.y)
          const landed: SectionView = { ...group, frame: { ...group.frame, x: group.frame.x + dx, y: group.frame.y + dy } }
          // Ungrouped cards it now covers join it, just as if they had been dropped there.
          const covered = cardsRef.current.filter(
            (c) => !c.archived && !c.sectionId && sectionAt(c, [landed]) === group.section.id
          )
          patchCards([
            ...group.members.map((c) => ({ sessionId: c.sessionId, x: c.x + dx, y: c.y + dy })),
            ...covered.map((c) => ({ sessionId: c.sessionId, sectionId: group.section.id }))
          ])
          saveSection({ ...group.section, x: landed.frame.x, y: landed.frame.y })
        }
        busy.current.delete(node.id)
        for (const id of drag?.members ?? []) busy.current.delete(id)
        return
      }

      if (node.id === ARCHIVE_ID) {
        const zone = archiveRef.current
        const next = {
          x: Math.round(node.position.x),
          y: Math.round(node.position.y),
          w: zone.w,
          h: zone.h
        }
        // Archived cards are drawn by the stack, so only its corner moves.
        setArchive(next)
        archiveBusy.current = false
        setMovingArchive(false)
        lastArchivePos.current = null
        busy.current.clear()
        return
      }

      const zone = zoneRef.current
      const byId = new Map(cardsRef.current.map((c) => [c.sessionId, c]))
      const moved = dragged.filter((n) => n.type === 'session' && byId.has(n.id))

      // Terminals can't be archived: one dropped on the archive goes back to where it was.
      const bounced = new Map<string, Point>()
      for (const n of moved) {
        const card = byId.get(n.id)!
        if (isTerminal(card) && isInArchive(n.position, zone)) {
          bounced.set(n.id, dragStart.current.get(n.id) ?? { x: card.x, y: card.y })
        }
      }
      if (bounced.size > 0) {
        setNodes((nds) => nds.map((n) => (bounced.has(n.id) ? { ...n, position: bounced.get(n.id)! } : n)))
      }

      // Cards dragged together land in the section under the one being dragged (it's the one highlighted).
      const primary = byId.get(node.id)
      const target = sectionAt(node.position, groupsRef.current, primary?.sectionId)
      const patches: NodePatch[] = moved
        .filter((n) => !bounced.has(n.id))
        .map((n) => {
          const archived = !isTerminal(byId.get(n.id)) && isInArchive(n.position, zone)
          return {
            sessionId: n.id,
            x: Math.round(n.position.x),
            y: Math.round(n.position.y),
            archived,
            sectionId: archived ? null : target
          }
        })
      const running = patches
        .map((p) => ({ p, card: byId.get(p.sessionId)! }))
        .filter(({ p, card }) => p.archived && !card.archived && card.live && card.status !== 'done')
        .map(({ card }) => card)

      const release = () => {
        for (const n of moved) busy.current.delete(n.id)
        dragStart.current.clear()
      }

      if (running.length > 0 && !(await confirmStopRunning(running))) {
        const starts = new Map(dragStart.current)
        setNodes((nds) =>
          nds.map((n) => (starts.has(n.id) ? { ...n, position: starts.get(n.id)! } : n))
        )
        release()
        return
      }

      patchCards(patches)
      release()
    },
    [confirmStopRunning, patchCards, setArchive, saveSection]
  )

  const onNodeClick = useCallback(
    (e: ReactMouseEvent, node: FlowNode) => {
      if (node.type !== 'session') return
      // The top of the stack fans it open rather than opening one card.
      if ((node as SessionFlowNode).data.card.archived && !stackViewRef.current.results.has(node.id)) {
        openStack()
        return
      }
      if (e.shiftKey || e.metaKey || e.ctrlKey) return
      if (renaming === node.id) return
      window.clearTimeout(titleClickTimer.current)
      // A click on the title waits briefly so a double-click can rename instead.
      if ((e.target as Element).closest('.card-title')) {
        titleClickTimer.current = window.setTimeout(() => openCard(node.id), 240)
      } else {
        openCard(node.id)
      }
    },
    [openCard, renaming, openStack]
  )

  const onNodeDoubleClick = useCallback((e: ReactMouseEvent, node: FlowNode) => {
    // Only a section's header takes the pointer, so this is a double-click on it.
    if (node.type === 'section') {
      setRenaming(node.id)
      return
    }
    if (node.type !== 'session') return
    if ((node as SessionFlowNode).data.card.archived && !stackViewRef.current.results.has(node.id)) return
    if ((e.target as Element).closest('.card-title')) {
      window.clearTimeout(titleClickTimer.current)
      setRenaming(node.id)
    }
  }, [])

  const onSelectionChange: OnSelectionChangeFunc<FlowNode> = useCallback(
    ({ nodes: sel }) => {
      setSelection(sel.filter((n) => n.type === 'session').map((n) => n.id))
    },
    [setSelection]
  )

  const saveViewportTimer = useRef<number | undefined>(undefined)
  const onMoveEnd: OnMove = useCallback(
    (_e, viewport) => {
      window.clearTimeout(saveViewportTimer.current)
      saveViewportTimer.current = window.setTimeout(() => {
        window.api.board.saveViewport(projectId, viewport)
      }, 400)
    },
    [projectId]
  )
  useEffect(() => () => window.clearTimeout(saveViewportTimer.current), [])

  // "Home" view: the active cards, or — when everything is archived — the most
  // recent archive rows plus empty space on the right to start new sessions in.
  // Fitting the whole archive would zoom a large one down to an unreadable size.
  const fitActive = useCallback(
    (duration = 320) => {
      const active = cardsRef.current.filter((c) => !c.archived).map((c) => ({ id: c.sessionId }))
      if (active.length > 0) {
        // Section frames too, so their headers aren't cut off.
        const frames = groupsRef.current.filter((g) => g.members.length > 0).map((g) => ({ id: g.section.id }))
        rf.fitView({ nodes: [...active, ...frames], padding: 0.2, maxZoom: 1, duration })
        return
      }
      const a = zoneRef.current
      rf.fitBounds(
        { x: a.x, y: a.y, width: a.w + HOME_FREE_SPACE, height: Math.min(a.h, HOME_ARCHIVE_ROWS_H) },
        { padding: 0.06, duration }
      )
    },
    [rf]
  )

  const onPaneDoubleClick = (e: ReactMouseEvent) => {
    if (!(e.target as Element).classList.contains('react-flow__pane')) return
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    if (containsPoint(zoneRef.current, p)) return
    createSession({ x: p.x - CARD_W / 2, y: p.y - CARD_H / 2 })
  }

  const onPaneContextMenu = useCallback(
    (e: ReactMouseEvent | MouseEvent) => {
      e.preventDefault()
      const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const inArchive = containsPoint(zoneRef.current, p)
      const inSection = groupsRef.current.some((g) => containsPoint(g.frame, p))
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'New session here',
            icon: <Plus />,
            hint: 'N',
            disabled: inArchive,
            onSelect: () => createSession({ x: p.x - CARD_W / 2, y: p.y - CARD_H / 2 })
          },
          {
            label: 'New terminal here',
            icon: <SquareTerminal />,
            hint: 'T',
            disabled: inArchive,
            onSelect: () => createTerminal({ x: p.x - CARD_W / 2, y: p.y - CARD_H / 2 })
          },
          {
            label: 'New section here',
            icon: <SquareDashed />,
            disabled: inArchive || inSection,
            onSelect: () => createSectionAt(p)
          },
          'separator',
          { label: 'Select all active', icon: <BoxSelect />, hint: '⌘A', onSelect: selectAllActive },
          { label: 'Zoom to fit', icon: <Maximize />, onSelect: fitActive },
          {
            label: 'Show everything',
            icon: <Maximize />,
            onSelect: () => rf.fitView({ padding: 0.12, duration: 320 })
          }
        ]
      })
    },
    [rf, createSession, createTerminal, createSectionAt, selectAllActive, fitActive]
  )

  const sectionMenu = useCallback(
    (group: SectionView): MenuItem[] => {
      const { section, members } = group
      const sessions = members.filter((c) => !isTerminal(c))
      const newIn = (kind: SessionKind) => () =>
        createSession(
          spotInSection(group, cardObstacles(cardsRef.current.filter((c) => !c.archived))),
          kind,
          section.id
        )
      return [
        { label: 'Rename', icon: <PencilLine />, onSelect: () => setRenaming(section.id) },
        {
          custom: (
            <ColorSwatches
              value={section.color}
              label="Section colour"
              onPick={(color) => {
                setMenu(null)
                saveSection({ ...section, color })
              }}
            />
          )
        },
        'separator',
        { label: 'New session in section', icon: <Plus />, onSelect: newIn('claude') },
        { label: 'New terminal in section', icon: <SquareTerminal />, onSelect: newIn('terminal') },
        {
          label: 'Select cards',
          icon: <BoxSelect />,
          disabled: members.length === 0,
          onSelect: () => selectCards(new Set(members.map((c) => c.sessionId)))
        },
        {
          label: sessions.length > 1 ? `Archive ${sessions.length} sessions` : 'Archive session',
          icon: <Archive />,
          disabled: sessions.length === 0,
          onSelect: () => archiveCards(sessions.map((c) => c.sessionId))
        },
        'separator',
        {
          label: members.length > 0 ? 'Ungroup' : 'Delete section',
          icon: <Ungroup />,
          onSelect: () => removeSection(section.id)
        }
      ]
    },
    [createSession, saveSection, selectCards, archiveCards, removeSection]
  )

  /** A card menu's section items: group it (or the selection it's in), or take it out. */
  const cardSectionItems = useCallback(
    (card: SessionCard): MenuItem[] => {
      if (card.archived) return []
      const sel = selectedIds()
      const ids = sel.includes(card.sessionId) && sel.length > 1 ? sel : [card.sessionId]
      const count = cardsRef.current.filter((c) => ids.includes(c.sessionId) && !c.archived).length
      const items: MenuItem[] = [
        {
          label: count > 1 ? `Group ${count} into section` : 'Group into section',
          icon: <Group />,
          hint: '⌘G',
          onSelect: () => groupCards(ids)
        }
      ]
      if (card.sectionId) {
        items.push({ label: 'Remove from section', icon: <Ungroup />, onSelect: () => leaveSection(card.sessionId) })
      }
      return items
    },
    [groupCards, leaveSection]
  )

  const terminalMenu = useCallback(
    (card: SessionCard): MenuItem[] => {
      const items: MenuItem[] = [
        { label: 'Open', icon: <SquareTerminal />, hint: '↩', onSelect: () => openTerminal(card.sessionId) },
        { label: 'Rename', icon: <PencilLine />, onSelect: () => setRenaming(card.sessionId) },
        ...cardSectionItems(card)
      ]
      if (card.live) {
        items.push({
          label: 'Stop shell',
          icon: <Square />,
          onSelect: () => {
            window.api.sessions.kill(card.sessionId)
          }
        })
      }
      items.push('separator', {
        label: 'Remove terminal',
        icon: <Trash2 />,
        danger: true,
        onSelect: async () => {
          // An exited shell has nothing to lose; only a running one asks first.
          if (card.live) {
            const ok = await confirm({
              title: 'Remove terminal?',
              message: `“${cardTitle(card)}” will be removed from this board. Its shell and anything running in it will be stopped.`,
              confirmLabel: 'Stop & Remove',
              danger: true
            })
            if (!ok) return
          }
          removeCard(card.sessionId)
        }
      })
      return items
    },
    [openTerminal, confirm, removeCard, cardSectionItems]
  )

  const onNodeContextMenu = useCallback(
    (e: ReactMouseEvent, node: FlowNode) => {
      e.preventDefault()
      if (node.type === 'section') {
        const group = groupsRef.current.find((g) => g.section.id === node.id)
        if (group) setMenu({ x: e.clientX, y: e.clientY, items: sectionMenu(group) })
        return
      }
      if (node.type !== 'session') return
      const card = (node as SessionFlowNode).data.card
      if (isTerminal(card)) {
        setMenu({ x: e.clientX, y: e.clientY, items: terminalMenu(card) })
        return
      }
      const sel = selectedIds()
      // Terminals in the selection can't be archived or merged; act on the sessions only.
      const byId = new Map(cardsRef.current.map((c) => [c.sessionId, c]))
      const group =
        sel.includes(card.sessionId) && sel.length > 1
          ? sel.filter((id) => !isTerminal(byId.get(id)))
          : [card.sessionId]
      const items: MenuItem[] = [
        card.archived
          ? { label: 'Preview', icon: <Eye />, hint: '↩', onSelect: () => openPreview(card.sessionId) }
          : { label: 'Open', icon: <SquareTerminal />, hint: '↩', onSelect: () => openTerminal(card.sessionId) },
        { label: 'Rename', icon: <PencilLine />, onSelect: () => setRenaming(card.sessionId) },
        card.archived
          ? { label: 'Restore to board', icon: <ArchiveRestore />, onSelect: () => restoreCard(card.sessionId) }
          : {
              label: group.length > 1 ? `Archive ${group.length} sessions` : 'Archive',
              icon: <Archive />,
              hint: '⌫',
              onSelect: () => archiveCards(group)
            },
        {
          label: group.length > 1 ? `New session from ${group.length} contexts…` : 'New session from context…',
          icon: <Sparkles />,
          onSelect: () => startMerge(group)
        },
        ...cardSectionItems(card)
      ]
      if (card.live) {
        items.push({
          label: 'Stop process',
          icon: <Square />,
          onSelect: () => {
            window.api.sessions.kill(card.sessionId)
          }
        })
      }
      items.push('separator', {
        label: 'Remove from board',
        icon: <Trash2 />,
        danger: true,
        onSelect: async () => {
          const ok = await confirm({
            title: 'Remove from board?',
            message: `“${cardTitle(card)}” will be removed from this board${card.live ? ' and its process stopped' : ''}. The transcript stays on disk.`,
            confirmLabel: 'Remove',
            danger: true
          })
          if (!ok) return
          if (card.live) await window.api.sessions.kill(card.sessionId)
          removeCard(card.sessionId)
        }
      })
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [
      openPreview,
      openTerminal,
      restoreCard,
      archiveCards,
      startMerge,
      confirm,
      removeCard,
      terminalMenu,
      sectionMenu,
      cardSectionItems
    ]
  )

  // ---- keyboard & menu commands ---------------------------------------------

  const latest = useRef({
    createSession,
    createTerminal,
    archiveCards,
    groupCards,
    selectAllActive,
    clearSelection,
    openCard,
    closeStack
  })
  latest.current = {
    createSession,
    createTerminal,
    archiveCards,
    groupCards,
    selectAllActive,
    clearSelection,
    openCard,
    closeStack
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState()
      if (s.terminalSessionId || s.previewSessionId || overlayOpenRef.current) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const sel = selectedIds()
      const fns = latest.current

      if (e.key === 'Escape') {
        if (stackViewRef.current.open) fns.closeStack()
        if (sel.length) fns.clearSelection()
      } else if (e.key.toLowerCase() === 'a' && e.metaKey && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        fns.selectAllActive()
      } else if (e.key.toLowerCase() === 'g' && e.metaKey && !e.shiftKey && !e.altKey) {
        if (sel.length) {
          e.preventDefault()
          fns.groupCards(sel)
        }
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.altKey) {
        if (sel.length) {
          e.preventDefault()
          fns.archiveCards(sel)
        }
      } else if (e.key === 'Enter' && !e.metaKey && !e.shiftKey && sel.length === 1) {
        e.preventDefault()
        fns.openCard(sel[0])
      } else if (e.key.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        fns.createSession()
      } else if (e.key.toLowerCase() === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        fns.createTerminal()
      }
    }
    window.addEventListener('keydown', onKey)
    const offMenu = window.api.on.menu((command) => {
      if (overlayOpenRef.current) return
      if (command === 'new-session') latest.current.createSession()
      else if (command === 'new-terminal') latest.current.createTerminal()
    })
    return () => {
      window.removeEventListener('keydown', onKey)
      offMenu()
      window.clearTimeout(titleClickTimer.current)
    }
  }, [])

  // ---- render --------------------------------------------------------------

  const activeCount = cards.filter((c) => !c.archived).length
  const selectedCards = cards.filter((c) => selection.includes(c.sessionId))

  return (
    <BoardActionsContext.Provider value={actions}>
      <RenamingContext.Provider value={renaming}>
        <ArchiveHotContext.Provider value={archiveHot}>
          <SectionHotContext.Provider value={hotSection}>
            <ArchiveStackContext.Provider value={stackCtx}>
              <div
                className={clsx(
                  'board-canvas',
                  movingArchive && 'is-moving-archive',
                  movingSection && 'is-moving-section',
                  stackScrolling && 'is-scrolling-stack',
                  !stackOpen && ((stackHover && !stackDismissed) || archiveHot) && 'stack-lift'
                )}
                ref={wrapperRef}
                onDoubleClick={onPaneDoubleClick}
                onPointerMove={onCanvasPointerMove}
                onWheel={onCanvasWheel}
                onPointerLeave={() => {
                setStackHover(false)
                setStackDismissed(false)
              }}
              >
                <TitleBarActions>
                  <button
                    className="btn btn-ghost no-drag"
                    onClick={() => createTerminal()}
                    title="New terminal in the project folder (⌘T)"
                  >
                    <SquareTerminal size={15} strokeWidth={2} />
                    Terminal
                  </button>
                  <button className="btn no-drag" onClick={() => createSession()} title="New session (⌘N)">
                    <Plus size={15} strokeWidth={2.2} />
                    New Session
                  </button>
                </TitleBarActions>

                <ReactFlow<FlowNode, Edge>
                  edgeTypes={edgeTypes}
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onNodeDragStart={onNodeDragStart}
                  onNodeDrag={onNodeDrag}
                  onNodeDragStop={onNodeDragStop}
                  onNodeClick={onNodeClick}
                  onNodeDoubleClick={onNodeDoubleClick}
                  onNodeContextMenu={onNodeContextMenu}
                  onPaneContextMenu={onPaneContextMenu}
                  onPaneClick={() => setMenu(null)}
                  onSelectionChange={onSelectionChange}
                  onMoveStart={() => setMenu(null)}
                  onMoveEnd={onMoveEnd}
                  defaultViewport={board.viewport}
                  onInit={() => {
                    if (!board.viewport) fitActive(0)
                  }}
                  minZoom={0.1}
                  maxZoom={2}
                  panOnScroll
                  zoomOnPinch
                  zoomOnDoubleClick={false}
                  selectionOnDrag
                  selectionMode={SelectionMode.Partial}
                  panOnDrag={[1]}
                  panActivationKeyCode="Space"
                  selectionKeyCode={null}
                  multiSelectionKeyCode={['Meta', 'Shift']}
                  deleteKeyCode={null}
                  disableKeyboardA11y
                  nodesConnectable={false}
                  elevateNodesOnSelect
                  onlyRenderVisibleElements={cards.length > 150}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background
                    variant={BackgroundVariant.Dots}
                    gap={22}
                    size={1.6}
                    color="var(--canvas-dot)"
                    bgColor="var(--bg-canvas)"
                  />
                  <MiniMap<FlowNode>
                    className="board-minimap"
                    style={{ width: 176, height: 118 }}
                    pannable
                    zoomable
                    nodeBorderRadius={6}
                    nodeColor={(n) => {
                      if (n.type === 'archive') return 'var(--archive-bg)'
                      // A faint wash of the section's colour (hex + alpha).
                      if (n.type === 'section') return `${sectionHue(n)}24`
                      const card = (n as SessionFlowNode).data.card
                      return isTerminal(card) ? 'var(--text-tertiary)' : STATUS_COLOR[card.status]
                    }}
                    nodeStrokeColor={(n) => {
                      if (n.type === 'archive') return 'var(--archive-border)'
                      if (n.type === 'section') return sectionHue(n)
                      return 'transparent'
                    }}
                    nodeStrokeWidth={3}
                  />
                  <BoardControls onFit={fitActive} />
                </ReactFlow>

                {activeCount === 0 && (
                  <div className="board-hint" aria-hidden>
                    <p className="board-hint-title">No active sessions</p>
                    <p className="board-hint-body">
                      Double-click anywhere or press <kbd>N</kbd> to start a Claude session, or{' '}
                      <kbd>T</kbd> for a terminal. Drag cards out of the archive to reactivate them.
                    </p>
                  </div>
                )}

                {selectedCards.length > 0 && !merge && (
                  <SelectionBar
                    count={selectedCards.length}
                    sessionCount={selectedCards.filter((c) => !isTerminal(c)).length}
                    activeCount={selectedCards.filter((c) => !c.archived && !isTerminal(c)).length}
                    groupCount={selectedCards.filter((c) => !c.archived).length}
                    onMerge={() => startMerge(selectedCards.map((c) => c.sessionId))}
                    onGroup={() => groupCards(selectedCards.map((c) => c.sessionId))}
                    onArchive={() => archiveCards(selectedCards.map((c) => c.sessionId))}
                    onClear={clearSelection}
                  />
                )}

                {toast && (
                  <div className="board-toast" role="status">
                    {toast}
                  </div>
                )}
              </div>
            </ArchiveStackContext.Provider>

            {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
            <ConfirmDialog request={confirmReq} />
            {merge && (
              <MergeDialog
                projectId={projectId}
                sources={merge}
                onClose={() => setMerge(null)}
                onStart={onMergeStart}
              />
            )}
          </SectionHotContext.Provider>
        </ArchiveHotContext.Provider>
      </RenamingContext.Provider>
    </BoardActionsContext.Provider>
  )
}
