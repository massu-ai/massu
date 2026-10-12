// THE ONE PLACE THAT DECIDES WHERE HEARTBEATS LIVE — imported by both the writer (the vitest
// reporter) and the reader (the watcher), so the two agree BY CONSTRUCTION.
//
// ⛔ WHY A SHARED RESOLVER RATHER THAN A CONVENTION. If the reporter computed the path and the
// watcher computed it separately, the two computations could drift and the watcher would poll a
// place nothing writes — which reads as PERMANENT SILENCE, i.e. the FIRING value, or worse as a
// report about the wrong run. One module, two importers, no handoff channel (Rule 25 / G32).
//
// ⛔ THE LAYOUT IS BASE/<PID>/heartbeat.json, AND THE PER-PID LEVEL IS NOT COSMETIC. Several
// sessions work this repo concurrently, so two vitest runs can be live at once. A single shared
// heartbeat.json would let them overwrite each other and leave the watcher unable to say WHICH
// run it read — a correctness failure, not untidiness. The pid is the run's own identity and
// both sides can derive their view of it: the writer knows `process.pid`; the watcher
// ENUMERATES the base and can ask whether each pid is still alive.
//
// ⛔ AND THE PID IS WHAT MAKES "no heartbeat at all" DISTINGUISHABLE FROM "a heartbeat that went
// quiet". A live pid with no file means the run started and has not emitted yet (a collection or
// worker-startup deadlock). A dead pid with a stale file means the run ended. Those are
// different states and the rule module keeps them apart.

import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The env var names the BASE, not the per-run directory — the reporter appends its own pid.
// Renamed from HANG_HEARTBEAT_DIR when the layout gained the pid level, so a stale caller
// passing a leaf path fails loudly rather than writing somewhere the watcher does not look.
export const ENV_BASE = 'HANG_HEARTBEAT_BASE';

// Repo-relative and gitignored. Deriving it from the repo root is what lets the writer and an
// independently-launched watcher land on the same place with nothing passed between them.
export const BASE_DIRNAME = '.hang-heartbeats';

export function baseFromEnv() {
  return process.env[ENV_BASE] || null;
}

export function baseFromRepoRoot(repoRoot) {
  return join(repoRoot, BASE_DIRNAME);
}

// runDir(base, pid) — where ONE run writes. The writer calls this with its own pid.
export function runDir(base, pid) {
  return join(base, String(pid));
}

export function ensureRunDir(base, pid) {
  const d = runDir(base, pid);
  mkdirSync(d, { recursive: true });
  return d;
}

// discoverRuns(base) -> [{ pid, dir, alive }]
//
// ⛔ M2: an unreadable base returns null, NOT an empty array. "There are no runs" and "I could
// not look" must not be the same value — an empty array would let a watcher that cannot read
// the directory report the same thing as one watching an idle repo, and idle reads as fine.
export function discoverRuns(base) {
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }

  const runs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!/^\d+$/.test(e.name)) continue; // only pid-shaped names are runs
    const pid = Number(e.name);
    runs.push({ pid, dir: join(base, e.name), alive: isAlive(pid) });
  }
  // Newest pid last is not meaningful; sort ascending so output is deterministic for tests.
  runs.sort((a, b) => a.pid - b.pid);
  return runs;
}

// isAlive(pid) — signal 0 probes existence without delivering anything.
//
// ⚠️ HONEST LIMIT: a pid can be REUSED by the OS, so "alive" means "some process holds this pid",
// not "that run is still going". Combined with the heartbeat's own freshness this is sufficient
// for the rule (a reused pid with a stale heartbeat still reads as stale), and claiming more
// would be claiming more than signal 0 can tell us.
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to another user — still alive for our purposes.
    return e && e.code === 'EPERM';
  }
}

export function dirMtimeMs(dir) {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}
