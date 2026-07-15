// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * LAYER 2 — THE INVARIANT: a learned rule is deleted ONLY when the server confirms
 * receipt. Nothing else may remove one. Not a retry cap, not a give-up, not a
 * cap-trim, not an exception, not a read.
 *
 * This file is written to be DEFEATED, not to be agreed with (CR-52). Each test
 * that guards a defect REINTRODUCES that defect and demands the guard go RED — a
 * test that merely re-asserts today's good behavior is a regression test, and a
 * regression test cannot find a false negative.
 *
 * The defect being guarded is not hypothetical. Measured 2026-07-14 across 7 repos:
 * 18 promotion events ever enqueued, 17 destroyed, 0 rules ever delivered.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, renameSync, statSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initMemorySchema,
  enqueueTeamPromotion,
  enqueueTeamRevocation,
  enqueueRulePromotionEvent,
  enqueueSyncPayload,
  dequeuePendingSync,
  incrementRetryCount,
} from '../memory-db.ts';
import {
  leaseLearning,
  ackLearning,
  nackLearning,
  undeliveredSnapshot,
  stripLearningFromPayload,
  payloadCarriesLearning,
  capTelemetry,
  LEASE_TTL_MS,
  STALL_ATTEMPTS,
  EVENT_DELIVERY_STALLED,
} from '../rule-delivery.ts';

let db: Database.Database;

/**
 * Overwrite a real source file ATOMICALLY (temp + rename). The anti-vacuity tests
 * below plant a defect into the LIVE memory-db.ts and restore it; a plain
 * writeFileSync truncates-then-writes, so a drift-guard in another vitest worker
 * that readFileSync's memory-db.ts mid-write can catch a torn (empty/partial) file
 * and fail spuriously (SUITE-FLAKE, audit 2026-07-14). renameSync is atomic on the
 * same filesystem: a concurrent reader always sees a COMPLETE file — the old
 * contents or the new, never a tear.
 */
function atomicOverwrite(path: string, content: string): void {
  const tmp = path + '.avtmp'; // .avtmp — never .ts, so globSourceFiles ignores it
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

beforeEach(() => {
  db = new Database(':memory:');
  initMemorySchema(db);
});

afterEach(() => {
  db.close();
});

const HASH = 'a'.repeat(16);

function seedRule(hash = HASH): void {
  enqueueTeamPromotion(db, {
    prompt_hash: hash,
    destination: 'corrections-md',
    draft_text: 'Always verify the end state.',
    score: 90,
    signals: ['recurrence'],
    content_hash: 'c'.repeat(64),
  });
}

function ruleCount(): number {
  const r = db.prepare('SELECT COUNT(*) AS n FROM team_promotion_outbound').get() as { n: number };
  return r.n;
}

describe('the delivery invariant: only a confirmed server receipt deletes a rule', () => {
  it('lease does NOT delete', () => {
    seedRule();
    const lease = leaseLearning(db);
    expect(lease.promotions.length).toBe(1);
    expect(ruleCount()).toBe(1); // the old drain would have made this 0
  });

  it('ack DOES delete — and only what it leased', () => {
    seedRule('a'.repeat(16));
    const lease = leaseLearning(db);
    // A rule enqueued mid-flight carries no lease token and must SURVIVE the ack.
    seedRule('b'.repeat(16));
    ackLearning(db, lease);
    const rows = db
      .prepare('SELECT prompt_hash FROM team_promotion_outbound')
      .all() as Array<{ prompt_hash: string }>;
    expect(rows.map((r) => r.prompt_hash)).toEqual(['b'.repeat(16)]);
  });

  it('nack KEEPS the rule and counts the attempt — forever, however many failures', () => {
    seedRule();
    for (let i = 1; i <= 25; i++) {
      const lease = leaseLearning(db);
      nackLearning(db, lease, 'HTTP 401: ');
      expect(ruleCount()).toBe(1); // 25 failures. Still here. That is the product.
    }
    const snap = undeliveredSnapshot(db);
    expect(snap.promotions).toBe(1);
    expect(snap.max_rule_attempts).toBe(25);
    expect(snap.stalled).toBe(true);
  });

  it('a stalled rule raises a DURABLE alarm — failure must not look like emptiness', () => {
    seedRule();
    for (let i = 0; i < STALL_ATTEMPTS; i++) {
      nackLearning(db, leaseLearning(db), 'HTTP 401: ');
    }
    const alarms = db
      .prepare('SELECT COUNT(*) AS n FROM analytics_events WHERE event_type = ?')
      .get(EVENT_DELIVERY_STALLED) as { n: number };
    expect(alarms.n).toBeGreaterThan(0);
  });

  it('an expired lease is reclaimable — a crashed session cannot strand a rule', () => {
    seedRule();
    const t0 = 1_000_000_000_000;
    leaseLearning(db, t0); // leased, then the session dies without ack/nack
    expect(leaseLearning(db, t0 + 1000).promotions.length).toBe(0); // still held
    const reclaimed = leaseLearning(db, t0 + LEASE_TTL_MS + 1);
    expect(reclaimed.promotions.length).toBe(1); // TTL expired → claimable again
    expect(ruleCount()).toBe(1);
  });
});

describe('an ACK requires a RECEIPT — not merely a truthy result', () => {
  // THE REGRESSION I INTRODUCED WHILE FIXING THIS EXACT BUG CLASS (2026-07-14).
  //
  // `syncToCloud` returns `success: true` when cloud sync is DISABLED — nothing was
  // sent, nothing was wrong. The first cut of the lease/ack wiring acked on
  // `success`, which would have DELETED every learned rule at session end on every
  // local-only (Free/Pro) seat. The fix: only a `transmitted: true` — set solely
  // after a real 2xx from the server — may authorize an ack.
  //
  // This is the CR-52 lesson made executable: I validated the fix against the
  // expectation I already held, and the expectation was wrong. The invariant is
  // "deleted only on a RECEIPT", and "success" is not a receipt.
  it('a result that is success-but-NOT-transmitted must never delete a rule', () => {
    seedRule();
    const lease = leaseLearning(db);
    // Simulate exactly what a disabled cloud returns: success true, transmitted absent.
    const result: { success: boolean; transmitted?: boolean; error?: string } = { success: true };
    if (result.transmitted === true) {
      ackLearning(db, lease);
    } else {
      nackLearning(db, lease, 'not transmitted');
    }
    expect(ruleCount()).toBe(1); // acking on `success` alone would have made this 0
  });

  it('only a transmitted:true receipt deletes the rule', () => {
    seedRule();
    const lease = leaseLearning(db);
    const result: { success: boolean; transmitted?: boolean } = { success: true, transmitted: true };
    if (result.transmitted === true) ackLearning(db, lease);
    expect(ruleCount()).toBe(0);
  });

  it('DRIFT GUARD: session-end must gate the ack on `transmitted`, never on `success`', () => {
    // A source-level assertion, because this is a one-character mistake with a
    // catastrophic blast radius and the type system cannot catch it.
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'hooks', 'session-end.ts'),
      'utf8',
    );
    expect(src).toMatch(/result\.transmitted\s*===\s*true/);
    // The naive form must NOT be what authorizes the ack.
    expect(src).not.toMatch(/if\s*\(\s*result\.success\s*\)\s*\{\s*ackLearning/);
  });
});

describe('pending_sync — the shredder — can no longer reach a learned rule', () => {
  it('stripLearningFromPayload removes every learned-rule section', () => {
    const stripped = stripLearningFromPayload({
      sessions: [{ id: 1 }],
      rule_promotions: [{ prompt_hash: HASH }],
      rule_revocations: [{ prompt_hash: HASH }],
      rule_promotion_events: [{ prompt_hash: HASH }],
    });
    expect(payloadCarriesLearning(stripped)).toBe(false);
    expect((stripped as Record<string, unknown>).sessions).toBeDefined();
  });

  it('ANTI-VACUITY: payloadCarriesLearning actually FIRES on a real payload', () => {
    // If this returned false for everything, the guard above would be decoration.
    expect(payloadCarriesLearning({ rule_promotions: [{ prompt_hash: HASH }] })).toBe(true);
    expect(payloadCarriesLearning({ rule_revocations: [{ prompt_hash: HASH }] })).toBe(true);
    expect(payloadCarriesLearning({ rule_promotion_events: [{ prompt_hash: HASH }] })).toBe(true);
    expect(payloadCarriesLearning({ sessions: [] })).toBe(false);
    expect(payloadCarriesLearning({ rule_promotions: [] })).toBe(false); // empty ≠ carrying
  });

  it('THE ACTUAL 2026-07-14 DEATH: a give-up RESCUES the rule instead of destroying it', () => {
    // Reproduce the exact production sequence that killed 17 rules: a payload
    // carrying a promoted rule is queued, fails 10+ times against an HTTP 401, and
    // hits the give-up path. Before Layer 2 this DELETED the rule. Now it rescues it.
    enqueueSyncPayload(
      db,
      JSON.stringify({
        sessions: [],
        rule_promotions: [
          {
            prompt_hash: HASH,
            destination: 'corrections-md',
            draft_text: 'Always verify the end state.',
            score: 90,
            signals: [],
            content_hash: 'c'.repeat(64),
          },
        ],
      }),
    );
    const queued = db.prepare('SELECT id FROM pending_sync').all() as Array<{ id: number }>;
    for (let i = 0; i < 10; i++) incrementRetryCount(db, queued[0].id, 'HTTP 401: ');

    expect(ruleCount()).toBe(0); // the rule is NOT yet in the outbound store
    dequeuePendingSync(db);      // ← the give-up path fires here

    // The payload is gone (sessions/observations are best-effort)...
    const left = db.prepare('SELECT COUNT(*) AS n FROM pending_sync').get() as { n: number };
    expect(left.n).toBe(0);
    // ...but the RULE was pulled to safety, not shredded.
    expect(ruleCount()).toBe(1);
    const rescued = db
      .prepare('SELECT prompt_hash, draft_text FROM team_promotion_outbound')
      .get() as { prompt_hash: string; draft_text: string };
    expect(rescued.prompt_hash).toBe(HASH);
    expect(rescued.draft_text).toBe('Always verify the end state.');
  });

  it('a give-up rescues REVOCATIONS too', () => {
    enqueueSyncPayload(
      db,
      JSON.stringify({ rule_revocations: [{ prompt_hash: HASH }] }),
    );
    const queued = db.prepare('SELECT id FROM pending_sync').all() as Array<{ id: number }>;
    for (let i = 0; i < 10; i++) incrementRetryCount(db, queued[0].id, 'HTTP 401: ');
    dequeuePendingSync(db);
    const r = db.prepare('SELECT COUNT(*) AS n FROM team_revocation_outbound').get() as { n: number };
    expect(r.n).toBe(1);
  });
});

describe('the rules/telemetry distinction is honest, not a loophole', () => {
  it('the cap trims TELEMETRY only — and NEVER touches a learned rule', () => {
    seedRule();
    for (let i = 0; i < 12; i++) {
      enqueueRulePromotionEvent(db, {
        prompt_hash: HASH,
        event_type: 'shown',
        created_at: `2026-06-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
    const dropped = capTelemetry(db, 5);
    expect(dropped).toBeGreaterThan(0);           // the cap really bit
    const ev = db
      .prepare('SELECT COUNT(*) AS n FROM rule_promotion_events_outbound')
      .get() as { n: number };
    expect(ev.n).toBe(5);
    expect(ruleCount()).toBe(1);                  // the RULE is untouched
  });

  it('a cap trim is RECORDED, never silent', () => {
    for (let i = 0; i < 4; i++) {
      enqueueRulePromotionEvent(db, {
        prompt_hash: HASH,
        event_type: 'shown',
        created_at: `2026-06-01T00:00:0${i}.000Z`,
      });
    }
    capTelemetry(db, 2);
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM analytics_events WHERE event_type = 'rule_telemetry_capped'")
      .get() as { n: number };
    expect(n.n).toBe(1);
  });
});

describe('DRIFT GUARD: the destructive drain may never come back', () => {
  const SRC = resolve(import.meta.dirname, '..');

  /**
   * Find every production source file that deletes from a LEARNED-RULE outbound
   * store. Returns the offending paths.
   *
   * REWRITTEN after an adversarial auditor DEFEATED the first version two ways:
   *   (A) it EXEMPTED memory-db.ts, so a destructive drain appended to that very
   *       file — the file the drains used to live in — passed 17/17 green;
   *   (B) it matched only LITERAL table names, so a template-literal DELETE (the
   *       exact idiom rule-delivery.ts itself uses) was invisible. A planted
   *       `DELETE FROM ${OUTBOX_T}` passed 17/17 green.
   *
   * So: no exemptions except the ONE sanctioned deleter, and the pattern catches
   * an interpolated table name too. A guard is not a guard until someone has tried
   * to get around it.
   */
  function findRuleDeleters(): string[] {
    const files = globSourceFiles(SRC).filter((f) => !f.includes('__tests__'));
    // M1 — PROVE IT LOOKED. A scan of zero files must never read as "clean".
    if (files.length < 20) {
      throw new Error(`drift guard scanned only ${files.length} files — it cannot see`);
    }
    // A DELETE naming a rule store outright.
    const LITERAL = /DELETE\s+FROM\s+team_(promotion|revocation)_outbound/i;
    // A DELETE whose table is interpolated. On its own this is INNOCENT — the
    // codegraph indexers legitimately do `DELETE FROM ${t('py_imports')}` against a
    // completely different database. It is only dangerous in a file that could
    // resolve that variable to a RULE store, so we require both.
    const INTERPOLATED = /DELETE\s+FROM\s+\$\{[^}]+\}/i;
    const NAMES_A_RULE_STORE =
      /team_(promotion|revocation)_outbound|RULE_OUTBOUND_TABLES|ALL_OUTBOUND_TABLES/;

    const offenders: string[] = [];
    for (const f of files) {
      // The ONLY sanctioned deleter: ackLearning, which deletes strictly by lease
      // token — i.e. only rows the server has just confirmed.
      if (f.endsWith('rule-delivery.ts')) continue;
      const src = readFileSync(f, 'utf8');
      if (LITERAL.test(src)) {
        offenders.push(f);
      } else if (INTERPOLATED.test(src) && NAMES_A_RULE_STORE.test(src)) {
        offenders.push(f); // evasion B: `const T = 'team_promotion_outbound'; DELETE FROM ${T}`
      }
    }
    return offenders;
  }

  it('NO production file outside rule-delivery.ts deletes a learned rule (memory-db.ts INCLUDED)', () => {
    expect(findRuleDeleters()).toEqual([]);
  });

  it('memory-db.ts no longer exports a destructive drain', () => {
    const src = readFileSync(resolve(SRC, 'memory-db.ts'), 'utf8');
    expect(src).not.toMatch(/export function drainTeamPromotions/);
    expect(src).not.toMatch(/export function drainTeamRevocations/);
    expect(src).not.toMatch(/export function drainRulePromotionEvents/);
  });

  it('ANTI-VACUITY: planting the defect IN THE REAL TREE makes the guard go RED', () => {
    // The previous version of this test regex-matched a string literal declared
    // INSIDE the test. That proves the regex compiles; it proves NOTHING about the
    // tree the guard actually scans, and it is how both evasions above stayed green.
    //
    // This plants the real defect in a real file, runs the REAL scanner, demands
    // RED, and restores the file — the only form of this test that can catch a
    // false negative. (CR-52: a regression test cannot find a false negative.)
    const victim = resolve(SRC, 'memory-db.ts'); // deliberately the once-EXEMPT file
    const original = readFileSync(victim, 'utf8');
    // Capture the original timestamps so the restore leaves ZERO trace — including
    // mtime. Planting in the REAL tree (CR-72) is correct, but an atomic rename bumps
    // the source file's mtime even when content is restored byte-identical, which then
    // trips the [13/21] Workspace Build Freshness gate (src newer than dist). A mutation
    // test that leaves a side-effect is an incomplete restore. Surfaced 2026-07-14.
    const originalStat = statSync(victim);
    expect(findRuleDeleters()).toEqual([]); // clean before

    try {
      atomicOverwrite(
        victim,
        original +
          `\n// planted by anti-vacuity test\nexport function __planted(db) {\n` +
          `  db.prepare('DELETE FROM team_promotion_outbound').run();\n}\n`,
      );
      expect(findRuleDeleters()).toContain(victim); // the guard MUST see it
    } finally {
      atomicOverwrite(victim, original); // always restore content
      utimesSync(victim, originalStat.atime, originalStat.mtime); // …and mtime — no trace
    }

    expect(findRuleDeleters()).toEqual([]); // clean after — no damage left behind
    expect(readFileSync(victim, 'utf8')).toBe(original);
  });

  it('ANTI-VACUITY: an INTERPOLATED delete is caught too (evasion B)', () => {
    const victim = resolve(SRC, 'memory-db.ts');
    const original = readFileSync(victim, 'utf8');
    const originalStat = statSync(victim); // restore mtime too — see the test above
    try {
      atomicOverwrite(
        victim,
        original +
          '\nconst __T = "team_promotion_outbound";\n' +
          'export function __planted2(db) { db.prepare(`DELETE FROM ${__T}`).run(); }\n',
      );
      expect(findRuleDeleters()).toContain(victim);
    } finally {
      atomicOverwrite(victim, original); // restore content
      utimesSync(victim, originalStat.atime, originalStat.mtime); // …and mtime — no trace
    }
    expect(findRuleDeleters()).toEqual([]);
  });
});

describe('WIRING: the strip is not merely defined, it is CALLED', () => {
  // Auditor defect 3: `stripLearningFromPayload` was tested as a pure function, but
  // NOTHING asserted that cloud-sync actually invokes it. When a bad `git checkout`
  // silently removed the call, the suite stayed fully green — the built-and-never-
  // enabled class, in the guard itself. A capability no test exercises reads as done.
  it('cloud-sync.ts strips learned rules before handing a payload to the discardable queue', () => {
    const src = readFileSync(resolve(import.meta.dirname, '..', 'cloud-sync.ts'), 'utf8');
    // The enqueue into pending_sync MUST pass through the strip.
    expect(src).toMatch(/enqueueSyncPayload\(\s*db,\s*JSON\.stringify\(\s*stripLearningFromPayload\(/);
  });

  it('session-end.ts acks only on a real receipt (`transmitted`), never on `success`', () => {
    const src = readFileSync(resolve(import.meta.dirname, '..', 'hooks', 'session-end.ts'), 'utf8');
    expect(src).toMatch(/result\.transmitted\s*===\s*true/);
    expect(src).not.toMatch(/if\s*\(\s*result\.success\s*\)\s*\{\s*ackLearning/);
  });

  it('cloud-sync sets `transmitted` ONLY after a real server response', () => {
    const src = readFileSync(resolve(import.meta.dirname, '..', 'cloud-sync.ts'), 'utf8');
    const hits = src.match(/transmitted:\s*true/g) ?? [];
    expect(hits.length).toBe(1); // exactly one place may mint a receipt
  });
});

/** Discover every .ts source file (no hand-typed candidate list — CR-52 rule 2). */
function globSourceFiles(dir: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  const out: string[] = [];
  // SUITE-FLAKE (audit 2026-07-14): tolerate an entry vanishing mid-walk. Sibling
  // test files open WAL-mode scratch DBs under src/ whose transient .db-shm/.db-wal
  // sidecars appear and disappear between readdir and stat; an unguarded statSync
  // then throws ENOENT and this guard CRASHES instead of guarding — a blind gate
  // that throws instead of asserting. A vanished entry is never a .ts source file,
  // so skipping it cannot lower the real-.ts denominator the M1 check depends on.
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // a directory that vanished mid-walk contributes nothing
  }
  for (const entry of entries) {
    const full = resolve(dir, entry);
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st) continue; // vanished between readdir and stat — a transient sidecar
    if (st.isDirectory()) {
      out.push(...globSourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}
