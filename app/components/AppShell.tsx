import { NavBar } from '@/app/components/NavBar'
import { slugifyAnchor } from '@/app/lib/search-index'

/** Page chrome: top + bottom nav with a centered, padded content column. */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen sm:flex">
      <NavBar />
      <main className="mx-auto max-w-5xl px-4 pb-24 pt-5 sm:flex-1 sm:min-w-0 sm:pb-10 sm:pt-6">{children}</main>
    </div>
  )
}

/** Standard titled surface card used across pages. */
export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    // Titled cards get a stable anchor id so global search can deep-link and
    // scroll to them (see app/lib/search-index.ts).
    <section
      id={title ? slugifyAnchor(title) : undefined}
      className={`card scroll-mt-20 p-4 sm:p-5 ${className}`}
    >
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && (
            <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-[var(--foreground)]">
              <span
                aria-hidden="true"
                className="h-3.5 w-1 flex-none rounded-full bg-[var(--accent)]"
              />
              {title}
            </h2>
          )}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

// Every empty state gets a house-brand epitaph. Picked by hashing the hint text
// so it's stable across renders (server components — no hydration surprises).
const EMPTY_QUIPS = [
  'Suspiciously quiet in here.',
  'No money was harmed in this view. Yet.',
  'Emptier than the account after Costco.',
  'Nothing here. The money saw you coming.',
  'Zero records. If only the credit card felt the same.',
  'All clear — a rare sight in this family.',
]

function quipFor(children: React.ReactNode): string {
  const s = typeof children === 'string' ? children : JSON.stringify(children ?? '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return EMPTY_QUIPS[Math.abs(h) % EMPTY_QUIPS.length]
}

/** Empty-state placeholder with a rotating deadpan one-liner. */
export function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 py-8 text-center text-sm text-[var(--muted)]">
      <span
        aria-hidden="true"
        className="mb-1 grid h-9 w-9 place-items-center rounded-full bg-[var(--surface-2)] text-base"
      >
        🪙
      </span>
      <div>{children}</div>
      <div className="text-xs italic opacity-70">{quipFor(children)}</div>
    </div>
  )
}
