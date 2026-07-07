'use client'

import { useEffect, useState } from 'react'

type ThemeChoice = 'light' | 'dark' | 'system'

// Per-device preference: lives in localStorage only, so the office browser and
// the phone can disagree in peace. The pre-paint script in layout.tsx reads the
// same key; this control just writes it and re-resolves the <html> attribute.
const KEY = 'theme'

function apply(choice: ThemeChoice) {
  const dark =
    choice === 'dark' ||
    (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

const OPTIONS: { value: ThemeChoice; label: string; icon: React.ReactNode; blurb: string }[] = [
  {
    value: 'light',
    label: 'Light',
    blurb: 'For counting money in broad daylight.',
    icon: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </>
    ),
  },
  {
    value: 'dark',
    label: 'Dark',
    blurb: 'Vault mode. The losses hurt less in the dark.',
    icon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  },
  {
    value: 'system',
    label: 'System',
    blurb: 'Let the device decide. One less decision to regret.',
    icon: (
      <>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </>
    ),
  },
]

export function ThemeToggle() {
  // Render "system" on the server, swap in the stored choice after mount —
  // avoids a hydration mismatch since localStorage is client-only.
  const [choice, setChoice] = useState<ThemeChoice>('system')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem(KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') setChoice(stored)
    setMounted(true)
  }, [])

  function select(next: ThemeChoice) {
    setChoice(next)
    localStorage.setItem(KEY, next)
    apply(next)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
        {OPTIONS.map((o) => {
          const active = mounted && choice === o.value
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => select(o.value)}
              className={`flex flex-col items-center gap-2 rounded-xl border px-3 py-4 text-sm font-medium transition-all ${
                active
                  ? 'border-[color-mix(in_srgb,var(--accent)_50%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--accent)]'
                  : 'border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)]'
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-6 w-6"
                aria-hidden="true"
              >
                {o.icon}
              </svg>
              {o.label}
            </button>
          )
        })}
      </div>
      <p className="text-xs text-[var(--muted)]">
        {OPTIONS.find((o) => o.value === choice)?.blurb}
      </p>
      <p className="text-xs text-[var(--muted)] opacity-70">
        Saved on this device only — your phone keeps its own opinion.
      </p>
    </div>
  )
}
