#!/usr/bin/env bash
# test_private_content_scan_git_failopen — P3-2: the scanner's own silent open.
#
# scan_git_metadata() had TWO early returns and only one of them was correct.
#
#   `if not (repo/".git").exists(): return findings`   <- CORRECT, LOAD-BEARING.
#       A packed npm tarball has no git at all. There is no metadata to scan and
#       nothing has gone wrong; the file walk still runs. Case 2 pins this so a
#       future "harden the scanner" change cannot break the tarball channel (C4)
#       while looking like an improvement.
#
#   `if proc.returncode != 0: return findings`         <- THE DEFECT.
#       A PRESENT-but-broken git makes `git log` fail, and the scanner reported
#       CLEAN having never examined a single author identity or commit message.
#       The caller could not distinguish "nothing to find" from "never looked".
#
# The fixture is therefore a directory with a `.git` that EXISTS and is BROKEN,
# which is the only shape that reaches the defect: `.git` present (so the first
# return is skipped) but unusable (so git fails).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCANNER="$REPO_ROOT/scripts/lib/private_content_scan.py"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok()  { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi; }

echo "=============================================================="
echo "  P3-2: a git-metadata scan that CANNOT RUN must not report CLEAN"
echo "=============================================================="

# ---------------------------------------------------------------------------
echo
echo "[1] PRESENT-but-BROKEN .git — must fail LOUD, not report clean"
D="$WORK/broken-git"
mkdir -p "$D"
printf 'ordinary public content\n' > "$D/README.md"
# A `.git` FILE pointing at a gitdir that does not exist: exists() is true, so
# the correct early return is skipped, and every git command then fails.
printf 'gitdir: /nonexistent\n' > "$D/.git"

OUT="$(python3 "$SCANNER" --root "$D" --git-metadata 2>&1)"; RC=$?
check "exits non-zero (rc=$RC)" "$([ "$RC" -ne 0 ]; echo $?)"
[ "$RC" -eq 2 ]
check "exits 2 (FATAL) — distinct from 1 (leaks found) and 0 (clean)" $?
grep -q 'FATAL' <<<"$OUT"
check "says FATAL" $?
grep -qi 'could not run\|git log failed' <<<"$OUT"
check "names the cause (the git scan could not run)" $?
# The whole point: it must NOT have claimed cleanliness.
! grep -q 'CLEAN' <<<"$OUT"
check "does NOT print CLEAN" $?

# ---------------------------------------------------------------------------
echo
echo "[2] NEGATIVE CONTROL — a real npm tarball (no .git) must still scan, exit 0"
# Required by the plan: making the no-git path fail would break C4, the channel
# P2-1/P2-2 depend on. This uses a REAL `npm pack` artifact, not a mock, because
# the property under test is 'the tarball channel still works'.
TARBALL_DIR="$WORK/tarball"
mkdir -p "$TARBALL_DIR"
if ( cd "$REPO_ROOT/packages/types" && npm pack --pack-destination "$TARBALL_DIR" ) >/dev/null 2>&1; then
  TGZ="$(find "$TARBALL_DIR" -name '*.tgz' -maxdepth 1 | head -1)"
  if [ -n "$TGZ" ]; then
    tar -xzf "$TGZ" -C "$TARBALL_DIR"
    EXTRACTED="$TARBALL_DIR/package"
    [ ! -e "$EXTRACTED/.git" ]
    check "extracted tarball genuinely has no .git (fixture is real)" $?
    OUT2="$(python3 "$SCANNER" --root "$EXTRACTED" --git-metadata 2>&1)"; RC2=$?
    [ "$RC2" -eq 0 ]
    check "scans and exits 0 despite --git-metadata and no git (rc=$RC2)" $?
    grep -q 'CLEAN' <<<"$OUT2"
    check "reports CLEAN — the no-git path is untouched" $?
    # LIVENESS: prove it actually walked files rather than short-circuiting.
    COUNT="$(find "$EXTRACTED" -type f | wc -l | tr -d ' ')"
    [ "$COUNT" -gt 0 ]
    check "the extracted tree is non-empty ($COUNT files) — so 'clean' means something" $?
  else
    bad "npm pack produced no .tgz — cannot run the negative control"
  fi
else
  bad "npm pack failed — cannot run the negative control (absence is not a pass)"
fi

# ---------------------------------------------------------------------------
echo
echo "[3] ANTI-VACUITY — the pre-fix scanner must report CLEAN on fixture [1]"
# Rebuild the defect from the live source by restoring the swallowing return.
# The mutant lives in its own dir alongside a copy of the deny-list, because the
# scanner resolves DENYLIST relative to its own path and fails CLOSED when it is
# missing (exit 2, "a missing deny-list is NOT a clean result"). Without the copy
# the mutant aborts on the deny-list and never reaches the branch under test —
# a red result that proves nothing about the defect.
MUTDIR="$WORK/mutant"
mkdir -p "$MUTDIR"
cp "$REPO_ROOT/scripts/lib/private-denylist.json" "$MUTDIR/" 2>/dev/null \
  || bad "could not copy private-denylist.json next to the mutant"
MUT="$MUTDIR/pre-fix-scan.py"
python3 - "$SCANNER" "$MUT" <<'PY'
import sys
# Structural excision, not a text pattern: find the `if proc.returncode != 0:`
# block and replace its whole body with the original swallowing return. Indent-
# driven, so it survives any rewording of the raise's message.
lines = open(sys.argv[1]).read().splitlines(keepends=True)
out, i, done = [], 0, False
while i < len(lines):
    line = lines[i]
    out.append(line)
    if not done and line.strip() == 'if proc.returncode != 0:':
        if_indent = len(line) - len(line.lstrip())
        i += 1
        # Skip the entire suite: every following line that is blank or indented
        # deeper than the `if`.
        while i < len(lines):
            nxt = lines[i]
            if nxt.strip() and (len(nxt) - len(nxt.lstrip())) <= if_indent:
                break
            i += 1
        out.append(' ' * (if_indent + 4) + 'return findings\n')
        done = True
        continue
    i += 1
if not done:
    sys.stderr.write("excision failed: `if proc.returncode != 0:` not found\n")
    sys.exit(3)
open(sys.argv[2], 'w').write(''.join(out))
PY
if [ $? -ne 0 ] || [ ! -s "$MUT" ]; then
  bad "could not rebuild the pre-fix scanner — cannot prove this test has teeth"
# Check the RETURNCODE branch specifically. The function also raises on OSError
# (git absent), which is deliberately retained — grepping the whole function for
# `raise` would match that and wrongly report a failed excision.
elif RC_BRANCH="$(grep -A 1 'if proc.returncode != 0:' "$MUT")"; ! grep -q 'return findings' <<<"$RC_BRANCH"; then
  bad "pre-fix variant's returncode branch does not return findings — excision did not apply"
else
  ok "PLANT: pre-fix variant built (raise replaced by the silent return)"
  OUT3="$(python3 "$MUT" --root "$WORK/broken-git" --git-metadata 2>&1)"; RC3=$?
  [ "$RC3" -eq 0 ]
  check "DEFEAT: pre-fix scanner exits 0 on a broken git (rc=$RC3)" $?
  grep -q 'CLEAN' <<<"$OUT3"
  check "ORACLE: and it printed CLEAN — the exact silent-open being fixed" $?
fi

echo
echo "=============================================================="
printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
echo "=============================================================="
[ "$FAIL" -eq 0 ]
