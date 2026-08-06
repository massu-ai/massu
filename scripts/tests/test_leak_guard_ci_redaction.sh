#!/usr/bin/env bash
# test_leak_guard_ci_redaction — P7-1: the detector must not republish what it
# detects.
#
# massu-public-leak-guard.sh runs in three public workflows (leak-guard.yml,
# leak-guard-retro.yml, leak-guard-scheduled.yml), whose logs are world-readable
# on a public repo. Two of them run `tree` mode over EVERY tracked file. On a hit
# the guard printed up to 100 characters of the matching line PLUS the pattern
# that found it — so the moment it detected private content it published that
# content to a public log, unattended.
#
# The assertion that matters is NEGATIVE and exact: the matched substring appears
# NOWHERE in stdout or stderr, while the finding is still reported by location
# and signature id. A redaction that also stops reporting is not a fix, so both
# halves are asserted.

set -uo pipefail

# --- G29/CR-92: NEUTRALISE THE CALLER'S GIT ENVIRONMENT — DO NOT REMOVE -------
# `git -C` DOES NOT SCOPE GIT. GIT_DIR outranks `-C` exactly as it outranks `cd` and
# `cwd:`, and is inherited from any CALLER that sets it — a nested git invocation, a
# wrapper, a harness, a tool — so this harness sends its sandbox `git add`/`git commit`
# at the REAL repository. (Git does NOT hand GIT_DIR to the hooks it runs; measured,
# scripts/ops/probe-git-hook-env.sh. A commit-stage hook DOES inherit GIT_INDEX_FILE,
# which redirects the index by itself — a second, independent carrier.)
# 2026-08-04, a sibling repo on this machine: a harness like this one committed
# 5,543 files touched, 1,388,627 lines deleted, 5,540 untracked — caught pre-push.
# Incident #166. Inline, NOT sourced: this script runs `set -uo pipefail` without
# `-e`, so a failed `source` would continue silently and leave it unprotected.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX
# ...and a machine-global `init.templateDir` pre-populates .git/hooks in EVERY `git init`,
# so a sandbox is NOT pristine just because it is new. GIT_TEMPLATE_DIR outranks the
# config; empty means "no template". Exported so child processes inherit it.
export GIT_TEMPLATE_DIR=""
# -----------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/massu-public-leak-guard.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok()  { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi; }

# A repo the guard will scan in tree mode. Paths must be ALLOWED ones, so that
# the CONTENT scan is what fires — not the path allowlist.
REPO="$WORK/repo"
mkdir -p "$REPO/packages/core/src"
git -C "$REPO" init -q 2>/dev/null || { mkdir -p "$REPO"; git -C "$REPO" init -q; }
git -C "$REPO" config user.email t@example.com
git -C "$REPO" config user.name T

# The secret payload. Assembled at runtime so this literal never sits in the
# repo as a contiguous string (it would otherwise trip the guard on sync).
SECRET_MARKER="$(printf 'TRADE-%s' 'SECRET')"
SECRET_CONTEXT="$(printf 'acme-falcon-ledger-internal-%s' 'only')"
printf 'header\nthis line is %s: %s\ntrailer\n' "$SECRET_MARKER" "$SECRET_CONTEXT" \
  > "$REPO/packages/core/src/leaky.ts"
git -C "$REPO" add -A >/dev/null 2>&1

echo "=============================================================="
echo "  P7-1: public CI logs must not republish detected content"
echo "=============================================================="

# ---------------------------------------------------------------------------
echo
echo "[1] CONTROL — the guard actually detects the plant (locally)"
# G-2 (plan-2026-07-26-anti-vacuity-9-unproven-gates): `env -u GITHUB_ACTIONS` is LOAD-BEARING.
# This case asserts the UN-redacted behaviour, but on a GitHub runner `GITHUB_ACTIONS=true` is
# inherited from the environment, the guard takes its redacting branch
# (massu-public-leak-guard.sh:274), and the assertion at :61 below fails. The script was only ever
# run where the assumption held — the M3 trap inverted: the TEST assumed its harness environment.
# This is a real script bug, not a missing precondition, which is why it is fixed here and not in
# the workflow.
#
# Enumerated over the WHOLE guard, not spot-checked: `GITHUB_ACTIONS` (:274) is its ONLY CI signal,
# so scrubbing that one variable is sufficient today. The assertion below exists because
# "sufficient today" is exactly what rots.
OUT_LOCAL="$( cd "$REPO" && env -u GITHUB_ACTIONS MASSU_LEAK_GUARD_MODE=tree bash "$GUARD" 2>&1 )"; RC_LOCAL=$?

# ASSERT THE SCRUB TOOK. A typo'd `env -u`, or the guard gaining a SECOND CI signal, would put this
# case silently back on the redacting branch — and a redacting CONTROL makes case [2] vacuous
# (there would be nothing to redact) while still reporting PASS. Fail LOUD instead.
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  # We are ON a runner, so this is the state that actually breaks. Prove the subshell did not see it.
  SCRUB_PROBE="$( env -u GITHUB_ACTIONS bash -c 'echo "${GITHUB_ACTIONS:-__UNSET__}"' )"
  if [ "$SCRUB_PROBE" != "__UNSET__" ]; then
    echo "  FAIL  env -u GITHUB_ACTIONS did not scrub the variable (got '$SCRUB_PROBE')" >&2
    echo "        The LOCAL case would run on the guard's REDACTING branch, making case [2] vacuous." >&2
    exit 1
  fi
  echo "  scrub asserted: GITHUB_ACTIONS is set in this environment and IS unset inside the LOCAL run"
else
  echo "  scrub asserted: GITHUB_ACTIONS is not set in this environment (nothing to scrub)"
fi
check "exits non-zero on the planted file (rc=$RC_LOCAL)" "$([ "$RC_LOCAL" -ne 0 ]; echo $?)"
grep -q 'leaky.ts' <<<"$OUT_LOCAL"
check "names the offending file" $?
# If this does NOT hold, case 2's redaction assertion is vacuous — there would be
# nothing to redact.
grep -q "$SECRET_CONTEXT" <<<"$OUT_LOCAL"
check "LOCAL run DOES print the matched content (so redaction is meaningful)" $?

# ---------------------------------------------------------------------------
echo
echo "[2] CI — the matched substring must appear NOWHERE, finding still reported"
OUT_CI="$( cd "$REPO" && GITHUB_ACTIONS=true MASSU_LEAK_GUARD_MODE=tree bash "$GUARD" 2>&1 )"; RC_CI=$?
check "still exits non-zero — the finding is NOT suppressed (rc=$RC_CI)" "$([ "$RC_CI" -ne 0 ]; echo $?)"
grep -q 'leaky.ts' <<<"$OUT_CI"
check "still names the offending file" $?
grep -qE 'signature CP-[0-9]{2}' <<<"$OUT_CI"
check "reports a signature id instead of the pattern" $?
grep -qE 'leaky\.ts:[0-9]+' <<<"$OUT_CI"
check "reports a line NUMBER (path:line)" $?
grep -q 'redacted' <<<"$OUT_CI"
check "says the content was redacted (not silently dropped)" $?

# THE assertion. Both the surrounding context and the marker itself.
! grep -q "$SECRET_CONTEXT" <<<"$OUT_CI"
check "matched CONTENT appears nowhere in stdout/stderr" $?
# NOT the bare marker: the guard's own help text legitimately names the
# marker classes it searches for, which is documentation of the RULE, not
# disclosure of the FILE. (This comment deliberately does not quote that help
# text, and does not name the marker class either: doing either put a flagged
# literal into a scripts/ file that syncs public, and ci-sync-check's own
# content grep caught it -- twice. A test about the leak boundary tripping the
# leak boundary.)
# What must never appear is the FILE'S matched line.
MATCHED_LINE="this line is ${SECRET_MARKER}: ${SECRET_CONTEXT}"
! grep -qF "$MATCHED_LINE" <<<"$OUT_CI"
check "the file's matched LINE appears nowhere in stdout/stderr" $?

# ---------------------------------------------------------------------------
echo
echo "[3] The reported line number must be CORRECT, not merely present"
# A redaction that reports the wrong location trades a leak for a lie.
REPORTED="$(grep -oE 'leaky\.ts:[0-9]+' <<<"$OUT_CI" | head -1 | cut -d: -f2)"
ACTUAL="$(grep -n "$SECRET_MARKER" "$REPO/packages/core/src/leaky.ts" | head -1 | cut -d: -f1)"
[ -n "$REPORTED" ] && [ "$REPORTED" = "$ACTUAL" ]
check "reported line $REPORTED matches the real line $ACTUAL" $?

# ---------------------------------------------------------------------------
echo
echo "[4] CLEAN tree in CI — no false positive"
rm -f "${REPO:?REPO is empty - refusing to build a destructive path (G17)}/packages/core/src/leaky.ts"
printf 'export const ok = 1;\n' > "$REPO/packages/core/src/fine.ts"
git -C "$REPO" add -A >/dev/null 2>&1
OUT_OK="$( cd "$REPO" && GITHUB_ACTIONS=true MASSU_LEAK_GUARD_MODE=tree bash "$GUARD" 2>&1 )"; RC_OK=$?
check "clean tree exits 0 under CI (rc=$RC_OK)" "$([ "$RC_OK" -eq 0 ]; echo $?)"

# ---------------------------------------------------------------------------
echo
echo "[5] ANTI-VACUITY — the pre-fix guard DID leak into the CI log"
# The guard does `source "$(dirname "$0")/lib/leak-patterns.sh"`, so the mutant
# must sit somewhere that resolves. Without this it finds no CONTENT_PATTERNS
# and matches nothing -- the case would go green for the wrong reason. (The real
# guard fails CLOSED on a missing pattern source, exit 1, verified separately.)
MUTDIR="$WORK/mutdir"
mkdir -p "$MUTDIR"
ln -sf "$REPO_ROOT/scripts/lib" "$MUTDIR/lib"
MUT="$MUTDIR/pre-fix-leak-guard.sh"
python3 - "$GUARD" "$MUT" <<'PY'
import sys
src = open(sys.argv[1]).read()
start = src.index('    pat_idx=$((pat_idx + 1))')
end   = src.rindex('  done\ndone <<< "$FILE_LIST"')
src = src[:start] + '''    matches=$(echo "$content" | grep -Ei "$pat" | grep -vE 'leak-guard-allow:' || true)
    if [ -n "$matches" ]; then
      first_line=$(echo "$matches" | head -1 | cut -c1-100)
      content_violations+=("$path  (matched: $pat)  -> ${first_line}")
    fi
''' + src[end:]
open(sys.argv[2], 'w').write(src)
PY
if [ ! -s "$MUT" ]; then
  bad "could not rebuild the pre-fix guard — cannot prove this test has teeth"
else
  ok "PLANT: pre-fix guard rebuilt (redaction branch removed)"
  printf 'header\nthis line is %s: %s\ntrailer\n' "$SECRET_MARKER" "$SECRET_CONTEXT" \
    > "$REPO/packages/core/src/leaky.ts"
  git -C "$REPO" add -A >/dev/null 2>&1
  OUT_MUT="$( cd "$REPO" && GITHUB_ACTIONS=true MASSU_LEAK_GUARD_MODE=tree bash "$MUT" 2>&1 )"
  grep -q "$SECRET_CONTEXT" <<<"$OUT_MUT"
  check "DEFEAT: pre-fix guard prints the secret INTO the CI log" $?
  grep -qF "$MATCHED_LINE" <<<"$OUT_MUT"
  check "ORACLE: the whole matched LINE — exactly what P7-1 removes" $?
fi

echo
echo "=============================================================="
printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
echo "=============================================================="
[ "$FAIL" -eq 0 ]
