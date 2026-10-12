#!/usr/bin/env bash
# HOST CAPACITY PRECONDITION — the third verdict for gates whose result depends on the host.
#
# WHY THIS EXISTS. Three pushes on 2026-09-23 failed at `[6/22] Tests` with
# `Error: Test timed out in Nms.` while the same file ran `Tests 30 passed (30)` in 473ms on a
# quiet host — a ~40x per-test divergence caused by an unrelated workload on the same machine
# holding ~16 of its 28 cores. (This file SHIPS to the public mirror, so the offending
# service is described rather than named: the Sync Check refused an earlier revision of this
# very comment for naming a private sibling repository, and it was right to.) None of those failures was evidence about the code, and every one of them looked
# exactly like evidence about the code. That is the blind-gate law pointed at the battery: "the
# suite is broken" and "this host could not run the suite" produced the same value, and it was
# the FAILING one, which is the mirror image of the usual disease and just as misleading.
#
# WHAT IT IS NOT. This is NOT a licence to launder a timeout. A timeout on a QUIET host stays a
# hard FAIL. The discriminator is a capacity reading taken AT GATE START, before the gate runs,
# so the verdict is decided by a measurement rather than by how the gate happened to end.
#
# WHY A PROBE AND NOT LOAD AVERAGE. Load average is a CORRELATE of "can this host do a unit of
# work at the expected speed" (G28 — the scope predicate must BE the property). A probe measures
# that property directly, and it transfers to a CI runner where load average means something
# different. The field calls this SELF-CALIBRATION and sets the bar at: a controlled runner, a
# CALIBRATED tolerance, a DETERMINISTIC workload, and an owner. This file supplies the last three;
# the first is why the verdict is a refusal rather than a bypass.
#
# THE BASELINE IS THE MINIMUM EVER OBSERVED ON THIS HOST, and it only ever ratchets DOWN.
# Contention can only ADD time, so the minimum is the best available estimate of idle capacity,
# and it needs no manual "run this on a quiet machine" step that someone would skip.
#   ⚠️ KNOWN LIMITATION, stated rather than hidden (G20): a FIRST sample taken on a loaded host
#   inflates the baseline and makes the gate permissive until a genuinely quiet run ratchets it
#   down. The provenance fields below exist so that state is auditable instead of invisible.
#
# THE TOLERANCE IS NOT TYPED. `max_ratio` starts ABSENT and its absence FAILS CLOSED, because a
# constant about the outside world is a claim and must be measured, not asserted (CR-68). It is
# ⛔ NOT RECORDED BY ANYTHING. Measured 2026-09-24: `--calibrate` ratchets `min_ms` and writes
# provenance, but does `setdefault("max_ratio", None)` — it only ensures the KEY exists. No code
# path in this tree ever writes a non-null value (the only other writers are two self-test
# fixtures, into temp files), and `--calibrate` performs no quietness measurement at all. So
# `hc_verdict` can NEVER leave UNMEASURABLE, and the precondition is permanently advisory
# (warn-and-run) rather than the fail-closed control the paragraph above describes — G7: a
# control that cannot arm produces silence. Arming it needs a DERIVATION PROCEDURE that does
# not exist; that is an operator design decision, and typing a number is forbidden (CR-68).
set -uo pipefail

_HC_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HC_BASELINE_FILE="${HC_BASELINE_FILE:-$_HC_HERE/host-capacity-baseline.json}"

# Bump when the workload changes: a baseline measured against a different workload is not a
# baseline, and silently comparing across versions would be the wrong-corpus defect.
HC_PROBE_VERSION=2

# ── THE DETERMINISTIC WORKLOAD ────────────────────────────────────────────────────────────────
# Pure integer arithmetic, fixed iteration count, no I/O, no allocation growth, no network, no
# clock-dependent branching. Node because that is what the battery already runs, and the timer is
# INSIDE the process so interpreter startup — which varies for reasons unrelated to CPU capacity —
# is excluded from the measurement.
#
# ⛔ PROBE v2 IS PARALLEL, AND v1 WAS THE WRONG MEASUREMENT. Measured 2026-09-23, same host, same
# day, on the two loads that matter:
#
#     1-min load ~60    ->  probe 656.0 ms
#     1-min load ~8.9   ->  probe 627.5 ms       ratio 1.045
#
# A single-threaded integer loop gets a whole core even on a badly oversubscribed 28-core host, so
# v1 could not see a 7x change in load. Any tolerance wide enough to admit the quiet reading would
# also admit load 60, so arming the precondition on v1 would have shipped decoration — worse than
# leaving it unarmed, because it would read as coverage (G24: replace a proxy metric, never
# disclaim it; THE BLIND-GATE LAW: a check that cannot see must never report clean).
#
# What the suite actually competes for is PARALLEL capacity. vitest runs many workers at once and
# they timed out while a single-threaded probe was comfortable. So v2 runs HC_PROBE_THREADS worker
# threads over the same fixed loop and times from first dispatch to last completion, inside the
# process. Oversubscription divides each worker's share of a core, so wall time rises with
# (runnable / cores) instead of staying flat.
#
# Thread count is HALF the cores by default: enough to feel contention, and bounded so the probe is
# never itself the load event — several sessions work this machine at once (G8).
HC_PROBE_THREADS="${HC_PROBE_THREADS:-0}"   # 0 = derive as cores/2, floor 2

hc_probe_once() {
  local threads="${HC_PROBE_THREADS}"
  if [ "${threads}" = "0" ]; then
    local cores
    cores="$(sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
    case "${cores}" in ''|*[!0-9]*) cores=2 ;; esac   # M2: never derive a thread count from junk
    threads=$(( cores / 2 ))
    [ "${threads}" -lt 2 ] && threads=2
  fi
  HC_THREADS="${threads}" node -e '
    const { Worker } = require("node:worker_threads");
    const THREADS = Number(process.env["HC_THREADS"]);
    const N = 12_000_000;
    const BODY = `
      const { parentPort } = require("node:worker_threads");
      let acc = 0;
      for (let i = 1; i <= ${N}; i++) acc = (acc + ((i * 2654435761) % 1048573)) % 2147483647;
      parentPort.postMessage(acc);
    `;
    if (!Number.isFinite(THREADS) || THREADS < 2) {
      process.stderr.write("hc: HC_THREADS must be a number >= 2\n");
      process.exit(2);
    }
    let done = 0, failed = 0, settled = false;
    const t0 = process.hrtime.bigint();
    const finish = () => {
      if (settled) return;
      settled = true;
      const t1 = process.hrtime.bigint();
      // M2: a worker that died makes the wall time meaningless — it measured fewer workers than
      // the baseline did. Refuse rather than report a flatteringly small number.
      if (failed > 0) {
        process.stderr.write(`hc: ${failed} of ${THREADS} probe workers failed\n`);
        process.exit(2);
      }
      process.stdout.write(String(Number(t1 - t0) / 1e6));
    };
    for (let w = 0; w < THREADS; w++) {
      const worker = new Worker(BODY, { eval: true });
      worker.on("message", () => { if (++done + failed === THREADS) finish(); });
      worker.on("error", () => { failed++; if (done + failed === THREADS) finish(); });
    }
  '
}

# Minimum of N samples. Contention only ADDS time, so the MIN is the signal and the mean is noise
# (the same reason G27 says to keep the minimum when comparing interleaved samples).
hc_probe_min() {
  local samples="${1:-5}" best="" v i
  for ((i = 0; i < samples; i++)); do
    v="$(hc_probe_once)" || return 2
    [ -n "$v" ] || return 2
    if [ -z "$best" ] || awk -v a="$v" -v b="$best" 'BEGIN{exit !(a < b)}'; then best="$v"; fi
  done
  [ -n "$best" ] || return 2
  printf '%s' "$best"
}

# ── VERDICT ───────────────────────────────────────────────────────────────────────────────────
# Prints one line: `OK <ratio> <now_ms> <base_ms>` or `DEGRADED <ratio> <now_ms> <base_ms>` or
# `UNMEASURABLE <reason>`. Returns 0 / 3 / 2 respectively — three values, never two, because
# "the host is fine", "the host is starved" and "I could not tell" are three different facts.
hc_verdict() {
  local now base maxr ver
  if [ ! -f "$HC_BASELINE_FILE" ]; then
    printf 'UNMEASURABLE no-baseline-file(%s)' "$HC_BASELINE_FILE"; return 2
  fi
  # ⛔ THE VERSION GUARD BELONGS ON THE READ PATH TOO. It was enforced only in hc_calibrate, so
  # a baseline measured against probe v1 (single-threaded) could be compared against a v2
  # (parallel) reading and yield a confident OK or DEGRADED about two different workloads — the
  # wrong-corpus defect this field exists to prevent. A mismatch is UNMEASURABLE, never a verdict.
  ver="$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
v=d.get("probe_version")
print("" if v is None else v)
' "$HC_BASELINE_FILE")" || { printf 'UNMEASURABLE baseline-unreadable'; return 2; }
  if [ -n "$ver" ] && [ "$ver" != "$HC_PROBE_VERSION" ]; then
    printf 'UNMEASURABLE baseline-probe-version(%s)-differs-from-this-probe(%s)' \
      "$ver" "$HC_PROBE_VERSION"
    return 2
  fi
  base="$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
v=d.get("min_ms")
print(v if isinstance(v,(int,float)) and v>0 else "")
' "$HC_BASELINE_FILE")" || { printf 'UNMEASURABLE baseline-unreadable'; return 2; }
  maxr="$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
v=d.get("max_ratio")
print(v if isinstance(v,(int,float)) and v>1 else "")
' "$HC_BASELINE_FILE")" || { printf 'UNMEASURABLE baseline-unreadable'; return 2; }
  [ -n "$base" ] || { printf 'UNMEASURABLE baseline-has-no-min_ms'; return 2; }
  # An ABSENT tolerance fails closed. It is a measured constant, never a typed one (CR-68).
  [ -n "$maxr" ] || { printf 'UNMEASURABLE baseline-has-no-max_ratio(NO WRITER EXISTS: --calibrate records min_ms only)'; return 2; }
  now="$(hc_probe_min "${HC_SAMPLES:-5}")" || { printf 'UNMEASURABLE probe-failed'; return 2; }
  awk -v n="$now" -v b="$base" -v m="$maxr" 'BEGIN{
    r = n / b;
    printf "%s %.2f %.1f %.1f", (r <= m ? "OK" : "DEGRADED"), r, n, b;
    exit (r <= m ? 0 : 3);
  }'
}

# ── CALIBRATE ─────────────────────────────────────────────────────────────────────────────────
# Ratchets min_ms DOWN and records provenance. Refuses to LOWER the tolerance silently: a
# tolerance that widens whenever a gate is inconvenient is the G27 reflex in configuration form.
hc_calibrate() {
  local samples="${1:-9}" now
  now="$(hc_probe_min "$samples")" || return 2
  python3 - "$HC_BASELINE_FILE" "$now" "$samples" "$HC_PROBE_VERSION" "$(sysctl -n hw.ncpu)" <<'PY'
import json, os, sys, datetime
path, now, samples, ver, cores = sys.argv[1], float(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
d = {}
if os.path.exists(path):
    d = json.load(open(path))
if d.get("probe_version") not in (None, ver):
    print(f"FATAL: baseline was measured against probe_version {d['probe_version']}, this is {ver}. "
          f"A baseline for a different workload is not a baseline — delete it and recalibrate.", file=sys.stderr)
    sys.exit(2)
prev = d.get("min_ms")
ratcheted = prev is None or now < prev
d["probe_version"] = ver
d["min_ms"] = round(now if ratcheted else prev, 1)
d["samples_seen"] = int(d.get("samples_seen", 0)) + samples
d["cores"] = cores
d["last_calibrated_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
d.setdefault("max_ratio", None)
d.setdefault("_doc", "min_ms is the MINIMUM ever observed on this host and only ratchets DOWN; "
                     "contention can only add time. max_ratio is a MEASURED tolerance and its "
                     "absence FAILS CLOSED (CR-68) — never type it. ⛔ AND NOTHING WRITES IT: "
                     "--calibrate does setdefault(max_ratio, None), so this key is permanently "
                     "null and the precondition is permanently advisory. Arming it requires a "
                     "derivation procedure that does not exist yet.")
json.dump(d, open(path, "w"), indent=2, sort_keys=True)
open(path, "a").write("\n")
print(f"probe {now:.1f}ms · min_ms {d['min_ms']}ms · ratcheted {ratcheted} · "
      f"samples_seen {d['samples_seen']} · cores {cores} · max_ratio {d['max_ratio']}")
PY
}

# ── SELF-TEST ─────────────────────────────────────────────────────────────────────────────────
hc_self_test() {
  local fails=0 out rc
  # 1. the probe returns a positive number
  out="$(hc_probe_once)"; rc=$?
  if [ "$rc" -eq 0 ] && awk -v v="$out" 'BEGIN{exit !(v > 0)}'; then echo "  OK    probe returns ${out}ms"
  else echo "  FAIL  probe did not return a positive number (rc=$rc out='$out')"; fails=$((fails+1)); fi
  # 2. a MISSING baseline is UNMEASURABLE, never OK (fail closed, M2)
  out="$(HC_BASELINE_FILE=/nonexistent/hc.json hc_verdict)"; rc=$?
  case "$out" in UNMEASURABLE*) [ "$rc" -eq 2 ] && echo "  OK    missing baseline -> $out (rc 2)" || { echo "  FAIL  missing baseline gave rc=$rc"; fails=$((fails+1)); } ;;
    *) echo "  FAIL  missing baseline did not report UNMEASURABLE: '$out'"; fails=$((fails+1)) ;; esac
  # 3. a baseline with NO max_ratio is UNMEASURABLE — the tolerance may never default
  local t; t="$(mktemp)"; printf '{"min_ms": 100, "probe_version": '"$HC_PROBE_VERSION"'}\n' > "$t"
  out="$(HC_BASELINE_FILE="$t" hc_verdict)"; rc=$?
  case "$out" in *no-max_ratio*) [ "$rc" -eq 2 ] && echo "  OK    absent tolerance -> $out (rc 2)" || { echo "  FAIL  absent tolerance gave rc=$rc"; fails=$((fails+1)); } ;;
    *) echo "  FAIL  absent tolerance did not fail closed: '$out'"; fails=$((fails+1)) ;; esac
  # 4. an ABSURDLY generous tolerance must say OK, and a tiny one must say DEGRADED — proving the
  #    comparison is live in BOTH directions rather than stuck on one answer.
  printf '{"min_ms": 100, "max_ratio": 100000, "probe_version": '"$HC_PROBE_VERSION"'}\n' > "$t"
  out="$(HC_SAMPLES=1 HC_BASELINE_FILE="$t" hc_verdict)"; rc=$?
  case "$out" in OK*) [ "$rc" -eq 0 ] && echo "  OK    generous tolerance -> $out" || { echo "  FAIL  rc=$rc"; fails=$((fails+1)); } ;;
    *) echo "  FAIL  generous tolerance did not say OK: '$out'"; fails=$((fails+1)) ;; esac
  printf '{"min_ms": 0.001, "max_ratio": 1.01, "probe_version": '"$HC_PROBE_VERSION"'}\n' > "$t"
  out="$(HC_SAMPLES=1 HC_BASELINE_FILE="$t" hc_verdict)"; rc=$?
  case "$out" in DEGRADED*) [ "$rc" -eq 3 ] && echo "  OK    tight tolerance -> $out (rc 3)" || { echo "  FAIL  rc=$rc"; fails=$((fails+1)); } ;;
    *) echo "  FAIL  tight tolerance did not say DEGRADED: '$out'"; fails=$((fails+1)) ;; esac
  rm -f "$t"
  echo "  self-test failures: $fails"
  return "$fails"
}

case "${1:-}" in
  --probe)      hc_probe_once; echo ;;
  --verdict)    hc_verdict; echo ;;
  --calibrate)  hc_calibrate "${2:-9}" ;;
  --self-test)  hc_self_test ;;
  "")           : ;;  # sourced
  *)            echo "usage: host-capacity.sh --probe|--verdict|--calibrate [n]|--self-test" >&2; exit 2 ;;
esac
