#!/usr/bin/env bash
# POSITIVE CONTROL for the heartbeat's open_modules tracking.
#
# The FINAL beat always shows open_modules: [] because every module has closed by
# onTestRunEnd. So the end state cannot demonstrate the naming capability — it is exactly the
# shape where "empty" is indistinguishable from "never populated". This samples MID-RUN.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:?usage: prove-open-modules.sh <heartbeat-dir>}"
rm -rf "$OUT"

( cd "$ROOT/packages/core" \
  && HANG_HEARTBEAT_BASE="$OUT" npx vitest run \
       --reporter="$ROOT/scripts/lib/vitest-heartbeat-reporter.mjs" \
       >/dev/null 2>&1 ) &
RUNNER=$!

MAX=0
SAMPLES=0
READABLE=0
BEST=""
while kill -0 "$RUNNER" 2>/dev/null; do
  # The reporter writes base/<pid>/heartbeat.json, so FIND the leaf rather than assuming where
  # it is. (The earlier version of this loop updated only the `if` test when the layout gained
  # the pid level and left two stale `$OUT/heartbeat.json` references below it — a fix landed at
  # one site of three, CR-74.)
  BEAT="$(find "$OUT" -name heartbeat.json -type f 2>/dev/null | head -1)"
  if [ -n "$BEAT" ]; then
    SAMPLES=$((SAMPLES + 1))
    # ⛔ AN UNREADABLE SAMPLE MUST NOT REPORT "0 open modules". The previous version's
    # `catch { write("0") }` collapsed "could not read the file" into "the set is empty" — the
    # blind-gate defect, in the probe whose whole job is to prove the tracking populates. It
    # emits ERR instead, and ERR is counted separately from a real zero.
    N="$(node -e '
      try {
        const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        process.stdout.write(String((d.open_modules || []).length));
      } catch (e) { process.stdout.write("ERR"); }
    ' "$BEAT" 2>/dev/null || echo ERR)"
    case "$N" in
      ''|*[!0-9]*) ;;  # ERR or anything non-numeric: not a readable sample
      *) READABLE=$((READABLE + 1))
         if [ "$N" -gt "$MAX" ]; then
           MAX="$N"
           BEST="$(cat "$BEAT")"
         fi ;;
    esac
  fi
  sleep 1
done
wait "$RUNNER" 2>/dev/null || true

printf 'SAMPLES_TAKEN: %s\n' "$SAMPLES"
printf 'SAMPLES_READABLE: %s\n' "$READABLE"
printf 'MAX_OPEN_MODULES_OBSERVED: %s\n' "$MAX"

# M1: samples must be non-zero, or the probe measured nothing and says so loudly.
if [ "$SAMPLES" -eq 0 ]; then
  printf 'ERROR: zero samples — the probe never found a heartbeat file, so it proves nothing\n' >&2
  exit 2
fi
# ⛔ THREE OUTCOMES, NOT TWO. "I found files but could never read one" is a PROBE failure and is
# not the same as "I read them and the set was always empty", which is a SUBJECT failure.
# Collapsing them would let a broken probe indict working code.
if [ "$READABLE" -eq 0 ]; then
  printf 'ERROR: found %s heartbeat sample(s) but could not READ any of them — this is a probe\n' "$SAMPLES" >&2
  printf '       failure, NOT evidence about open_modules\n' >&2
  exit 2
fi
if [ "$MAX" -eq 0 ]; then
  printf 'ERROR: open_modules was EMPTY in all %s readable sample(s) — the tracking does not populate\n' "$READABLE" >&2
  exit 1
fi

printf '\nthe richest beat observed (%s open modules):\n' "$MAX"
printf '%s\n' "$BEST" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => {
    const d = JSON.parse(s);
    console.log("  last event :", d.event, d.subject);
    console.log("  open       :", d.open_modules.length);
    for (const m of d.open_modules.slice(0, 6)) {
      // ⛔ PRINT THE KEY AS STORED. This line used to strip `^.*/packages/core/` for
      // readability, and on 2026-09-24 I read that RENDERED output back as evidence about
      // the DATA — concluding the stored module key was project-relative and nearly filing
      // a cross-run inconsistency finding against vitest. It is ABSOLUTE (measured from the
      // raw bytes), which is what lets D-4 join it directly against `testCase.module.moduleId`.
      // A display transform in your own instrument is not a fact about the data.
      console.log("    -", m.module, "| last:", m.last_event);
    }
  });
'
