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
# No pipe / `2>&1` swallow — vitest's exit code must reach `set -e`.
MASSU_WRITE_EVAL_REPORT=1 npx vitest run recall-eval
status=$?
echo ""
echo "Report: docs/reports/2026-07-12-recall-eval-semantic.md"
exit $status
