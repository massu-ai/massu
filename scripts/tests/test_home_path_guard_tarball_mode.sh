#!/usr/bin/env bash
# test_home_path_guard_tarball_mode — P2-2: the home-path guard must be able to
# scan something that is not a git repo.
#
# The guard is the ONLY deny-list-INDEPENDENT layer in the publication stack. The
# deny-list is generated from the current machine's $HOME, so it knows exactly one
# operator identity; a SECOND operator's real home path passes it clean. This
# guard inverts that — it allows a documented set of synthetic placeholder names
# and refuses every other /Users/<name>.
#
# It required a git repo, so it could not run over an extracted npm tarball, which
# is precisely the channel (C4) that has no git tree. Result: tarballs were covered
# by the deny-list alone — never by the one layer that catches a second operator.
#
# The fixture is a REAL `npm pack` artifact, not a synthesised directory, because
# the property under test is "this works on the actual publication artifact".

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
GUARD="$REPO_ROOT/scripts/lib/home-path-guard.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok()  { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi; }

# A home path that is NOT this machine's operator and NOT a placeholder — the
# exact shape the deny-list cannot know about. Built at runtime so the literal
# never sits in the repo as a static string.
SECOND_OPERATOR="/Users/$(printf 'mriv%s' 'ers')/work/notes.txt"

echo "=============================================================="
echo "  P2-2: home-path guard runs over a non-git tarball"
echo "=============================================================="

# ---------------------------------------------------------------------------
echo
echo "[0] Build a REAL npm pack artifact"
TB="$WORK/tb"; mkdir -p "$TB"
if ! ( cd "$REPO_ROOT/packages/types" && npm pack --pack-destination "$TB" ) >/dev/null 2>&1; then
  bad "npm pack failed — cannot build the fixture (absence is not a pass)"
  printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"; exit 1
fi
TGZ="$(find "$TB" -maxdepth 1 -name '*.tgz' | head -1)"
[ -n "$TGZ" ]
check "npm pack produced a tarball" $?
tar -xzf "$TGZ" -C "$TB"
PKG="$TB/package"
[ -d "$PKG" ]
check "tarball extracted to $PKG" $?
[ ! -e "$PKG/.git" ]
check "extraction has NO .git (this is the case the guard could not handle)" $?

# ---------------------------------------------------------------------------
echo
echo "[1] CLEAN tarball — must pass, and must say what it scanned"
OUT="$(bash "$GUARD" "$PKG" 2>&1)"; RC=$?
check "exits 0 on the unmodified tarball (rc=$RC)" "$([ "$RC" -eq 0 ]; echo $?)"
grep -q 'mode=dir' <<<"$OUT"
check "auto-selected dir mode (liveness — it took the non-git path)" $?
grep -qE 'scanning [1-9][0-9]* file\(s\)' <<<"$OUT"
check "reports a NON-ZERO scanned count (clean means something)" $?

# ---------------------------------------------------------------------------
echo
echo "[2] PLANT a second-operator home path — must go RED and name the file"
printf 'see %s for details\n' "$SECOND_OPERATOR" > "$PKG/NOTES.md"
OUT="$(bash "$GUARD" "$PKG" 2>&1)"; RC=$?
check "exits non-zero (rc=$RC)" "$([ "$RC" -ne 0 ]; echo $?)"
[ "$RC" -eq 1 ]
check "exit 1 = hits found (not 2 = could not scan)" $?
grep -q 'NOTES.md' <<<"$OUT"
check "names the offending file" $?
grep -q 'HOME-PATH GUARD' <<<"$OUT"
check "prints the guard's banner" $?

# ---------------------------------------------------------------------------
echo
echo "[3] REMOVE it — must go back to GREEN"
rm -f "${PKG:?PKG is empty - refusing to build a destructive path (G17)}/NOTES.md"
OUT="$(bash "$GUARD" "$PKG" 2>&1)"; RC=$?
check "exits 0 once the plant is removed (rc=$RC)" "$([ "$RC" -eq 0 ]; echo $?)"

# ---------------------------------------------------------------------------
echo
echo "[4] A documented PLACEHOLDER must still be allowed in dir mode"
printf 'example path /Users/example/project\n' > "$PKG/DOC.md"
OUT="$(bash "$GUARD" "$PKG" 2>&1)"; RC=$?
check "placeholder name does not trip the guard (rc=$RC)" "$([ "$RC" -eq 0 ]; echo $?)"
rm -f "${PKG:?PKG is empty - refusing to build a destructive path (G17)}/DOC.md"

# ---------------------------------------------------------------------------
echo
echo "[5] EMPTY directory — 'nothing to scan' is NOT clean"
EMPTY="$WORK/empty"; mkdir -p "$EMPTY"
OUT="$(bash "$GUARD" "$EMPTY" 2>&1)"; RC=$?
[ "$RC" -eq 2 ]
check "exits 2, refusing to report clean on 0 files (rc=$RC)" $?
grep -q 'scanned 0 files' <<<"$OUT"
check "says so explicitly" $?

# ---------------------------------------------------------------------------
echo
echo "[6] TREE mode still works — no regression on the git path"
G="$WORK/gitrepo"; mkdir -p "$G"
git -C "$G" init -q
git -C "$G" config user.email t@example.com
git -C "$G" config user.name T
printf 'clean\n' > "$G/a.txt"
git -C "$G" add -A >/dev/null 2>&1
OUT="$(bash "$GUARD" "$G" 2>&1)"; RC=$?
check "clean git tree exits 0 (rc=$RC)" "$([ "$RC" -eq 0 ]; echo $?)"
grep -q 'mode=tree' <<<"$OUT"
check "auto-selected tree mode for a git repo" $?
printf 'leak %s\n' "$SECOND_OPERATOR" > "$G/b.txt"
git -C "$G" add -A >/dev/null 2>&1
OUT="$(bash "$GUARD" "$G" 2>&1)"; RC=$?
[ "$RC" -eq 1 ]
check "tracked leak still caught in tree mode (rc=$RC)" $?

# ---------------------------------------------------------------------------
echo
echo "[7] ANTI-VACUITY — the pre-fix guard could NOT scan the tarball at all"
MUT="$WORK/pre-fix-home-path-guard.sh"
python3 - "$GUARD" "$MUT" <<'PY'
import sys
src = open(sys.argv[1]).read()
start = src.index('  local mode="${2:-auto}"')
end = src.index('  # Build an anchored alternation')
src = src[:start] + '''
  if [ ! -d "$root/.git" ] && ! git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
    echo "home_path_guard: '$root' is not a git repo — cannot determine the tracked publication set." >&2
    return 2
  fi

''' + src[end:]
# Restore the pre-fix single-path scan too.
src = src.replace('''  local raw
  if [ "$mode" = "tree" ]; then''', '''  local raw
  if true; then''')
open(sys.argv[2], 'w').write(src)
PY
if [ ! -s "$MUT" ]; then
  bad "could not rebuild the pre-fix guard — cannot prove this test has teeth"
else
  ok "PLANT: pre-fix guard rebuilt (git-repo requirement restored)"
  printf 'see %s\n' "$SECOND_OPERATOR" > "$PKG/NOTES.md"
  OUT="$(bash "$MUT" "$PKG" 2>&1)"; RC=$?
  [ "$RC" -eq 2 ]
  check "DEFEAT: pre-fix guard exits 2 on the tarball — it cannot scan it (rc=$RC)" $?
  grep -q 'is not a git repo' <<<"$OUT"
  check "ORACLE: and it says why — the tarball has no git tree" $?
  # The consequence: a real second-operator path sat in the artifact UNCHECKED.
  grep -q 'NOTES.md' <<<"$OUT"
  check "ORACLE: it never named the planted file (it never looked)" "$([ $? -ne 0 ]; echo $?)"
  rm -f "${PKG:?PKG is empty - refusing to build a destructive path (G17)}/NOTES.md"
fi

echo
echo "=============================================================="
printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
echo "=============================================================="
[ "$FAIL" -eq 0 ]
