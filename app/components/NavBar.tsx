'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { logout } from '@/app/actions/auth'

const LINKS = [
  { href: '/', label: 'Overview', icon: '◎' },
  { href: '/trends', label: 'Trends', icon: '↗' },
  { href: '/merchants', label: 'Merchants', icon: '◆' },
  { href: '/transactions', label: 'Activity', icon: '≣' },
]

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname.startsWith(href)
}

export function NavBar() {
  const pathname = usePathname()

  return (
    <>
      {/* Top bar (all viewports) */}
      <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--background)_85%,transparent)] backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link href="/" className="flex items-center gap-2 font-bold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--accent)] text-sm text-[var(--accent-fg)]">
              $
            </span>
            <span>Family Budget</span>
          </Link>

          <nav className="hidden items-center gap-1 sm:flex">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  isActive(pathname, l.href)
                    ? 'bg-[var(--surface-2)] text-[var(--foreground)]'
                    : 'text-[var(--muted)] hover:text-[var(--foreground)]'
                }`}
              >
                {l.label}
              </Link>
            ))}
            <form action={logout}>
              <button
                type="submit"
                className="ml-1 rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--muted)] transition-colors hover:text-[var(--negative)]"
              >
                Sign out
              </button>
            </form>
          </nav>

          <form action={logout} className="sm:hidden">
            <button
              type="submit"
              className="rounded-lg px-2 py-1 text-xs font-medium text-[var(--muted)]"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      {/* Bottom nav (mobile) */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 grid grid-cols-4 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_92%,transparent)] backdrop-blur sm:hidden">
        {LINKS.map((l) => {
          const active = isActive(pathname, l.href)
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium ${
                active ? 'text-[var(--accent)]' : 'text-[var(--muted)]'
              }`}
            >
              <span className="text-base leading-none">{l.icon}</span>
              {l.label}
            </Link>
          )
        })}
      </nav>
    </>
  )
}
