#!/usr/bin/env bash
# Copyright (c) 2026 Massu. All rights reserved.
# Licensed under BSL 1.1 - see LICENSE file for details.
#
# massu-db-size-audit.sh — where a massu SQLite database's bytes are. READ-ONLY.
#
# Hook plan P5-004. Prints, for one database:
#   - the file size, page size, page count and FREE pages, so LIVE bytes are split from space a
#     DELETE freed but SQLite kept (only VACUUM returns it to the disk);
#   - the largest tables and indexes by bytes (SQLite's dbstat), or row counts where dbstat is
#     not compiled in, and says which it used;
#   - the cloud-sync retry queue (pending_sync), whose unbounded growth is the 2026-11-10 incident.
#
# It opens the database read-only, waits up to 5 s for a lock, and never writes. A database it
# cannot open is an ERROR (exit 2), never an empty report.
#
# usage: scripts/massu-db-size-audit.sh [--db <path>] [--top <n>]
#        default --db .massu/memory.db  --top 10
set -euo pipefail

DB=".massu/memory.db"
TOP=10
while [ "$#" -gt 0 ]; do
  case "$1" in
    --db)  DB="${2:?--db needs a path}"; shift 2 ;;
    --top) TOP="${2:?--top needs a number}"; shift 2 ;;
    -h|--help) sed -n '5,19p' "$0"; exit 0 ;;
    *) echo "FATAL: unknown argument '$1' (see --help)" >&2; exit 2 ;;
  esac
done
case "$TOP" in ''|*[!0-9]*) echo "FATAL: --top must be a number" >&2; exit 2 ;; esac
command -v sqlite3 >/dev/null 2>&1 || { echo "FATAL: sqlite3 not found" >&2; exit 2; }
[ -f "$DB" ] || { echo "FATAL: no database at $DB" >&2; exit 2; }

# Even read-only, SQLite must open a WAL database's `-shm` file for writing. Where that is not
# possible (a read-only filesystem or a sandbox; measured 2026-11-10: the same query ran from one
# directory and failed with "unable to open database file" from another), fall back to
# `immutable=1`, which reads the file without locks or the WAL index. While another process is
# writing, figures read that way can lag slightly; the report says when it was used.
MODE="normal"
q() {
  local out rc=0
  if [ "$MODE" = "normal" ]; then
    out="$(sqlite3 -readonly -cmd '.timeout 5000' "$DB" "$1" 2>&1)" || rc=$?
    if [ "$rc" -eq 0 ]; then printf '%s\n' "$out"; return 0; fi
    case "$out" in
      *"unable to open database file"*) MODE="immutable" ;;
      *) printf '%s\n' "$out" >&2; return "$rc" ;;
    esac
  fi
  rc=0
  out="$(sqlite3 "file:${DB}?mode=ro&immutable=1" "$1" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then printf '%s\n' "$out"; return 0; fi
  printf '%s\n' "$out" >&2
  return "$rc"
}

# Decide the open mode ONCE, here: q() runs in a subshell, so a switch made inside it is lost.
probe_rc=0; probe="$(sqlite3 -readonly -cmd '.timeout 5000' "$DB" 'PRAGMA page_count;' 2>&1)" || probe_rc=$?
if [ "$probe_rc" -ne 0 ]; then
  case "$probe" in
    *"unable to open database file"*) MODE="immutable" ;;
    *) echo "FATAL: cannot read $DB: $probe" >&2; exit 2 ;;
  esac
fi

page_size="$(q 'PRAGMA page_size;')" || { echo "FATAL: cannot read $DB" >&2; exit 2; }
page_count="$(q 'PRAGMA page_count;')"
free_pages="$(q 'PRAGMA freelist_count;')"
auto_vacuum="$(q 'PRAGMA auto_vacuum;')"
tables="$(q "SELECT COUNT(*) FROM sqlite_schema WHERE type='table';")"
[ -n "$page_size" ] && [ -n "$page_count" ] && [ "$tables" -gt 0 ] || { echo "FATAL: $DB read as empty — refusing to report it clean" >&2; exit 2; }

file_bytes="$(wc -c < "$DB" | tr -d ' ')"
mb() { awk -v b="$1" 'BEGIN { printf "%.1f MB", b / 1048576 }'; }
live_pages=$((page_count - free_pages))
echo "database   : $DB"
[ "$MODE" = "immutable" ] && echo "read mode  : immutable (no lock or WAL index available here; figures may lag a live writer)"
echo "file       : $(mb "$file_bytes")  ($page_count pages x $page_size B, $tables tables, auto_vacuum=$auto_vacuum)"
echo "live       : $(mb $((live_pages * page_size)))"
echo "free pages : $(mb $((free_pages * page_size)))  ($free_pages pages; returned to disk only by VACUUM)"
echo

if q "SELECT 1 FROM dbstat LIMIT 1;" >/dev/null 2>&1; then
  echo "largest objects by bytes (dbstat):"
  q "SELECT printf('  %-44s %10.1f MB', name, SUM(pgsize) / 1048576.0) FROM dbstat GROUP BY name ORDER BY SUM(pgsize) DESC LIMIT $TOP;"
else
  echo "largest tables by ROW COUNT (dbstat is not compiled into this sqlite3; bytes unavailable):"
  for t in $(q "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%';"); do
    printf '  %-44s %12s rows\n' "$t" "$(q "SELECT COUNT(*) FROM \"$t\";")"
  done | sort -k2 -n -r | head -n "$TOP"
fi
echo

if [ "$(q "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name='pending_sync';")" = "1" ]; then
  echo "cloud-sync retry queue (pending_sync):"
  q "SELECT printf('  %d item(s), %.1f MB, oldest %s, never attempted %d',
                   COUNT(*), COALESCE(SUM(LENGTH(payload)), 0) / 1048576.0,
                   COALESCE(MIN(created_at), '-'), COALESCE(SUM(retry_count = 0), 0))
       FROM pending_sync;"
  q "SELECT printf('  last error: %s (x%d)', COALESCE(last_error, '(none)'), COUNT(*))
       FROM pending_sync WHERE last_error IS NOT NULL GROUP BY last_error ORDER BY COUNT(*) DESC LIMIT 3;"
fi
