#!/usr/bin/env bash
# pushed-range.sh — ONE derivation of "what is this push actually delivering?"
#
# SOURCED, never executed. Provides `massu_pushed_range`, which prints one
# `<source>\t<base>\t<head>` record per ref being pushed.
#
# ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
#
# `scripts/massu-incident-coverage.sh` (CR-62) scans the commits a push delivers. It used to
# GUESS that range:
#
#     if git rev-parse --verify --quiet "origin/$BRANCH"; then RANGE="origin/$BRANCH..HEAD"
#     else                                                     RANGE="HEAD~1..HEAD"      # <-- the defect
#
# The `else` branch is taken on EVERY not-yet-pushed branch, and it is wrong in BOTH
# directions, which is why widening it is not the fix:
#
#   TOO NARROW  a branch of 8 commits is judged on its last 1. Seven obligated commits
#               are never examined, and the gate reports PASS. That is the blind-gate
#               signature on the irreversible half of the commit/push pair.
#   TOO WIDE-ish/WRONG  the discharge evidence for the last commit may sit two commits
#               back, so the gate reports FAIL on a fully-compliant branch. Measured
#               2026-09-22 on `chore/website-row-aliases-onto-tables-generic`:
#               `HEAD~1..HEAD` -> FAIL, the real pushed range -> "8 commit(s); 2
#               obligated; discharged: containment 1 · citation 1 … PASS".
#
# A gate that is red on compliant work teaches `--no-verify` (CR-72), and one that is
# green on 7 unexamined commits is decoration. Both come from the same root: THE GATE WAS
# GUESSING A FACT GIT HANDS US.
#
# ── THE AUTHORITATIVE SOURCE ───────────────────────────────────────────────────
#
# git's documented `pre-push` protocol writes one line per ref to the hook's STDIN:
#
#     <local ref> <local oid> <remote ref> <remote oid>
#
# and, per githooks(5): "If the foreign ref does not yet exist the <remote SHA-1> will be
# 40 0" — i.e. a new branch is self-identifying. git-lfs's own pre-push implementation
# consumes exactly this. So the range is not something to infer; it is an input, and every
# derivation is a re-derivation of a fact we were already given (Rule 25).
#
# Sources: git-scm.com/docs/githooks (pre-push), manpages "git-lfs-pre-push".
#
# ── WHY AN ENV VAR AND NOT STDIN ───────────────────────────────────────────────
#
# A STREAM HAS EXACTLY ONE READER, and this chain has four links:
#
#     .git/hooks/pre-push (managed shim)  ->  pre-push.local  ->  pre-push-release-battery.sh
#       ->  pre-push-light.sh  ->  massu-incident-coverage.sh
#
# The shim already learned this the hard way and documents it: the dispatcher consumes
# stdin to EOF, so a later link reads an EXHAUSTED stream, sees no refs, and "nothing to
# scan" ALLOWS the push. If this library read stdin, it would be the fifth reader of a
# stream the first four already drained.
#
# So the payload is captured ONCE, at the boundary that legitimately has it
# (`scripts/hooks/pre-push-release-battery.sh`), and EXPORTED as `MASSU_PUSH_REFS`. An
# environment variable has no reader-exhaustion semantics: every consumer sees it, in any
# order, however many of them there are.
#
# ── RESOLUTION ORDER, AND WHY IT ENDS IN exit 2 ────────────────────────────────
#
#   1. an explicit `<base>..<head>` argument       — an operator asking a specific question
#   2. MASSU_PUSH_REFS                             — AUTHORITATIVE: git told us
#   3. the branch's upstream (`@{u}..HEAD`)        — a manual run on a tracked branch
#   4. everything not on any remote               — a manual run on an untracked branch
#   5. exit 2                                      — COULD NOT LOOK. Never a range.
#
# There is deliberately NO fallback that invents a range. `HEAD~1..HEAD` was precisely
# such a fallback, and its whole cost was that "I could not determine the range" arrived
# wearing the clothes of "here is the range". A caller that cannot be told what a push
# delivers must refuse, not scan an arbitrary window (M2 — fail closed).
#
# Every record names its SOURCE so the log says which branch was taken (M1): a silent
# regression from `refs` to `upstream` is otherwise indistinguishable from a healthy run.

# A deletion (or a brand-new ref) is announced with an all-zero oid. Match on ANY length
# so this keeps working under SHA-256 object format, where the zero oid is 64 characters.
_massu_is_zero_oid() {
  case "$1" in
    *[!0]*) return 1 ;;   # contains a non-zero character
    "")     return 1 ;;
    *)      return 0 ;;
  esac
}

# The base for a NEW ref: the newest commit that is already on some remote and is an
# ancestor of the pushed head. Derived by asking git which commits are new and taking the
# parent of the OLDEST one — which is exactly the set `git push` will transmit.
#
# Prints the base oid, or the empty string when the push includes a root commit (there is
# no parent to name). The caller must handle empty explicitly; it means "all of history",
# never "nothing".
_massu_base_for_new_ref() {
  local head="$1" oldest_new
  oldest_new="$(git rev-list "$head" --not --remotes | tail -1)" || return 1
  if [ -z "$oldest_new" ]; then
    # Every commit is already on a remote: the ref is new but delivers no new commits
    # (e.g. pushing an existing sha under a second name). The base IS the head.
    printf '%s\n' "$head"
    return 0
  fi
  git rev-parse --verify --quiet "${oldest_new}^" 2>/dev/null || printf '%s' ''
}

# massu_pushed_range [<explicit range>]
#
# Prints TAB-separated `<source>\t<base>\t<head>` records, one per pushed ref. `<base>`
# empty means "from the root". Returns 2 when the range cannot be determined.
massu_pushed_range() {
  local explicit="${1:-}"

  # ── 1. an explicit argument wins, and is passed through verbatim.
  if [ -n "$explicit" ]; then
    local base="${explicit%%..*}" head="${explicit##*..}"
    printf 'argv\t%s\t%s\n' "$base" "$head"
    return 0
  fi

  # ── 2. AUTHORITATIVE: the ref lines git handed the pre-push hook.
  if [ -n "${MASSU_PUSH_REFS:-}" ]; then
    local local_ref local_oid remote_ref remote_oid emitted=0
    while read -r local_ref local_oid remote_ref remote_oid; do
      [ -z "${local_ref:-}" ] && continue
      if [ -z "${remote_oid:-}" ]; then
        echo "pushed-range: MALFORMED ref line (expected 4 fields): $local_ref $local_oid $remote_ref" >&2
        return 2
      fi
      if _massu_is_zero_oid "$local_oid"; then
        # A deletion delivers no commits. Not an error, and not a range.
        continue
      fi
      if _massu_is_zero_oid "$remote_oid"; then
        local base
        base="$(_massu_base_for_new_ref "$local_oid")" || {
          echo "pushed-range: could not derive a base for new ref $local_ref" >&2
          return 2
        }
        printf 'refs:new\t%s\t%s\n' "$base" "$local_oid"
      else
        printf 'refs:update\t%s\t%s\n' "$remote_oid" "$local_oid"
      fi
      emitted=$((emitted + 1))
    done <<REFS
$MASSU_PUSH_REFS
REFS
    # A payload that parsed to nothing is either a deletion-only push or a corrupted
    # capture, and those must not look alike. Say which.
    if [ "$emitted" -eq 0 ]; then
      printf 'refs:none\t\t\n'
    fi
    return 0
  fi

  # ── 3. a manual run on a branch that has an upstream.
  local head_oid upstream
  head_oid="$(git rev-parse --verify --quiet HEAD)" || {
    echo "pushed-range: HEAD does not resolve — refusing to guess a range" >&2
    return 2
  }
  if upstream="$(git rev-parse --verify --quiet '@{u}' 2>/dev/null)" && [ -n "$upstream" ]; then
    printf 'upstream\t%s\t%s\n' "$upstream" "$head_oid"
    return 0
  fi

  # ── 4. a manual run on a branch with no upstream: whatever is not on any remote.
  #      This is the SAME question git answers for a new ref, so it uses the same helper
  #      rather than a second derivation that could drift from it (Rule 25).
  if [ -n "$(git for-each-ref --count=1 'refs/remotes/')" ]; then
    local base
    base="$(_massu_base_for_new_ref "$head_oid")" || {
      echo "pushed-range: could not derive a base from remote-tracking refs" >&2
      return 2
    }
    printf 'remotes\t%s\t%s\n' "$base" "$head_oid"
    return 0
  fi

  # ── 5. COULD NOT LOOK. This is the branch that used to say `HEAD~1..HEAD`.
  echo "pushed-range: cannot determine what this push delivers." >&2
  echo "  no MASSU_PUSH_REFS, no upstream for $(git rev-parse --abbrev-ref HEAD 2>/dev/null), and no remote-tracking refs." >&2
  echo "  Refusing to substitute an arbitrary window — pass an explicit <base>..<head>." >&2
  return 2
}
