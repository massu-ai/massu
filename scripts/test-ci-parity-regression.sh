#!/usr/bin/env bash
# P3-000 regression test — AC-PARITY-REGRESSION verifier
# (plan-2026-05-18-pre-push-ci-parity).
#
# Creates an ephemeral CLONE at /tmp/massu-parity-regression-<epoch>, reverts
# the two SHAs (8c6b843, d3164f7) that fixed the 4 CI-only failure modes from
# 2026-05-18, then asserts that the new pre-push-light catches what shipped
# CI caught — i.e. it FAILS on the reverted state.
#
# Output markers (sole SoT for AC #1 grep):
#   PARITY-REGRESSION-TEST: PASS    — gate effective (exit 0)
#   PARITY-REGRESSION-TEST: FAIL    — gate ineffective (exit 1)
#   PARITY-REGRESSION-TEST: ABORT   — env issue, not real failure (exit 2)
#
# AC #1 verification: `bash scripts/test-ci-parity-regression.sh | grep -q "PARITY-REGRESSION-TEST: PASS"`
#
# Time budget: ~3 min (clone + npm ci + full pre-push-light). NOT invoked from
# pre-push-light itself; operator-run / CI-scheduled only.

set -uo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# mktemp -d (unique per invocation; safe under concurrent runs — LOW security
# finding 2026-05-18). EPOCH-only filenames collide on the same second.
CLONE_DIR="$(mktemp -d -t massu-parity-regression-XXXXXXXX)"

cleanup() {
  rm -rf -- "$CLONE_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# (a) Ephemeral clone — NOT a worktree (worktree mutation could corrupt the
# operator's working tree if interrupted; clone is fully isolated).
if ! git clone --no-local --quiet "$REPO_ROOT" "$CLONE_DIR" 2>/tmp/parity-regression-clone.log; then
  echo "PARITY-REGRESSION-TEST: ABORT (git clone failed; see /tmp/parity-regression-clone.log)"
  exit 2
fi

cd "$CLONE_DIR"

# (b) Revert the two SHAs that fixed the 4 CI-only failure modes from 2026-05-18.
for sha in 8c6b843 d3164f7; do
  if ! git revert --no-edit "$sha" 2>/tmp/parity-regression-revert.log; then
    git revert --abort 2>/dev/null || true
    echo "PARITY-REGRESSION-TEST: ABORT (revert conflict on $sha; see /tmp/parity-regression-revert.log)"
    exit 2
  fi
done

# (c) Populate node_modules.
if ! npm ci --silent 2>/tmp/parity-regression-npm-ci.log; then
  echo "PARITY-REGRESSION-TEST: ABORT (npm ci failed; see /tmp/parity-regression-npm-ci.log)"
  exit 2
fi

# (d) Run pre-push-light against the reverted state — capture exit code.
bash scripts/pre-push-light.sh > /tmp/parity-regression-prepush.log 2>&1
PREPUSH_EXIT=$?

# (e) Assert: gate caught the reverted state (EXIT != 0).
if [ "$PREPUSH_EXIT" -eq 0 ]; then
  echo "PARITY-REGRESSION-TEST: FAIL (pre-push-light passed against reverted state — gate ineffective)"
  echo "  See: /tmp/parity-regression-prepush.log"
  exit 1
fi

echo "PARITY-REGRESSION-TEST: PASS (pre-push-light exit=$PREPUSH_EXIT caught the reverted state)"
exit 0
