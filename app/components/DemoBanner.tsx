import { isDemoSession } from '@/app/lib/demo'
import { logout } from '@/app/actions/auth'

/**
 * Sticky banner shown only during a read-only DEMO session. Rendered from the
 * root layout (a server component not imported by any client component) so the
 * server-only next/headers import here never taints a client bundle.
 */
export async function DemoBanner() {
  if (!(await isDemoSession())) return null
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-500 px-4 py-1.5 text-center text-xs font-medium text-amber-950">
      <span>🔍 Demo mode — sample data, editing is disabled.</span>
      <form action={logout}>
        <button type="submit" className="underline underline-offset-2 hover:no-underline">
          Exit demo
        </button>
      </form>
    </div>
  )
}
