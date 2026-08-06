// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P1-002 (plan-2026-07-23-hook-latency-silent-loss-fixes) — the BEHAVIOURAL proof that
 * `PRAGMA busy_timeout` actually makes a blocked writer WAIT instead of failing instantly.
 *
 * The defect this pins: with no busy-timeout, SQLite's default is 0ms, so a second writer
 * gets `SQLITE_BUSY` ("database is locked") immediately. Every massu hook catches that,
 * appends to `.massu/hook-failures.jsonl`, and exits 0 — so the row is silently gone.
 * 2,169 such losses were measured in one workspace and 156 in another before this landed.
 *
 * WHY THE LOCK-HOLDER MUST BE OFF THE MAIN THREAD (do not "simplify" this):
 * the plan audit EXECUTED the obvious same-thread variant — hold the lock, release it from
 * a `setTimeout` — and it is IMPOSSIBLE. SQLite's busy-wait is SYNCHRONOUS: it blocks the
 * event loop, so the release timer can never fire, and the probe threw `database is locked`
 * after 2,112ms even with `busy_timeout=2000`. A real second thread is required.
 *
 * CAN-FAIL PROOF: the same INSERT, against the same held lock, with
 * `MASSU_DB_BUSY_TIMEOUT_MS=0` — it must THROW. Without that half, a green run cannot
 * distinguish "the timeout worked" from "there was never any contention".
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Worker } from 'worker_threads';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, DB_BUSY_TIMEOUT_ENV } from '../db-driver.ts';

/** How long the worker holds the write lock after announcing it. Generous on purpose:
 *  the main thread must still be inside its blocking INSERT when the hold expires, and
 *  contention on a loaded machine only ever ADDS delay to the handoff. */
const HOLD_MS = 800;

const LOCK_HOLDER = `
const { parentPort, workerData } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(workerData.dbPath);
// BEGIN IMMEDIATE takes the RESERVED write lock right now, rather than lazily on first
// write — that is what makes the handoff to the main thread deterministic.
db.exec('BEGIN IMMEDIATE');
db.prepare('INSERT INTO t (v) VALUES (?)').run('from-worker');

parentPort.postMessage('locked');

// Atomics.wait blocks THIS thread without releasing the lock and without a timer — the
// main thread is free to run (and to block) while we hold it.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);

db.exec('COMMIT');
db.close();
parentPort.postMessage('released');
`;

interface Harness {
  dir: string;
  dbPath: string;
  worker: Worker;
}

const active: Harness[] = [];

afterEach(async () => {
  for (const h of active.splice(0)) {
    await h.worker.terminate().catch(() => undefined);
    rmSync(h.dir, { recursive: true, force: true });
  }
});

/** Create a DB with a table, then start a worker that takes and holds the write lock.
 *  Resolves once the lock is CONFIRMED held, so the caller's attempt truly contends. */
async function withHeldLock(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'massu-busy-timeout-'));
  const dbPath = join(dir, 'busy.db');

  const seed = openDatabase(dbPath);
  seed.exec('CREATE TABLE t (v TEXT)');
  seed.close();

  const holderPath = join(dir, 'lock-holder.cjs');
  writeFileSync(holderPath, LOCK_HOLDER);

  const worker = new Worker(holderPath, { workerData: { dbPath, holdMs: HOLD_MS } });
  const harness: Harness = { dir, dbPath, worker };
  active.push(harness);

  await new Promise<void>((resolve, reject) => {
    worker.once('message', (m) => (m === 'locked' ? resolve() : reject(new Error(`unexpected: ${m}`))));
    worker.once('error', reject);
  });

  return harness;
}

/** Run body with the busy-timeout env knob set, restoring the previous value after. */
function withBusyTimeout<T>(ms: string, body: () => T): T {
  const prev = process.env[DB_BUSY_TIMEOUT_ENV];
  process.env[DB_BUSY_TIMEOUT_ENV] = ms;
  try {
    return body();
  } finally {
    if (prev === undefined) delete process.env[DB_BUSY_TIMEOUT_ENV];
    else process.env[DB_BUSY_TIMEOUT_ENV] = prev;
  }
}

/** Attempt one INSERT at the given busy-timeout. Returns the outcome, never throws. */
function attemptInsert(dbPath: string, timeoutMs: string, value: string) {
  return withBusyTimeout(timeoutMs, () => {
    const db = openDatabase(dbPath);
    try {
      db.prepare('INSERT INTO t (v) VALUES (?)').run(value);
      return { threw: false, message: '' };
    } catch (err) {
      return { threw: true, message: err instanceof Error ? err.message : String(err) };
    } finally {
      db.close();
    }
  });
}

describe('PRAGMA busy_timeout (P1 — silent telemetry loss)', () => {
  /**
   * Both halves run against ONE held lock, which is what makes this deterministic:
   *
   *   with timeout 0    -> THROWS   (proves the lock is genuinely held right now)
   *   with timeout 2000 -> SUCCEEDS (proves the pragma converts that into a wait)
   *
   * Deliberately NOT asserted via elapsed time. A wall-clock bound states a property of
   * the machine, not of the code (G27) — it goes red on a loaded host and green on a fast
   * one even after a regression. The zero-timeout probe is a strictly better floor: it can
   * only pass while contention is real, so it rules out the vacuous run (worker released
   * early, nothing ever contended) that a timing bound was only approximating.
   */
  it('converts an instant SQLITE_BUSY failure into a successful wait', async () => {
    const { dbPath, worker } = await withHeldLock();

    const unarmed = attemptInsert(dbPath, '0', 'probe-unarmed');
    expect(
      unarmed.threw,
      'INSERT SUCCEEDED with busy_timeout=0 — the lock was not actually held, so the armed case below would prove nothing',
    ).toBe(true);
    expect(unarmed.message.toLowerCase()).toMatch(/locked|busy/);

    // Same lock, same moment — the ONLY difference is the pragma.
    const armed = attemptInsert(dbPath, '2000', 'from-main');
    expect(
      armed.threw,
      `INSERT threw with busy_timeout=2000 while the lock was held: ${armed.message}`,
    ).toBe(false);

    // WAIT FOR THE WORKER'S OWN 'released' SIGNAL BEFORE READING.
    //
    // A successful armed INSERT proves the lock was RELEASED — it does NOT prove the worker
    // COMMITTED. A rolled-back worker transaction (interrupted thread, throwing COMMIT) also
    // releases the lock, and then `from-worker` never existed. Reading straight after the
    // armed insert therefore raced the worker's COMMIT, and the loss surfaced as a bare
    // row-set mismatch — `['from-main'] !== ['from-main','from-worker']` — which names
    // neither the worker nor the rollback. Observed 2026-08-05 in the pre-push [14/22]
    // sync-check mirror under load; passes 3/3 in isolation, i.e. exactly the load-sensitive
    // shape a row assertion cannot attribute.
    //
    // The worker already posts 'released' after COMMIT + close; the test simply never awaited
    // it. Awaiting it makes the ordering explicit rather than inferred, and lets an 'error'
    // reject with the worker's REAL cause instead of a downstream symptom.
    await new Promise<void>((resolve, reject) => {
      worker.once('message', (m) =>
        m === 'released'
          ? resolve()
          : reject(new Error(`worker sent ${JSON.stringify(m)}, expected 'released'`)),
      );
      worker.once('error', (err) =>
        reject(new Error(`worker died before COMMIT — its transaction rolled back: ${err.message}`)),
      );
    });

    const verify = openDatabase(dbPath);
    const rows = verify.prepare('SELECT v FROM t ORDER BY v').all() as Array<{ v: string }>;
    verify.close();
    // The unarmed probe's row must be ABSENT (it threw); the worker's and the armed one present.
    expect(rows.map((r) => r.v)).toEqual(['from-main', 'from-worker']);
  });
});
