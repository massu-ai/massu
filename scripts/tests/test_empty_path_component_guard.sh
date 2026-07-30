#!/usr/bin/env bash
# test_empty_path_component_guard — a destructive path built from a variable that can be
# EMPTY must not survive in this repo.
#
# INCIDENT 2026-07-26: an empty path component widens a delete to its parent.
#
# On 2026-07-26 a test harness destroyed a project directory outright and removed 250 files
# from a second one before a circuit breaker froze it. Two lines:
#
#     ENC6="$(enc_project_dir "$R6")"        # encoder fails -> prints nothing -> ENC6=""
#     rm -rf "$HOME/.claude/projects/$ENC6"  # -> rm -rf "$HOME/.claude/projects/"
#
# Three defences were present and all three were inert. `set -u` fires on an UNSET variable,
# not an EMPTY one. A `[ -n "$COMPOSED_PATH" ]` guard is always true because the literal
# prefix alone satisfies it — it validated the concatenation, never the component that could
# vanish. Nothing asserted containment.
#
# THE TEST APPLIED HERE, to every destructive command in the repo:
#     "if every variable in this path were the empty string, what does it point at?"
# If a real directory survives that blanking, the line is a live wipe waiting on one failed
# subprocess, and this guard fails.
#
# ${VAR:?message} is the only plain-shell form that aborts on EMPTY as well as unset, so it
# is what counts as guarded here.
#
# M1: reports its DENOMINATOR (files scanned). Scanning zero files is a LOUD failure, never
# a pass. M4: mutation-proven below — the guard plants the real defect, demands RED,
# restores, and asserts the tree is unchanged.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PASS=0
FAIL=0
ok()  { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }

# ── the scanner ──────────────────────────────────────────────────────────────────────
# Returns one line per offending site. Kept in-file so the guard has no external
# dependency that could go missing and silently turn every run green.
scan () {
  local root="$1"
  python3 - "$root" <<'PY'
import os, re, sys

root = sys.argv[1]
SKIP = re.compile(r"/(node_modules|\.git|\.venv|__pycache__|dist|build|coverage)(/|$)")
EXT = (".sh", ".bash", ".zsh")
DESTRUCTIVE = re.compile(r"\brm\s+-[rRf][rRfdv]*\s|\brmdir\b|\bmv\b|\bfind\b[^\n|;]*-delete")
QUOTED = re.compile(r'"([^"\n]*)"')
BLANKABLE = re.compile(r"\$\{[^}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*")
GUARDED = re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*:[?+-]")
MESSAGE = re.compile(r"^\s*(echo|printf|logger|say|print)\b")

scanned = 0
for dirpath, dirnames, filenames in os.walk(root):
    if SKIP.search(dirpath + "/"):
        dirnames[:] = []
        continue
    for fn in filenames:
        if not fn.endswith(EXT):
            continue
        p = os.path.join(dirpath, fn)
        try:
            text = open(p, encoding="utf-8", errors="replace").read()
        except Exception as e:
            print(f"UNREADABLE\t{p}\t{e}")   # M2: never silently skip
            continue
        scanned += 1
        for n, line in enumerate(text.splitlines(), 1):
            s = line.strip()
            if not s or s.startswith("#") or MESSAGE.match(s):
                continue
            if not DESTRUCTIVE.search(line) or GUARDED.search(line):
                continue
            for tok in QUOTED.findall(line):
                if "$" not in tok:
                    continue
                residue = re.sub(r"/{2,}", "/", BLANKABLE.sub("", tok))
                # A real path surviving the blanking is the defect.
                if "/" in residue and residue.strip("/"):
                    print(f"HIT\t{p}\t{n}\t{residue}\t{s[:100]}")
                    break
print(f"SCANNED\t{scanned}")
PY
}

echo "== repo is clean of the Incident #128 shape =="
OUT="$(scan "$REPO_ROOT")"
SCANNED="$(printf '%s\n' "$OUT" | awk -F'\t' '$1=="SCANNED"{print $2}')"
HITS="$(printf '%s\n' "$OUT" | awk -F'\t' '$1=="HIT"' || true)"
UNREADABLE="$(printf '%s\n' "$OUT" | awk -F'\t' '$1=="UNREADABLE"' || true)"

# M1: a scan that examined nothing must be LOUD, never a quiet pass.
if [ -z "${SCANNED:-}" ] || [ "$SCANNED" -lt 5 ]; then
  bad "DENOMINATOR: only ${SCANNED:-0} file(s) scanned — the scan collapsed, refusing to report clean"
else
  ok "DENOMINATOR: $SCANNED shell file(s) scanned"
fi

if [ -n "$UNREADABLE" ]; then
  bad "unreadable file(s) — an unreadable input is a failure, never an empty result"
  printf '%s\n' "$UNREADABLE" | sed 's/^/      /'
else
  ok "every candidate file was readable"
fi

if [ -n "$HITS" ]; then
  bad "destructive path(s) that widen to a parent when a variable is empty"
  printf '%s\n' "$HITS" | awk -F'\t' '{printf "      %s:%s  collapses to %s\n         %s\n", $2, $3, $4, $5}'
else
  ok "no destructive path collapses to a real directory"
fi

# ── M4 MUTATION: plant the real defect, demand RED, restore, assert unchanged ─────────
echo "== the guard actually FIRES on the real defect (not decoration) =="
PLANT="$REPO_ROOT/scripts/tests/.empty-path-mutation-probe.sh"
cleanup_plant () { rm -f "${PLANT:?}"; }
trap cleanup_plant EXIT

# The probe path is assembled from a SINGLE-QUOTED fragment and written with printf, so
# the offending literal never appears inside this file as a double-quoted token. Excluding
# this file from its own scan would have been the easy fix and the wrong one -- it would
# blind the guard to a genuine defect introduced here later.
PROBE_PATH='$HOME/.massu/projects/$ENC'
printf '#!/usr/bin/env bash\nset -uo pipefail\nENC=""\nrm -rf "%s"\n' "$PROBE_PATH" > "$PLANT"

PLANTED_OUT="$(scan "$REPO_ROOT")"
if printf '%s\n' "$PLANTED_OUT" | grep -q 'empty-path-mutation-probe'; then
  ok "guard goes RED on a planted defect"
else
  bad "guard stayed GREEN on a planted defect — it is DECORATION"
fi

rm -f "$PLANT"
if [ -e "$PLANT" ]; then
  bad "planted probe not removed — tree left dirty"
else
  ok "planted probe removed, tree restored"
fi

RESTORED_OUT="$(scan "$REPO_ROOT")"
if printf '%s\n' "$RESTORED_OUT" | grep -q 'empty-path-mutation-probe'; then
  bad "probe still detected after removal — scan is stale"
else
  ok "guard returns to GREEN after restore"
fi

echo
echo "checks run (denominator): $((PASS + FAIL))   passed: $PASS   failed: $FAIL"
if [ $((PASS + FAIL)) -lt 6 ]; then
  echo "FAIL-CLOSED: only $((PASS + FAIL)) checks ran — the harness itself is broken" >&2
  exit 2
fi
[ "$FAIL" -eq 0 ] || exit 1
echo "RESULT: PASS — the Incident #128 shape is absent, and the guard proves it can detect it."
exit 0
