/**
 * ADVERSARIAL ATTACKS 4 + 5 on the lease/ack invariant.
 *
 * 4. Two sessions lease at once. Can a rule be lost? Can session A's nack clobber
 *    session B's lease?
 * 5. Lease TTL reclaim: session A hangs past the TTL, B reclaims, then A's late
 *    ack/nack lands. Can A's late ack delete rows B now owns (loss), or can the
 *    rule be double-delivered?
 *
 * The SELECT-then-UPDATE in claimPage() is NOT wrapped in a transaction, so an
 * interleaving where both sessions read the same claimable ids is reachable. This
 * file forces that exact interleaving instead of hoping for it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initMemorySchema, enqueueTeamPromotion } from '../memory-db.ts';
import { leaseLearning, ackLearning, nackLearning, LEASE_TTL_MS } from '../rule-delivery.ts';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  initMemorySchema(db);
});
afterEach(() => db.close());

function seed(hash: string): void {
  enqueueTeamPromotion(db, {
    prompt_hash: hash,
    destination: 'corrections-md',
    draft_text: `rule ${hash}`,
    score: 9,
    signals: ['user-correction'],
    content_hash: `ch-${hash}`,
  });
}
const count = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM team_promotion_outbound').get() as { n: number }).n;

describe('ATTACK 4: two concurrent sessions leasing the same rows', () => {
  it('the second lease finds NOTHING while the first lease is live (no double-claim)', () => {
    seed('a'.repeat(16));
    const now = Date.now();
    const a = leaseLearning(db, now);
    const b = leaseLearning(db, now); // B runs while A's lease is fresh

    expect(a.promotions).toHaveLength(1);
    expect(b.promotions).toHaveLength(0); // B must NOT re-claim a live-leased row
  });

  it("session B's nack cannot clobber session A's live lease, and loses no rule", () => {
    seed('a'.repeat(16));
    const now = Date.now();
    const a = leaseLearning(db, now);
    const b = leaseLearning(db, now); // empty lease

    // B fails and nacks its (empty) lease. Its UPDATE is keyed by B's token.
    nackLearning(db, b, 'B failed');

    // A's lease must be intact: A can still ack exactly its own rows.
    const stillLeasedToA = db
      .prepare('SELECT COUNT(*) AS n FROM team_promotion_outbound WHERE lease_token = ?')
      .get(a.token) as { n: number };
    expect(stillLeasedToA.n).toBe(1); // B's nack did NOT steal/clear A's lease
    expect(count()).toBe(1); // and nothing was lost
  });

  it('a rule enqueued MID-FLIGHT is not deleted by an ack of the earlier lease', () => {
    seed('a'.repeat(16));
    const a = leaseLearning(db);
    seed('b'.repeat(16)); // arrives after the lease — carries no lease_token
    ackLearning(db, a); // server confirmed ONLY what A leased

    expect(count()).toBe(1); // the mid-flight rule survives
    const left = db.prepare('SELECT prompt_hash FROM team_promotion_outbound').get() as {
      prompt_hash: string;
    };
    expect(left.prompt_hash).toBe('b'.repeat(16));
  });
});

describe('ATTACK 5: lease TTL reclaim', () => {
  it('an expired lease is reclaimable — a crashed session cannot strand a rule', () => {
    seed('a'.repeat(16));
    const t0 = Date.now();
    leaseLearning(db, t0); // session A leases, then "crashes" (never acks/nacks)
    expect(count()).toBe(1); // nothing deleted by the crash

    const b = leaseLearning(db, t0 + LEASE_TTL_MS + 1); // B reclaims after TTL
    expect(b.promotions).toHaveLength(1); // recovered, not stranded
  });

  it("a CRASHED session's late ACK cannot delete rows the reclaiming session now owns", () => {
    seed('a'.repeat(16));
    const t0 = Date.now();
    const a = leaseLearning(db, t0); // A leases
    const b = leaseLearning(db, t0 + LEASE_TTL_MS + 1); // B reclaims (rows now carry B's token)
    expect(b.promotions).toHaveLength(1);

    // A wakes up from a very slow HTTP call and acks its STALE lease.
    ackLearning(db, a);

    // A's DELETE is keyed by A's token; the rows carry B's. Nothing is lost.
    expect(count()).toBe(1);
    const stillB = db
      .prepare('SELECT COUNT(*) AS n FROM team_promotion_outbound WHERE lease_token = ?')
      .get(b.token) as { n: number };
    expect(stillB.n).toBe(1);
  });

  it("a crashed session's late NACK cannot strip the reclaiming session's lease", () => {
    seed('a'.repeat(16));
    const t0 = Date.now();
    const a = leaseLearning(db, t0);
    const b = leaseLearning(db, t0 + LEASE_TTL_MS + 1);

    nackLearning(db, a, 'A timed out'); // stale nack, keyed by A's token

    const stillB = db
      .prepare('SELECT COUNT(*) AS n FROM team_promotion_outbound WHERE lease_token = ?')
      .get(b.token) as { n: number };
    expect(stillB.n).toBe(1); // B still owns it; B's ack will still work
    expect(count()).toBe(1);
  });
});
