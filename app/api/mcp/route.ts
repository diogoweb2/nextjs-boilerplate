import type { NextRequest } from 'next/server'
import { verifyMcpToken, type GrantClaims } from '@/app/lib/mcp/tokens'
import { publicOrigin, resourceMetadataUrl } from '@/app/lib/mcp/origin'
import { TOOLS, callTool, SERVER_INSTRUCTIONS } from '@/app/lib/mcp/tools'

/**
 * Remote MCP server (Streamable HTTP, stateless JSON responses) so the owner can
 * ask Claude (claude.ai / the Claude apps) questions about the budget. Auth is an
 * OAuth bearer token minted by /oauth/* after the master password is entered
 * (BUSINESS_RULES §28). proxy.ts lets this path through to its own auth.
 * Read-only: no tool writes to the database.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

function unauthorized(req: NextRequest): Response {
  const meta = resourceMetadataUrl(publicOrigin(req))
  return Response.json(
    { error: 'invalid_token', error_description: 'Connect this server from Claude to authorize.' },
    { status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${meta}"` } }
  )
}

function authorized(req: NextRequest): boolean {
  const header = req.headers.get('authorization')
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null
  return verifyMcpToken<GrantClaims>(token, 'access') !== null
}

const result = (id: RpcRequest['id'], value: unknown) => ({ jsonrpc: '2.0', id, result: value })
const error = (id: RpcRequest['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

async function handle(msg: RpcRequest): Promise<object | null> {
  const id = msg.id
  // Notifications (no id) get no response body.
  if (id === undefined || id === null) return null
  switch (msg.method) {
    case 'initialize': {
      const asked = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : ''
      return result(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'family-budget', title: 'Family Budget', version: '1.0.0' },
        instructions: SERVER_INSTRUCTIONS,
      })
    }
    case 'ping':
      return result(id, {})
    case 'tools/list':
      return result(id, {
        tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
      })
    case 'tools/call': {
      const name = typeof msg.params?.name === 'string' ? msg.params.name : ''
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      return result(id, await callTool(name, args))
    }
    case 'resources/list':
      return result(id, { resources: [] })
    case 'prompts/list':
      return result(id, { prompts: [] })
    default:
      return error(id, -32601, `Method not found: ${msg.method}`)
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!authorized(req)) return unauthorized(req)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json(error(null, -32700, 'Parse error'), { status: 400 })
  }

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(m as RpcRequest)))).filter(Boolean)
    return out.length ? Response.json(out) : new Response(null, { status: 202 })
  }
  const out = await handle(body as RpcRequest)
  return out ? Response.json(out) : new Response(null, { status: 202 })
}

// Stateless server: no server-initiated SSE stream and no sessions to delete.
export async function GET(req: NextRequest): Promise<Response> {
  if (!authorized(req)) return unauthorized(req)
  return new Response(null, { status: 405, headers: { Allow: 'POST' } })
}

export async function DELETE(): Promise<Response> {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } })
}
