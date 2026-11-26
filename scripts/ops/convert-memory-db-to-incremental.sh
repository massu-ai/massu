#!/usr/bin/env bash
# P8-003 / P8-007: repair ONE existing massu database, by hand. Never automatic.
#
# Plan: docs/plans/2026-07-23-hook-latency-and-silent-loss-fixes.md, Phase P8 (amendment 2026-11-25).
# This script holds NO repair logic of its own any more. It is the operator's entry point to the ONE
# implementation, `packages/core/src/memory-db-maintenance.ts`, reached through the built CLI's
# `massu memory inspect|repair` — the same code `massu doctor --fix` runs for npm users. The module:
#
#   1. refuses unless the file is in WAL mode, then holds it EXCLUSIVELY for the whole run, checked
#      through SQLite itself (leaving WAL fails while any other connection has the file open), so it
#      needs no lsof;
#   2. refuses unless free disk covers 4x the DATA (measured peak 2.63-3.92x). The 25% disk floor does
#      not apply: the run ends with more free space (operator ruling 2026-11-25);
#   3. takes a verified backup (`<db>.pre-maintenance-<date>`) that is never deleted;
#   4. merges duplicate session_summaries rows into one per session, losing no value;
#   5. converts to auto_vacuum=INCREMENTAL with a VACUUM;
#   6. ASSERTS the end state (mode 2, integrity ok, freelist 0, every row count, every session's merge)
#      and names any mismatch and the backup.
#
# Undo: stop massu, then copy the backup over the database.
#
# usage: convert-memory-db-to-incremental.sh --repo <dir> [--db memory.db|data.db|knowledge.db]
#                                            [--dry-run (default) | --apply | --list]
set -euo pipefail

REPO=""
DB_NAME="memory.db"
MODE="dry-run"

usage() { sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || { echo "--repo needs a directory" >&2; exit 2; }; REPO="$2"; shift 2 ;;
    --db) [ $# -ge 2 ] || { echo "--db needs a name" >&2; exit 2; }; DB_NAME="$2"; shift 2 ;;
    --dry-run) MODE="dry-run"; shift ;;
    --apply) MODE="apply"; shift ;;
    --list) MODE="list"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$DB_NAME" in
  memory.db|data.db|knowledge.db) ;;
  *) echo "refusing --db '$DB_NAME': must be one of memory.db, data.db, knowledge.db" >&2; exit 2 ;;
esac
[ -n "$REPO" ] || { echo "refusing: --repo is required (no default repository)" >&2; exit 2; }
[ -d "$REPO" ] || { echo "refusing: --repo '$REPO' is not a directory" >&2; exit 2; }
REPO="$(cd "$REPO" && pwd)"
DIR="$REPO/.massu"

# The built CLI of THIS checkout. Missing build is a refusal, never a silent fallback to some other massu.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$HERE/packages/core/dist/cli.js"
[ -f "$CLI" ] || { echo "refusing: $CLI is missing — run: (cd $HERE/packages/core && npm run build:cli)" >&2; exit 2; }
massu() { node --no-warnings "$CLI" "$@"; }

if [ "$MODE" = "list" ]; then
  n=0
  for f in memory.db data.db knowledge.db; do
    [ -f "$DIR/$f" ] || continue
    n=$((n + 1))
    massu memory inspect --db "$DIR/$f" || echo "  ^ $f could not be inspected"
  done
  echo "databases found in $DIR: $n of 3 candidates"
  exit 0
fi

DB="$DIR/$DB_NAME"
[ -f "$DB" ] || { echo "refusing: $DB does not exist" >&2; exit 2; }

if [ "$MODE" = "dry-run" ]; then
  massu memory repair --db "$DB" --dry-run
  exit $?
fi
# --apply is the operator's explicit confirmation, so the CLI is not asked to prompt again.
massu memory repair --db "$DB" --yes
