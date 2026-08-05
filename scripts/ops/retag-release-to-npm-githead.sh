#!/usr/bin/env bash
# retag-release-to-npm-githead.sh — point a release tag at the commit npm actually published.
#
# WHY THIS EXISTS. A release tag is supposed to answer "which commit shipped as X.Y.Z". Two
# things break that, and both happened here:
#   - the tag is created BEFORE the post-publish bookkeeping commit, then moved forward, so it
#     lands on a commit that is not the published tree (v2.2.0 sat on a CI commit from the
#     following day);
#   - the tag is never created at all (v2.4.0 shipped 2026-08-01 untagged).
#
# THE ANSWER IS NOT A GUESS. npm records `gitHead` with every publish — the exact commit HEAD
# was at when the tarball was packed. This script reads THAT and refuses to do anything else.
#
# SAFETY POSTURE
#   - --dry-run is the DEFAULT. --apply is required to move anything.
#   - FAIL CLOSED (M2): no gitHead from the registry, or an unparseable one, is an ERROR. It
#     never falls back to "use HEAD" or to a date-based guess.
#   - The target commit must EXIST in this repo and be a real commit object; otherwise abort.
#   - Never force-pushes. It moves the LOCAL tag and prints the push command, so publishing a
#     rewritten ref stays a separate, deliberate act.
#   - Reports its DENOMINATOR (tags examined) so "0 examined, 0 wrong" cannot read as clean.
#
# Usage:
#   scripts/ops/retag-release-to-npm-githead.sh                 # audit every vX.Y.Z tag
#   scripts/ops/retag-release-to-npm-githead.sh --apply v2.2.0  # retarget just this one
#   scripts/ops/retag-release-to-npm-githead.sh --apply         # retarget every mismatch
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root" >&2; exit 2; }

PKG="${MASSU_RETAG_PKG:-@massu/core}"
APPLY=false
WANTED=()
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --dry-run) APPLY=false ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    v*) WANTED+=("$arg") ;;
    *) echo "FATAL: unrecognised argument '$arg' — refusing to guess (R-011)" >&2; exit 2 ;;
  esac
done

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'

if [ ${#WANTED[@]} -eq 0 ]; then
  while IFS= read -r t; do WANTED+=("$t"); done < <(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' | LC_ALL=C sort -V)
fi

if [ ${#WANTED[@]} -eq 0 ]; then
  echo "FATAL: found ZERO release tags to examine — the audit could not run (M1)." >&2
  exit 2
fi

examined=0; matched=0; mismatched=0; moved=0; errored=0
echo "retag-release-to-npm-githead — package $PKG — mode $([ "$APPLY" = true ] && echo APPLY || echo DRY-RUN)"
echo ""

for tag in "${WANTED[@]}"; do
  version="${tag#v}"
  examined=$((examined + 1))

  gh="$(npm view "${PKG}@${version}" gitHead 2>/dev/null | tr -d '\r' | tr -d '[:space:]')"
  if ! printf '%s' "$gh" | grep -qE '^[0-9a-f]{40}$'; then
    echo "  ${RED}ERROR${NC}  $tag — no usable gitHead from the registry (got '${gh:-<empty>}')."
    echo "         Refusing to retarget on anything other than the registry's own record."
    errored=$((errored + 1)); continue
  fi

  if ! git cat-file -e "${gh}^{commit}" 2>/dev/null; then
    echo "  ${RED}ERROR${NC}  $tag — gitHead ${gh:0:8} is not a commit in this repo."
    errored=$((errored + 1)); continue
  fi

  cur="$(git rev-list -n1 "$tag" 2>/dev/null || true)"
  if [ "$cur" = "$gh" ]; then
    echo "  ${GREEN}ok${NC}     $tag -> ${gh:0:8}  (matches gitHead)"
    matched=$((matched + 1)); continue
  fi

  mismatched=$((mismatched + 1))
  echo "  ${YELLOW}DRIFT${NC}  $tag"
  echo "         tag     ${cur:0:8}  $(git log -1 --format=%s "$cur" 2>/dev/null | cut -c1-58)"
  echo "         gitHead ${gh:0:8}  $(git log -1 --format=%s "$gh" | cut -c1-58)"

  if [ "$APPLY" = true ]; then
    if git tag -f -a "$tag" "$gh" -m "$tag — retargeted to the commit npm published (gitHead $gh)" >/dev/null 2>&1; then
      after="$(git rev-list -n1 "$tag")"
      if [ "$after" = "$gh" ]; then
        echo "         ${GREEN}moved${NC} -> ${gh:0:8}"
        moved=$((moved + 1))
      else
        echo "         ${RED}FAILED${NC} — tag still at ${after:0:8} after the move (end state asserted, not assumed)"
        errored=$((errored + 1))
      fi
    else
      echo "         ${RED}FAILED${NC} — git tag -f refused"
      errored=$((errored + 1))
    fi
  fi
done

echo ""
echo "DENOMINATOR: $examined tag(s) examined; $matched already correct, $mismatched drifted, $moved moved, $errored error(s)."

if [ "$APPLY" = true ] && [ "$moved" -gt 0 ]; then
  echo ""
  echo "Local tags moved. NOTHING has been published — publishing a rewritten ref is deliberate:"
  for tag in "${WANTED[@]}"; do
    [ "$(git rev-list -n1 "$tag" 2>/dev/null)" = "$(npm view "${PKG}@${tag#v}" gitHead 2>/dev/null | tr -d '\r[:space:]')" ] \
      && echo "    git push origin +refs/tags/$tag"
  done
fi

[ "$errored" -gt 0 ] && exit 1
[ "$APPLY" = false ] && [ "$mismatched" -gt 0 ] && exit 1
exit 0
