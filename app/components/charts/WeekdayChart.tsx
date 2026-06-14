import { formatCurrencyCompact, weekdayLabel } from '@/app/lib/format'

/** Vertical bars for spend-by-weekday. Weekend (Sat/Sun) bars are accented. */
export function WeekdayChart({ data }: { data: { weekday: number; amount: number }[] }) {
  // Reorder to Mon..Sun for a more natural week view.
  const order = [1, 2, 3, 4, 5, 6, 0]
  const ordered = order.map((w) => data.find((d) => d.weekday === w) ?? { weekday: w, amount: 0 })
  const max = Math.max(1, ...ordered.map((d) => d.amount))

  return (
    <div className="flex h-40 items-end justify-between gap-2">
      {ordered.map((d) => {
        const isWeekend = d.weekday === 0 || d.weekday === 6
        return (
          <div key={d.weekday} className="flex flex-1 flex-col items-center gap-1.5">
            <div className="flex w-full flex-1 items-end">
              <div
                className="w-full rounded-t-md transition-all"
                style={{
                  height: `${(d.amount / max) * 100}%`,
                  minHeight: d.amount > 0 ? 4 : 0,
                  background: isWeekend ? 'var(--accent)' : 'color-mix(in srgb, var(--accent) 45%, transparent)',
                }}
                title={`${weekdayLabel(d.weekday)}: ${formatCurrencyCompact(d.amount)}`}
              />
            </div>
            <span className="text-[10px] font-medium text-[var(--muted)]">
              {weekdayLabel(d.weekday).slice(0, 1)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
