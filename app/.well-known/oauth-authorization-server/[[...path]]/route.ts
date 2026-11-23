import { publicOrigin } from '@/app/lib/mcp/origin'
import { MCP_SCOPE } from '@/app/lib/mcp/tokens'

/** RFC 8414 authorization-server metadata for the MCP connector (BUSINESS_RULES §28). */
export async function GET(req: Request): Promise<Response> {
  const origin = publicOrigin(req)
  return Response.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [MCP_SCOPE],
    },
    { headers: { 'Access-Control-Allow-Origin': '*' } }
  )
}
