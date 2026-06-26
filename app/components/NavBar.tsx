'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { logout } from '@/app/actions/auth'

const LINKS = [
  { href: '/', label: 'Overview', icon: '◎' },
  { href: '/budget', label: 'Budget', icon: '◇' },
  { href: '/transactions', label: 'Activity', icon: '≣' },
  { href: '/accounts', label: 'Accounts', icon: '◔' },
  { href: '/reports', label: 'Reports', icon: '↗' },
  { href: '/report', label: 'Recap', icon: '★' },
  { href: '/manage', label: 'Manage', icon: '⚙' },
]

// On mobile only the first few links live in the bottom bar; the rest collapse
// into a "More" sheet. Desktop shows the full list in the sidebar.
const MOBILE_PRIMARY_COUNT = 4
const MOBILE_PRIMARY = LINKS.slice(0, MOBILE_PRIMARY_COUNT)
const MOBILE_MORE = LINKS.slice(MOBILE_PRIMARY_COUNT)

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname.startsWith(href)
}

export function NavBar() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [moreOpen, setMoreOpen] = useState(false)

  // Close the mobile "More" sheet whenever the route changes.
  useEffect(() => {
    setMoreOpen(false)
  }, [pathname])

  const moreActive = MOBILE_MORE.some((l) => isActive(pathname, l.href))

  function navHref(href: string): string {
    const preserved: string[] = []
    const month = searchParams.get('month')
    const months = searchParams.get('months')
    const special = searchParams.get('special')
    if (href === '/reports') {
      // month has no meaning in reports/trends; default to 2M (skip 1M, it's not useful)
      const trendsMonths = months && months !== '1' ? months : '2'
      preserved.push(`months=${trendsMonths}`)
    } else {
      if (month) preserved.push(`month=${encodeURIComponent(month)}`)
    }
    if (special) preserved.push(`special=${encodeURIComponent(special)}`)
    return preserved.length ? `${href}?${preserved.join('&')}` : href
  }

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden sm:flex sm:w-52 sm:flex-none sm:flex-col sm:sticky sm:top-0 sm:h-screen sm:border-r sm:border-[var(--border)] sm:bg-[var(--background)] sm:px-3 sm:py-5">
        <Link
          href={navHref('/')}
          className="mb-6 flex items-center gap-2 px-2 font-bold tracking-tight"
        >
          <span className="grid h-7 w-7 flex-none place-items-center rounded-lg bg-[var(--accent)] text-sm text-[var(--accent-fg)]">
            $
          </span>
          <span>Family Budget</span>
        </Link>

        <nav className="flex flex-1 flex-col gap-0.5">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={navHref(l.href)}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive(pathname, l.href)
                  ? 'bg-[var(--surface-2)] text-[var(--foreground)]'
                  : 'text-[var(--muted)] hover:text-[var(--foreground)]'
              }`}
            >
              <span className="text-base leading-none">{l.icon}</span>
              {l.label}
            </Link>
          ))}
        </nav>

        <form action={logout}>
          <button
            type="submit"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-[var(--muted)] transition-colors hover:text-[var(--negative)]"
          >
            <span className="text-base leading-none">⏏</span>
            Sign out
          </button>
        </form>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--background)_85%,transparent)] backdrop-blur sm:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Link href={navHref('/')} className="flex items-center gap-2 font-bold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--accent)] text-sm text-[var(--accent-fg)]">
              $
            </span>
            <span>Family Budget</span>
          </Link>
          <form action={logout}>
            <button
              type="submit"
              className="rounded-lg px-2 py-1 text-xs font-medium text-[var(--muted)]"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      {/* More sheet (mobile) */}
      {moreOpen && (
        <div className="fixed inset-0 z-40 sm:hidden" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="absolute bottom-[4.25rem] left-2 right-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="grid grid-cols-2 gap-1">
              {MOBILE_MORE.map((l) => {
                const active = isActive(pathname, l.href)
                return (
                  <Link
                    key={l.href}
                    href={navHref(l.href)}
                    className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium ${
                      active
                        ? 'bg-[var(--surface-2)] text-[var(--accent)]'
                        : 'text-[var(--foreground)]'
                    }`}
                  >
                    <span className="text-base leading-none">{l.icon}</span>
                    {l.label}
                  </Link>
                )
              })}
            </div>
            <form action={logout} className="mt-1 border-t border-[var(--border)] pt-1">
              <button
                type="submit"
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-[var(--negative)]"
              >
                <span className="text-base leading-none">⏏</span>
                Sign out
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Bottom nav (mobile) */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 grid grid-cols-5 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_92%,transparent)] backdrop-blur sm:hidden">
        {MOBILE_PRIMARY.map((l) => {
          const active = isActive(pathname, l.href)
          return (
            <Link
              key={l.href}
              href={navHref(l.href)}
              className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium ${
                active ? 'text-[var(--accent)]' : 'text-[var(--muted)]'
              }`}
            >
              <span className="text-base leading-none">{l.icon}</span>
              {l.label}
            </Link>
          )
        })}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium ${
            moreOpen || moreActive ? 'text-[var(--accent)]' : 'text-[var(--muted)]'
          }`}
        >
          <span className="text-base leading-none">⋯</span>
          More
        </button>
      </nav>
    </>
  )
}
