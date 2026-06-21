#!/bin/bash
# Manual "sync everything now" trigger — runs every bank/card sync the launchd
# schedule runs, but on demand (e.g. `npm run sync`).
#
# Reuses each source's existing launchd-safe wrapper (run-<source>.sh), so they
# set INGEST_URL, resolve a stable node, retry on transient failure, and write
# status — identical behaviour to the daily cron, just kicked off by hand.
#
# Runs SEQUENTIALLY: the syncs are HEADED and share one GUI session + browser
# profile, so two can't run at once (that's why the cron staggers them). One
# source failing does NOT stop the rest — we continue and report a summary at
# the end. Re-imports dedup to zero, so re-running any time is harmless.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Order mirrors the launchd schedule (Rogers → Amex → Scotia → Tangerine).
SOURCES=(rogers amex scotia tangerine)

declare -a RESULTS=()
overall=0

for src in "${SOURCES[@]}"; do
  echo
  echo "########## sync: $src @ $(date) ##########"
  if bash "$DIR/run-$src.sh"; then
    RESULTS+=("✓ $src")
  else
    RESULTS+=("✗ $src")
    overall=1
  fi
done

echo
echo "========== sync summary @ $(date) =========="
for line in "${RESULTS[@]}"; do
  echo "  $line"
done

exit "$overall"
