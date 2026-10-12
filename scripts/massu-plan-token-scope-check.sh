#!/usr/bin/env bash
# massu-plan-token-scope-check — refuse a commit whose Conventional-Commits SCOPE claims a
# plan token that no plan declares.
#
# WHY THIS EXISTS — occurrence #2 in one session, 2026-09-20.
#
# This repo RESERVES the scope `(plan-<token>)` in a commit subject to mean "this commit
# implements that plan token" (scripts/massu-plan-commit-drift.sh:7). A subject like
#
#     feat(plan-gates): discover plan gates instead of remembering them
#
# therefore DECLARES a plan `plan-gates`, which does not exist. The drift scanner catches it
# — but only afterwards, through `plan-status-drift-guard.test.ts` in the full suite, by
# which point the commit is written and must be amended.
#
# It happened twice in one session, hours apart, the second time immediately after fixing
# the first (42568ee5 -> the same mistake again at 77bb908a). A scope that reads like an
# ordinary topic label — `plan-gates`, `plan-audit`, `plan-corpus` — is exactly the phrase
# an author reaches for when the commit is ABOUT plans. The convention is fine; the moment
# of authoring has no guard, and discipline is not a control.
#
# So this is a commit-msg hook: it fires at the moment the subject is written, and it covers
# a HUMAN typing `git commit` as well as an agent issuing one — a distinction that matters,
# because the repo's other commit-time gating is a Claude Code `PreToolUse` hook and reaches
# only one of those two actors (G1).
#
# FAILS CLOSED (M2): if the plan corpus cannot be read, it REFUSES rather than waving the
# commit through. An unreadable corpus and a corpus with no matching plan are different
# states and must not share a verdict.
set -uo pipefail

MSG_FILE="${1:-}"
[ -n "$MSG_FILE" ] || { echo "massu-plan-token-scope-check: no message file given" >&2; exit 2; }
[ -r "$MSG_FILE" ] || { echo "massu-plan-token-scope-check: cannot read $MSG_FILE" >&2; exit 2; }

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "massu-plan-token-scope-check: not inside a git work tree" >&2; exit 2; }

SUBJECT="$(head -1 "$MSG_FILE")"

# The regex is SOURCED, never restated — scripts/lib/plan-token-regex.sh is the single
# source of truth shared with the drift scanner, the changelog gate and the TS generator.
# Restating it here would be the N+1 parser this repo already consolidated once.
REGEX_LIB="$ROOT/scripts/lib/plan-token-regex.sh"
[ -r "$REGEX_LIB" ] || {
  echo "massu-plan-token-scope-check: BLOCKED — missing $REGEX_LIB" >&2
  echo "        Refusing: with no pattern this check would pass every subject." >&2
  exit 2
}
# shellcheck source=lib/plan-token-regex.sh
. "$REGEX_LIB"

MATCH="$(printf '%s' "$SUBJECT" | LC_ALL=C grep -oE "$PLAN_TOKEN_REGEX" || true)"
[ -n "$MATCH" ] || exit 0   # no plan-scoped subject: nothing to adjudicate

TOKEN="$(printf '%s' "$MATCH" | LC_ALL=C sed -E 's/^(feat|fix|chore|docs)\(//; s/\)$//')"

PLANS_DIR="${MASSU_PLAN_DIR:-$ROOT/docs/plans}"
[ -d "$PLANS_DIR" ] || {
  echo "massu-plan-token-scope-check: BLOCKED — no plan corpus at $PLANS_DIR (M2)" >&2
  exit 2; }

# DENOMINATOR (M1). "Searched 0 plans, found no match" must never read as a verdict.
COUNT="$(/usr/bin/find "$PLANS_DIR" -type f -name '*.md' | wc -l | tr -d ' ')"
[ "$COUNT" -gt 0 ] || {
  echo "massu-plan-token-scope-check: BLOCKED — 0 plans found in $PLANS_DIR (M2)" >&2
  exit 2; }

# The corpus writes the token BACKTICKED — **Plan Token**: `plan-foo` — which a plain
# fixed-string match for "**Plan Token**: $TOKEN" misses entirely. The first draft did
# exactly that and REFUSED a commit naming a real plan; its own both-directions attack
# caught it, which is the whole reason the attack demands the gate OPEN as well as refuse
# (CR-72 — a gate that only ever refuses is a brick).
#
# COLLECT AND NORMALISE rather than escape a backtick inside a shell regex — the second
# draft tried that and the quoting mangled the pattern, so it still refused real tokens.
# Extracting every declared token and comparing exactly is both simpler and anchored:
# `plan-foo` cannot match `plan-foo-bar`.
if LC_ALL=C grep -rhE '^\*\*Plan Token\*\*:' "$PLANS_DIR" 2>/dev/null \
   | LC_ALL=C sed -E 's/^\*\*Plan Token\*\*:[[:space:]]*//; s/^.//; s/.$//' \
   | LC_ALL=C sed -E 's/[[:space:]]+$//' \
   | LC_ALL=C grep -qxF "$TOKEN"; then
  exit 0
fi

ALLOWLIST="${MASSU_DRIFT_ALLOWLIST:-$ROOT/scripts/massu-plan-external-tokens.txt}"
if [ -r "$ALLOWLIST" ] && LC_ALL=C grep -qxF "$TOKEN" "$ALLOWLIST" 2>/dev/null; then
  exit 0
fi

cat >&2 <<MSG

massu-plan-token-scope-check: BLOCKED

  subject: $SUBJECT
  scope claims plan token: $TOKEN
  searched: $COUNT plan(s) in $PLANS_DIR — none declares "**Plan Token**: $TOKEN"

This repo RESERVES \`(plan-<token>)\` as a Conventional-Commits scope: it means "this commit
implements that plan token", and scripts/massu-plan-commit-drift.sh checks the plan's Status
against it. A topic label that merely starts with "plan-" claims a plan that does not exist.

  WRONG   feat(plan-gates):  ...      <- reads as the plan token \`plan-gates\`
  RIGHT   feat(gates):       ...      <- an ordinary scope

If this commit really does implement a plan, add \`**Plan Token**: $TOKEN\` to that plan. If
the plan lives in another repo, add the token to:
  $ALLOWLIST
MSG
exit 1
