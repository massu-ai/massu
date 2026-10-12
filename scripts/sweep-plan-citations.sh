#!/usr/bin/env bash
# sweep-plan-citations — run the citation verifier over a corpus of plans and REPORT.
#
# Reports the DENOMINATOR and three DISTINCT states: PASS / FAIL / NO-CITATIONS.
# Exits non-zero only when a plan has citations that do not resolve.
#   --changed   only plans differing from origin/main or dirty/untracked in the worktree
#               (scope DERIVED from git, never a roster — G32)
#
# PORTABILITY: no `mapfile`. macOS ships bash 3.2, where `mapfile` does not exist and the
# script exits 127 — a gate that cannot run at all (M3: test it the way production runs it).
set -euo pipefail
# G29: never inherit a caller's git environment.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MODE="${1:-in-flight}"
case "$MODE" in
  in-flight|all|--changed) : ;;
  *) echo "usage: sweep-plan-citations.sh [in-flight|all|--changed]" >&2; exit 2 ;;
esac

# ⛔ WHY THE DEFAULT IS `in-flight`, AND WHY THE ARCHIVE IS REPORTED BUT NOT FAILED.
#
# Measured 2026-09-20 over the whole corpus: 125 plans, 101 failing, 667 unresolved
# citations. Broken down by the plan's own Status line:
#
#     FINISHED        90 failing of 108   (83%)
#     IN FLIGHT        6 failing of  11   (55%)
#
# 86% of this repo's plans are FINISHED, and their citations were ACCURATE WHEN WRITTEN.
# `config.ts:386` was line 386 the day it shipped; months of edits moved it. Rewriting
# those to today's line numbers would FALSIFY A HISTORICAL RECORD and drift again within
# weeks — a loop whose output grows its own input, with no fixed point (G24).
#
# A citation in a shipped plan is a claim about the tree AT THE TIME IT SHIPPED. Checking
# it against HEAD is a category error, and 101 failures nobody can act on is precisely the
# gate people learn to ignore (CR-72).
#
# So the default scope is the plans where a wrong citation misleads an implementer TODAY.
# The archive is still COUNTED and PRINTED every run — it is a known, explained state, not
# a hidden one — and `all` restores the old behaviour for anyone who wants it.

LIST="$(mktemp -t massu-plan-sweep-XXXXXXXX)"
trap 'rm -f "$LIST"' EXIT INT TERM

if [ "$MODE" = "--changed" ]; then
  # THE BASE IS DERIVED AND MUST RESOLVE.
  #
  # This used to read `origin/main...HEAD` with the failure silenced by `|| true`. When
  # that ref could not be resolved — a clone whose default branch is not `main`, a
  # checkout with no `origin`, a fetch that never ran — the diff produced nothing, the
  # list was empty, and the script reported `PLANS CHANGED: 0 — nothing to verify` and
  # EXIT 0. "I could not look" and "I looked and found nothing" were the same value, and
  # it was the passing one (THE BLIND-GATE LAW). Found 2026-09-22 while enumerating the
  # sites obligated by the pushed-range fix; same class, different script.
  #
  # `refs/remotes/origin/HEAD` is origin's OWN statement of its default branch, so the
  # base is asked for rather than assumed (no hardcoded branch name to rot). If neither
  # that nor `origin/main` resolves, REFUSE: there is no base against which "changed in
  # flight" means anything.
  CHANGED_BASE=""
  if BASE_REF="$(git symbolic-ref --quiet refs/remotes/origin/HEAD)"; then
    CHANGED_BASE="$BASE_REF"
  elif git rev-parse --verify --quiet origin/main >/dev/null; then
    CHANGED_BASE="origin/main"
  fi
  if [ -z "$CHANGED_BASE" ]; then
    echo "sweep-plan-citations: CANNOT RESOLVE a base for --changed." >&2
    echo "  neither refs/remotes/origin/HEAD nor origin/main resolves, so 'changed in" >&2
    echo "  flight' has no meaning here. Refusing rather than reporting 0 changed." >&2
    exit 2
  fi
  echo "sweep-plan-citations: --changed base ${CHANGED_BASE}"
  {
    git diff --name-only "${CHANGED_BASE}...HEAD" -- 'docs/plans/*.md'
    git diff --name-only -- 'docs/plans/*.md' 2>/dev/null || true
    git ls-files --others --exclude-standard -- 'docs/plans/*.md' 2>/dev/null || true
  } | LC_ALL=C sort -u | grep -v '^$' > "$LIST" || true
else
  git ls-files 'docs/plans/*.md' | LC_ALL=C sort > "$LIST"
fi

# Partition by the plan's own Status line. A plan with NO status line is treated as
# in-flight: unknown is not a licence to skip (M2, fail closed).
ARCHIVE="$(mktemp -t massu-plan-sweep-archive-XXXXXXXX)"
if [ "$MODE" = "in-flight" ]; then
  INFLIGHT="$(mktemp -t massu-plan-sweep-inflight-XXXXXXXX)"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if head -40 "$f" | LC_ALL=C grep -qiE '^\*\*Status\*\*:.*(SHIPPED|COMPLETE|IMPLEMENTED|DONE)'; then
      printf '%s\n' "$f" >> "$ARCHIVE"
    else
      printf '%s\n' "$f" >> "$INFLIGHT"
    fi
  done < "$LIST"
  cp "$INFLIGHT" "$LIST"
  rm -f "$INFLIGHT"
fi
ARCHIVED=$(wc -l < "$ARCHIVE" | tr -d ' ')

TOTAL=$(wc -l < "$LIST" | tr -d ' ')
if [ "$TOTAL" -eq 0 ]; then
  if [ "$MODE" = "--changed" ]; then echo "PLANS CHANGED: 0 — nothing to verify"; exit 0; fi
  echo "sweep-plan-citations: DENOMINATOR 0 — no plans found. Refusing to report clean." >&2
  exit 2
fi

P=0; F=0; N=0
FAILED="$(mktemp -t massu-plan-sweep-failed-XXXXXXXX)"
trap 'rm -f "$LIST" "$FAILED" "$ARCHIVE"' EXIT INT TERM
while IFS= read -r f; do
  [ -n "$f" ] || continue
  set +e
  node "$ROOT/scripts/verify-plan-citations.mjs" "$f" --quiet >/dev/null 2>&1
  rc=$?
  set -e
  case "$rc" in
    0) P=$((P+1)) ;;
    3) N=$((N+1)) ;;
    *) F=$((F+1)); printf '  %s\n' "$f" >> "$FAILED" ;;
  esac
done < "$LIST"

echo "----"
echo "SCOPE: $MODE"
echo "PLANS SCANNED (denominator): $TOTAL"
echo "  PASS         : $P"
echo "  FAIL         : $F"
echo "  NO-CITATIONS : $N   (nothing was verified — this is not a pass)"
if [ "$MODE" = "in-flight" ]; then
  # PRINTED EVERY RUN, never silently excluded. The archive is a known state with a
  # recorded reason, and a reader must be able to see how much of the corpus that is.
  echo "  ARCHIVED     : $ARCHIVED   (Status SHIPPED/COMPLETE — citations describe the tree"
  echo "                 AS IT WAS; verifying them against HEAD is a category error. Run"
  echo "                 with \`all\` to check them anyway.)"
fi
if [ "$F" -gt 0 ]; then
  echo "plans with unresolving citations:"
  cat "$FAILED"
  exit 1
fi
