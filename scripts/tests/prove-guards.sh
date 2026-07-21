#!/usr/bin/env bash
# scripts/tests/prove-guards.sh — run the per-kind real-tree can-fail proof for every guard-kind
# gate serially and tally PASS/FAIL. A focused proving loop over the P4 guard universe (the runner's
# guard-DEFEAT phase does this too, but this skips the slow shell sweep and captures each failure).
#
# Usage: bash scripts/tests/prove-guards.sh [--like SUBSTR]
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REG="$REPO_ROOT/scripts/lib/gate-registry.json"
EXEC="$REPO_ROOT/scripts/tests/_run_guard_defeat.py"
LIKE="${2:-}"
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; NC=$'\033[0m'

IDS=$(python3 -c '
import json,sys
reg=json.load(open(sys.argv[1])); like=sys.argv[2]
for g in reg["gates"]:
    if g.get("kind","shell-failpoint")=="shell-failpoint": continue
    if like and like not in g["id"]: continue
    print(g["id"])
' "$REG" "$LIKE")

TOTAL=$(printf '%s\n' "$IDS" | grep -c .)
[ "$TOTAL" -eq 0 ] && { echo "no guard gates selected"; exit 2; }
echo "Proving $TOTAL guard gate(s)..."
PASS=0; FAIL=0; FATAL=0
FAILLOG="$(mktemp)"
i=0
while IFS= read -r gid; do
  [ -z "$gid" ] && continue
  i=$((i+1))
  out="$(python3 "$EXEC" --registry "$REG" --repo-root "$REPO_ROOT" --gate "$gid" 2>&1)"; ec=$?
  if [ "$ec" -eq 0 ]; then PASS=$((PASS+1)); printf '\r  [%d/%d] %sPASS%s %d\033[K' "$i" "$TOTAL" "$GREEN" "$NC" "$PASS"
  elif [ "$ec" -eq 2 ]; then FATAL=$((FATAL+1)); { echo "── FATAL $gid"; echo "$out"; } >> "$FAILLOG"
  else FAIL=$((FAIL+1)); { echo "── FAIL $gid"; printf '%s\n' "$out" | tail -3; } >> "$FAILLOG"; fi
done <<< "$IDS"
echo
echo "═══════════════════════════════════════════"
echo "  proven : $PASS / $TOTAL"
echo "  failed : $FAIL   fatal: $FATAL"
if [ "$FAIL" -gt 0 ] || [ "$FATAL" -gt 0 ]; then
  echo "${RED}FAILURES (fix the plant/oracle for each):${NC}"; cat "$FAILLOG"
  cp "$FAILLOG" "$REPO_ROOT/.guard-proof-failures.txt"
  echo "(full list also in .guard-proof-failures.txt)"
  rm -f "$FAILLOG"; exit 1
fi
rm -f "$FAILLOG"
echo "${GREEN}PASS${NC}: every guard gate went RED on its planted defect."
exit 0
