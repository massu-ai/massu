// Analyse the event logs produced by vitest-gap-reporter.mjs and report the inter-event gap
// distribution -- the measurement that sets the hang detector's silence bound (CR-68).
//
// M2 FAIL CLOSED: zero logs, zero events, or a single event (from which no gap can be formed)
// all exit 2. "Could not measure" must never print a distribution.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: vitest-gap-analyse.mjs <dir-of-jsonl-logs>');
  process.exit(2);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
if (files.length === 0) {
  console.error(`ERROR no .jsonl logs in ${dir} — nothing to analyse`);
  process.exit(2);
}

// A gap is only meaningful WITHIN one run. The interval between the last event of one run and
// the first of the next is an artifact of the harness, not of the runner, so runs are never
// concatenated.
const gaps = [];          // {ms, from, to, fromSubject, toSubject, file}
let totalEvents = 0;
let malformed = 0;
const eventCounts = new Map();
const perFile = [];

for (const f of files) {
  const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.trim());
  const recs = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (typeof r.t_ms !== 'number' || typeof r.event !== 'string') {
        // G3: an unparseable record is COUNTED, never silently skipped.
        malformed += 1;
        continue;
      }
      recs.push(r);
    } catch {
      malformed += 1;
    }
  }
  totalEvents += recs.length;
  for (const r of recs) eventCounts.set(r.event, (eventCounts.get(r.event) || 0) + 1);

  let fileMax = 0;
  for (let i = 1; i < recs.length; i += 1) {
    const ms = recs[i].t_ms - recs[i - 1].t_ms;
    if (ms < 0) {
      // hrtime is monotonic, so this cannot happen; if it does, the instrument is wrong and
      // saying so is more useful than a plausible number.
      console.error(`ERROR negative gap in ${f} at record ${i} — instrument is untrustworthy`);
      process.exit(2);
    }
    if (ms > fileMax) fileMax = ms;
    gaps.push({
      ms,
      from: recs[i - 1].event,
      to: recs[i].event,
      fromSubject: recs[i - 1].subject || '',
      toSubject: recs[i].subject || '',
      file: f,
    });
  }
  perFile.push({ file: f, events: recs.length, maxGap: fileMax });
}

// M1: the denominator, before any conclusion.
console.log(`LOGS_ANALYSED:   ${files.length}`);
console.log(`EVENTS_TOTAL:    ${totalEvents}`);
console.log(`GAPS_TOTAL:      ${gaps.length}`);
console.log(`MALFORMED_LINES: ${malformed}`);
console.log('');

if (gaps.length === 0) {
  console.error('ERROR zero gaps formed — a distribution over nothing is not a measurement');
  process.exit(2);
}

console.log('PER-RUN');
for (const p of perFile) {
  console.log(`  ${p.file}  events=${p.events}  max_gap_ms=${p.maxGap}`);
}
if (perFile.some((p) => p.events === 0)) {
  console.error('\nERROR at least one run produced ZERO events — the reporter did not arm there');
  process.exit(2);
}
console.log('');

const sorted = gaps.map((g) => g.ms).sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

console.log('INTER-EVENT GAP DISTRIBUTION (ms)');
console.log(`  p50   ${pct(50)}`);
console.log(`  p90   ${pct(90)}`);
console.log(`  p99   ${pct(99)}`);
console.log(`  max   ${sorted[sorted.length - 1]}`);
console.log('');

// NEVER REPORT A COUNT WITHOUT ITS MATCHES (G16). The maximum is the number that sets the
// bound, so the transitions that produced the longest silences are printed and must be READ:
// if the widest gap sits across a boundary that is about to gain its own beat, the bound
// derived from it is too wide.
const top = gaps.slice().sort((a, b) => b.ms - a.ms).slice(0, 10);
console.log('TEN LONGEST SILENCES — read these, do not just take the max');
for (const g of top) {
  const fs = g.fromSubject ? ` [${g.fromSubject}]` : '';
  const ts = g.toSubject ? ` [${g.toSubject}]` : '';
  console.log(`  ${String(g.ms).padStart(7)}ms  ${g.from}${fs}  ->  ${g.to}${ts}`);
}
console.log('');

console.log('EVENTS OBSERVED (derived — this is the hook surface this vitest actually emits)');
for (const [k, v] of [...eventCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(6)}  ${k}`);
}
console.log('');

// The bound is NOT decided here. This script measures; the plan's D-1 records the decision and
// its margin, in one place, with this output pasted as its evidence.
console.log('OBSERVED_MAX_GAP_MS: ' + sorted[sorted.length - 1]);
console.log('');
console.log('This is an OBSERVATION, not a bound. Choosing the bound needs a stated margin and');
console.log('the reasoning for it, recorded in the plan — and re-running this on a LOADED host,');
console.log('because the widest legitimate silence is a property of contention, not of the code.');
