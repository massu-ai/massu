#!/usr/bin/env bash
# ============================================================
# massu-memory-consolidate.sh (P6-003, plan-living-memory-slice-3-consolidation)
#
# The wrapper the Guardian producer shells out to for the nightly deep
# consolidation pass on THIS host.
#
# Note this is *this machine's* scheduler glue, NOT a product dependency:
# @massu/core consolidates automatically inside its own session-end hook, so a
# user who downloads Massu needs none of this.
#
# Exit 0 = the pass completed. Non-zero = a real failure worth alerting on.
# The result JSON is echoed so the producer can also spot a pass that
# "succeeded" while silently doing nothing (no embedder, sessions whose raw
# transcripts were destroyed before they could be distilled, etc).
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# Prefer the repo's own source (always current) over a possibly-stale global.
CLI="$REPO_ROOT/packages/core/src/cli.ts"
if [[ ! -f "$CLI" ]]; then
  echo "massu-memory-consolidate: CLI not found at $CLI" >&2
  exit 1
fi

exec node --experimental-strip-types "$CLI" consolidate --json "$@"
