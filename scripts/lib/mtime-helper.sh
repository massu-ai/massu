# scripts/lib/mtime-helper.sh — sourced by callers; defines:
#   file_mtime <path>  -> stdout: epoch.fractional seconds; non-zero exit if path absent
#
# Detects GNU vs BSD stat at source-time and exports the correct implementation.
# Used by P2-005 (pre-push-light [12/15] Workspace Build Freshness) and any
# future portable-mtime caller. `find -printf '%T@\n'` is FORBIDDEN — macOS BSD
# find has no -printf; query mtime through file_mtime instead.
#
# Plan: docs/plans/2026-05-18-pre-push-ci-parity.md (P2-005 sub-deliverable).

if stat --version >/dev/null 2>&1; then
  file_mtime() { stat -c '%Y' "$1"; }                       # GNU (Linux CI)
elif stat -f '%m' /dev/null >/dev/null 2>&1; then
  file_mtime() { stat -f '%m' "$1"; }                       # BSD (macOS dev)
else
  file_mtime() { python3 -c "import os,sys; print(os.path.getmtime(sys.argv[1]))" "$1"; }
fi
export -f file_mtime
