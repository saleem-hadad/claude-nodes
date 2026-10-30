// Board tools: an MCP server that lets Claude sessions work with the board
// they run on. Every Claude session can write sticky notes on it, so what it
// found can go up beside its card; action runs can also list and archive the
// board's sessions.
//
// Claude Code reaches the server over the MCP streamable HTTP transport, at
// the session host (host.ts), which passes each request on to the app. The
// host outlives the app, as the sessions do, so a session keeps its tools
// when the app restarts. Every process gets the same config: Claude Code
// fills in the host's port and token, and the session's id, from the env
// hookEnv gives it, so the token never shows up in a process listing.
import { app } from 'electron'
import { FOLDER_COLORS, type FolderColor } from '@shared/types'
import { MCP_PATH, MCP_SESSION_HEADER } from './hostProtocol'
import { projectIdForSession } from './store'

/** The server's name in Claude Code: its tools are mcp__claude-nodes__<tool>. */
export const BOARD_SERVER = 'claude-nodes'
const PROTOCOL_VERSION = '2025-06-18'

/** What a note tool may change about a note. */
export interface NotePatch {
  text?: string
  color?: FolderColor
}

export interface BoardToolHandlers {
  /** Whether the session is an action run, which gets the session tools too. */
  isRun(sessionId: string): boolean
  /** The project's sessions, leaving out the calling run. */
  listSessions(projectId: string, self: string, includeArchived: boolean): unknown
  archiveSessions(projectId: string, self: string, sessionIds: string[], force: boolean): unknown
  listNotes(projectId: string, self: string): unknown
  createNote(projectId: string, self: string, note: NotePatch): unknown
  updateNote(projectId: string, noteId: string, patch: NotePatch): unknown
}

const INSTRUCTIONS =
  'Claude Nodes is the board of Claude Code sessions the user runs this session from. Besides the session cards, it holds sticky notes. When the user asks you to put something on the board, or to make notes of it, write it with create_note. Read the notes they have put up with list_notes. Only write notes when the user asks for them.'

const colorProperty = (description: string) => ({ type: 'string', enum: FOLDER_COLORS, description })

/** Every session's tools. */
const NOTE_TOOLS = [
  {
    name: 'create_note',
    description:
      'Puts a sticky note on the user’s Claude Nodes board, beside this session’s card. Use it when the user asks you to put something on the board: findings, a summary, a plan, a list to come back to. A note shows its text as written, so Markdown is not rendered: skip **bold** and # headings, though "- " bullets and blank lines read well. Keep each note to one topic someone can take in at a glance, starting with a short line that says what it is about, and write several notes for several topics. Returns the note’s id.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What the note says.' },
        color: colorProperty('The note’s colour. Defaults to yellow. Colours can tell kinds of notes apart.')
      },
      required: ['text']
    }
  },
  {
    name: 'update_note',
    description:
      'Changes the text or colour of a note on the board. Use it to revise a note rather than writing another beside it.',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'An id from create_note or list_notes.' },
        text: { type: 'string', description: 'The note’s new text, in full.' },
        color: colorProperty('The note’s new colour.')
      },
      required: ['note_id']
    }
  },
  {
    name: 'list_notes',
    description:
      'Lists the sticky notes on the board, the user’s and any Claude wrote: each one’s id, text and colour, and whether this session wrote it.',
    inputSchema: { type: 'object', properties: {} }
  }
]

/** An action run's tools, on top of the note tools. */
const SESSION_TOOLS = [
  {
    name: 'list_sessions',
    description:
      'Lists the sessions on this project’s Claude Nodes board. Each has its id, title, kind (claude or terminal), status (working, waiting for the user, or done), whether its process is running, whether it is archived, the section it is in, Claude’s last reply, and when it was last active. The session running this action is not listed.',
    inputSchema: {
      type: 'object',
      properties: {
        include_archived: { type: 'boolean', description: 'Also list archived sessions. Defaults to false.' }
      }
    }
  },
  {
    name: 'archive_sessions',
    description:
      'Moves sessions into the board’s archive and stops their processes. Their transcripts are kept, so they can be picked up again later. A session nothing was said in is removed from the board instead, as there is nothing to keep. Sessions that are working or waiting for the user are skipped unless force is true. Terminals cannot be archived.',
    inputSchema: {
      type: 'object',
      properties: {
        session_ids: { type: 'array', items: { type: 'string' }, description: 'Ids from list_sessions.' },
        force: { type: 'boolean', description: 'Archive sessions even if they are working or waiting.' }
      },
      required: ['session_ids']
    }
  }
]

const SESSION_TOOL_NAMES = new Set(SESSION_TOOLS.map((t) => t.name))

/** Allow rules that let a session use every board tool it has without asking. */
export const BOARD_TOOL_RULES = [...NOTE_TOOLS, ...SESSION_TOOLS].map((t) => `mcp__${BOARD_SERVER}__${t.name}`)

/** The `--mcp-config` for every claude process. Claude Code expands the ${…} from its env (hookEnv). */
export const BOARD_MCP_CONFIG = JSON.stringify({
  mcpServers: {
    [BOARD_SERVER]: {
      type: 'http',
      url: `http://127.0.0.1:\${CLAUDE_NODES_PORT}${MCP_PATH}`,
      headers: {
        Authorization: 'Bearer ${CLAUDE_NODES_TOKEN}',
        [MCP_SESSION_HEADER]: '${CLAUDE_NODES_SESSION}'
      }
    }
  }
})

let handlers: BoardToolHandlers | null = null

export function configureBoardTools(h: BoardToolHandlers) {
  handlers = h
}

interface RpcRequest {
  id: string | number | null
  method: string
  params?: Record<string, unknown>
}

/** Answers a JSON-RPC request from a session's process, relayed by the session host. */
export function answerMcp(sessionId: string, message: unknown) {
  const msg = message as RpcRequest
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion
      return ok({
        protocolVersion: typeof asked === 'string' ? asked : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: BOARD_SERVER, version: app.getVersion() },
        instructions: INSTRUCTIONS
      })
    }
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: handlers?.isRun(sessionId) ? [...NOTE_TOOLS, ...SESSION_TOOLS] : NOTE_TOOLS })
    case 'tools/call':
      return ok(callTool(msg.params ?? {}, sessionId))
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } }
  }
}

const isColor = (value: unknown): value is FolderColor => FOLDER_COLORS.includes(value as FolderColor)

function callTool(params: Record<string, unknown>, sessionId: string) {
  const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<
    string,
    unknown
  >
  const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
  const patch = (): NotePatch => ({
    text: typeof args.text === 'string' ? args.text : undefined,
    color: isColor(args.color) ? args.color : undefined
  })
  try {
    if (!handlers) throw new Error('The board is not available')
    const projectId = projectIdForSession(sessionId)
    if (!projectId) throw new Error('This session is no longer on a Claude Nodes board')
    // A run the user took over is an ordinary session now.
    if (SESSION_TOOL_NAMES.has(String(params.name)) && !handlers.isRun(sessionId)) {
      throw new Error(`${String(params.name)} is only for action runs`)
    }
    switch (params.name) {
      case 'create_note':
        return text(handlers.createNote(projectId, sessionId, patch()))
      case 'update_note':
        if (typeof args.note_id !== 'string') throw new Error('note_id is required')
        return text(handlers.updateNote(projectId, args.note_id, patch()))
      case 'list_notes':
        return text(handlers.listNotes(projectId, sessionId))
      case 'list_sessions':
        return text(handlers.listSessions(projectId, sessionId, args.include_archived === true))
      case 'archive_sessions': {
        const ids = Array.isArray(args.session_ids) ? args.session_ids.filter((id) => typeof id === 'string') : []
        return text(handlers.archiveSessions(projectId, sessionId, ids, args.force === true))
      }
      default:
        throw new Error(`Unknown tool ${String(params.name)}`)
    }
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
  }
}
