import { publicOrigin, MCP_PATH } from '@/app/lib/mcp/origin'
import { MCP_SCOPE } from '@/app/lib/mcp/tokens'

/** RFC 9728 protected-resource metadata for the MCP endpoint (BUSINESS_RULES §28).
 *  Served at both /.well-known/oauth-protected-resource and …/api/mcp. */
export async function GET(req: Request): Promise<Response> {
  const origin = publicOrigin(req)
  return Response.json(
    {
      resource: `${origin}${MCP_PATH}`,
      authorization_servers: [origin],
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Family Budget',
    },
    { headers: { 'Access-Control-Allow-Origin': '*' } }
  )
}
