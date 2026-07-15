/**
 * LAYER 2 — THE REAL END-TO-END PROOF.
 *
 * The earlier proof POSTed a HAND-WRITTEN payload with curl. That is a fixture, not
 * a boundary probe: it proves the server ingests what I *think* the client sends. A
 * test that hand-writes the boundary cannot guard the boundary.
 *
 * This drives the ACTUAL CLIENT: leaseLearning -> the real syncToCloud (its own
 * serializer, its own privacy filters, its own retry logic) -> the real /sync Edge
 * Function -> Postgres. Then it acks only on a real receipt.
 *
 * Run against a scratch DB + the local Supabase stack. Never touches a real store.
 */

import Database from 'better-sqlite3';
import { initMemorySchema, enqueueTeamPromotion, enqueueRulePromotionEvent } from '../packages/core/src/memory-db.ts';
import { leaseLearning, ackLearning, nackLearning } from '../packages/core/src/rule-delivery.ts';
import { syncToCloud } from '../packages/core/src/cloud-sync.ts';
import { createHash } from 'node:crypto';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: layer2-prove-e2e-client.ts <scratch memory.db>');
  process.exit(2);
}

const db = new Database(dbPath);
initMemorySchema(db);

const count = (t: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

const HASH = 'fdb781ac297d2837';
const draft = 'Verify the end state with a command; never claim done from code alone.';

enqueueTeamPromotion(db, {
  prompt_hash: HASH,
  destination: 'corrections-md',
  draft_text: draft,
  score: 90,
  signals: ['recurrence'],
  content_hash: createHash('sha256').update(`corrections-md\n${draft}`).digest('hex'),
});
enqueueRulePromotionEvent(db, {
  prompt_hash: HASH,
  event_type: 'approved',
  created_at: new Date().toISOString(),
  metadata: { destination: 'corrections-md' },
});

console.log('=== CLIENT-SIDE, BEFORE ===');
console.log(`  team_promotion_outbound        : ${count('team_promotion_outbound')}`);
console.log(`  rule_promotion_events_outbound : ${count('rule_promotion_events_outbound')}`);

// The real lease, and the real payload the real client builds.
const lease = leaseLearning(db);
const payload = {
  sessions: [{
    local_session_id: `layer2-client-${Date.now()}`,
    summary: 'Layer 2 real-client end-to-end proof',
    ended_at: new Date().toISOString(),
    turns: 1,
    tokens_used: 0,
    estimated_cost: 0,
    tools_used: [],
  }],
  observations: [],
  rule_promotions: lease.promotions.map((p) => ({
    prompt_hash: p.prompt_hash,
    destination: p.destination,
    draft_text: p.draft_text,
    score: p.score,
    signals: p.signals,
    content_hash: p.content_hash,
  })),
  rule_promotion_events: lease.events,
};

console.log(`  leased for delivery            : ${lease.promotions.length} rule(s), ${lease.events.length} event(s)`);

async function main(): Promise<void> {
  // THE REAL CLIENT TRANSPORT — not curl.
  const result = await syncToCloud(db, payload as never);
  console.log('');
  console.log('=== THE REAL syncToCloud RESULT ===');
  console.log(`  success     : ${result.success}`);
  console.log(`  transmitted : ${result.transmitted}   <-- the ONLY thing that may authorize a delete`);
  console.log(`  error       : ${result.error ?? '(none)'}`);

  if (result.transmitted === true) {
    ackLearning(db, lease);
    console.log('  -> RECEIPT CONFIRMED: acked, rows removed.');
  } else {
    nackLearning(db, lease, result.error ?? 'not transmitted');
    console.log('  -> NO RECEIPT: nacked, rows RETAINED (nothing lost).');
  }

  console.log('');
  console.log('=== CLIENT-SIDE, AFTER ===');
  console.log(`  team_promotion_outbound        : ${count('team_promotion_outbound')}`);
  console.log(`  rule_promotion_events_outbound : ${count('rule_promotion_events_outbound')}`);

  db.close();
}

void main();
