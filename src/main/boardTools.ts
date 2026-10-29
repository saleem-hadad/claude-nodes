// Board tools for action runs: a small MCP server on 127.0.0.1 that lets a
// run's Claude session see and tidy the board it was started from.
//
// Claude Code connects over the MCP streamable HTTP transport; every request
// is answered with plain JSON, so there are no streams to keep open. Each run
// gets its own token, which ties its calls to one project and keeps its own
// card out of reach. The token sits in a config file only the user can read,
// so it never shows up in a process listing.
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { app } from 'electron'

/** The server's name in Claude Code: its tools are mcp__claude-nodes__<tool>. */
export const BOARD_SERVER = 'claude-nodes'
const PROTOCOL_VERSION = '2025-06-18'
const MAX_BODY_BYTES = 1024 * 1024

export interface BoardToolHandlers {
  /** The project's sessions, leaving out the calling run. */
  listSessions(projectId: string, self: string, includeArchived: boolean): unknown
  archiveSessions(projectId: string, self: string, sessionIds: string[], force: boolean): unknown
}

interface Grant {
  projectId: string
  sessionId: string
}

const TOOLS = [
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
      'Moves sessions into the board’s archive and stops their processes. Their transcripts are kept, so they can be picked up again later. Sessions that are working or waiting for the user are skipped unless force is true. Terminals cannot be archived.',
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

/** Allow rules that let a run use every board tool without asking. */
export const BOARD_TOOL_RULES = TOOLS.map((t) => `mcp__${BOARD_SERVER}__${t.name}`)

const grants = new Map<string, Grant>()
let handlers: BoardToolHandlers | null = null
let ready: Promise<number> | null = null

export function startBoardTools(h: BoardToolHandlers): Promise<number> {
  handlers = h
  ready ??= new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      serve(req, res).catch((err) => {
        console.error('[board-tools]', err)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(new Error('Board tools server has no port'))
    })
  })
  return ready
}

function configDir() {
  return path.join(app.getPath('userData'), 'runs')
}

/**
 * Gives a run access to its project's board, and returns the path of an MCP
 * config file for `claude --mcp-config`.
 */
export async function grantBoardTools(projectId: string, sessionId: string): Promise<string> {
  if (!ready) throw new Error('Board tools are not running')
  const port = await ready
  const token = crypto.randomBytes(24).toString('hex')
  grants.set(token, { projectId, sessionId })

  const dir = configDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${sessionId}.json`)
  const config = {
    mcpServers: {
      [BOARD_SERVER]: {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: `Bearer ${token}` }
      }
    }
  }
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
  return file
}

export function revokeBoardTools(sessionId: string) {
  for (const [token, grant] of grants) if (grant.sessionId === sessionId) grants.delete(token)
  fs.rmSync(path.join(configDir(), `${sessionId}.json`), { force: true })
}

async function serve(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.url !== '/mcp') return void res.writeHead(404).end()
  const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
  const grant = token ? grants.get(token) : undefined
  if (!grant) return void res.writeHead(401).end()
  // No server-to-client stream: every answer comes back on its POST.
  if (req.method === 'GET') return void res.writeHead(405, { Allow: 'POST' }).end()
  if (req.method === 'DELETE') return void res.writeHead(204).end()
  if (req.method !== 'POST') return void res.writeHead(405, { Allow: 'POST' }).end()

  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY_BYTES) return void res.writeHead(413).end()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return reply(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed]
  const answers = messages
    .filter((m): m is RpcRequest => Boolean(m) && typeof m === 'object' && 'id' in m && typeof m.method === 'string')
    .map((m) => answer(m, grant))
  // Notifications (no id) get no answer.
  if (answers.length === 0) return void res.writeHead(202).end()
  reply(res, Array.isArray(parsed) ? answers : answers[0])
}

interface RpcRequest {
  id: string | number | null
  method: string
  params?: Record<string, unknown>
}

function answer(msg: RpcRequest, grant: Grant) {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion
      return ok({
        protocolVersion: typeof asked === 'string' ? asked : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: BOARD_SERVER, version: app.getVersion() }
      })
    }
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: TOOLS })
    case 'tools/call':
      return ok(callTool(msg.params ?? {}, grant))
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } }
  }
}

function callTool(params: Record<string, unknown>, { projectId, sessionId }: Grant) {
  const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<
    string,
    unknown
  >
  const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
  try {
    if (!handlers) throw new Error('The board is not available')
    switch (params.name) {
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

function reply(res: http.ServerResponse, value: unknown) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}
