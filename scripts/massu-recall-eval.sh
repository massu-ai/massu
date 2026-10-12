#!/usr/bin/env bash
# Copyright (c) 2026 Massu. All rights reserved.
# Licensed under BSL 1.1 - see LICENSE file for details.
#
# Recall eval runner (plan-living-memory-slice-2a-embedder P4-001).
# Runs the 3-way recall eval (BM25 vs hybrid FTS-only vs hybrid semantic) over
# the labeled dataset and writes a report to docs/reports/.
#
# GAP-007: this script propagates the vitest exit code — a non-zero exit (semantic
# precision@k regressing below FTS-only, or any latency/recall gate failing) FAILS
# the runner. A green run is therefore real proof of the semantic win, not a print.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/packages/core"

echo "== Massu recall eval (BM25 vs hybrid FTS-only vs hybrid semantic) =="
# No pipe / `2>&1` swallow — vitest's own exit code must survive to our exit.
#
# ⛔ AND THE CAPTURE MUST BE REACHABLE. This read `npx vitest …` then a bare `status=$?`, which
# under `set -e` is dead code: on a failing run errexit ended the script at vitest, so the
# "Report:" line below never printed and `exit $status` never ran. The earlier comment here
# claimed the exit code "must reach `set -e`" — it did, and that was the bug, because reaching
# errexit is precisely what killed the reporting. `&& status=0 || status=$?` keeps errexit out of
# the way long enough to record the real code, and we still exit with it.
MASSU_WRITE_EVAL_REPORT=1 npx vitest run recall-eval && status=0 || status=$?
echo ""
echo "Report: docs/reports/2026-07-12-recall-eval-semantic.md"
exit "$status"
