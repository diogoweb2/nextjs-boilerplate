/**
 * Monthly INVESTMENT report engine — a deterministic "what changed since last
 * month" recap over the iTrade holdings snapshots (§16b). No live prices, no AI:
 * every number comes from comparing two stored snapshots (the latest, and the
 * newest one at least ~a month older) plus the contribution ledger in between.
 *
 * The goal is decision support: is it worth moving something? And — since the
 * owner parks a big chunk in bonds — a "should I rotate bonds into equities?"
 * signal that lights up when the equity market is meaningfully off its recent
 * high (buy-the-dip), computed purely from the value-over-time snapshot series.
 *
 * Pure & db-free so it can be unit-tested and imported by a client component;
 * the loader (app/actions/investmentReport.ts) does the db work and feeds this.
 */

export type ReportPosition = {
  symbol: string
  name: string
  assetClass: string
  currency: string
  quantity: number
  marketValueCad: number
  bookValueCad: number
}

export type ReportSnapshot = {
  occurredAt: string // YYYY-MM-DD
  fxUsdCad: number
  totalValueCad: number
  positions: ReportPosition[]
}

export type ReportAccountInput = {
  id: number
  name: string
  kind: string
  ownerName: string
  /** The most recent snapshot (the "now"). */
  current: ReportSnapshot | null
  /** The newest snapshot at least ~a month older than `current` (the baseline). */
  previous: ReportSnapshot | null
  /** Full value-over-time series (oldest→newest) for the dip signal. */
  valueSeries: { occurredAt: string; value: number }[]
  /** Net contributions (in − out) that occurred strictly after `previous.occurredAt`. */
  contributionsInWindow: number
}

// --- asset-class buckets ----------------------------------------------------

export type AssetBucket = 'bonds' | 'equity' | 'cash' | 'other'

const BOND_HINTS = ['fixed income', 'bond', 'gic', 'debenture', 'income']
const CASH_HINTS = ['cash', 'money market', 'savings']
const EQUITY_HINTS = ['equity', 'stock', 'etf', 'fund', 'share']

/** Classify an iTrade asset-class label into a coarse bucket. Deterministic. */
export function bucketForAssetClass(assetClass: string): AssetBucket {
  const a = (assetClass || '').toLowerCase()
  if (BOND_HINTS.some((h) => a.includes(h))) return 'bonds'
  if (CASH_HINTS.some((h) => a.includes(h))) return 'cash'
  if (EQUITY_HINTS.some((h) => a.includes(h))) return 'equity'
  return 'other'
}

// --- report shape -----------------------------------------------------------

export type PositionMove = {
  symbol: string
  name: string
  assetClass: string
  bucket: AssetBucket
  valueNow: number
  valueThen: number // 0 if the position is new
  deltaCad: number
  deltaPct: number | null // null when there was no prior value (new position)
  isNew: boolean
  isGone: boolean // held before, gone now
}

export type AccountReport = {
  id: number
  name: string
  kind: string
  ownerName: string
  valueNow: number
  valueThen: number
  deltaCad: number // raw value change
  contributionsInWindow: number
  /** Market change = value change minus new money in (the part that isn't deposits). */
  marketDeltaCad: number
  marketDeltaPct: number | null
  movers: PositionMove[] // sorted by |deltaCad| desc
}

export type BucketAllocation = {
  bucket: AssetBucket
  valueCad: number
  pct: number // of the total portfolio
  deltaCad: number // vs previous
}

export type DipSignal = {
  /** How far the portfolio's market value is below its trailing peak, as a %. */
  drawdownPct: number
  peakValue: number
  peakDate: string
  currentValue: number
  /** True when there's a meaningful drawdown AND a meaningful bond allocation to rotate. */
  rotateOpportunity: boolean
  level: 'buy' | 'watch' | 'steady'
  message: string
}

export type InvestmentReport = {
  ok: boolean
  reason?: string
  /** The window the report covers. */
  fromDate: string
  toDate: string
  // Portfolio-wide headline.
  valueNow: number
  valueThen: number
  deltaCad: number
  contributionsInWindow: number
  marketDeltaCad: number // value change excluding new deposits
  marketDeltaPct: number | null
  accounts: AccountReport[]
  allocation: BucketAllocation[]
  bondPct: number
  dip: DipSignal
  topMovers: PositionMove[] // best/worst across the whole portfolio, by |deltaCad|
}

// --- tuning knobs (named consts, easy to retune) ----------------------------

/** A drawdown at/under this (negative) triggers the "buy the dip" rotate signal. */
const DIP_BUY_THRESHOLD = -8 // % below trailing peak
const DIP_WATCH_THRESHOLD = -4
/** Only nudge a rotation when at least this share of the portfolio sits in bonds/cash. */
const MIN_BOND_PCT_TO_ROTATE = 15
/** Ignore trivial position moves in the movers list. */
const MOVER_MIN_ABS_CAD = 25

const round2 = (n: number) => Math.round(n * 100) / 100

function bucketTotals(positions: ReportPosition[]): Record<AssetBucket, number> {
  const t: Record<AssetBucket, number> = { bonds: 0, equity: 0, cash: 0, other: 0 }
  for (const p of positions) t[bucketForAssetClass(p.assetClass)] += p.marketValueCad
  return t
}

function positionMoves(cur: ReportSnapshot, prev: ReportSnapshot | null): PositionMove[] {
  const prevBySym = new Map<string, ReportPosition>()
  for (const p of prev?.positions ?? []) prevBySym.set(p.symbol, p)

  const seen = new Set<string>()
  const moves: PositionMove[] = []
  for (const p of cur.positions) {
    seen.add(p.symbol)
    const before = prevBySym.get(p.symbol)
    const valueThen = before ? before.marketValueCad : 0
    const delta = round2(p.marketValueCad - valueThen)
    moves.push({
      symbol: p.symbol,
      name: p.name,
      assetClass: p.assetClass,
      bucket: bucketForAssetClass(p.assetClass),
      valueNow: p.marketValueCad,
      valueThen,
      deltaCad: delta,
      deltaPct: before && valueThen ? round2((delta / Math.abs(valueThen)) * 100) : null,
      isNew: !before,
      isGone: false,
    })
  }
  // Positions fully sold since last month.
  for (const p of prev?.positions ?? []) {
    if (seen.has(p.symbol)) continue
    moves.push({
      symbol: p.symbol,
      name: p.name,
      assetClass: p.assetClass,
      bucket: bucketForAssetClass(p.assetClass),
      valueNow: 0,
      valueThen: p.marketValueCad,
      deltaCad: round2(-p.marketValueCad),
      deltaPct: -100,
      isNew: false,
      isGone: true,
    })
  }
  return moves.sort((a, b) => Math.abs(b.deltaCad) - Math.abs(a.deltaCad))
}

/**
 * Trailing-peak drawdown of the whole-portfolio value series. Compares the
 * latest value to the highest value seen over the series; a deep drawdown while
 * a chunk sits in bonds is the "rotate into equities" cue the owner asked for.
 */
function computeDip(series: { occurredAt: string; value: number }[], bondPct: number): DipSignal {
  const points = series.filter((p) => p.value > 0)
  const current = points.at(-1)?.value ?? 0
  let peak = current
  let peakDate = points.at(-1)?.occurredAt ?? ''
  for (const p of points) {
    if (p.value > peak) {
      peak = p.value
      peakDate = p.occurredAt
    }
  }
  const drawdownPct = peak > 0 ? round2(((current - peak) / peak) * 100) : 0
  const hasBondsToRotate = bondPct >= MIN_BOND_PCT_TO_ROTATE

  let level: DipSignal['level'] = 'steady'
  if (drawdownPct <= DIP_BUY_THRESHOLD) level = 'buy'
  else if (drawdownPct <= DIP_WATCH_THRESHOLD) level = 'watch'

  const rotateOpportunity = level === 'buy' && hasBondsToRotate

  let message: string
  if (level === 'buy' && hasBondsToRotate) {
    message = `The market is ${Math.abs(drawdownPct)}% off its peak and ${Math.round(bondPct)}% of the portfolio is in bonds/cash — a good moment to rotate some into equities while prices are low.`
  } else if (level === 'buy') {
    message = `The market is ${Math.abs(drawdownPct)}% off its peak — a dip, but there's little in bonds/cash to rotate from.`
  } else if (level === 'watch') {
    message = `Down ${Math.abs(drawdownPct)}% from the peak — worth watching, not yet a clear buy-the-dip.`
  } else if (drawdownPct >= 0) {
    message = `Near an all-time high — not a moment to move bonds into equities.`
  } else {
    message = `Only ${Math.abs(drawdownPct)}% off the peak — holding steady looks fine.`
  }

  return { drawdownPct, peakValue: round2(peak), peakDate, currentValue: round2(current), rotateOpportunity, level, message }
}

/**
 * Build the report from per-account current/previous snapshots. Returns
 * `ok: false` with a reason when there isn't enough history to compare.
 */
export function buildInvestmentReport(accounts: ReportAccountInput[]): InvestmentReport {
  const withCurrent = accounts.filter((a) => a.current)
  const empty = (reason: string): InvestmentReport => ({
    ok: false,
    reason,
    fromDate: '',
    toDate: '',
    valueNow: 0,
    valueThen: 0,
    deltaCad: 0,
    contributionsInWindow: 0,
    marketDeltaCad: 0,
    marketDeltaPct: null,
    accounts: [],
    allocation: [],
    bondPct: 0,
    dip: computeDip([], 0),
    topMovers: [],
  })

  if (withCurrent.length === 0) return empty('No holdings snapshots yet — import an iTrade portfolio CSV.')
  const comparable = withCurrent.filter((a) => a.previous)
  if (comparable.length === 0)
    return empty('Only one holdings snapshot so far — the report appears once there are two, about a month apart.')

  const accountReports: AccountReport[] = []
  let valueNow = 0
  let valueThen = 0
  let contributionsInWindow = 0
  const allMovers: PositionMove[] = []
  const bucketNow: Record<AssetBucket, number> = { bonds: 0, equity: 0, cash: 0, other: 0 }
  const bucketThen: Record<AssetBucket, number> = { bonds: 0, equity: 0, cash: 0, other: 0 }

  // Merge each account's series into a portfolio series keyed by date.
  const portfolioSeries = new Map<string, number>()

  let fromDate = ''
  let toDate = ''

  for (const a of withCurrent) {
    const cur = a.current!
    const prev = a.previous
    const vNow = cur.totalValueCad
    const vThen = prev ? prev.totalValueCad : 0
    valueNow += vNow
    valueThen += vThen
    contributionsInWindow += a.contributionsInWindow

    for (const [b, v] of Object.entries(bucketTotals(cur.positions))) bucketNow[b as AssetBucket] += v
    if (prev) for (const [b, v] of Object.entries(bucketTotals(prev.positions))) bucketThen[b as AssetBucket] += v

    for (const s of a.valueSeries) portfolioSeries.set(s.occurredAt, (portfolioSeries.get(s.occurredAt) ?? 0) + s.value)

    if (!toDate || cur.occurredAt > toDate) toDate = cur.occurredAt
    if (prev && (!fromDate || prev.occurredAt < fromDate)) fromDate = prev.occurredAt

    if (prev) {
      const movers = positionMoves(cur, prev).filter((m) => Math.abs(m.deltaCad) >= MOVER_MIN_ABS_CAD)
      const marketDelta = round2(vNow - vThen - a.contributionsInWindow)
      accountReports.push({
        id: a.id,
        name: a.name,
        kind: a.kind,
        ownerName: a.ownerName,
        valueNow: vNow,
        valueThen: vThen,
        deltaCad: round2(vNow - vThen),
        contributionsInWindow: a.contributionsInWindow,
        marketDeltaCad: marketDelta,
        marketDeltaPct: vThen ? round2((marketDelta / vThen) * 100) : null,
        movers,
      })
      allMovers.push(...movers)
    }
  }

  const bondPct = valueNow > 0 ? round2(((bucketNow.bonds + bucketNow.cash) / valueNow) * 100) : 0
  const allocation: BucketAllocation[] = (['equity', 'bonds', 'cash', 'other'] as AssetBucket[])
    .map((b) => ({
      bucket: b,
      valueCad: round2(bucketNow[b]),
      pct: valueNow > 0 ? round2((bucketNow[b] / valueNow) * 100) : 0,
      deltaCad: round2(bucketNow[b] - bucketThen[b]),
    }))
    .filter((b) => b.valueCad > 0 || b.deltaCad !== 0)

  const series = [...portfolioSeries.entries()]
    .map(([occurredAt, value]) => ({ occurredAt, value }))
    .sort((x, y) => x.occurredAt.localeCompare(y.occurredAt))

  const marketDeltaCad = round2(valueNow - valueThen - contributionsInWindow)
  const topMovers = [...allMovers].sort((a, b) => Math.abs(b.deltaCad) - Math.abs(a.deltaCad)).slice(0, 6)

  return {
    ok: true,
    fromDate,
    toDate,
    valueNow: round2(valueNow),
    valueThen: round2(valueThen),
    deltaCad: round2(valueNow - valueThen),
    contributionsInWindow: round2(contributionsInWindow),
    marketDeltaCad,
    marketDeltaPct: valueThen ? round2((marketDeltaCad / valueThen) * 100) : null,
    accounts: accountReports,
    allocation,
    bondPct,
    dip: computeDip(series, bondPct),
    topMovers,
  }
}
