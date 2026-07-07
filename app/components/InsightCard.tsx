import type { InsightCard as InsightCardData, InsightTone } from '@/app/lib/insights'

const TONE_STYLES: Record<InsightTone, { ring: string; chip: string; icon: string }> = {
  good: {
    ring: 'border-l-[var(--positive)]',
    chip: 'text-[var(--positive)]',
    icon: '✓',
  },
  warn: {
    ring: 'border-l-amber-500',
    chip: 'text-amber-500',
    icon: '!',
  },
  up: {
    ring: 'border-l-[var(--negative)]',
    chip: 'text-[var(--negative)]',
    icon: '↑',
  },
  down: {
    ring: 'border-l-[var(--positive)]',
    chip: 'text-[var(--positive)]',
    icon: '↓',
  },
  neutral: {
    ring: 'border-l-[var(--accent)]',
    chip: 'text-[var(--accent)]',
    icon: '★',
  },
}

export function InsightCard({ card }: { card: InsightCardData }) {
  const s = TONE_STYLES[card.tone]
  const inner = (
    <div className="flex items-start gap-2.5">
      <span
        className={`mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full bg-[var(--surface-2)] text-xs font-bold ${s.chip}`}
      >
        {s.icon}
      </span>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold leading-snug">{card.title}</span>
        <span className="text-xs leading-relaxed text-[var(--muted)]">{card.detail}</span>
      </div>
    </div>
  )
  if (card.href) {
    return (
      <a href={card.href} className={`card animate-in border-l-4 ${s.ring} p-4 block hover:opacity-80 transition-opacity`}>
        {inner}
      </a>
    )
  }
  return (
    <div className={`card animate-in border-l-4 ${s.ring} p-4`}>
      {inner}
    </div>
  )
}
