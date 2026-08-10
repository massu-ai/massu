#!/usr/bin/env bash
# Copyright (c) 2026 Massu. All rights reserved.
# Licensed under BSL 1.1 - see LICENSE file for details.
#
# Publish a sync commit to the PUBLIC mirror through a PULL REQUEST, and merge it
# only once every REQUIRED status check has actually reported success.
#
# WHY THIS EXISTS
# ---------------
# `sync-public.sh` used to run `git push origin main`. The mirror's ruleset
# (`main-branch-protection`, enforcement active, 7 required checks) cannot stop
# that: checks have not run on a commit that does not exist yet, so every direct
# push reported
#
#     Bypassed rule violations ... 7 of 7 required status checks are expected
#
# The push landed, the checks ran afterwards, and nothing read their verdict.
# On 2026-08-09 that left three genuinely failing tests red on a PUBLIC repo for
# two days.
#
# THE BYPASS IS REAL AND THIS SCRIPT DOES NOT RELY ON GITHUB TO ENFORCE ANYTHING
# ------------------------------------------------------------------------------
# The ruleset carries `bypass_actors: [{actor_id: 261639734, bypass_mode: always}]`
# — the same account that runs the sync. GitHub will therefore permit the merge
# whether or not the checks passed. So the verdict is enforced HERE: this script
# reads each required context's conclusion itself and refuses to merge unless all
# of them are SUCCESS. Protection that depends on the pusher not having a bypass
# is protection you do not have.
#
# THE REQUIRED SET IS DERIVED, NEVER TYPED IN
# -------------------------------------------
# The contexts come from the live ruleset (falling back to the tracked JSON that
# the sync itself publishes), so a check added to the ruleset tomorrow is waited
# on the first time it exists. A hand-maintained roster here would be the N+1th
# list and would silently shrink the gate's scope (G18/G28).
#
# USAGE
#   scripts/ops/publish-public-mirror.sh --repo-dir <dir> [--remote origin]
#                                        [--branch-prefix sync]
#                                        [--timeout-secs 2700]
#                                        [--dry-run] [--list]
set -euo pipefail

# --- G29: this script is reachable from the pre-push battery via sync-public.sh,
#     so it ASSERTS the repository rather than scrubbing git's environment. A
#     blanket scrub is the documented DISARM for hook-reachable scripts, because
#     GIT_INDEX_FILE is supplied by git on the pre-commit path and is load-bearing.
#     `--show-toplevel` cannot see a GIT_DIR leak (it returns the CWD); only
#     `--absolute-git-dir` can.
assert_repo() {
  local dir="$1" actual expected
  expected="$(cd "$dir" && pwd)/.git"
  actual="$(git -C "$dir" rev-parse --absolute-git-dir)"
  # A worktree/submodule git dir is legitimately elsewhere; compare after
  # resolving both, and fail LOUD rather than guessing.
  if [ "$actual" != "$expected" ]; then
    echo "FATAL: git in '$dir' resolves to '$actual', expected '$expected'." >&2
    echo "       GIT_DIR is leaking from the caller; refusing to publish." >&2
    exit 1
  fi
}

REPO_DIR=""
REMOTE="origin"
BRANCH_PREFIX="sync"
TIMEOUT_SECS=2700           # 45 min: the mirror's Test job alone runs ~2 min, but
                            # the internal Anti-Vacuity-shaped jobs can be long and
                            # a queued runner is not a failed one.
POLL_SECS=20
DRY_RUN=false
LIST_ONLY=false

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-dir)       REPO_DIR="${2:?--repo-dir needs a value}"; shift 2 ;;
    --remote)         REMOTE="${2:?--remote needs a value}"; shift 2 ;;
    --branch-prefix)  BRANCH_PREFIX="${2:?--branch-prefix needs a value}"; shift 2 ;;
    --timeout-secs)   TIMEOUT_SECS="${2:?--timeout-secs needs a value}"; shift 2 ;;
    --poll-secs)      POLL_SECS="${2:?--poll-secs needs a value}"; shift 2 ;;
    --dry-run)        DRY_RUN=true; shift ;;
    --list)           LIST_ONLY=true; shift ;;
    -h|--help)        sed -n '1,45p' "$0"; exit 0 ;;
    # R-011: refuse an unmatched argument. Never resolve it to the likeliest match.
    *) echo "FATAL: unrecognised argument '$1'" >&2; exit 2 ;;
  esac
done

# G17: validate the COMPONENT, before assembly. An empty --repo-dir must not
# compose into a path that happens to be non-empty because of its prefix.
: "${REPO_DIR:?--repo-dir is required and must not be empty}"
[ -d "$REPO_DIR" ] || { echo "FATAL: --repo-dir '$REPO_DIR' is not a directory" >&2; exit 1; }
REPO_DIR="$(cd "$REPO_DIR" && pwd)"
assert_repo "$REPO_DIR"

command -v gh >/dev/null 2>&1 || { echo "FATAL: gh CLI not found" >&2; exit 1; }

# The slug comes from the REMOTE WE ARE PUSHING TO, never from the ambient
# directory. `gh repo view` with no -R reads the CWD, and the first draft of this
# script did exactly that: invoked from a different checkout it resolved to THAT
# repository and derived ITS thirteen required checks instead of this target's
# seven. The gate would then have waited on contexts the PR can never report and
# timed out — or worse, matched a same-named context and merged on the wrong
# repository's evidence. The slug must BE the push destination, not a correlate
# of it (G28).
REMOTE_URL="$(git -C "$REPO_DIR" remote get-url "$REMOTE")"
SLUG="$(printf '%s' "$REMOTE_URL" \
        | sed -E 's#^git@github\.com:#: #; s#^ssh://git@github\.com/#: #; s#^https?://[^/]*/#: #' \
        | sed -E 's#^: ##; s#\.git$##')"
case "$SLUG" in
  */*) : ;;
  *) echo "FATAL: could not derive an owner/repo slug from '$REMOTE_URL'" >&2; exit 1 ;;
esac

# --- The required contexts, DERIVED from the ruleset ------------------------
# Live API first (that is what actually gates), tracked JSON as the fallback so
# the script still works offline / with a token lacking ruleset read.
required_contexts() {
  local out=""
  out="$(gh api "repos/$SLUG/rulesets" --jq '.[].id' 2>/dev/null | while read -r rid; do
    gh api "repos/$SLUG/rulesets/$rid" --jq \
      '.rules[] | select(.type=="required_status_checks")
       | .parameters.required_status_checks[].context' 2>/dev/null
  done || true)"
  if [ -z "$out" ] && [ -f "$REPO_DIR/.github/rulesets/main-branch.json" ]; then
    echo "note: ruleset API returned nothing; falling back to the tracked JSON" >&2
    out="$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
for r in d.get("rules", []):
    if r.get("type") == "required_status_checks":
        for c in r["parameters"]["required_status_checks"]:
            print(c["context"])
' "$REPO_DIR/.github/rulesets/main-branch.json")"
  fi
  printf '%s\n' "$out" | sed '/^$/d' | LC_ALL=C sort -u
}

REQUIRED="$(required_contexts)"
REQUIRED_COUNT="$(printf '%s\n' "$REQUIRED" | sed '/^$/d' | wc -l | tr -d ' ')"

# M1 — PROVE IT LOOKED. A zero here means we could not read the ruleset, which is
# observationally identical to "nothing is required". Fail closed.
if [ "$REQUIRED_COUNT" -eq 0 ]; then
  echo "FATAL: derived 0 required status checks for $SLUG." >&2
  echo "       That is indistinguishable from 'no protection'; refusing to publish." >&2
  exit 1
fi

echo "─── Publish target ───"
echo "  repo            : $SLUG"
echo "  local dir       : $REPO_DIR"
echo "  required checks : $REQUIRED_COUNT"
printf '%s\n' "$REQUIRED" | sed 's/^/                    - /'

if $LIST_ONLY; then
  echo "(--list: nothing was pushed, no PR was opened.)"
  exit 0
fi

# --- What are we publishing? ------------------------------------------------
HEAD_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
SUBJECT="$(git -C "$REPO_DIR" log -1 --pretty=%s)"
BASE="$(git -C "$REPO_DIR" symbolic-ref --quiet --short HEAD || echo main)"

if [ "$BASE" != "main" ]; then
  echo "FATAL: local HEAD is on '$BASE', expected 'main'." >&2
  exit 1
fi

REMOTE_MAIN="$(git -C "$REPO_DIR" ls-remote "$REMOTE" refs/heads/main | awk '{print $1}')"
if [ -z "$REMOTE_MAIN" ]; then
  echo "FATAL: '$REMOTE' has no refs/heads/main" >&2
  exit 1
fi

# Idempotent: already published is a reported NO-OP, never an error.
if [ "$HEAD_SHA" = "$REMOTE_MAIN" ]; then
  echo "Already published — $REMOTE/main is already $HEAD_SHA. Nothing to do."
  exit 0
fi

BRANCH="$BRANCH_PREFIX/$(git -C "$REPO_DIR" rev-parse --short HEAD)"

echo ""
echo "─── Publishing via pull request ───"
echo "  commit  : $HEAD_SHA"
echo "  subject : $SUBJECT"
echo "  branch  : $BRANCH -> main"

if $DRY_RUN; then
  echo ""
  echo "(--dry-run: would push '$BRANCH', open a PR, wait for $REQUIRED_COUNT checks,"
  echo " then rebase-merge. Nothing was pushed.)"
  exit 0
fi

# --- 1. Push the branch -----------------------------------------------------
# `--force-with-lease` so a re-run after a failed attempt updates the same branch
# rather than erroring, while still refusing to clobber someone else's work.
git -C "$REPO_DIR" push --force-with-lease "$REMOTE" "HEAD:refs/heads/$BRANCH"

PUSHED="$(git -C "$REPO_DIR" ls-remote "$REMOTE" "refs/heads/$BRANCH" | awk '{print $1}')"
# CR-69: assert the END STATE. Never infer it from exit 0.
if [ "$PUSHED" != "$HEAD_SHA" ]; then
  echo "FATAL: after push, $REMOTE/$BRANCH is '$PUSHED', expected '$HEAD_SHA'." >&2
  exit 1
fi
echo "  pushed  : $REMOTE/$BRANCH = $PUSHED"

# --- 2. Open (or reuse) the PR ----------------------------------------------
PR_NUM="$(gh pr list --repo "$SLUG" --head "$BRANCH" --state open \
            --json number --jq '.[0].number' 2>/dev/null || true)"
if [ -n "$PR_NUM" ] && [ "$PR_NUM" != "null" ]; then
  echo "  pr      : reusing existing #$PR_NUM"
else
  # The PR title becomes the commit subject under a SQUASH merge and is what a
  # human reads; the rebase merge below preserves the original subject verbatim,
  # which is what `Source-of-Truth Discipline` scans for.
  gh pr create --repo "$SLUG" --base main --head "$BRANCH" \
    --title "$SUBJECT" \
    --body "Automated publication of the public mirror.

Opened by \`scripts/ops/publish-public-mirror.sh\` so the $REQUIRED_COUNT required
status checks run BEFORE this reaches \`main\`. Direct pushes to \`main\` cannot be
gated by them — checks have not run on a commit that does not exist yet — which is
how three failing tests sat red on this repo for two days (2026-08-09/10).

Merged by rebase, so the \`sync: Update from massu-internal (<hash>)\` subject that
\`Source-of-Truth Discipline\` requires is preserved verbatim." >/dev/null
  PR_NUM="$(gh pr list --repo "$SLUG" --head "$BRANCH" --state open \
              --json number --jq '.[0].number')"
  [ -n "$PR_NUM" ] && [ "$PR_NUM" != "null" ] \
    || { echo "FATAL: PR creation reported success but no open PR exists for $BRANCH" >&2; exit 1; }
  echo "  pr      : opened #$PR_NUM"
fi

# --- 3. Wait for EVERY required context, to a DEADLINE -----------------------
# Poll to a deadline rather than sleeping once: "the check has not reported yet"
# and "the check will never report" are the same observation at any single
# instant, and treating the first as the second is how a successful publish was
# once reported as a failure.
DEADLINE=$(( $(date +%s) + TIMEOUT_SECS ))
echo ""
echo "─── Waiting for $REQUIRED_COUNT required check(s), deadline ${TIMEOUT_SECS}s ───"

# Conclusions that are NOT a pass. `cancelled` is called out explicitly: a
# cancelled run renders the same X as a failure but is a MISSING verdict, and a
# newer push destroys the verdict of the one before it.
verdict_line() {
  gh pr checks "$PR_NUM" --repo "$SLUG" --json name,state,link \
    --jq '.[] | "\(.name)\t\(.state)"' 2>/dev/null || true
}

while :; do
  NOW="$(date +%s)"
  RAW="$(verdict_line)"

  missing=""; failed=""; pending=""; passed=0
  while IFS= read -r ctx; do
    [ -n "$ctx" ] || continue
    # A context may appear more than once (re-runs); take the LAST report.
    state="$(printf '%s\n' "$RAW" | awk -F'\t' -v c="$ctx" '$1==c {s=$2} END {print s}')"
    case "$state" in
      SUCCESS)                      passed=$((passed+1)) ;;
      "")                           missing="$missing $ctx" ;;
      PENDING|QUEUED|IN_PROGRESS|EXPECTED|WAITING) pending="$pending $ctx" ;;
      *)                            failed="$failed $ctx($state)" ;;
    esac
  done <<EOF
$REQUIRED
EOF

  if [ -n "$failed" ]; then
    echo ""
    echo "─── REQUIRED CHECK(S) DID NOT PASS ───"
    echo "  failed :$failed"
    echo ""
    echo "  The PR is left OPEN on purpose: nothing reached main, and the branch is"
    echo "  the artifact to debug. Fix the SOURCE in massu-internal, re-run the sync,"
    echo "  and this script will update the same branch."
    echo "  PR: $(gh pr view "$PR_NUM" --repo "$SLUG" --json url --jq .url)"
    exit 1
  fi

  if [ "$passed" -eq "$REQUIRED_COUNT" ]; then
    echo "  all $REQUIRED_COUNT required check(s) SUCCESS"
    break
  fi

  if [ "$NOW" -ge "$DEADLINE" ]; then
    echo ""
    echo "─── TIMED OUT after ${TIMEOUT_SECS}s ───"
    echo "  passed  : $passed/$REQUIRED_COUNT"
    echo "  pending :$pending"
    echo "  missing :$missing"
    echo ""
    echo "  A check that never reported is NOT a check that passed. Nothing was merged."
    echo "  PR: $(gh pr view "$PR_NUM" --repo "$SLUG" --json url --jq .url)"
    exit 1
  fi

  printf '\r  %s/%s passed, %ss remaining ' "$passed" "$REQUIRED_COUNT" "$((DEADLINE - NOW))"
  sleep "$POLL_SECS"
done

# --- 4. Merge, and assert the END STATE -------------------------------------
# Rebase, not squash or merge-commit: `required_linear_history` forbids a merge
# commit, and rebase replays the commit with its subject intact so
# `Source-of-Truth Discipline` still recognises it as sync output.
echo ""
echo "─── Merging #$PR_NUM (rebase) ───"
gh pr merge "$PR_NUM" --repo "$SLUG" --rebase --delete-branch

# CR-69 again: `gh pr merge` exiting 0 is not proof main moved. Read the remote.
FINAL="$(git -C "$REPO_DIR" ls-remote "$REMOTE" refs/heads/main | awk '{print $1}')"
if [ "$FINAL" = "$REMOTE_MAIN" ]; then
  echo "FATAL: merge reported success but $REMOTE/main is unchanged at $FINAL." >&2
  exit 1
fi
git -C "$REPO_DIR" fetch --quiet "$REMOTE" main
echo "  $REMOTE/main : $REMOTE_MAIN -> $FINAL"

# The rebase rewrites the SHA, so the local branch must be realigned or the next
# sync starts from a commit that is not an ancestor of main.
git -C "$REPO_DIR" reset --hard "$REMOTE/main" >/dev/null
LOCAL_AFTER="$(git -C "$REPO_DIR" rev-parse HEAD)"
[ "$LOCAL_AFTER" = "$FINAL" ] \
  || { echo "FATAL: local main is $LOCAL_AFTER, remote is $FINAL" >&2; exit 1; }

MERGED_SUBJECT="$(git -C "$REPO_DIR" log -1 --pretty=%s)"
if [ "$MERGED_SUBJECT" != "$SUBJECT" ]; then
  echo "WARNING: merged subject '$MERGED_SUBJECT' differs from '$SUBJECT'." >&2
  echo "         Source-of-Truth Discipline scans commit subjects — check it stayed green." >&2
fi

echo "Published: $SLUG main = $FINAL"
