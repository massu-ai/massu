#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.
//
// Measure how long chokidar takes to deliver the watcher-liveness canary's own write
// back to the daemon (plan-2026-08-12-watch-daemon-silent-dead-watcher).
//
// WHY THIS SHIPS INSTEAD OF A BARE CONSTANT (CR-68): CANARY_MIN_GRACE_MS is a claim
// about the outside world -- "a healthy watcher always echoes within X ms". A comment
// asserting a constant is safe ("well under", "typical") is an unprobed capability
// claim, and getting it wrong makes the canary declare a HEALTHY watcher dead and
// reconcile the user's project on its own heartbeat. Re-run this when the constant is
// questioned, and run it UNDER LOAD -- that is the condition the defect appears in.
//
//   node scripts/ops/measure-canary-echo-latency.mjs [trials]
//   MASSU_CANARY_LOAD=1 node scripts/ops/measure-canary-echo-latency.mjs 40
//
// Exit 0 = measured; exit 3 = INCONCLUSIVE (too few deliveries to characterise the
// latency, which is fail-closed: an unmeasured distribution is never reported as a
// safe bound).

import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
// Resolve chokidar relative to THIS FILE, so the probe runs from any cwd and in a clone.
const require = createRequire(import.meta.url);
const chokidar = require(resolve(REPO_ROOT, 'node_modules/chokidar'));

const TRIALS = Number(process.argv[2] ?? 30);
const CANARY_DIR_REL = '.massu/watch-canary';
const CANARY_FILE_REL = `${CANARY_DIR_REL}/liveness`;

function isCanary(p) {
  const norm = String(p).split(sep).join('/');
  return norm === CANARY_DIR_REL || norm.startsWith(`${CANARY_DIR_REL}/`);
}

const dir = mkdtempSync(resolve(tmpdir(), 'massu-canary-latency-'));
mkdirSync(resolve(dir, 'src'), { recursive: true });
mkdirSync(resolve(dir, CANARY_DIR_REL), { recursive: true });

let pending = null;
const latencies = [];
let dead = 0;

const w = chokidar.watch(['package.json', 'src/**', CANARY_DIR_REL], {
  cwd: dir,
  ignored: ['**/node_modules/**', '**/.git/**'],
  ignoreInitial: true,
  persistent: true,
  awaitWriteFinish: false,
});
w.on('all', (_ev, p) => {
  if (!isCanary(p) || pending === null) return;
  latencies.push(Date.now() - pending);
  pending = null;
});
await new Promise((r) => w.on('ready', r));

// Optional synthetic load: the defect and the latency tail both appear under contention.
const loaders = [];
if (process.env.MASSU_CANARY_LOAD) {
  const { spawn } = await import('node:child_process');
  for (let i = 0; i < 8; i++) {
    loaders.push(spawn(process.execPath, ['-e', 'for(;;){Math.sqrt(Math.random());}'], { stdio: 'ignore' }));
  }
}

const PER_TRIAL_BUDGET_MS = 3_000;
for (let i = 0; i < TRIALS; i++) {
  pending = Date.now();
  writeFileSync(resolve(dir, CANARY_FILE_REL), `${Date.now()}-${i}\n`, 'utf-8');
  const until = Date.now() + PER_TRIAL_BUDGET_MS;
  while (pending !== null && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (pending !== null) { dead++; pending = null; }
  await new Promise((r) => setTimeout(r, 50));
}

for (const l of loaders) l.kill('SIGKILL');
await w.close();
rmSync(dir, { recursive: true, force: true });

latencies.sort((a, b) => a - b);
const pct = (q) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : NaN);

console.log(`trials         : ${TRIALS}`);
console.log(`delivered      : ${latencies.length}`);
console.log(`never delivered: ${dead}   (a genuinely dead watcher, the defect itself)`);
console.log(`load           : ${process.env.MASSU_CANARY_LOAD ? '8 spinner processes' : 'none (idle box)'}`);
if (latencies.length < 5) {
  console.log('INCONCLUSIVE: fewer than 5 deliveries — no latency distribution to report.');
  process.exit(3);
}
console.log(`latency ms     : min=${latencies[0]} p50=${pct(0.5)} p90=${pct(0.9)} p99=${pct(0.99)} max=${latencies[latencies.length - 1]}`);
process.exit(0);
