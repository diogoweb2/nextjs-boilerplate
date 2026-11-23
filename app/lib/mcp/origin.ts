/**
 * Public origin of this deployment as the caller sees it. On Vercel the request
 * URL already carries the real host; behind other proxies honour x-forwarded-*.
 * The OAuth issuer, the protected-resource URL and the metadata links must all
 * agree on this value or Claude rejects the connector.
 */
export function publicOrigin(req: Request): string {
  const url = new URL(req.url)
  const host = req.headers.get('x-forwarded-host') ?? url.host
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')
  return `${proto}://${host}`
}

export const MCP_PATH = '/api/mcp'

export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`
}
