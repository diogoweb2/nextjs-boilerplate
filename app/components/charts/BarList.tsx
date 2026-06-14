import { formatCurrency } from '@/app/lib/format'

export type BarItem = {
  label: string
  amount: number
  sublabel?: string
  color?: string
}

/** Horizontal bar list — great for "top merchants" / rankings, mobile-friendly. */
export function BarList({ items, accent = 'var(--accent)' }: { items: BarItem[]; accent?: string }) {
  const max = Math.max(1, ...items.map((i) => i.amount))
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item) => (
        <li key={item.label} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-medium text-[var(--foreground)]">{item.label}</span>
            <span className="shrink-0 tabular-nums font-semibold">
              {formatCurrency(item.amount)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
              <div
                className="h-full rounded-full"
                style={{ width: `${(item.amount / max) * 100}%`, background: item.color ?? accent }}
              />
            </div>
            {item.sublabel && (
              <span className="w-16 shrink-0 text-right text-xs text-[var(--muted)]">
                {item.sublabel}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
