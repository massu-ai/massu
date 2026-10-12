#!/usr/bin/env bash
# test-pushed-range.sh — one fixture per RESOLUTION BRANCH of scripts/lib/pushed-range.sh.
#
# Each branch must FIRE for its own declared reason, and the two refusal branches must
# refuse for THEIR reason rather than merely exiting non-zero (a positive control must
# reach the branch it names — memory `a-positive-control-must-reach-the-branch-it-names`).
#
# EVERY git call here runs through `git_isolated` / `mk_git_sandbox`, so a leaked GIT_DIR
# cannot make this harness read or write the real repository (G29). That is not a
# precaution: a sandbox harness in this very repo once committed a 5,540-file deletion to
# a live tree because `cd` does not scope git.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=lib/git-env-scrub.sh
. "$REPO/scripts/lib/git-env-scrub.sh" || { echo "cannot source git-env-scrub.sh" >&2; exit 2; }
# shellcheck source=lib/pushed-range.sh
. "$REPO/scripts/lib/pushed-range.sh" || { echo "cannot source pushed-range.sh" >&2; exit 2; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; }

SANDBOX="$(mk_git_sandbox pushed-range-test)" || exit 2
REMOTE="$SANDBOX/../$(basename "$SANDBOX")-remote.git"
cleanup() { [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX" "$REMOTE"; }
trap cleanup EXIT INT TERM

# ── Build a real origin and three commits, all isolated from the caller's git env.
git_isolated -C "$SANDBOX" config user.email t@t
git_isolated -C "$SANDBOX" config user.name t
git_isolated init -q --bare "$REMOTE"
mk() { echo "$1" > "$SANDBOX/$1"; git_isolated -C "$SANDBOX" add -A; git_isolated -C "$SANDBOX" commit -qm "$1"; }
mk one; mk two
git_isolated -C "$SANDBOX" remote add origin "$REMOTE"
git_isolated -C "$SANDBOX" push -q origin HEAD:refs/heads/main
git_isolated -C "$SANDBOX" fetch -q origin
BASE_SHA="$(git_isolated -C "$SANDBOX" rev-parse HEAD)"
mk three; mk four
HEAD_SHA="$(git_isolated -C "$SANDBOX" rev-parse HEAD)"

# The library is pure shell over `git`, so it must run WITH the sandbox as its repo. Run
# each case in a subshell whose cwd is the sandbox and whose git env is neutralised, so a
# leaked binding cannot silently retarget the assertion at the real repo.
run() {  # run <MASSU_PUSH_REFS> [<argv range>]
  ( cd "$SANDBOX" || exit 2
    for n in $GIT_ENV_ALL_BINDINGS; do unset "$n"; done
    MASSU_PUSH_REFS="$1" massu_pushed_range "${2:-}" 2>&1 )
}
ZERO40="0000000000000000000000000000000000000000"
ZERO64="$(printf '0%.0s' $(seq 64))"

# ── 1. argv wins and passes through verbatim.
OUT="$(run "" "abc..def")"
[ "$OUT" = "$(printf 'argv\tabc\tdef')" ] && ok "argv passes through ($OUT)" || bad "argv: got '$OUT'"

# ── 2. an EXISTING ref: the range is exactly remote_oid..local_oid.
OUT="$(run "refs/heads/main $HEAD_SHA refs/heads/main $BASE_SHA")"
[ "$OUT" = "$(printf 'refs:update\t%s\t%s' "$BASE_SHA" "$HEAD_SHA")" ] \
  && ok "refs:update -> remote..local" || bad "refs:update: got '$OUT'"

# ── 3. a NEW ref: the base is the newest commit already on a remote — NOT HEAD~1.
#      This is the branch whose old behaviour scanned one commit of four.
OUT="$(run "refs/heads/feat $HEAD_SHA refs/heads/feat $ZERO40")"
EXPECT="$(printf 'refs:new\t%s\t%s' "$BASE_SHA" "$HEAD_SHA")"
if [ "$OUT" = "$EXPECT" ]; then
  ok "refs:new -> base is the last commit on a remote, not HEAD~1"
else
  bad "refs:new: got '$OUT' want '$EXPECT'"
fi
#      …and prove the DIFFERENCE is load-bearing: the old fallback would have seen 1 commit.
NEW_N="$(( $(git_isolated -C "$SANDBOX" rev-list "$BASE_SHA..$HEAD_SHA" | wc -l) ))"
[ "$NEW_N" -eq 2 ] && ok "the derived range carries $NEW_N commits (HEAD~1..HEAD would carry 1)" \
  || bad "expected 2 new commits, got $NEW_N"

# ── 4. a SHA-256 zero oid is still a zero oid (64 chars, not 40).
OUT="$(run "refs/heads/feat $HEAD_SHA refs/heads/feat $ZERO64")"
case "$OUT" in refs:new*) ok "a 64-char zero oid is recognised as a new ref" ;;
  *) bad "sha256 zero oid not recognised: '$OUT'" ;; esac

# ── 5. a DELETION delivers no commits, and says so distinctly.
OUT="$(run "(delete) $ZERO40 refs/heads/gone $HEAD_SHA")"
[ "$OUT" = "$(printf 'refs:none\t\t')" ] && ok "a deletion yields refs:none, not a range" \
  || bad "deletion: got '$OUT'"

# ── 6. a MALFORMED ref line is an ERROR, never a skipped row (G3: closed vocabulary).
OUT="$(run "refs/heads/main $HEAD_SHA refs/heads/main")"; RC=$?
if [ "$RC" -eq 2 ] && grep -q 'MALFORMED' <<< "$OUT"; then
  ok "a 3-field ref line exits 2 naming MALFORMED"
else
  bad "malformed line: rc=$RC out='$OUT'"
fi

# ── 7. no refs + an upstream -> the upstream branch fires.
git_isolated -C "$SANDBOX" branch --set-upstream-to=origin/main >/dev/null 2>&1
OUT="$(run "")"
case "$OUT" in upstream*"$HEAD_SHA") ok "no refs + upstream -> upstream branch" ;;
  *) bad "upstream branch: got '$OUT'" ;; esac

# ── 8. no refs + no upstream + remote refs present -> the remotes branch fires.
git_isolated -C "$SANDBOX" branch --unset-upstream >/dev/null 2>&1
OUT="$(run "")"
case "$OUT" in remotes*) ok "no refs + no upstream -> remotes branch (not HEAD~1)" ;;
  *) bad "remotes branch: got '$OUT'" ;; esac

# ── 9. THE BRANCH THAT USED TO INVENT A RANGE. With nothing to derive from, refuse —
#      and refuse for its own stated reason, not by accident.
git_isolated -C "$SANDBOX" remote remove origin
OUT="$(run "")"; RC=$?
if [ "$RC" -eq 2 ] && grep -q 'cannot determine what this push delivers' <<< "$OUT"; then
  ok "no refs, no upstream, no remotes -> exit 2 naming its reason"
else
  bad "the refusal branch: rc=$RC out='$OUT'"
fi
#      NEGATIVE CONTROL: it refused because it could not look, not because it always refuses.
OUT="$(run "" "x..y")"
[ "$OUT" = "$(printf 'argv\tx\ty')" ] && ok "negative control: it still answers when told the range" \
  || bad "negative control: got '$OUT'"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
