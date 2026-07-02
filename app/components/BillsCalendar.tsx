import type { BillCalendar, CalendarBill, BillStatus } from '@/app/lib/bill-calendar'
import { daysInMonth } from '@/app/lib/projection'
import { formatCurrency, formatCurrencyCompact } from '@/app/lib/format'

/**
 * Bills & recurring calendar (§19) — a month view of every projected bill on
 * its expected day, paydays marked, actuals replacing projections as they post.
 * Desktop: a 7-column month grid. Mobile: a compact agenda list (the grid is
 * unusable at phone width). Server component — display only; each bill
 * deep-links to its merchant's transactions.
 */

const STATUS_STYLE: Record<BillStatus, string> = {
  paid: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  due: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  missed: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
}

const STATUS_TEXT: Record<BillStatus, string> = {
  paid: 'text-emerald-600 dark:text-emerald-400',
  due: 'text-amber-700 dark:text-amber-400',
  missed: 'text-red-600 dark:text-red-400',
}

const STATUS_ICON: Record<BillStatus, string> = { paid: '✓', due: '•', missed: '!' }
const STATUS_LABEL: Record<BillStatus, string> = { paid: 'paid', due: 'due', missed: 'missed' }

function billHref(b: CalendarBill): string {
  return `/transactions?period=all&q=${encodeURIComponent(b.label)}`
}

function BillChip({ bill }: { bill: CalendarBill }) {
  return (
    <a
      href={billHref(bill)}
      title={`${bill.label} — ${formatCurrency(bill.amount)} (${STATUS_LABEL[bill.status]}${bill.status === 'paid' ? '' : ', expected day'})`}
      className={`block truncate rounded border px-1 py-0.5 text-[10px] leading-tight font-medium transition-opacity hover:opacity-75 ${STATUS_STYLE[bill.status]}`}
    >
      {STATUS_ICON[bill.status]} {bill.label}
      <span className="ml-1 tabular-nums opacity-80">{formatCurrencyCompact(bill.amount)}</span>
    </a>
  )
}

export function BillsCalendar({ calendar, todayIso }: { calendar: BillCalendar; todayIso: string }) {
  const { ym, bills, paydays } = calendar
  const [y, m] = ym.split('-').map(Number)
  const days = daysInMonth(ym)
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay() // 0 = Sunday
  const today = todayIso.slice(0, 10)
  const todayDay = today.slice(0, 7) === ym ? Number(today.slice(8, 10)) : null

  const billsByDay = new Map<number, CalendarBill[]>()
  for (const b of bills) billsByDay.set(b.day, [...(billsByDay.get(b.day) ?? []), b])
  const paydaySet = new Set(paydays.map((p) => p.day))

  if (bills.length === 0 && paydays.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-[var(--muted)]">
        Nothing recurring expected this month. Bills come from the Home category and your
        confirmed projected bills — add more on Budget › Bills.
      </p>
    )
  }

  return (
    <div>
      {/* Totals + legend */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-[var(--muted)]">
        <span className="tabular-nums">
          <span className="font-semibold text-[var(--foreground)]">{formatCurrency(calendar.totalPaid)}</span> bills paid ·{' '}
          <span className="font-semibold text-[var(--foreground)]">{formatCurrency(calendar.totalUpcoming)}</span>{' '}
          still to come
          {bills.some((b) => b.billKey === 'cc') && <span> (credit card payment not counted)</span>}
        </span>
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          <span className="text-emerald-600 dark:text-emerald-400">✓ paid</span>
          <span className="text-amber-700 dark:text-amber-400">• due</span>
          <span className="text-red-600 dark:text-red-400">! missed</span>
          <span>💰 payday</span>
        </span>
      </div>

      {/* Desktop / tablet: month grid */}
      <div className="hidden sm:block">
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--border)]">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} className="bg-[var(--surface-2)] px-2 py-1 text-center text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
              {d}
            </div>
          ))}
          {Array.from({ length: firstWeekday }, (_, i) => (
            <div key={`pad-${i}`} className="min-h-[4.5rem] bg-[var(--surface)] opacity-50" />
          ))}
          {Array.from({ length: days }, (_, i) => {
            const day = i + 1
            const isToday = day === todayDay
            return (
              <div
                key={day}
                className={`min-h-[4.5rem] bg-[var(--surface)] p-1 ${isToday ? 'ring-2 ring-inset ring-[var(--accent)]' : ''}`}
              >
                <div className="mb-0.5 flex items-center justify-between px-0.5">
                  <span className={`text-[10px] tabular-nums ${isToday ? 'font-bold' : 'text-[var(--muted)]'}`}>{day}</span>
                  {paydaySet.has(day) && (
                    <span title={paydays.filter((p) => p.day === day).map((p) => `${p.label} ${formatCurrency(p.amount)}${p.actual ? '' : ' (expected)'}`).join(', ')}>
                      💰
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-0.5">
                  {(billsByDay.get(day) ?? []).map((b) => (
                    <BillChip key={b.billKey} bill={b} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Mobile: agenda list */}
      <ul className="flex flex-col divide-y divide-[var(--border)] sm:hidden">
        {Array.from(new Set([...billsByDay.keys(), ...paydaySet])).sort((a, b) => a - b).map((day) => (
          <li key={day} className={`flex gap-3 py-2 ${day === todayDay ? 'font-medium' : ''}`}>
            <span className={`w-8 shrink-0 pt-0.5 text-right text-sm tabular-nums ${day === todayDay ? 'font-bold' : 'text-[var(--muted)]'}`}>
              {day}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {paydays.filter((p) => p.day === day).map((p, i) => (
                <span key={`p-${i}`} className="text-sm">
                  💰 {p.label}{' '}
                  <span className="tabular-nums text-[var(--muted)]">
                    {formatCurrency(p.amount)}{p.actual ? '' : ' expected'}
                  </span>
                </span>
              ))}
              {(billsByDay.get(day) ?? []).map((b) => (
                <a key={b.billKey} href={billHref(b)} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">
                    <span className={STATUS_TEXT[b.status]}>{STATUS_ICON[b.status]}</span>{' '}
                    {b.label}
                  </span>
                  <span className="shrink-0 tabular-nums text-[var(--muted)]">{formatCurrency(b.amount)}</span>
                </a>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
