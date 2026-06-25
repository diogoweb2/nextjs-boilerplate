/**
 * USD→CAD exchange rate from the Bank of Canada Valet API — the official daily
 * noon/close rate, free and key-less. Fetched once when a holdings CSV is
 * imported and then STORED on the snapshot, so historical snapshots stay
 * reproducible even though the rate itself is fetched live.
 *
 * If the fetch fails (offline, API change), callers fall back to the last
 * snapshot's rate or 1, and the UI lets the owner override the rate by hand — so
 * an FX hiccup never blocks an import.
 */

const VALET_URL =
  'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1'

/** Fetch the latest USD→CAD rate, or null if unavailable. */
export async function fetchUsdCadRate(): Promise<number | null> {
  try {
    const res = await fetch(VALET_URL, {
      // The rate moves at most daily; cache for an hour to avoid hammering it.
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const data: { observations?: { FXUSDCAD?: { v?: string } }[] } = await res.json()
    const raw = data.observations?.at(-1)?.FXUSDCAD?.v
    const rate = raw ? Number(raw) : NaN
    // Sanity-bound it so a malformed response can't poison a snapshot.
    return Number.isFinite(rate) && rate > 0.5 && rate < 3 ? rate : null
  } catch {
    return null
  }
}
