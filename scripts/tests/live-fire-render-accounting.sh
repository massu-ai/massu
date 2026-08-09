#!/usr/bin/env bash
# Live-fire attack on the render-pipeline conservation guard (CR-72).
#
# A fixture-only mutation test is a regression test in disguise, and a regression test
# cannot find a false negative. So each plant goes into the REAL source file, the REAL
# suite runs, and RED is demanded FOR THAT PLANT'S OWN DECLARED REASON — a plant that goes
# red for an unrelated reason proves nothing.
#
# Restore is from the BYTES THIS SCRIPT SAW, never from git: `git checkout --` reverts to
# the INDEX, which silently discards a concurrent uncommitted edit by the operator or
# another session. Byte-identity is asserted by sha256 at the end, and the trap makes the
# restore survive an abort.
#
# SAFETY (G25): every plant is an accounting edit — no destructive token, no shell
# metacharacter, no path interpolation. If the guard under test were entirely disabled,
# each plant would do nothing worse than make a counter wrong.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 2

RENDERER="packages/core/src/memory-renderer.ts"
LOADER="packages/core/src/memory-render-candidates.ts"

for f in "$RENDERER" "$LOADER"; do
  [ -f "$f" ] || { echo "FATAL: $f missing — cannot attack a guard that is not there"; exit 2; }
done

SNAP_DIR="$(mktemp -d -t render-accounting-livefire-XXXXXX)" || exit 2
cp "$RENDERER" "$SNAP_DIR/renderer.ts"
cp "$LOADER"   "$SNAP_DIR/loader.ts"
SHA_RENDERER_BEFORE="$(shasum -a 256 "$RENDERER" | cut -d' ' -f1)"
SHA_LOADER_BEFORE="$(shasum -a 256 "$LOADER"   | cut -d' ' -f1)"

restore() { cp "$SNAP_DIR/renderer.ts" "$RENDERER"; cp "$SNAP_DIR/loader.ts" "$LOADER"; }
cleanup() { restore; rm -rf "${SNAP_DIR:?}"; }
trap cleanup EXIT

pass=0; fail=0

# $1 label, $2 file, $3 python-replace old, $4 new, $5 vitest pattern, $6 expected-substring
attack() {
  local label="$1" file="$2" old="$3" new="$4" pattern="$5" want="$6"
  restore

  if ! python3 - "$file" "$old" "$new" <<'PY'
import sys, pathlib
p, old, new = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
s = p.read_text()
n = s.count(old)
if n != 1:
    print(f"PLANT-REFUSED: anchor occurs {n} times, expected exactly 1", file=sys.stderr)
    raise SystemExit(3)
p.write_text(s.replace(old, new))
PY
  then
    fail=$((fail+1)); printf '  FAIL %-46s could not plant (anchor drifted)\n' "$label"; return
  fi

  local out rc=0
  out="$(cd packages/core && npx vitest run "$pattern" 2>&1)" || rc=$?
  restore

  if [ "$rc" -eq 0 ]; then
    fail=$((fail+1)); printf '  FAIL %-46s stayed GREEN under the plant — DEAD GUARD\n' "$label"
  elif printf '%s' "$out" | grep -qF "$want"; then
    pass=$((pass+1)); printf '  ok   %-46s RED for its own reason\n' "$label"
  else
    fail=$((fail+1)); printf '  FAIL %-46s RED, but not for "%s"\n' "$label" "$want"
    printf '%s\n' "$out" | tail -12 | sed 's/^/         /'
  fi
}

echo "=== PLANTS — each must go RED, for ITS OWN declared reason ==="

# P1 — remove the `unchanged` bucket, restoring the original silent `continue`. The
# conservation invariant must catch it: a candidate leaves the loop accounted by nothing.
attack "unchanged bucket removed -> accounting leak" "$RENDERER" \
  '        unchanged++;
        continue;' \
  '        continue;' \
  'memory-render' \
  'ACCOUNTING-LEAK-DEGRADED'

# P2 — drop a denominator from an EMPTY() call site. This is the exact original defect:
# an early gate that walked away from N candidates and reported 0.
attack "EMPTY() loses its denominator" "$RENDERER" \
  "return EMPTY('lock_busy', candidates.length);" \
  "return EMPTY('lock_busy');" \
  'memory-render-accounting' \
  'no denominator'

# P3 — shrink the row window. The truncation must be REPORTED, not silently absorbed;
# this is the site that hid 10 rows on the live corpus.
attack "row window shrunk -> truncation must surface" "$LOADER" \
  'LIMIT ${CANDIDATE_WINDOW}' \
  'LIMIT 1' \
  'memory-render-accounting' \
  'ROW-WINDOW-DRIFT'

# P4 — break the loader's own conservation by discarding the exclusion bucket.
attack "loader drops its exclusion bucket" "$LOADER" \
  '  const excluded = reingest.length
    ? [{ reason: EXCLUSION_MEMORY_FILE_REINGEST, count: reingest.length }]
    : [];' \
  '  const excluded: Array<{ reason: string; count: number }> = [];' \
  'memory-render-accounting' \
  'does not balance'

echo
echo "=== RESTORE — byte-identity, asserted not assumed ==="
SHA_RENDERER_AFTER="$(shasum -a 256 "$RENDERER" | cut -d' ' -f1)"
SHA_LOADER_AFTER="$(shasum -a 256 "$LOADER"   | cut -d' ' -f1)"
for pair in "renderer:$SHA_RENDERER_BEFORE:$SHA_RENDERER_AFTER" "loader:$SHA_LOADER_BEFORE:$SHA_LOADER_AFTER"; do
  name="${pair%%:*}"; rest="${pair#*:}"; before="${rest%%:*}"; after="${rest#*:}"
  if [ "$before" = "$after" ]; then
    pass=$((pass+1)); printf '  ok   %-46s %s\n' "$name restored byte-identical" "${before:0:16}…"
  else
    fail=$((fail+1)); printf '  FAIL %-46s %s != %s\n' "$name NOT restored" "${before:0:16}" "${after:0:16}"
  fi
done

echo
echo "=== POSITIVE CONTROL — the suite must PASS on the clean tree ==="
# A gate that is red no matter what is a brick, and a brick gets bypassed (CR-72).
if (cd packages/core && npx vitest run memory-render >/dev/null 2>&1); then
  pass=$((pass+1)); printf '  ok   %-46s\n' "clean tree is GREEN"
else
  fail=$((fail+1)); printf '  FAIL %-46s\n' "clean tree is RED — the guard is a brick"
fi

echo
echo "-------------------------------------------"
echo "  passed: $pass    failed: $fail"
[ "$fail" -eq 0 ] || exit 1
echo "  RESULT: PASS"
