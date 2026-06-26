'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export interface SectionTab {
  href: string
  label: string
  /** If true, this tab is active only on an exact pathname match (not prefix). */
  exact?: boolean
}

export function SectionTabs({ tabs }: { tabs: SectionTab[] }) {
  const pathname = usePathname()

  function isActive(tab: SectionTab): boolean {
    if (tab.exact) return pathname === tab.href
    return pathname === tab.href || pathname.startsWith(tab.href + '/')
  }

  return (
    <div className="mb-5 flex gap-1 overflow-x-auto rounded-xl bg-[var(--surface-2)] p-1">
      {tabs.map((tab) => {
        const active = isActive(tab)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex-none rounded-lg px-4 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
              active
                ? 'bg-[var(--background)] text-[var(--foreground)] shadow-sm'
                : 'text-[var(--muted)] hover:text-[var(--foreground)]'
            }`}
          >
            {tab.label}
          </Link>
        )
      })}
    </div>
  )
}
