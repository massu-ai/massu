#!/usr/bin/env bash
# massu pre-push release battery — runs the 22-gate battery on EVERY push.
#
# Why this lives in scripts/hooks/ and not in .git/hooks/:
#
#   .git/ is not tracked by git and cannot be, so a hook body written directly into
#   .git/hooks/ exists in exactly one copy, on one machine, with no history, no review,
#   and no diff. A fresh clone silently has none of it. Worse, any installer that writes
#   the same hook name overwrites it without warning — two gates guarding different things
#   destroy each other, last writer wins, and nothing reports the loss.
#
#   So: hook BODIES are tracked here, reviewed and diffable. scripts/install-hooks.sh
#   writes thin stubs into .git/hooks/ that exec them, and composes the concerns that
#   share a hook name rather than letting them overwrite one another.
#
# Ordering note (see install-hooks.sh): the leak guard runs BEFORE this battery, so a
# secret aborts the push immediately rather than after minutes of gates.
#
# CR-62: an enforcement mechanism that is not wired to the action it guards is
# indistinguishable from one that does not exist. Bypass (`git push --no-verify`)
# remains possible but is an EXPLICIT act, logged for the audit trail — never the
# silent default.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
GATE="$REPO_ROOT/scripts/pre-push-light.sh"

# --- CAPTURE WHAT THE PUSH ACTUALLY DELIVERS, ONCE, AT THE ONLY BOUNDARY THAT HAS IT ---
#
# git writes one line per pushed ref to the pre-push hook's STDIN:
#
#     <local ref> <local oid> <remote ref> <remote oid>
#
# That is the ONLY authoritative statement of what this push will transmit. Everything
# downstream used to re-derive it, and the derivation's fallback (`HEAD~1..HEAD`) judged
# an 8-commit branch on its last commit — a blind gate on the irreversible half of the
# commit/push pair.
#
# THIS IS THE LAST LINK IN THE CHAIN THAT RECEIVES THE STREAM, AND A STREAM HAS EXACTLY
# ONE READER. `.git/hooks/pre-push` (the managed shim) replays its captured payload to
# `pre-push.local`, which invokes this script with that stdin inherited; nothing after
# this point reads it. So capturing here consumes nothing another link needs — and
# EXPORTING it, rather than piping it on, is what lets several gates read the same fact.
# A pipe would hand it to exactly one of them and leave the rest reporting
# "nothing to scan", which ALLOWS.
#
# `[ ! -t 0 ]` distinguishes a real hook invocation from an interactive run. A terminal
# stdin means nobody handed us refs, and the resolver's own fallback chain takes over —
# it refuses rather than inventing a range, so an empty capture cannot read as "clean".
if [ ! -t 0 ]; then
  MASSU_PUSH_REFS="$(cat)"
  export MASSU_PUSH_REFS
  # M1 — say what was captured. Zero refs on the hook path is a state worth seeing in the
  # log: it means either a no-op push or a broken capture, and those must not look alike.
  echo "[pre-push] pushed refs captured: $(printf '%s' "$MASSU_PUSH_REFS" | grep -c . || true) line(s)"
fi

if [ ! -x "$GATE" ] && [ ! -f "$GATE" ]; then
  echo "[pre-push] WARNING: $GATE not found — pushing WITHOUT release gates." >&2
  echo "[pre-push] $(date -u +%FT%TZ) MISSING-GATE push allowed" >> "$REPO_ROOT/.massu/pre-push-audit.log" 2>/dev/null || true
  # fail-open-approved: KNOWN HOLE, TRACKED — not an endorsement.
  # This contradicts the standing rule that a gate which "could not check" has
  # stopped checking and must exit 1. It is retained ONLY because flipping it
  # bricks `git push` for anyone whose checkout lacks pre-push-light.sh, and a
  # bricked push is answered with --no-verify, which disables the whole battery
  # rather than this one branch. The mitigation actually in force is the audit
  # line written just above: a missing-gate push is RECORDED, so it is countable
  # rather than invisible. Escalated for an operator decision on 2026-07-24
  # (P3-1); the alternative is to fail closed and ship a remediation command.
  exit 0
fi

echo "[pre-push] running 22-gate battery (bash scripts/pre-push-light.sh)…"
if bash "$GATE"; then
  echo "[pre-push] ALL GATES PASSED"
  exit 0
fi
echo "" >&2
echo "[pre-push] ✗ GATES FAILED — push BLOCKED." >&2
echo "[pre-push]   Fix the failures above, or bypass EXPLICITLY with: git push --no-verify" >&2
echo "[pre-push]   (a bypass is not a pass)" >&2
exit 1
