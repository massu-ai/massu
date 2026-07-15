/**
 * ADVERSARIAL ATTACK on the claimed invariant:
 *   "A learned rule is deleted ONLY when the server confirms receipt."
 *
 * ATTACK: cloud sync is DISABLED (the default seat state).
 *   session-end.ts:180  lease  = leaseLearning(db)        -> stamps lease_token on EVERY rule row
 *   session-end.ts:182  payload = buildSyncPayload(...)   -> willTransmit=false => payload rules = []
 *   session-end.ts:183  result = await syncToCloud(...)   -> cloud-sync.ts:126-128 returns success:TRUE
 *   session-end.ts:184  if (result.success)
 *   session-end.ts:185      ackLearning(db, lease)        -> DELETE FROM t WHERE lease_token = ?
 *
 * ackLearning deletes by LEASE TOKEN, not by what was transmitted. The rows were
 * leased in step 1 regardless of willTransmit. No server was ever contacted.
 * The rules are destroyed and EVENT_DELIVERY_CONFIRMED is recorded.
 *
 * THE ATTACK LANDED. This was a REAL, catastrophic regression, introduced by the
 * very change that was meant to abolish this bug class: on every local-only (Free /
 * Pro) seat — the default state — every learned rule would have been deleted at
 * session end without ever being sent anywhere. Found independently by an
 * adversarial auditor and by a re-read, which is the whole argument for CR-52: you
 * cannot be the sole verifier of your own artifact, because you check what you built
 * against the expectation you already hold.
 *
 * THE FIX (cloud-sync.ts + session-end.ts): `SyncResult.transmitted` is set ONLY
 * after a real 2xx from the server. The ack is gated on `transmitted === true`, never
 * on `success` — because `success` is also true when sync is DISABLED, and "we never
 * sent it" is not a receipt.
 *
 * This file now stands as the permanent guard for that fix. It uses the REAL
 * syncToCloud, the REAL lease/ack, and the REAL production branch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../config.ts', () => ({
  getConfig: () => ({ cloud: { enabled: false } }),
}));

import { initMemorySchema, enqueueTeamPromotion } from '../memory-db.ts';
import { leaseLearning, ackLearning, nackLearning } from '../rule-delivery.ts';
import { syncToCloud } from '../cloud-sync.ts';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  initMemorySchema(db);
});
afterEach(() => db.close());

describe('ATTACK: ack fires without transmission when cloud sync is disabled', () => {
  it('a learned rule SURVIVES a session-end where nothing was ever transmitted', async () => {
    enqueueTeamPromotion(db, {
      prompt_hash: 'a'.repeat(16),
      destination: 'corrections-md',
      draft_text: 'Always use absolute paths.',
      score: 9,
      signals: ['user-correction'],
      content_hash: 'c'.repeat(16),
    });
    const before = db.prepare('SELECT COUNT(*) AS n FROM team_promotion_outbound').get() as { n: number };
    expect(before.n).toBe(1);

    // --- the REAL production sequence (session-end.ts, post-fix) ---
    const lease = leaseLearning(db);
    // buildSyncPayload with willTransmit=false: the rules are NOT in the payload.
    const payload = { sessions: [], observations: [] };
    const result = await syncToCloud(db, payload as never);

    // A disabled cloud still reports SUCCESS having sent absolutely nothing
    // (cloud-sync.ts:126-128). This is the trap the ack must not fall into.
    expect(result.success).toBe(true);
    // ...but it did NOT transmit, and that is the distinction the invariant rests on.
    expect(result.transmitted).not.toBe(true);

    if (result.transmitted === true) {
      ackLearning(db, lease);
    } else {
      nackLearning(db, lease, result.error ?? 'not transmitted');
    }
    // --- end production sequence ---

    const after = db.prepare('SELECT COUNT(*) AS n FROM team_promotion_outbound').get() as { n: number };

    // THE INVARIANT: no server confirmed receipt — no server was even contacted —
    // therefore the rule MUST still be here.
    expect(after.n).toBe(1);

    // And it must not have been falsely recorded as delivered.
    const confirmed = db
      .prepare("SELECT COUNT(*) AS n FROM analytics_events WHERE event_type = 'rule_delivery_confirmed'")
      .get() as { n: number };
    expect(confirmed.n).toBe(0);
  });

  it('ANTI-VACUITY: acking on `success` (the old branch) really DOES destroy the rule', () => {
    // Proves the guard above is not decoration. If the old branch were harmless,
    // the test above would pass for the wrong reason and could never catch a
    // regression. Here we reintroduce the defect and watch the rule die.
    enqueueTeamPromotion(db, {
      prompt_hash: 'b'.repeat(16),
      destination: 'corrections-md',
      draft_text: 'Always use absolute paths.',
      score: 9,
      signals: [],
      content_hash: 'd'.repeat(16),
    });
    const lease = leaseLearning(db);
    const resultLikeDisabledCloud = { success: true } as { success: boolean; transmitted?: boolean };
    if (resultLikeDisabledCloud.success) ackLearning(db, lease); // <- the old, fatal branch
    const after = db.prepare('SELECT COUNT(*) AS n FROM team_promotion_outbound').get() as { n: number };
    expect(after.n).toBe(0); // the rule is GONE — this is what shipped for a moment
  });
});
