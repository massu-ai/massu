#!/usr/bin/env bash
# P8-003: convert ONE existing massu database to auto_vacuum=INCREMENTAL, once, by hand. Never automatic.
#
# Plan: docs/plans/2026-07-23-hook-latency-and-silent-loss-fixes.md, Phase P8. A database created by massu
# before P8-001 is auto_vacuum=0, and in mode 0 every page a pruner frees stays in the file forever (measured
# 2026-11-21: one store 622 MB with 75% free pages, another 8.9 GB with 87%). Switching an existing file to
# mode 2 needs a full VACUUM (sqlite.org/lang_vacuum.html), which needs an exclusive lock and about the file's
# size in temporary space, so it is an operator act with these guards, in this order:
#
#   1. the database exists and is not already mode 2 (mode 2 is a REPORTED no-op, exit 0 — idempotent);
#   2. NO process holds the database, its -wal or its -shm (`lsof`); a holder is named and the run refuses;
#   3. free disk covers the PEAK the conversion needs AND still leaves 25% of the disk free at that peak
#      (operator ruling: every disk keeps 25% free). The peak is 3x the DATA, not the file: the backup, the
#      VACUUM's temporary copy, and the WAL the VACUUM writes back through, each about the size of the live
#      pages. Measured 2026-11-21 on a copy of an 8.9 GB file holding 1.13 GB of data: peak 3,398 MB extra
#      (df sampled every 0.5 s); the first draft's 2x-the-file estimate asked for 17.8 GB. Margin: +10%.
#   4. a consistent backup (`VACUUM INTO memory.db.pre-incremental-<date>`) passes its own integrity_check;
#   5. `PRAGMA auto_vacuum=INCREMENTAL; VACUUM;`
#   6. the END STATE is asserted, not inferred: mode 2, integrity_check = ok, freelist 0, and EVERY table holds
#      exactly the row count it held before (nothing was deleted — CR-61). Any mismatch exits 1 and names it.
#
# The backup is kept until the operator deletes it; this script never deletes anything.
# Undo: stop massu, then copy the backup over the database (it is a complete, consistent database).
#
# usage: convert-memory-db-to-incremental.sh --repo <dir> [--db memory.db|data.db|knowledge.db]
#                                            [--dry-run (default) | --apply | --list]
set -euo pipefail

REPO=""
DB_NAME="memory.db"
MODE="dry-run"
MIN_FREE_PCT=25

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs a directory}"; shift 2 ;;
    --db) DB_NAME="${2:?--db needs a name}"; shift 2 ;;
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

if [ "$MODE" = "list" ]; then
  n=0
  for f in memory.db data.db knowledge.db; do
    [ -f "$DIR/$f" ] || continue
    n=$((n + 1))
    node --no-warnings -e '
      const { DatabaseSync } = require("node:sqlite");
      const d = new DatabaseSync(process.argv[1], { readOnly: true });
      const q = (s) => Object.values(d.prepare(s).get())[0];
      const pc = q("PRAGMA page_count"), fl = q("PRAGMA freelist_count");
      console.log(`${process.argv[2].padEnd(13)} auto_vacuum=${q("PRAGMA auto_vacuum")}  ${(q("PRAGMA page_size")*pc/1e6).toFixed(0)} MB  free pages ${fl}/${pc} (${pc ? (100*fl/pc).toFixed(0) : 0}%)`);
    ' "$DIR/$f" "$f"
  done
  echo "databases found in $DIR: $n of 3 candidates"
  exit 0
fi

DB="$DIR/$DB_NAME"
[ -f "$DB" ] || { echo "refusing: $DB does not exist" >&2; exit 2; }

# ---- 1. current state (read-only) ----
STATE="$(node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const d = new DatabaseSync(process.argv[1], { readOnly: true });
  const q = (s) => Object.values(d.prepare(s).get())[0];
  console.log(q("PRAGMA auto_vacuum"), q("PRAGMA page_count"), q("PRAGMA freelist_count"), q("PRAGMA page_size"));
' "$DB")" || { echo "FAIL: could not read $DB (read-only open)" >&2; exit 2; }
read -r CUR_MODE PAGES FREE PAGE_SIZE <<<"$STATE"
for v in CUR_MODE PAGES FREE PAGE_SIZE; do
  case "${!v:-}" in ''|*[!0-9]*) echo "FAIL: unreadable state '$STATE' for $DB" >&2; exit 2 ;; esac
done
SIZE=$(( PAGES * PAGE_SIZE ))
echo "database : $DB"
echo "state    : auto_vacuum=$CUR_MODE  $(( SIZE / 1000000 )) MB  free pages $FREE of $PAGES"
if [ "$CUR_MODE" = "2" ]; then
  echo "RESULT: already auto_vacuum=INCREMENTAL — nothing to do (no-op)."
  exit 0
fi

# ---- 2. no holder ----
# A missing lsof must REFUSE: an absent holder check and an empty one print the same nothing.
command -v lsof >/dev/null 2>&1 || { echo "REFUSED: lsof is not installed, so open handles cannot be checked" >&2; exit 2; }
HOLDERS="$(lsof -F pc -- "$DB" "$DB-wal" "$DB-shm" 2>/dev/null | paste - - | sed 's/^p\([0-9]*\)\tc\(.*\)/pid \1 (\2)/' | LC_ALL=C sort -u || true)"  # hostproc: excluded operator-run once on the DB's own dir; must run where hostproc is absent (CI runners, other machines)
if [ -n "$HOLDERS" ]; then
  echo "REFUSED: the database is open in another process. VACUUM needs it exclusively. Close these first:"
  printf '  %s\n' "$HOLDERS"
  exit 1
fi
echo "holders  : none (lsof on the database, -wal and -shm)"

# ---- 3. disk ----
read -r AVAIL_KB TOTAL_KB < <(df -Pk "$DIR" | awk 'NR==2 {print $4, $2}')  # hostproc: excluded operator-run once on the DB's own dir; must run where hostproc is absent (CI runners, other machines)
AVAIL=$(( ${CONVERT_TEST_AVAIL_BYTES:-$(( AVAIL_KB * 1024 ))} ))   # CONVERT_TEST_AVAIL_BYTES: test seam only
TOTAL=$(( TOTAL_KB * 1024 ))
DATA=$(( (PAGES - FREE) * PAGE_SIZE ))
NEED=$(( DATA * 3 * 11 / 10 ))
AFTER=$(( AVAIL - NEED ))
FLOOR=$(( TOTAL * MIN_FREE_PCT / 100 ))
echo "disk     : $(( AVAIL / 1000000000 )) GB free of $(( TOTAL / 1000000000 )) GB; needs $(( NEED / 1000000 )) MB; floor ${MIN_FREE_PCT}% = $(( FLOOR / 1000000000 )) GB"
if [ "$AFTER" -lt "$FLOOR" ]; then
  echo "REFUSED: at the conversion's peak the disk would have $(( AFTER / 1000000000 )) GB free, below the ${MIN_FREE_PCT}% floor (operator ruling; the operator decides any exception)."
  exit 1
fi

BACKUP="$DB.pre-incremental-$(date +%Y%m%d-%H%M%S)"
if [ "$MODE" = "dry-run" ]; then
  echo "would    : back up to $BACKUP (VACUUM INTO + integrity_check), then PRAGMA auto_vacuum=INCREMENTAL; VACUUM;"
  echo "RESULT: dry run — all checks pass; nothing was written. Re-run with --apply to convert."
  exit 0
fi

# ---- 4-6. backup, convert, assert the end state ----
node --no-warnings - "$DB" "$BACKUP" <<'JS'
const { DatabaseSync } = require('node:sqlite');
const { existsSync, statSync } = require('node:fs');
const [db, backup] = process.argv.slice(2);
const one = (d, s) => Object.values(d.prepare(s).get())[0];
const counts = (d) => Object.fromEntries(
  d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, Number(one(d, `SELECT count(*) FROM "${name.replace(/"/g, '""')}"`))]),
);
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

if (existsSync(backup)) fail(`backup path already exists: ${backup}`);
const d = new DatabaseSync(db);
d.exec('PRAGMA busy_timeout = 0');               // a lock we did not see in lsof must REFUSE, not wait
const before = counts(d);
const sizeBefore = statSync(db).size;

d.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
const b = new DatabaseSync(backup, { readOnly: true });
const bOk = one(b, 'PRAGMA integrity_check');
const bCounts = counts(b);
b.close();
if (bOk !== 'ok') fail(`backup integrity_check: ${bOk}`);
if (JSON.stringify(bCounts) !== JSON.stringify(before)) fail('backup row counts differ from the live database');
console.log(`backup   : ${backup} (${(statSync(backup).size / 1e6).toFixed(0)} MB, integrity ok, ${Object.keys(before).length} tables match)`);

d.exec('PRAGMA auto_vacuum = INCREMENTAL');
d.exec('VACUUM');
// TEST SEAM ONLY: simulate a conversion that lost a row, so the row-count proof below can be shown to FIRE.
// (A real VACUUM never loses rows; without this the proof could be deleted and every test would stay green.)
if (process.env.CONVERT_TEST_LOSE_ROW_IN) d.exec(`DELETE FROM "${process.env.CONVERT_TEST_LOSE_ROW_IN}" WHERE rowid = (SELECT max(rowid) FROM "${process.env.CONVERT_TEST_LOSE_ROW_IN}")`);
d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const mode = Number(one(d, 'PRAGMA auto_vacuum'));
const ok = one(d, 'PRAGMA integrity_check');
const free = Number(one(d, 'PRAGMA freelist_count'));
const after = counts(d);
d.close();

const diffs = Object.keys({ ...before, ...after }).filter((t) => before[t] !== after[t]);
if (mode !== 2) fail(`auto_vacuum is ${mode} after VACUUM, expected 2`);
if (ok !== 'ok') fail(`integrity_check: ${ok} — restore from ${backup}`);
if (free !== 0) fail(`freelist_count is ${free} after VACUUM, expected 0`);
if (diffs.length) fail(`row counts changed in: ${diffs.map((t) => `${t} ${before[t]} -> ${after[t]}`).join(', ')} — restore from ${backup}`);
console.log(`converted: auto_vacuum=2, integrity ok, freelist 0, ${Object.keys(after).length} tables with identical row counts`);
console.log(`size     : ${(sizeBefore / 1e6).toFixed(0)} MB -> ${(statSync(db).size / 1e6).toFixed(0)} MB`);
console.log(`RESULT: converted. The backup is kept: ${backup}`);
JS
