'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { logout } from '@/app/actions/auth'
import { GlobalSearch } from '@/app/components/GlobalSearch'
import { PwaBackButton } from '@/app/components/PwaBackButton'
import { LogoMark, LogoWordmark } from '@/app/components/Logo'

// Stroke icon paths (24×24 grid, lucide-style) — crisper than the old unicode
// glyphs and they inherit currentColor like everything else.
const ICON_PATHS: Record<string, React.ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </>
  ),
  budget: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  activity: (
    <>
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
      <path d="M14 8H8" />
      <path d="M16 12H8" />
      <path d="M13 16H8" />
    </>
  ),
  accounts: (
    <>
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </>
  ),
  reports: (
    <>
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
      <polyline points="16 7 22 7 22 13" />
    </>
  ),
  recap: (
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
  ),
  manage: (
    <>
      <line x1="21" x2="14" y1="4" y2="4" />
      <line x1="10" x2="3" y1="4" y2="4" />
      <line x1="21" x2="12" y1="12" y2="12" />
      <line x1="8" x2="3" y1="12" y2="12" />
      <line x1="21" x2="16" y1="20" y2="20" />
      <line x1="12" x2="3" y1="20" y2="20" />
      <line x1="14" x2="14" y1="2" y2="6" />
      <line x1="8" x2="8" y1="10" y2="14" />
      <line x1="16" x2="16" y1="18" y2="22" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" x2="9" y1="12" y2="12" />
    </>
  ),
}

function NavIcon({ name, className = 'h-[18px] w-[18px]' }: { name: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-none ${className}`}
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  )
}

const LINKS = [
  { href: '/', label: 'Overview', icon: 'overview' },
  { href: '/budget', label: 'Budget', icon: 'budget' },
  { href: '/transactions', label: 'Activity', icon: 'activity' },
  { href: '/accounts', label: 'Accounts', icon: 'accounts' },
  { href: '/reports', label: 'Reports', icon: 'reports' },
  { href: '/report', label: 'Recap', icon: 'recap' },
  { href: '/manage', label: 'Manage', icon: 'manage' },
]

// On mobile only the first few links live in the bottom bar; the rest collapse
// into a "More" sheet. Desktop shows the full list in the sidebar.
const MOBILE_PRIMARY_COUNT = 4
const MOBILE_PRIMARY = LINKS.slice(0, MOBILE_PRIMARY_COUNT)
const MOBILE_MORE = LINKS.slice(MOBILE_PRIMARY_COUNT)

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
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
        <div className="mb-6 flex items-center gap-1 px-2">
          <PwaBackButton />
          <Link
            href={navHref('/')}
            className="flex items-center gap-2"
          >
          <LogoMark className="h-8 w-10 flex-none" />
          <LogoWordmark className="text-[15px]" />
          </Link>
        </div>

        <GlobalSearch variant="desktop" />

        <nav className="flex flex-1 flex-col gap-0.5">
          {LINKS.map((l) => {
            const active = isActive(pathname, l.href)
            return (
              <Link
                key={l.href}
                href={navHref(l.href)}
                className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-all ${
                  active
                    ? 'bg-[color-mix(in_srgb,var(--accent)_13%,transparent)] text-[var(--accent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_25%,transparent)]'
                    : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]'
                }`}
              >
                <NavIcon name={l.icon} />
                {l.label}
              </Link>
            )
          })}
        </nav>

        <p className="px-3 pb-2 text-[10px] leading-relaxed text-[var(--muted)] opacity-70">
          Family funds under 24/7 surveillance.
          <br />
          The money knows.
        </p>
        <form action={logout}>
          <button
            type="submit"
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-[var(--muted)] transition-colors hover:text-[var(--negative)]"
          >
            <NavIcon name="logout" />
            Sign out
          </button>
        </form>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--background)_85%,transparent)] backdrop-blur sm:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-1">
            <PwaBackButton />
            <Link href={navHref('/')} className="flex items-center gap-2">
            <LogoMark className="h-7 w-9 flex-none" />
            <LogoWordmark className="text-[15px]" />
            </Link>
          </div>
          <div className="flex items-center gap-1">
            <GlobalSearch variant="mobile" />
            <form action={logout}>
              <button
                type="submit"
                className="rounded-lg px-2 py-1 text-xs font-medium text-[var(--muted)]"
              >
                Sign out
              </button>
            </form>
          </div>
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
                        ? 'bg-[color-mix(in_srgb,var(--accent)_13%,transparent)] text-[var(--accent)]'
                        : 'text-[var(--foreground)]'
                    }`}
                  >
                    <NavIcon name={l.icon} />
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
                <NavIcon name="logout" />
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
              className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium ${
                active ? 'text-[var(--accent)]' : 'text-[var(--muted)]'
              }`}
            >
              <NavIcon name={l.icon} className="h-[19px] w-[19px]" />
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
