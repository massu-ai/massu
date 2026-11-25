#!/usr/bin/env bash
# P8-002: MEASURE the incremental_vacuum batch size. Ship the measuring script, never the number (CR-68).
#
# Plan: docs/plans/2026-07-23-hook-latency-and-silent-loss-fixes.md, Phase P8. The session-end hook frees pages
# with `PRAGMA incremental_vacuum(N)` in a loop until its phase budget runs out. N is a claim about the outside
# world (disk, page cache, SQLite version), so it is measured here, on the engine massu ships (node:sqlite).
#
# ⛔ WHY NOT A COPY OF THE REAL DB. Every real massu memory.db today is auto_vacuum=0. incremental_vacuum is a
# no-op in mode 0, and converting a copy (VACUUM) DISCARDS the very free pages we want to time. So this builds a
# mode-2 database at the real page size, fills it to the real size, and deletes 3 rows of every 4 so the free
# pages are SCATTERED through the file, as they are in a store that has been pruned for months. Freeing a
# scattered page means relocating a live page from the end of the file, which is the expensive case.
#
# WHAT IS RECORDED, per (batch size N, cache_size): wall time of each `incremental_vacuum(N)` call, wall time of
# the PASSIVE checkpoint after it, and the WAL frames that batch produced (the `log` column of
# `wal_checkpoint`). The SQLite forum reports a single large incremental_vacuum spilling ~100x more pages to the
# WAL than many small ones when the page cache fills mid-operation (sqlite.org/forum/forumpost/bca9f3906a), so
# cache_size is a measured axis, not a constant.
#
# THE SELECTION RULE (printed with the result, derived from constants the hook already has):
#   p95(batch + checkpoint) <= MIN_PHASE_BUDGET_MS / 2   a phase granted its minimum budget still completes a batch
#                                                        and the deadline is checked at least that often
#   max WAL frames per batch <= 1000                     SQLite's default wal_autocheckpoint; the WAL never grows
#                                                        past what every massu DB already tolerates
# Among the N meeting both at the hook's real cache_size (the default, -2000), the recommendation is the one that
# frees the most pages per millisecond (p50) — the phase loops batches until its budget ends, so throughput is what
# it buys. Within 10% of the best, the LARGER N wins (fewer round trips, coarser but still bounded steps).
# (The first draft took the LARGEST qualifying N: measured, that was 1024 at 957 frames — 4% under the WAL limit —
# and SLOWER per page than 512. Size is not the property; pages freed per unit of budget is.)
#
# ⛔ NOTHING IS DELETED. One temp directory holds the template and one working copy, which is OVERWRITTEN for
# each configuration. Both paths are printed; the OS reclaims the directory (G8/G17).
set -euo pipefail

FREE_PAGES=117000          # massu-internal measured 2026-11-21: 117,568 free of 156,557
FREE_FRACTION_PCT=75
PAGE_SIZE=4096
BATCHES="64,128,256,512,1024,2048,4096"
CACHES="-2000,-16000"
ROUNDS=12
MIN_PHASE_BUDGET_MS=500    # packages/core/src/hooks/session-end.ts
LIKE=""
OUT=""

usage() {
  cat <<'EOF'
usage: measure-incremental-vacuum.sh [options]
  --like <memory.db>    read page_size and freelist_count from a real DB (opened READ-ONLY)
  --free-pages <n>      free pages to create (default 117000)
  --page-size <bytes>   default 4096
  --batches <list>      comma list of N (default 64,128,256,512,1024,2048,4096)
  --caches <list>       comma list of cache_size values (default -2000,-16000; -2000 is the hook's)
  --rounds <n>          batches timed per configuration (default 12)
  --out <file.tsv>      also write the raw per-batch rows here
  --list                print the configurations that would run, and exit
  -h, --help
EOF
}

LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --like) LIKE="${2:?--like needs a path}"; shift 2 ;;
    --free-pages) FREE_PAGES="${2:?}"; shift 2 ;;
    --page-size) PAGE_SIZE="${2:?}"; shift 2 ;;
    --batches) BATCHES="${2:?}"; shift 2 ;;
    --caches) CACHES="${2:?}"; shift 2 ;;
    --rounds) ROUNDS="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    --list) LIST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for v in FREE_PAGES PAGE_SIZE ROUNDS; do
  case "${!v}" in ''|*[!0-9]*) echo "$v must be a positive integer, got '${!v}'" >&2; exit 2 ;; esac
done

WORK="(not created: --list)"
if [ "$LIST" -eq 0 ]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/massu-measure-ivac.XXXXXX")"
  : "${WORK:?mktemp returned nothing}"
fi

exec node --no-warnings --input-type=module - \
  "$WORK" "$FREE_PAGES" "$FREE_FRACTION_PCT" "$PAGE_SIZE" "$BATCHES" "$CACHES" "$ROUNDS" \
  "$MIN_PHASE_BUDGET_MS" "$LIKE" "$OUT" "$LIST" <<'JS'
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [work, freeArg, fracArg, pageArg, batchArg, cacheArg, roundsArg, minPhaseArg, like, out, listArg] =
  process.argv.slice(2);
let freePages = Number(freeArg);
let pageSize = Number(pageArg);
const frac = Number(fracArg) / 100;
const batches = batchArg.split(',').map(Number);
const caches = cacheArg.split(',').map(Number);
const rounds = Number(roundsArg);
const minPhase = Number(minPhaseArg);
const one = (db, sql) => Object.values(db.prepare(sql).get() ?? {})[0];

if (like) {
  const r = new DatabaseSync(like, { readOnly: true });
  pageSize = Number(one(r, 'PRAGMA page_size'));
  freePages = Number(one(r, 'PRAGMA freelist_count'));
  r.close();
  console.log(`--like ${like}: page_size ${pageSize}, freelist ${freePages}`);
}
for (const n of [...batches, freePages, pageSize, rounds]) {
  if (!Number.isInteger(n) || n <= 0) { console.error(`invalid numeric argument: ${n}`); process.exit(2); }
}
const sqliteVersion = one(new DatabaseSync(':memory:'), 'select sqlite_version()');
console.log(`node ${process.version}  sqlite ${sqliteVersion}  page_size ${pageSize}  target free pages ${freePages}`);
console.log(`configurations: ${batches.length} batch sizes x ${caches.length} cache sizes = ${batches.length * caches.length}, ${rounds} batches each`);
if (listArg === '1') {
  for (const c of caches) for (const n of batches) console.log(`  N=${n} cache_size=${c}`);
  process.exit(0);
}
if (freePages < rounds * Math.max(...batches)) {
  console.error(`free pages ${freePages} < rounds*maxN ${rounds * Math.max(...batches)}: the largest N would run dry and be timed on a short final batch`);
  process.exit(2);
}

// ---- template: mode 2, WAL, filled to total = free / frac pages, then 3 of 4 rows deleted (scattered) ----
const template = join(work, 'template.db');
const copy = join(work, 'work.db');
console.log(`work dir: ${work}`);
{
  const db = new DatabaseSync(template);
  db.exec(`PRAGMA page_size=${pageSize}`);
  db.exec('PRAGMA auto_vacuum=INCREMENTAL');
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT, body TEXT)');
  db.exec('CREATE INDEX t_k ON t(k)');
  const totalPages = Math.ceil(freePages / frac);
  const ins = db.prepare('INSERT INTO t (k, body) VALUES (?, ?)');
  const body = 'x'.repeat(Math.floor(pageSize / 4));
  let i = 0;
  while (Number(one(db, 'PRAGMA page_count')) < totalPages) {
    db.exec('BEGIN');
    for (let j = 0; j < 5000; j++, i++) ins.run(`k${(i * 2654435761) % 1000003}`, body + i);
    db.exec('COMMIT');
  }
  db.exec('DELETE FROM t WHERE id % 4 != 0');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const mode = Number(one(db, 'PRAGMA auto_vacuum'));
  const pc = Number(one(db, 'PRAGMA page_count'));
  const fl = Number(one(db, 'PRAGMA freelist_count'));
  db.close();
  if (mode !== 2) { console.error(`template auto_vacuum=${mode}, expected 2`); process.exit(1); }
  if (fl < freePages * 0.9) { console.error(`template has ${fl} free pages, wanted ~${freePages}`); process.exit(1); }
  console.log(`template: ${pc} pages, ${fl} free (${((100 * fl) / pc).toFixed(0)}%), ${(statSync(template).size / 1e6).toFixed(0)} MB, mode ${mode}`);
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const rows = [];
const summary = [];
for (const cache of caches) {
  for (const n of batches) {
    // A leftover WAL from the previous configuration would be REPLAYED into the fresh copy. SQLite removes it
    // when the last connection closes cleanly; if it is still there, the measurement cannot be trusted.
    if (existsSync(copy + '-wal')) { console.error(`stale WAL at ${copy}-wal: the previous configuration did not close cleanly`); process.exit(1); }
    copyFileSync(template, copy);                       // overwrite: no delete anywhere
    const db = new DatabaseSync(copy);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`PRAGMA cache_size=${cache}`);
    const before = Number(one(db, 'PRAGMA freelist_count'));
    const totals = [];
    const frames = [];
    for (let r = 0; r < rounds; r++) {
      const fl0 = Number(one(db, 'PRAGMA freelist_count'));
      const t0 = performance.now();
      db.exec(`PRAGMA incremental_vacuum(${n})`);
      const t1 = performance.now();
      const ck = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
      const t2 = performance.now();
      const fl1 = Number(one(db, 'PRAGMA freelist_count'));
      const freed = fl0 - fl1;
      const logFrames = Number(ck.log);
      totals.push(t2 - t0);
      frames.push(logFrames);
      rows.push([n, cache, r, (t1 - t0).toFixed(2), (t2 - t1).toFixed(2), freed, logFrames].join('\t'));
      if (freed !== n) { console.error(`N=${n} cache=${cache} round ${r}: freed ${freed}, expected ${n}`); process.exit(1); }
    }
    const after = Number(one(db, 'PRAGMA freelist_count'));
    const integrity = one(db, 'PRAGMA integrity_check');
    db.close();
    if (integrity !== 'ok') { console.error(`integrity_check after N=${n}: ${integrity}`); process.exit(1); }
    summary.push({ n, cache, p50: pct(totals, 50), p95: pct(totals, 95), maxFrames: Math.max(...frames), freed: before - after });
  }
}

console.log('\n    N  cache_size   p50 ms   p95 ms  max WAL frames/batch  pages freed  verdict');
const limitMs = minPhase / 2;
for (const s of summary) {
  const ok = s.p95 <= limitMs && s.maxFrames <= 1000;
  console.log(`${String(s.n).padStart(5)}  ${String(s.cache).padStart(10)}  ${s.p50.toFixed(1).padStart(7)}  ${s.p95.toFixed(1).padStart(7)}  ${String(s.maxFrames).padStart(20)}  ${String(s.freed).padStart(11)}  ${ok ? 'within' : 'OUT'}`);
}
const hookCache = -2000;
const fit = summary.filter((s) => s.cache === hookCache && s.p95 <= limitMs && s.maxFrames <= 1000)
  .map((s) => ({ ...s, rate: s.n / s.p50 }));
const bestRate = fit.length ? Math.max(...fit.map((s) => s.rate)) : 0;
const pick = fit.filter((s) => s.rate >= 0.9 * bestRate).sort((a, b) => b.n - a.n)[0];
for (const s of fit) console.log(`  within rule: N=${s.n}  ${s.rate.toFixed(1)} pages/ms (p50)`);
console.log(`\nrule: p95(batch+checkpoint) <= ${limitMs} ms (MIN_PHASE_BUDGET_MS/2) and max WAL frames/batch <= 1000, at cache_size ${hookCache}`);
console.log(`rows timed: ${rows.length} (expected ${batches.length * caches.length * rounds})`);
if (rows.length !== batches.length * caches.length * rounds) { console.error('row count mismatch'); process.exit(1); }
if (out) { writeFileSync(out, ['N\tcache_size\tround\tvacuum_ms\tcheckpoint_ms\tpages_freed\twal_frames', ...rows].join('\n') + '\n'); console.log(`raw rows: ${out}`); }
if (fit.length === 0) { console.log('RESULT: NO measured N meets the rule — no batch size is recommended; widen --batches downward'); process.exit(1); }
console.log(`RESULT: recommended N = ${pick.n}  (${pick.rate.toFixed(1)} pages/ms p50, p95 ${pick.p95.toFixed(1)} ms, ${pick.maxFrames} WAL frames/batch; best ${bestRate.toFixed(1)}; sqlite ${sqliteVersion})`);
JS
