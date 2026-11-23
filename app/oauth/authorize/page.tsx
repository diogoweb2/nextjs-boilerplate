import type { Metadata } from 'next'
import { LogoMark } from '@/app/components/Logo'
import { validateAuthorize } from '@/app/lib/mcp/authorize'
import { ApproveForm } from './ApproveForm'

export const metadata: Metadata = { title: 'Connect Claude' }
export const dynamic = 'force-dynamic'

/**
 * OAuth consent screen for the MCP connector (BUSINESS_RULES §28). Reached from
 * claude.ai's "Connect" button; proxy.ts lets it through without a session
 * because the master password is entered here.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const raw = await searchParams
  const params = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
  ) as Record<string, string | undefined>
  const req = validateAuthorize(params)

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="card w-full max-w-sm p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <LogoMark className="h-14 w-16" />
          <h1 className="mt-3 text-xl font-semibold text-[var(--foreground)]">Connect Claude</h1>
        </div>
        {typeof req === 'string' ? (
          <p className="text-sm text-[var(--negative,#dc2626)]">{req}</p>
        ) : (
          <>
            <p className="mb-4 text-sm text-[var(--muted)]">
              <strong className="text-[var(--foreground)]">{req.clientName}</strong> wants{' '}
              <strong className="text-[var(--foreground)]">read-only</strong> access to your transactions,
              balances and budget data so it can answer questions. It cannot change anything.
            </p>
            <ApproveForm params={params} />
          </>
        )}
      </div>
    </div>
  )
}
