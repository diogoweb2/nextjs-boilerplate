'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  FEATURE_INDEX,
  slugifyAnchor,
  type SearchResult,
  type SearchTag,
} from '@/app/lib/search-index'

/**
 * The global search box (nav sidebar on desktop, 🔍 overlay on mobile).
 * Autocomplete-only — there is no results page. Two sources, merged:
 *  - FEATURE_INDEX matched locally on every keystroke (instant), so pages and
 *    sections ("50/30/20 rule", "Spending pace") always appear first;
 *  - /api/search fetched with a short debounce for merchants, transactions,
 *    categories, projects and goals.
 * Selecting a result navigates; a #hash href also smooth-scrolls to the card
 * and flashes it (Card ids come from slugifyAnchor of the title).
 * Shortcuts: ⌘K / Ctrl+K or "/" focuses the box.
 */

const TAG_STYLE: Record<SearchTag, { label: string; className: string }> = {
  feature: { label: 'feature', className: 'bg-[var(--accent)] text-[var(--accent-fg)]' },
  transaction: { label: 'transaction', className: 'bg-[var(--surface-2)] text-[var(--muted)]' },
  merchant: { label: 'merchant', className: 'bg-emerald-500/15 text-emerald-500' },
  category: { label: 'category', className: 'bg-sky-500/15 text-sky-500' },
  project: { label: 'project', className: 'bg-violet-500/15 text-violet-500' },
  goal: { label: 'goal', className: 'bg-amber-500/15 text-amber-500' },
}

const MAX_FEATURES = 6

/** Rank features: label prefix > label substring > keyword > breadcrumb. */
function matchFeatures(q: string): SearchResult[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  const scored: { score: number; r: SearchResult }[] = []
  for (const f of FEATURE_INDEX) {
    const label = f.label.toLowerCase()
    let score = 0
    if (label.startsWith(needle)) score = 4
    else if (label.includes(needle)) score = 3
    else if (f.keywords?.some((k) => k.includes(needle))) score = 2
    else if (f.page.toLowerCase().includes(needle)) score = 1
    if (score > 0) {
      scored.push({
        score,
        r: { tag: 'feature', label: f.label, sublabel: f.page, href: f.href },
      })
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FEATURES)
    .map((s) => s.r)
}

/** Scroll to a card that may not be in the DOM yet (page still streaming in). */
function scrollToAnchor(id: string) {
  let tries = 0
  const tick = () => {
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      el.classList.add('search-flash')
      setTimeout(() => el.classList.remove('search-flash'), 2500)
    } else if (++tries < 30) {
      setTimeout(tick, 100)
    }
  }
  tick()
}

export function GlobalSearch({ variant }: { variant: 'desktop' | 'mobile' }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [dbResults, setDbResults] = useState<SearchResult[]>([])
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const features = useMemo(() => matchFeatures(query), [query])
  const results = useMemo(() => [...features, ...dbResults], [features, dbResults])

  // Debounced DB fetch; abort the in-flight request on every keystroke.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setDbResults([])
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        })
        if (!res.ok) return
        const data = (await res.json()) as { results: SearchResult[] }
        setDbResults(data.results)
      } catch {
        // aborted or offline — keep whatever is showing
      }
    }, 150)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query])

  useEffect(() => setActive(0), [query])

  // ⌘K / Ctrl+K anywhere, or "/" outside a field, focuses the search box.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const inField =
        e.target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !inField)) {
        e.preventDefault()
        setOpen(true)
        // The mobile overlay input mounts on open; focus on the next frame.
        requestAnimationFrame(() => inputRef.current?.focus())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Click outside closes the dropdown.
  useEffect(() => {
    if (!open) return
    function onDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  const navigate = useCallback(
    (r: SearchResult) => {
      setOpen(false)
      setQuery('')
      inputRef.current?.blur()
      router.push(r.href)
      const hash = r.href.split('#')[1]
      if (hash) scrollToAnchor(hash)
    },
    [router]
  )

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      const r = results[active]
      if (r) navigate(r)
    } else if (e.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
    }
  }

  const panel = open && query.trim().length > 0 && (
    <div
      className={`z-50 max-h-[60vh] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg ${
        variant === 'desktop' ? 'absolute left-0 top-full mt-1 w-80' : 'mt-2'
      }`}
    >
      {results.length === 0 ? (
        <div className="px-3 py-4 text-center text-sm text-[var(--muted)]">No matches</div>
      ) : (
        results.map((r, i) => {
          const tag = TAG_STYLE[r.tag]
          return (
            <button
              key={`${r.tag}-${r.href}-${i}`}
              type="button"
              onClick={() => navigate(r)}
              onMouseEnter={() => setActive(i)}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${
                i === active ? 'bg-[var(--surface-2)]' : ''
              }`}
            >
              <span
                className={`flex-none rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tag.className}`}
              >
                {tag.label}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-[var(--foreground)]">
                  {r.label}
                </span>
                <span className="block truncate text-xs text-[var(--muted)]">{r.sublabel}</span>
              </span>
            </button>
          )
        })
      )}
    </div>
  )

  const input = (
    <input
      ref={inputRef}
      value={query}
      onChange={(e) => {
        setQuery(e.target.value)
        setOpen(true)
      }}
      onFocus={() => setOpen(true)}
      onKeyDown={onKeyDown}
      placeholder="Search…  ⌘K"
      className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)]"
      role="combobox"
      aria-expanded={open}
      aria-autocomplete="list"
    />
  )

  if (variant === 'desktop') {
    return (
      <div ref={rootRef} className="relative mb-4 px-1">
        {input}
        {panel}
      </div>
    )
  }

  // Mobile: a 🔍 button in the top bar; the box + results open as an overlay.
  return (
    <div ref={rootRef}>
      <button
        type="button"
        aria-label="Search"
        onClick={() => {
          setOpen(true)
          requestAnimationFrame(() => inputRef.current?.focus())
        }}
        className="rounded-lg border border-[var(--border)] p-2 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </button>
      {open && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute left-2 right-2 top-2 rounded-2xl border border-[var(--border)] bg-[var(--background)] p-2 shadow-lg">
            {input}
            {panel}
          </div>
        </div>
      )}
    </div>
  )
}
