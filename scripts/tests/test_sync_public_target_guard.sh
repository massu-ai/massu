#!/usr/bin/env bash
# test_sync_public_target_guard — P2-4: sync-public.sh must refuse an
# unconfirmed default target.
#
# sync-public.sh runs `git rm -rf . && git clean -fd` against its target and then
# commits. Its target used to default silently to the real public mirror, so one
# forgotten argument wiped and rewrote ~/massu.
#
# SAFETY — why this does not test against the real ~/massu.
# VR-P2-4 is written as "run it with no argument, then assert `git -C ~/massu
# status --porcelain` is unchanged". Executed literally that is a test which,
# WHEN THE IMPLEMENTATION IS BROKEN, destroys the mirror it is checking — the
# failure mode and the test procedure are the same act. So instead we build a
# throwaway internal repo whose sibling `../massu` resolves inside a temp dir:
# the default path is exercised for real, and the blast radius is scratch.
# Case 0 asserts that containment before anything runs.

set -uo pipefail

# --- G29/CR-92: NEUTRALISE THE CALLER'S GIT ENVIRONMENT — DO NOT REMOVE -------
# `cd` DOES NOT SCOPE GIT. GIT_DIR outranks cwd, `git -C` and `cwd:`, and is inherited
# from any CALLER that sets it — a nested git invocation, a wrapper, a harness, a tool
# — so a git write aimed at a temp sandbox silently addresses the REAL repository
# instead. (Git does NOT hand GIT_DIR to the hooks it runs; measured,
# scripts/ops/probe-git-hook-env.sh. A commit-stage hook DOES inherit GIT_INDEX_FILE,
# which redirects the index by itself — a second, independent carrier.)
# 2026-08-04, a sibling repo on this machine: one such harness
# committed 5,543 files touched, 1,388,627 lines deleted, `core.bare` flipped true.
# Incident #166. Unset, never override: a sandbox belongs to no repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX
# ...and a machine-global `init.templateDir` pre-populates .git/hooks in EVERY `git init`,
# so a sandbox is NOT pristine just because it is new. GIT_TEMPLATE_DIR outranks the
# config; empty means "no template". Exported so child processes inherit it.
export GIT_TEMPLATE_DIR=""
# -----------------------------------------------------------------------------


REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REAL_SYNC="$REPO_ROOT/scripts/sync-public.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok()  { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi; }

# A minimal internal repo: enough for the script to resolve INTERNAL_REPO and
# its own HEAD. $1 = destination, $2 = the sync script to install.
make_fake_internal() {
  local dir="$1" script="$2"
  mkdir -p "$dir/scripts" "$dir/packages/core" "$dir/website"
  cp "$script" "$dir/scripts/sync-public.sh"
  chmod +x "$dir/scripts/sync-public.sh"
  printf 'x\n' > "$dir/packages/core/placeholder.txt"
  git -C "$dir" init -q
  git -C "$dir" config user.email t@example.com
  git -C "$dir" config user.name T
  git -C "$dir" add -A >/dev/null 2>&1
  git -C "$dir" commit -qm init
}

# The sibling that `${1:-$INTERNAL_REPO/../massu}` resolves to.
make_fake_mirror() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email t@example.com
  git -C "$dir" config user.name T
  printf 'canary — must survive a refused run\n' > "$dir/CANARY.txt"
  git -C "$dir" add -A >/dev/null 2>&1
  git -C "$dir" commit -qm "mirror baseline"
}

SANDBOX="$WORK/sandbox"
mkdir -p "$SANDBOX"
INTERNAL="$SANDBOX/massu-internal"
MIRROR="$SANDBOX/massu"

echo "=============================================================="
echo "  P2-4: sync-public.sh refuses an unconfirmed default target"
echo "=============================================================="

# ---------------------------------------------------------------------------
echo
echo "[0] CONTAINMENT — the default target must resolve inside the sandbox"
make_fake_internal "$INTERNAL" "$REAL_SYNC"
make_fake_mirror "$MIRROR"
DEFAULT_TARGET="$(cd "$INTERNAL/scripts/.." && pwd)/../massu"
RESOLVED="$(cd "$(dirname "$DEFAULT_TARGET")" && pwd)/$(basename "$DEFAULT_TARGET")"
case "$RESOLVED" in
  "$SANDBOX"/*) ok "default target resolves to $RESOLVED (inside sandbox)" ;;
  *)            bad "default target escaped the sandbox: $RESOLVED — REFUSING to continue"
                printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"; exit 1 ;;
esac

MIRROR_HEAD_BEFORE="$(git -C "$MIRROR" rev-parse HEAD)"

# ---------------------------------------------------------------------------
echo
echo "[1] NO argument, NO env var — must refuse and touch nothing"
OUT="$(cd "$INTERNAL" && bash scripts/sync-public.sh 2>&1)"; RC=$?
check "exits non-zero (rc=$RC)" "$([ "$RC" -ne 0 ]; echo $?)"
grep -q 'REFUSING to run' <<<"$OUT"
check "says why, by name ('REFUSING to run')" $?
# The mirror is the thing at risk; assert on IT, not just on the exit code.
[ -f "$MIRROR/CANARY.txt" ]
check "mirror contents untouched (CANARY.txt still present)" $?
[ -z "$(git -C "$MIRROR" status --porcelain)" ]
check "mirror working tree clean (status --porcelain empty)" $?
[ "$(git -C "$MIRROR" rev-parse HEAD)" = "$MIRROR_HEAD_BEFORE" ]
check "mirror HEAD unmoved" $?

# ---------------------------------------------------------------------------
echo
echo "[2] MASSU_SYNC_PUBLIC_CHECK_ONLY=1 is NOT a way through"
# It exits at the drift-guard, hundreds of lines before the publication gate,
# returning 0 having scanned nothing. It must not double as target consent.
OUT="$(cd "$INTERNAL" && MASSU_SYNC_PUBLIC_CHECK_ONLY=1 bash scripts/sync-public.sh 2>&1)"; RC=$?
check "still refuses (rc=$RC, non-zero)" "$([ "$RC" -ne 0 ]; echo $?)"
grep -q 'REFUSING to run' <<<"$OUT"
check "still prints the refusal" $?

# ---------------------------------------------------------------------------
echo
echo "[3] An EXPLICIT target is accepted — the guard is not a wall"
OUT="$(cd "$INTERNAL" && bash scripts/sync-public.sh "$MIRROR" 2>&1)"; RC=$?
! grep -q 'REFUSING to run' <<<"$OUT"
check "does NOT refuse when given \$1" $?
[ "$RC" -ne 2 ]
check "does not exit with the refusal code 2 (rc=$RC)" $?

# ---------------------------------------------------------------------------
echo
echo "[4] MASSU_SYNC_TARGET_CONFIRMED=1 is accepted, and says so"
OUT="$(cd "$INTERNAL" && MASSU_SYNC_TARGET_CONFIRMED=1 bash scripts/sync-public.sh 2>&1)"; RC=$?
! grep -q 'REFUSING to run' <<<"$OUT"
check "does NOT refuse when consent is given" $?
grep -q 'target CONFIRMED via MASSU_SYNC_TARGET_CONFIRMED=1' <<<"$OUT"
check "announces the confirmed target (liveness — it really took this path)" $?

# ---------------------------------------------------------------------------
echo
echo "[5] ANTI-VACUITY — the pre-guard script must NOT refuse"
# Reintroduce the exact original line. If this still refuses, cases 1-2 are
# passing for some other reason and prove nothing about the guard.
MUT="$WORK/pre-guard-sync-public.sh"
python3 - "$REAL_SYNC" "$MUT" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
start = src.index('# --- P2-4: refuse an UNCONFIRMED default target')
end = src.index('SOURCE_HASH="$(git -C "$INTERNAL_REPO" rev-parse --short HEAD)"')
open(sys.argv[2], 'w').write(
    src[:start] + 'PUBLIC_REPO="${1:-$INTERNAL_REPO/../massu}"\n\n' + src[end:]
)
PY
if [ ! -s "$MUT" ]; then
  bad "could not build the pre-guard variant — cannot prove this test has teeth"
elif grep -q 'REFUSING to run' "$MUT"; then
  bad "pre-guard variant still contains the refusal — the excision did not apply"
else
  ok "PLANT: pre-guard variant built (refusal block removed)"
  INTERNAL2="$WORK/sandbox2/massu-internal"
  MIRROR2="$WORK/sandbox2/massu"
  mkdir -p "$WORK/sandbox2"
  make_fake_internal "$INTERNAL2" "$MUT"
  make_fake_mirror "$MIRROR2"
  OUT="$(cd "$INTERNAL2" && bash scripts/sync-public.sh 2>&1)"; RC=$?
  ! grep -q 'REFUSING to run' <<<"$OUT"
  check "DEFEAT: pre-guard script does NOT refuse a bare invocation" $?
  # And prove the CONSEQUENCE, not just the absence of a refusal: with no
  # argument it announced a target of `<internal>/../massu` — the unexpanded
  # default expression — and proceeded into the sync. That literal `/../massu`
  # is the fingerprint of the default branch; an explicit $1 would have been an
  # already-resolved path.
  if grep -qE 'Syncing massu-internal .*public repo \(.*/\.\./massu\)' <<<"$OUT"; then
    ok "ORACLE: it announced the DEFAULT target (<internal>/../massu) and proceeded"
  else
    bad "ORACLE: could not confirm it selected the default target (rc=$RC)"
    printf '       output was: %s\n' "$(head -2 <<<"$OUT")"
  fi
fi

echo
echo "=============================================================="
printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
echo "=============================================================="
[ "$FAIL" -eq 0 ]
