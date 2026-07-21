'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card } from '@/app/components/AppShell'
import { RetirementChart } from '@/app/components/charts/RetirementChart'
import { formatCurrency, formatCurrencyCompact } from '@/app/lib/format'
import type { RetirementData } from '@/app/actions/retirement'
import { saveParams, resetParams, saveRrspBalance } from '@/app/actions/retirement'
import {
  buildRetirementPlan,
  type RetirementParams,
  type LifestyleTier,
  type PlanResult,
} from '@/app/lib/retirement'
import { buildAdvice } from '@/app/lib/retirement-advice'

const ACCENT = '#6366f1'
const TIER_LABELS: Record<LifestyleTier, string> = {
  essentials: 'Essentials',
  today: "Today's Life",
  snowbird: 'Snowbird Dream',
}
const TIER_BULLETS: Record<LifestyleTier, string[]> = {
  essentials: ['One car, home paid off', 'Groceries, health & dental covered', 'Half the dining out, no travel'],
  today: ['Your current lifestyle', 'Minus the mortgage & kids', 'Plus your usual travel'],
  snowbird: ['6 months in a Brazil beach city', '2 Brazil + 1 Europe trip a year', 'Private travel health cover'],
}

function mo(v: number) {
  return `${formatCurrencyCompact(v)}/mo`
}

export function RetirementPlan({ data }: { data: RetirementData }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  // Working params (play mode). Start from the saved/effective params.
  const [params, setParams] = useState<RetirementParams>(data.params)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Live recompute on every change — the engine is pure & fast.
  const plan = useMemo(() => buildRetirementPlan(data.inputs, params), [data.inputs, params])
  const advice = useMemo(() => buildAdvice(plan, params, data), [plan, params, data])
  // Baseline = the plan under the saved params, for the live "what changed" readout.
  const basePlan = useMemo(() => buildRetirementPlan(data.inputs, data.params), [data.inputs, data.params])

  const dirty = useMemo(() => JSON.stringify(params) !== JSON.stringify(data.params), [params, data.params])

  const chartRows = plan.rows.map((r, i) => ({
    year: r.year,
    capitalReal: r.capitalReal,
    neededReal: r.neededReal,
    crisisReal: plan.crisisCapitalReal[i] ?? r.capitalReal,
  }))

  const set = <K extends keyof RetirementParams>(key: K, value: RetirementParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }))

  const onSave = () => {
    // Only send keys that differ from the engine defaults (overrides only).
    const overrides = diffOverrides(params, data.defaults)
    startTransition(async () => {
      await saveParams(overrides)
      router.refresh()
    })
  }
  const onDiscard = () => setParams(data.params)
  const onRestore = () => {
    startTransition(async () => {
      await resetParams()
      router.refresh()
    })
    setParams(data.defaults)
  }

  const gap = plan.monthlyGapReal
  const onTrack = plan.onTrack
  // Primary verdict = does the money last to plan end (same test the consultant
  // recommendation uses). A negative year-one gap while still surviving means later
  // pensions (CPP/OAS) backfill the early years — that's a bridge, not a shortfall.
  const survives = plan.survivesToPlanEnd
  const earlyYearsBridge = survives && gap < 0
  const couldRetireEarlier =
    survives && plan.recommendedRetireAge != null && plan.recommendedRetireAge < plan.selfRetireAge

  return (
    <div className="space-y-6">
      {/* ─────────────── Hero verdict ─────────────── */}
      <Card>
        <div className="space-y-3">
          <p className="text-lg sm:text-xl font-semibold leading-snug">
            In <span style={{ color: ACCENT }}>{plan.retirementYear}</span>, at{' '}
            {plan.selfRetireAge} &amp; {plan.partnerRetireAge}, your family will have{' '}
            <span style={{ color: ACCENT }}>≈ {mo(plan.incomeAtRetirementReal)}</span>.
          </p>
          <p className="text-base text-[var(--muted)]">
            The <strong>{TIER_LABELS[params.lifestyle]}</strong> lifestyle needs{' '}
            {mo(plan.lifestyleMonthlyReal)}.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            {(() => {
              const color = onTrack ? '#10b981' : earlyYearsBridge ? '#f59e0b' : '#ef4444'
              const label = onTrack
                ? couldRetireEarlier
                  ? `AHEAD — you could retire at ${plan.recommendedRetireAge}`
                  : 'ON TRACK ✓'
                : earlyYearsBridge
                  ? `LASTS TO ${params.planToAge} — ${mo(Math.abs(gap))} below target`
                  : `${mo(Math.abs(gap))} short`
              return (
                <span
                  className="inline-flex items-center rounded-full px-3 py-1 text-sm font-bold"
                  style={{
                    background: `color-mix(in srgb, ${color} 15%, transparent)`,
                    color,
                  }}
                >
                  {label}
                </span>
              )
            })()}
            {!plan.survivesCrisis && (
              <span className="text-xs text-[#f59e0b]">⚠ may not survive a historical market crash</span>
            )}
          </div>
          {advice[0] && <p className="text-sm leading-relaxed">{advice[0].headline}</p>}
        </div>
      </Card>

      {/* ─────────────── The two sliders ─────────────── */}
      <Card title="Your plan">
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium mb-2">
              Retirement age: <span style={{ color: ACCENT }}>{params.retirementAge}</span>
            </label>
            <input
              type="range"
              min={50}
              max={70}
              value={params.retirementAge}
              onChange={(e) => set('retirementAge', Number(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-[var(--muted)] mt-1">
              <span>50</span>
              {plan.recommendedRetireAge && <span>consultant: {plan.recommendedRetireAge}</span>}
              <span>70</span>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Lifestyle</label>
            <div className="grid grid-cols-3 gap-2">
              {(['essentials', 'today', 'snowbird'] as LifestyleTier[]).map((tier) => {
                const active = params.lifestyle === tier
                return (
                  <button
                    key={tier}
                    onClick={() => set('lifestyle', tier)}
                    className="text-left rounded-lg border p-2 transition"
                    style={{
                      borderColor: active ? ACCENT : 'var(--border)',
                      background: active ? 'color-mix(in srgb, #6366f1 8%, transparent)' : 'transparent',
                    }}
                  >
                    <div className="text-xs font-semibold">{TIER_LABELS[tier]}</div>
                    <div className="text-sm font-bold" style={{ color: active ? ACCENT : undefined }}>
                      {mo(params.tierMonthly[tier])}
                    </div>
                    <ul className="mt-1 text-[10px] text-[var(--muted)] leading-tight space-y-0.5">
                      {TIER_BULLETS[tier].map((b) => (
                        <li key={b}>· {b}</li>
                      ))}
                    </ul>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </Card>

      {/* ─────────────── Centerpiece chart ─────────────── */}
      <Card title="Where you are vs. where you should be">
        <RetirementChart
          rows={chartRows}
          retirementYear={plan.retirementYear}
          currentYear={data.inputs.currentYear}
        />
        <div className="mt-2 flex items-center gap-4 text-xs text-[var(--muted)] flex-wrap">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-0.5" style={{ background: ACCENT }} /> You (investable)
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 border-t border-dashed" style={{ borderColor: 'var(--muted)' }} /> Needed
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-2" style={{ background: 'color-mix(in srgb, #f59e0b 20%, transparent)' }} /> If markets crash
          </span>
        </div>
        <p className="mt-3 text-sm">
          You are{' '}
          <strong style={{ color: plan.capitalVsNeededAtRetireReal >= 0 ? '#10b981' : '#ef4444' }}>
            {formatCurrency(Math.abs(plan.capitalVsNeededAtRetireReal))}{' '}
            {plan.capitalVsNeededAtRetireReal >= 0 ? 'ahead of' : 'behind'}
          </strong>{' '}
          the curve for retiring at {plan.selfRetireAge}.
        </p>
      </Card>

      {/* ─────────────── Income waterfall ─────────────── */}
      <Card title="Your monthly income at retirement">
        <div className="space-y-2">
          {plan.incomeLayers.map((l) => {
            const negative = l.monthlyReal < 0
            const pct = plan.incomeAtRetirementReal > 0
              ? (Math.abs(l.monthlyReal) / plan.incomeAtRetirementReal) * 100
              : 0
            return (
              <div key={l.key}>
                <div className="flex justify-between text-sm mb-0.5">
                  <span>{l.label}</span>
                  <span className="font-medium" style={negative ? { color: '#ef4444' } : undefined}>
                    {negative ? `− ${mo(Math.abs(l.monthlyReal))}` : mo(l.monthlyReal)}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-[var(--border)] overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.min(100, pct)}%`, background: negative ? '#ef4444' : ACCENT }}
                  />
                </div>
              </div>
            )
          })}
          <div className="flex justify-between text-sm font-bold pt-2 border-t border-[var(--border)]">
            <span>Total (after tax)</span>
            <span>{mo(plan.incomeAtRetirementReal)}</span>
          </div>
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">
          Today&apos;s dollars, once every pension is in pay. If you retire before CPP/OAS start,
          your savings bridge those years — see &ldquo;when to move money&rdquo; below.
        </p>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Her hospital pension (HOOPP) alone is worth ≈{' '}
          {formatCurrencyCompact((plan.hooppAnnualReal / 12) * 12 * 25)} in an RRSP — guaranteed for
          life and inflation-protected.
        </p>
      </Card>

      {/* ─────────────── Timeline ─────────────── */}
      <Card title="Your plan timeline">
        <Timeline data={data} plan={plan} params={params} />
      </Card>

      {/* ─────────────── Advice cards ─────────────── */}
      <Card title="What your consultant says">
        <div className="grid gap-3 sm:grid-cols-2">
          {advice.slice(0, 4).map((a) => (
            <div key={a.key} className="rounded-lg border border-[var(--border)] p-3">
              <div className="text-sm font-semibold mb-1">{a.title}</div>
              <p className="text-sm text-[var(--muted)] leading-relaxed">{a.body}</p>
              {a.href && (
                <Link href={a.href} className="text-xs mt-1 inline-block" style={{ color: ACCENT }}>
                  {a.linkLabel ?? 'View →'}
                </Link>
              )}
            </div>
          ))}
        </div>
        {plan.drawPhases.length > 0 && (
          <div className="mt-4">
            <div className="text-sm font-semibold mb-2">When to move money (and how much)</div>
            <div className="space-y-1 text-sm">
              {plan.drawPhases
                .filter((ph) => ph.rrspMonthly > 0 || ph.tfsaMonthly > 0)
                .map((ph, i) => (
                  <div key={i} className="text-[var(--muted)]">
                    Ages {ph.fromAge}–{ph.toAge}:{' '}
                    {ph.rrspMonthly > 0 && <span>withdraw {mo(ph.rrspMonthly)} from RRSP</span>}
                    {ph.rrspMonthly > 0 && ph.tfsaMonthly > 0 && ' + '}
                    {ph.tfsaMonthly > 0 && <span>{mo(ph.tfsaMonthly)} from TFSA</span>}
                  </div>
                ))}
            </div>
          </div>
        )}
      </Card>

      {/* ─────────────── Parameters drawer ─────────────── */}
      <div>
        <button
          onClick={() => setDrawerOpen((o) => !o)}
          className="text-sm text-[var(--muted)] underline"
        >
          {drawerOpen ? '▾ Hide' : '▸'} Assumptions &amp; controls
        </button>
        {drawerOpen && (
          <Card>
            <ParamsDrawer
              params={params}
              defaults={data.defaults}
              data={data}
              set={set}
              advancedOpen={advancedOpen}
              setAdvancedOpen={setAdvancedOpen}
              pending={pending}
              startTransition={startTransition}
              router={router}
              basePlan={basePlan}
              plan={plan}
            />
          </Card>
        )}
        <p className="mt-3 text-[11px] text-[var(--muted)]">
          Rules last verified {data.rulesLastVerified}. A planning model, not advice —{' '}
          <em>your</em> model, which is better. CPP is reconstructed from two salary points; check
          your real number at My Service Canada.
        </p>
      </div>

      {/* ─────────────── Sticky save bar (play mode) ─────────────── */}
      {dirty && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--background)] px-4 py-2 shadow-lg">
          <span className="text-xs text-[var(--muted)]">
            Unsaved changes<DeltaSummary base={basePlan} cur={plan} />
          </span>
          <button onClick={onSave} disabled={pending} className="rounded-full px-3 py-1 text-sm font-medium text-white" style={{ background: ACCENT }}>
            Save
          </button>
          <button onClick={onDiscard} disabled={pending} className="rounded-full border border-[var(--border)] px-3 py-1 text-sm">
            Discard
          </button>
          <button onClick={onRestore} disabled={pending} className="rounded-full px-3 py-1 text-sm text-[var(--muted)]">
            Restore defaults
          </button>
        </div>
      )}
    </div>
  )
}

/* ─────────────── Timeline ─────────────── */

function Timeline({
  data,
  plan,
  params,
}: {
  data: RetirementData
  plan: ReturnType<typeof buildRetirementPlan>
  params: RetirementParams
}) {
  const pins: { year: number; label: string; emoji: string }[] = []
  pins.push({ year: data.inputs.mortgagePayoffYear, label: 'mortgage-free', emoji: '🎉' })
  if (!params.rdspOpen) pins.push({ year: data.inputs.currentYear + 1, label: 'open the RDSP', emoji: '🎁' })
  pins.push({ year: plan.retirementYear, label: 'retire', emoji: '🏖️' })
  pins.push({ year: data.inputs.self.birthYear + params.selfCppAge, label: 'CPP starts', emoji: '💵' })
  pins.push({ year: data.inputs.self.birthYear + params.selfOasAge, label: 'OAS starts', emoji: '🍁' })
  pins.push({ year: data.inputs.self.birthYear + 71, label: 'RRSP → RRIF', emoji: '🔁' })
  pins.sort((a, b) => a.year - b.year)

  const minYear = pins[0].year
  const maxYear = pins[pins.length - 1].year
  const span = Math.max(1, maxYear - minYear)

  return (
    <div className="relative pt-2 pb-8">
      <div className="absolute left-0 right-0 top-4 h-0.5 bg-[var(--border)]" />
      <div className="relative h-8">
        {pins.map((p, i) => {
          const left = ((p.year - minYear) / span) * 100
          return (
            <div
              key={i}
              className="absolute -translate-x-1/2 flex flex-col items-center"
              style={{ left: `${left}%` }}
              title={`${p.year}: ${p.label}`}
            >
              <span className="text-base leading-none">{p.emoji}</span>
              <span className="mt-1 text-[10px] text-[var(--muted)] whitespace-nowrap">{p.year}</span>
              <span className="text-[10px] font-medium whitespace-nowrap">{p.label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ─────────────── Parameters drawer ─────────────── */

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium">{label}</span>
      {hint && <span className="block text-[11px] text-[var(--muted)] mb-1">{hint}</span>}
      {children}
    </label>
  )
}

function NumField({ value, onChange, step = 1, suffix }: { value: number; onChange: (v: number) => void; step?: number; suffix?: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        value={value}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-28 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-sm"
      />
      {suffix && <span className="text-xs text-[var(--muted)]">{suffix}</span>}
    </span>
  )
}

function ParamsDrawer({
  params,
  defaults,
  data,
  set,
  advancedOpen,
  setAdvancedOpen,
  pending,
  startTransition,
  router,
  basePlan,
  plan,
}: {
  params: RetirementParams
  defaults: RetirementParams
  data: RetirementData
  set: <K extends keyof RetirementParams>(key: K, value: RetirementParams[K]) => void
  advancedOpen: boolean
  setAdvancedOpen: (v: boolean) => void
  pending: boolean
  startTransition: React.TransitionStartFunction
  router: ReturnType<typeof useRouter>
  basePlan: PlanResult
  plan: PlanResult
}) {
  const [rrspSelf, setRrspSelf] = useState(String(data.rrsp.self))
  const [rrspPartner, setRrspPartner] = useState(String(data.rrsp.partner))

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`

  return (
    <div className="space-y-5">
      <div className="text-xs text-[var(--muted)]">
        Each control shows the consultant&apos;s default. Changes preview live; nothing saves until you
        press Save.
      </div>

      <LiveImpact base={basePlan} cur={plan} />

      {/* ── Basic ── */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold">Basics</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`${data.names.self} RRSP today`} hint={data.rrsp.selfAsOf ? `as of ${data.rrsp.selfAsOf}` : 'no snapshot yet'}>
            <span className="inline-flex items-center gap-2">
              <input
                type="number"
                value={rrspSelf}
                onChange={(e) => setRrspSelf(e.target.value)}
                className="w-32 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-sm"
              />
              <button
                onClick={() => startTransition(async () => { await saveRrspBalance('self', Number(rrspSelf)); router.refresh() })}
                disabled={pending}
                className="text-xs underline text-[var(--muted)]"
              >
                update
              </button>
            </span>
          </Field>
          <Field label={`${data.names.partner} RRSP today`} hint={data.rrsp.partnerIsEstimate ? 'estimate — confirm from a statement' : data.rrsp.partnerAsOf ? `as of ${data.rrsp.partnerAsOf}` : 'no snapshot yet'}>
            <span className="inline-flex items-center gap-2">
              <input
                type="number"
                value={rrspPartner}
                onChange={(e) => setRrspPartner(e.target.value)}
                className="w-32 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-sm"
              />
              <button
                onClick={() => startTransition(async () => { await saveRrspBalance('partner', Number(rrspPartner)); router.refresh() })}
                disabled={pending}
                className="text-xs underline text-[var(--muted)]"
              >
                update
              </button>
            </span>
          </Field>
          <Field label="Redirect freed-up mortgage payment" hint={`consultant: ${pct(defaults.postMortgageRedirect)} to savings after payoff`}>
            <input type="range" min={0} max={1} step={0.05} value={params.postMortgageRedirect} onChange={(e) => set('postMortgageRedirect', Number(e.target.value))} className="w-full" />
            <span className="text-xs text-[var(--muted)]">{pct(params.postMortgageRedirect)}</span>
          </Field>
          <Field label="Extra monthly savings" hint="on top of what you already invest">
            <NumField value={params.extraMonthlySavings} onChange={(v) => set('extraMonthlySavings', v)} step={50} suffix="$/mo" />
          </Field>
          <Field label="Employer RRSP match" hint={`consultant: ${pct(defaults.employerMatchRate)} of your gross — confirm from a pay stub`}>
            <NumField value={round4(params.employerMatchRate * 100)} onChange={(v) => set('employerMatchRate', v / 100)} step={0.5} suffix="%" />
          </Field>
          <Field label="Sell / downsize the house?" hint={`default: keep it (also ${data.names.kid1}'s home)`}>
            <span className="inline-flex items-center gap-2">
              <input type="checkbox" checked={params.sellHouse} onChange={(e) => set('sellHouse', e.target.checked)} />
              <span className="text-sm">Sell at age</span>
              <NumField value={params.sellHouseAge} onChange={(v) => set('sellHouseAge', v)} />
            </span>
          </Field>
        </div>
      </section>

      {/* ── Advanced ── */}
      <button onClick={() => setAdvancedOpen(!advancedOpen)} className="text-sm text-[var(--muted)] underline">
        {advancedOpen ? '▾ Hide advanced' : '▸ Advanced'}
      </button>
      {advancedOpen && (
        <section className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Inflation" hint={`consultant: ${pct(defaults.inflation)}`}>
              <NumField value={round4(params.inflation * 100)} onChange={(v) => set('inflation', v / 100)} step={0.1} suffix="%" />
            </Field>
            <Field label="Equity return (nominal)" hint={`consultant: ${pct(defaults.equityReturn)}`}>
              <NumField value={round4(params.equityReturn * 100)} onChange={(v) => set('equityReturn', v / 100)} step={0.1} suffix="%" />
            </Field>
            <Field label="Bond return (nominal)" hint={`consultant: ${pct(defaults.bondReturn)}`}>
              <NumField value={round4(params.bondReturn * 100)} onChange={(v) => set('bondReturn', v / 100)} step={0.1} suffix="%" />
            </Field>
            <Field label="Your CPP start age" hint="60–70; default 65">
              <NumField value={params.selfCppAge} onChange={(v) => set('selfCppAge', v)} />
            </Field>
            <Field label={`${data.names.partner} CPP start age`}>
              <NumField value={params.partnerCppAge} onChange={(v) => set('partnerCppAge', v)} />
            </Field>
            <Field label="Your OAS start age" hint="65–70">
              <NumField value={params.selfOasAge} onChange={(v) => set('selfOasAge', v)} />
            </Field>
            <Field label={`${data.names.partner} HOOPP service start year`} hint={`consultant: ${defaults.hooppServiceStartYear}`}>
              <NumField value={params.hooppServiceStartYear} onChange={(v) => set('hooppServiceStartYear', v)} />
            </Field>
            <Field label="Equity glidepath aggressiveness" hint={`equity% = ${params.glideBase} − age; consultant: ${defaults.glideBase}`}>
              <NumField value={params.glideBase} onChange={(v) => set('glideBase', v)} />
            </Field>
            <Field label="Model market crises" hint={`a −${(defaults.crisisEquityDrop * 100).toFixed(0)}% crash every ${defaults.crisisEveryYears} yrs`}>
              <input type="checkbox" checked={params.crisisEnabled} onChange={(e) => set('crisisEnabled', e.target.checked)} />
            </Field>
            <Field label="Plan to age" hint="longevity horizon; default 95">
              <NumField value={params.planToAge} onChange={(v) => set('planToAge', v)} />
            </Field>
          </div>

          {/* Son (§6) */}
          <div className="rounded-lg border border-[var(--border)] p-3 space-y-3">
            <div className="text-sm font-semibold">{data.names.kid1} — disability planning</div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="RDSP opened?" hint="DTC approved → eligible now; ~$10,500/yr of catch-up grants wait">
                <input type="checkbox" checked={params.rdspOpen} onChange={(e) => set('rdspOpen', e.target.checked)} />
              </Field>
              <Field label="RDSP contribution / yr" hint={`consultant: ${formatCurrencyCompact(defaults.rdspAnnualContribution)}`}>
                <NumField value={params.rdspAnnualContribution} onChange={(v) => set('rdspAnnualContribution', v)} step={100} suffix="$/yr" />
              </Field>
            </div>
            <p className="text-[11px] text-[var(--muted)]">
              Estate note: a Henson trust + the RDSP is the usual inheritance vehicle; keeping the
              house is partly {data.names.kid1}&apos;s long-term housing security.
            </p>
          </div>
        </section>
      )}

      <p className="text-xs text-[var(--muted)]">
        All amounts are in today&apos;s dollars (today&apos;s purchasing power).
      </p>
    </div>
  )
}

/* ─────────────── Live impact (what your change does) ─────────────── */

type ImpactRow = {
  label: string
  from: string
  to: string
  delta: string
  /** true = improvement (green), false = worse (red), null = neutral (muted). */
  good: boolean | null
}

/** The rows of the plan that changed between the saved baseline and the live params. */
function impactRows(base: PlanResult, cur: PlanResult): ImpactRow[] {
  const rows: ImpactRow[] = []
  const signed = (v: number, unit: string) => `${v > 0 ? '+' : '−'}${Math.abs(v)}${unit}`
  const signedMo = (v: number) =>
    `${v > 0 ? '+' : '−'}${formatCurrencyCompact(Math.abs(v))}/mo`

  if (cur.selfRetireAge !== base.selfRetireAge) {
    const d = cur.selfRetireAge - base.selfRetireAge
    rows.push({
      label: 'Retire',
      from: `${base.retirementYear} (age ${base.selfRetireAge})`,
      to: `${cur.retirementYear} (age ${cur.selfRetireAge})`,
      delta: signed(d, 'y'),
      good: null, // your choice, not better/worse by itself
    })
  }
  if (Math.round(cur.incomeAtRetirementReal) !== Math.round(base.incomeAtRetirementReal)) {
    const d = cur.incomeAtRetirementReal - base.incomeAtRetirementReal
    rows.push({
      label: 'Monthly income (after tax)',
      from: mo(base.incomeAtRetirementReal),
      to: mo(cur.incomeAtRetirementReal),
      delta: signedMo(d),
      good: d > 0,
    })
  }
  if (Math.round(cur.lifestyleMonthlyReal) !== Math.round(base.lifestyleMonthlyReal)) {
    const d = cur.lifestyleMonthlyReal - base.lifestyleMonthlyReal
    rows.push({
      label: 'Lifestyle needs',
      from: mo(base.lifestyleMonthlyReal),
      to: mo(cur.lifestyleMonthlyReal),
      delta: signedMo(d),
      good: null,
    })
  }
  if (Math.round(cur.monthlyGapReal) !== Math.round(base.monthlyGapReal)) {
    const d = cur.monthlyGapReal - base.monthlyGapReal
    const fmt = (g: number) => (g >= 0 ? `${mo(g)} surplus` : `${mo(Math.abs(g))} short`)
    rows.push({
      label: 'Surplus / shortfall',
      from: fmt(base.monthlyGapReal),
      to: fmt(cur.monthlyGapReal),
      delta: signedMo(d),
      good: d > 0,
    })
  }
  if (cur.recommendedRetireAge !== base.recommendedRetireAge) {
    const from = base.recommendedRetireAge
    const to = cur.recommendedRetireAge
    rows.push({
      label: 'Earliest you could retire',
      from: from != null ? `age ${from}` : 'never (unfunded)',
      to: to != null ? `age ${to}` : 'never (unfunded)',
      delta: from != null && to != null ? signed(to - from, 'y') : '—',
      good: from != null && to != null ? to < from : to != null,
    })
  }
  if (cur.survivesToPlanEnd !== base.survivesToPlanEnd) {
    rows.push({
      label: 'Money lasts to plan end',
      from: base.survivesToPlanEnd ? 'yes' : 'no',
      to: cur.survivesToPlanEnd ? 'yes' : 'no',
      delta: cur.survivesToPlanEnd ? '✓' : '✗',
      good: cur.survivesToPlanEnd,
    })
  }
  if (cur.survivesCrisis !== base.survivesCrisis) {
    rows.push({
      label: 'Crash test',
      from: base.survivesCrisis ? 'survives' : 'fails',
      to: cur.survivesCrisis ? 'survives' : 'fails',
      delta: cur.survivesCrisis ? '✓' : '✗',
      good: cur.survivesCrisis,
    })
  }
  return rows
}

const deltaColor = (good: boolean | null) =>
  good === null ? 'var(--muted)' : good ? '#10b981' : '#ef4444'

/** Live readout inside the controls drawer: saved plan → what you're previewing. */
function LiveImpact({ base, cur }: { base: PlanResult; cur: PlanResult }) {
  const rows = impactRows(base, cur)
  return (
    <div className="sticky top-2 z-10 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
      <div className="text-xs font-semibold mb-1">What your changes do</div>
      {rows.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">
          Move any control and the effect shows here — e.g. &ldquo;Retire: −4y → age 54&rdquo;.
        </p>
      ) : (
        <div className="space-y-1">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-[var(--muted)]">{r.label}</span>
              <span className="text-right">
                <span className="text-[var(--muted)]">{r.from}</span>
                <span className="mx-1">→</span>
                <span className="font-medium">{r.to}</span>
                <span
                  className="ml-2 inline-block rounded-full px-1.5 py-0.5 font-semibold"
                  style={{
                    color: deltaColor(r.good),
                    background: `color-mix(in srgb, ${deltaColor(r.good)} 12%, transparent)`,
                  }}
                >
                  {r.delta}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** One-line version for the sticky save bar. */
function DeltaSummary({ base, cur }: { base: PlanResult; cur: PlanResult }) {
  const parts: { text: string; good: boolean | null }[] = []
  if (cur.selfRetireAge !== base.selfRetireAge) {
    const d = cur.selfRetireAge - base.selfRetireAge
    parts.push({ text: `retire ${d > 0 ? '+' : '−'}${Math.abs(d)}y → age ${cur.selfRetireAge}`, good: null })
  }
  const dIncome = cur.incomeAtRetirementReal - base.incomeAtRetirementReal
  if (Math.round(dIncome) !== 0) {
    parts.push({
      text: `income ${dIncome > 0 ? '+' : '−'}${formatCurrencyCompact(Math.abs(dIncome))}/mo`,
      good: dIncome > 0,
    })
  }
  if (cur.survivesToPlanEnd !== base.survivesToPlanEnd) {
    parts.push({
      text: cur.survivesToPlanEnd ? 'now lasts to plan end' : 'runs out of money',
      good: cur.survivesToPlanEnd,
    })
  }
  if (parts.length === 0) return null
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {' · '}
          <span style={{ color: deltaColor(p.good) }}>{p.text}</span>
        </span>
      ))}
    </>
  )
}

/* ─────────────── helpers ─────────────── */

function round4(v: number) {
  return Math.round(v * 100) / 100
}

/** Compute the subset of params that differ from the engine defaults. */
function diffOverrides(params: RetirementParams, defaults: RetirementParams): Partial<RetirementParams> {
  const out: Partial<RetirementParams> = {}
  ;(Object.keys(params) as (keyof RetirementParams)[]).forEach((k) => {
    if (JSON.stringify(params[k]) !== JSON.stringify(defaults[k])) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(out as any)[k] = params[k]
    }
  })
  return out
}
