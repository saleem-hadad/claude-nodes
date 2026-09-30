import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
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
  type OnResizeEnd,
  type OnSelectionChangeFunc
} from '@xyflow/react'
import {
  Archive,
  ArchiveRestore,
  Eye,
  Loader2,
  Maximize,
  PencilLine,
  Plus,
  Sparkles,
  SquareTerminal,
  Square,
  Trash2,
  BoxSelect
} from 'lucide-react'
import type { BoardSnapshot, NodePatch, SessionCard } from '@shared/types'
import { cardTitle, useApp } from '@renderer/store'
import { ContextMenu, type MenuItem } from '@renderer/components/ContextMenu'
import { TitleBarActions } from '@renderer/components/TitleBarActions'
import {
  ArchiveHotContext,
  BoardActionsContext,
  RenamingContext,
  type BoardActions
} from '@renderer/components/board/BoardContext'
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
  archiveSlots,
  cardObstacles,
  cardRect,
  containsPoint,
  findFreeSpot,
  intersects,
  isInArchive,
  spotForNewSession,
  spotRightOfArchive,
  type Point
} from '@renderer/components/board/layout'
import '@renderer/components/board/board.css'

type FlowNode = SessionFlowNode | ArchiveFlowNode

const nodeTypes = { session: SessionCardNode, archive: ArchiveZoneNode }
const edgeTypes = { lineage: LineageEdge }

/** Home view when nothing is active: room right of the archive for new cards… */
const HOME_FREE_SPACE = 760
/** …and roughly the three most recent archive rows. */
const HOME_ARCHIVE_ROWS_H = 64 + 3 * 240

const STATUS_COLOR = {
  working: 'var(--status-working)',
  waiting: 'var(--status-waiting)',
  done: 'var(--status-done)'
} as const

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

/**
 * Derives React Flow nodes from the board snapshot while preserving local
 * React Flow state (selection, measurements) and the live position of any node
 * that is mid-drag or mid-resize.
 */
function buildNodes(
  board: BoardSnapshot,
  prev: FlowNode[],
  busy: Set<string>,
  archiveBusy: boolean,
  onResizeEnd: OnResizeEnd
): FlowNode[] {
  const prevById = new Map(prev.map((n) => [n.id, n]))
  const archivedCount = board.cards.filter((c) => c.archived).length

  const pa = prevById.get(ARCHIVE_ID) as ArchiveFlowNode | undefined
  const keepArchive = pa && (archiveBusy || pa.dragging || pa.resizing)
  const archiveNode: ArchiveFlowNode = {
    ...pa,
    id: ARCHIVE_ID,
    type: 'archive',
    position: keepArchive ? pa.position : { x: board.archive.x, y: board.archive.y },
    width: keepArchive ? pa.width : board.archive.w,
    height: keepArchive ? pa.height : board.archive.h,
    data:
      pa && pa.data.count === archivedCount && pa.data.onResizeEnd === onResizeEnd
        ? pa.data
        : { count: archivedCount, onResizeEnd },
    zIndex: -1,
    selectable: false,
    focusable: false,
    deletable: false,
    dragHandle: '.archive-header'
  }

  const sessionNodes = board.cards.map((card): SessionFlowNode => {
    const p = prevById.get(card.sessionId) as SessionFlowNode | undefined
    if (!p) {
      return {
        id: card.sessionId,
        type: 'session',
        position: { x: card.x, y: card.y },
        width: CARD_W,
        height: CARD_H,
        deletable: false,
        data: { card }
      }
    }
    const keepPos = p.dragging || busy.has(card.sessionId)
    const position = keepPos ? p.position : { x: card.x, y: card.y }
    const dataSame = sameCard(p.data.card, card)
    if (dataSame && position.x === p.position.x && position.y === p.position.y) return p
    return { ...p, position, data: dataSame ? p.data : { card } }
  })

  return [archiveNode, ...sessionNodes]
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
  const setSelection = useApp((s) => s.setSelection)
  const openTerminal = useApp((s) => s.openTerminal)
  const openPreview = useApp((s) => s.openPreview)
  const selection = useApp((s) => s.selection)

  const { cards, archive } = board
  const cardsRef = useRef(cards)
  cardsRef.current = cards
  const archiveRef = useRef(archive)
  archiveRef.current = archive

  // Nodes that must keep their local position while the store changes underneath.
  const busy = useRef(new Set<string>())
  const dragStart = useRef(new Map<string, Point>())
  const archiveBusy = useRef(false)
  const lastArchivePos = useRef<Point | null>(null)
  const titleClickTimer = useRef<number | undefined>(undefined)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const [renaming, setRenaming] = useState<string | null>(null)
  const [archiveHot, setArchiveHot] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)
  const [merge, setMerge] = useState<MergeSource[] | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const closeMenu = useCallback(() => setMenu(null), [])
  const overlayOpen = Boolean(menu || confirmReq || merge)
  const overlayOpenRef = useRef(overlayOpen)
  overlayOpenRef.current = overlayOpen

  const onArchiveResizeEnd: OnResizeEnd = useCallback(
    (_e, p) => {
      archiveBusy.current = false
      setArchive({
        x: Math.round(p.x),
        y: Math.round(p.y),
        w: Math.round(p.width),
        h: Math.round(p.height)
      })
    },
    [setArchive]
  )

  const [nodes, setNodes] = useState<FlowNode[]>(() =>
    buildNodes(board, [], busy.current, false, onArchiveResizeEnd)
  )
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  useEffect(() => {
    setNodes((prev) => buildNodes(board, prev, busy.current, archiveBusy.current, onArchiveResizeEnd))
  }, [board, onArchiveResizeEnd])

  const edges = useMemo<Edge[]>(() => {
    const ids = new Set(cards.map((c) => c.sessionId))
    return cards.flatMap((child) =>
      (child.parents ?? [])
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
    async (at?: Point) => {
      const all = cardsRef.current
      const zone = archiveRef.current
      const spot = at
        ? findFreeSpot(at, cardObstacles(all), zone)
        : spotForNewSession(zone, all)
      const pos = { x: Math.round(spot.x), y: Math.round(spot.y) }
      try {
        const card = await window.api.sessions.create(projectId, pos)
        upsertCard(card)
        ensureVisible(pos)
        openTerminal(card.sessionId)
      } catch (err) {
        showToast(`Couldn't start a session: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [projectId, upsertCard, openTerminal, ensureVisible, showToast]
  )

  const archiveCards = useCallback(
    async (ids: string[]) => {
      const all = cardsRef.current
      const targets = all.filter((c) => ids.includes(c.sessionId) && !c.archived)
      if (targets.length === 0) return
      const running = targets.filter((c) => c.live && c.status !== 'done')
      if (running.length > 0 && !(await confirmStopRunning(running))) return
      const moving = new Set(targets.map((t) => t.sessionId))
      const { slots, archive: grown } = archiveSlots(archiveRef.current, all, targets.length, moving)
      if (grown.h !== archiveRef.current.h) setArchive(grown)
      patchCards(
        targets.map((c, i) => ({
          sessionId: c.sessionId,
          x: Math.round(slots[i].x),
          y: Math.round(slots[i].y),
          archived: true
        }))
      )
      setNodes((nds) => nds.map((n) => (moving.has(n.id) && n.selected ? { ...n, selected: false } : n)))
    },
    [confirmStopRunning, patchCards, setArchive]
  )

  const restoreCard = useCallback(
    (sessionId: string) => {
      const spot = spotRightOfArchive(archiveRef.current, cardsRef.current, new Set([sessionId]))
      patchCards([
        { sessionId, x: Math.round(spot.x), y: Math.round(spot.y), archived: false }
      ])
      ensureVisible(spot)
    },
    [patchCards, ensureVisible]
  )

  const startMerge = useCallback((ids: string[]) => {
    const byId = new Map(cardsRef.current.map((c) => [c.sessionId, c]))
    const sources = ids
      .map((id) => byId.get(id))
      .filter((c): c is SessionCard => Boolean(c))
      .map((c) => ({ sessionId: c.sessionId, title: cardTitle(c) }))
    if (sources.length > 0) setMerge(sources)
  }, [])

  const onMergeStart = useCallback(
    async ({ name, initialPrompt, parents }: MergeStartOptions) => {
      const all = cardsRef.current
      const zone = archiveRef.current
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
      setRenaming
    }),
    [patchCards]
  )

  // ---- React Flow handlers -------------------------------------------------

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const relevant = changes.filter((c) => c.type !== 'remove')
    for (const c of relevant) {
      if (c.type === 'dimensions' && c.id === ARCHIVE_ID && c.resizing !== undefined) {
        archiveBusy.current = c.resizing
      }
    }
    setNodes((nds) => applyNodeChanges(relevant, nds))
  }, [])

  const onNodeDragStart: OnNodeDrag<FlowNode> = useCallback((_e, node, dragged) => {
    setMenu(null)
    window.clearTimeout(titleClickTimer.current)
    if (node.id === ARCHIVE_ID) {
      archiveBusy.current = true
      lastArchivePos.current = { ...node.position }
      for (const c of cardsRef.current) if (c.archived) busy.current.add(c.sessionId)
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
    const zone = archiveRef.current
    setArchiveHot(dragged.some((n) => n.type === 'session' && isInArchive(n.position, zone)))
  }, [])

  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback(
    async (_e, node, dragged) => {
      setArchiveHot(false)

      if (node.id === ARCHIVE_ID) {
        const zone = archiveRef.current
        const next = {
          x: Math.round(node.position.x),
          y: Math.round(node.position.y),
          w: zone.w,
          h: zone.h
        }
        const dx = next.x - zone.x
        const dy = next.y - zone.y
        const patches: NodePatch[] = cardsRef.current
          .filter((c) => c.archived)
          .map((c) => ({ sessionId: c.sessionId, x: Math.round(c.x + dx), y: Math.round(c.y + dy) }))
        setArchive(next)
        patchCards(patches)
        archiveBusy.current = false
        lastArchivePos.current = null
        busy.current.clear()
        return
      }

      const zone = archiveRef.current
      const byId = new Map(cardsRef.current.map((c) => [c.sessionId, c]))
      const moved = dragged.filter((n) => n.type === 'session' && byId.has(n.id))
      const patches: NodePatch[] = moved.map((n) => ({
        sessionId: n.id,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
        archived: isInArchive(n.position, zone)
      }))
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
    [confirmStopRunning, patchCards, setArchive]
  )

  const onNodeClick = useCallback(
    (e: ReactMouseEvent, node: FlowNode) => {
      if (node.type !== 'session') return
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
    [openCard, renaming]
  )

  const onNodeDoubleClick = useCallback((e: ReactMouseEvent, node: FlowNode) => {
    if (node.type !== 'session') return
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
        rf.fitView({ nodes: active, padding: 0.2, maxZoom: 1, duration })
        return
      }
      const a = archiveRef.current
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
    if (containsPoint(archiveRef.current, p)) return
    createSession({ x: p.x - CARD_W / 2, y: p.y - CARD_H / 2 })
  }

  const onPaneContextMenu = useCallback(
    (e: ReactMouseEvent | MouseEvent) => {
      e.preventDefault()
      const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const inArchive = containsPoint(archiveRef.current, p)
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
    [rf, createSession, selectAllActive, fitActive]
  )

  const onNodeContextMenu = useCallback(
    (e: ReactMouseEvent, node: FlowNode) => {
      e.preventDefault()
      if (node.type !== 'session') return
      const card = (node as SessionFlowNode).data.card
      const sel = selectedIds()
      const group = sel.includes(card.sessionId) && sel.length > 1 ? sel : [card.sessionId]
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
        }
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
    [openPreview, openTerminal, restoreCard, archiveCards, startMerge, confirm, removeCard]
  )

  // ---- keyboard & menu commands ---------------------------------------------

  const latest = useRef({ createSession, archiveCards, selectAllActive, clearSelection, openCard })
  latest.current = { createSession, archiveCards, selectAllActive, clearSelection, openCard }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState()
      if (s.terminalSessionId || s.previewSessionId || overlayOpenRef.current) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const sel = selectedIds()
      const fns = latest.current

      if (e.key === 'Escape') {
        if (sel.length) fns.clearSelection()
      } else if (e.key.toLowerCase() === 'a' && e.metaKey && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        fns.selectAllActive()
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
      }
    }
    window.addEventListener('keydown', onKey)
    const offMenu = window.api.on.menu((command) => {
      if (command === 'new-session' && !overlayOpenRef.current) latest.current.createSession()
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
          <div className="board-canvas" ref={wrapperRef} onDoubleClick={onPaneDoubleClick}>
            <TitleBarActions>
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
                nodeColor={(n) =>
                  n.type === 'archive'
                    ? 'var(--archive-bg)'
                    : STATUS_COLOR[(n as SessionFlowNode).data.card.status]
                }
                nodeStrokeColor={(n) => (n.type === 'archive' ? 'var(--archive-border)' : 'transparent')}
                nodeStrokeWidth={3}
              />
              <BoardControls onFit={fitActive} />
            </ReactFlow>

            {activeCount === 0 && (
              <div className="board-hint" aria-hidden>
                <p className="board-hint-title">No active sessions</p>
                <p className="board-hint-body">
                  Double-click anywhere or press <kbd>N</kbd> to start a Claude session. Drag
                  cards out of the archive to reactivate them.
                </p>
              </div>
            )}

            {selectedCards.length > 0 && !merge && (
              <SelectionBar
                count={selectedCards.length}
                activeCount={selectedCards.filter((c) => !c.archived).length}
                onMerge={() => startMerge(selectedCards.map((c) => c.sessionId))}
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
        </ArchiveHotContext.Provider>
      </RenamingContext.Provider>
    </BoardActionsContext.Provider>
  )
}
