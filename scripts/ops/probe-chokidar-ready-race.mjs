#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.
//
// Does chokidar's `ignoreInitial: true` actually suppress the initial-scan directory
// events? (plan-2026-08-12-watch-daemon-silent-dead-watcher, D-7.)
//
// WHY THIS SHIPS INSTEAD OF A SENTENCE (CR-63/CR-68). "ignoreInitial suppresses events
// only until ready" is a universal claim about a dependency's behaviour, and reading the
// plan cannot validate it. It is also the claim the whole D-7 fix rests on: if the
// emissions were deterministic rather than racing `ready`, the correct repair would have
// been to filter pre-existing directories instead of filtering by relevance.
//
// The answer is NOT a constant — it depends on how long the initial scan takes, which is
// why the same daemon emitted a phantom startup refresh on some runs and not others.
//
//   node scripts/ops/probe-chokidar-ready-race.mjs
//
// Exit 0 = measured. Exit 3 = INCONCLUSIVE (no variant emitted anything after ready, so
// the race was not observed on this host and the claim is unverified here — fail-closed,
// never reported as "suppression works").

import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
// Resolved relative to THIS FILE so the probe runs from any cwd and in a clone.
const require = createRequire(import.meta.url);
const chokidar = require(resolve(REPO_ROOT, 'node_modules/chokidar'));

async function run(label, watchList, { makeSrc = true, extraDirs = [], manifest = false } = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'massu-ready-race-'));
  if (makeSrc) mkdirSync(resolve(dir, 'src'), { recursive: true });
  for (const d of extraDirs) mkdirSync(resolve(dir, d), { recursive: true });
  if (manifest) writeFileSync(resolve(dir, 'package.json'), '{"name":"p"}\n', 'utf-8');

  const before = [];
  const after = [];
  let ready = false;
  const w = chokidar.watch(watchList, {
    cwd: dir,
    ignored: ['**/node_modules/**', '**/.git/**'],
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: false,
  });
  w.on('all', (ev, p) => (ready ? after : before).push(`${ev}:${p}`));
  await new Promise((r) => w.on('ready', r));
  ready = true;
  await new Promise((r) => setTimeout(r, 700));

  console.log(`${label.padEnd(34)} AFTER ready: ${after.length ? after.join(', ') : '(nothing)'}`);
  await w.close();
  rmSync(dir, { recursive: true, force: true });
  return after.length;
}

console.log("chokidar ignoreInitial:true — what still arrives AFTER 'ready'?");
console.log('');
let leaked = 0;
leaked += await run("watch ['src/**']", ['src/**']);
leaked += await run("watch ['src']", ['src']);
leaked += await run("watch ['src/**'] nested dirs", ['src/**'], { extraDirs: ['src/a', 'src/a/b'] });
const withManifest = await run("watch ['package.json','src/**']", ['package.json', 'src/**'], { manifest: true });
const srcAbsent = await run("watch ['src/**'] src absent", ['src/**'], { makeSrc: false });

console.log('');
// Raw values only. An interpretation typed INTO the output pre-commits a conclusion the
// run may contradict: an earlier run of this same probe had the manifest variant leak
// NOTHING, and a label reading "longer scan lets ready win" then survived a run that
// refuted it. Interpret in prose, after reading the numbers (G23).
console.log(`variants leaking after ready : ${leaked > 0 ? 'YES' : 'no'}`);
console.log(`manifest variant leaked      : ${withManifest > 0 ? 'YES' : 'no'}`);
console.log(`src-absent variant leaked    : ${srcAbsent > 0 ? 'YES' : 'no'}`);
console.log('NOTE: this set is not stable run-to-run — that instability IS the finding.');
if (leaked === 0) {
  console.log('INCONCLUSIVE: no variant leaked on this host — the race was not observed here.');
  process.exit(3);
}
console.log('VERDICT: ignoreInitial does NOT reliably suppress initial-scan directory events;');
console.log('         whether they land before or after `ready` depends on scan duration.');
process.exit(0);
