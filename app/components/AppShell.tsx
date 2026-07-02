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
          {title && <h2 className="text-sm font-semibold text-[var(--foreground)]">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

/** Empty-state placeholder. */
export function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-8 text-center text-sm text-[var(--muted)]">{children}</div>
  )
}
