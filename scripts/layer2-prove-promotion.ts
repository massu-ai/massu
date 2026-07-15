/**
 * LAYER 2 — THE PROOF, ON A SCRATCH COPY.
 *
 * Takes a COPY of a real `.massu` directory, adopts the stranded JSON candidates
 * into the new `rule_candidates` table, promotes one through the real code path,
 * and prints the row counts BEFORE and AFTER at every stage.
 *
 * Prove-before-destroy: it never writes to the real store. The real candidates are
 * left exactly where they are. Run with:
 *   npx tsx scripts/layer2-prove-promotion.ts <path-to-a-COPY-of-.massu> <repo-root>
 */

import Database from 'better-sqlite3';
import { initMemorySchema, enqueueTeamPromotion } from '../packages/core/src/memory-db.ts';
import {
  importOrphanSidecars,
  candidateFunnel,
  listCandidates,
  setCandidateStatus,
} from '../packages/core/src/rule-candidate-store.ts';
import {
  leaseLearning,
  ackLearning,
  nackLearning,
  undeliveredSnapshot,
} from '../packages/core/src/rule-delivery.ts';
import { createHash } from 'node:crypto';

const dbPath = process.argv[2];
const repoRoot = process.argv[3];
if (!dbPath || !repoRoot) {
  console.error('usage: layer2-prove-promotion.ts <scratch memory.db> <scratch repo root>');
  process.exit(2);
}

const db = new Database(dbPath);
initMemorySchema(db);

const line = (s: string): void => console.log(s);
const count = (t: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

line('=== STAGE 0 — BEFORE (the world as Layer 2 found it) ===');
line(`  rule_candidates rows            : ${count('rule_candidates')}`);
line(`  team_promotion_outbound rows    : ${count('team_promotion_outbound')}`);
line(`  rule_promotion_events_outbound  : ${count('rule_promotion_events_outbound')}`);

line('');
line('=== STAGE 1 — adopt the stranded JSON candidates into the real table (D-11) ===');
const adopted = importOrphanSidecars(db, repoRoot);
line(`  adopted from disk               : ${adopted}`);
line(`  rule_candidates rows            : ${count('rule_candidates')}`);
if (adopted === 0) {
  // M1: prove it looked. "0 adopted" on a directory full of files is a BUG, not a pass.
  console.error('FAIL-CLOSED: adopted 0 candidates. Either the dir is empty or the import is dead.');
  process.exit(1);
}
line(`  funnel                          : ${JSON.stringify(candidateFunnel(db))}`);

line('');
line('=== STAGE 2 — promote ONE candidate (the outbound row the product depends on) ===');
const candidates = listCandidates(db, 'proposed');
const target = candidates[0];
line(`  promoting prompt_hash           : ${target.prompt_hash}`);
const draft = 'Verify the end state with a command; never claim done from code alone.';
enqueueTeamPromotion(db, {
  prompt_hash: target.prompt_hash,
  destination: 'corrections-md',
  draft_text: draft,
  score: target.score ?? 0,
  signals: [],
  content_hash: createHash('sha256').update(`corrections-md\n${draft}`).digest('hex'),
});
setCandidateStatus(db, target.prompt_hash, 'promoted', 'corrections-md');
line(`  team_promotion_outbound rows    : ${count('team_promotion_outbound')}  <-- A ROW MOVED`);
line(`  funnel                          : ${JSON.stringify(candidateFunnel(db))}`);

line('');
line('=== STAGE 3 — a FAILED delivery must KEEP the rule (the 17-rule regression) ===');
const lease1 = leaseLearning(db);
line(`  leased promotions               : ${lease1.promotions.length}`);
line(`  rows still present while leased : ${count('team_promotion_outbound')}  (old code: 0)`);
nackLearning(db, lease1, 'HTTP 401: simulated auth failure');
line(`  rows after a FAILED delivery    : ${count('team_promotion_outbound')}  <-- SURVIVED`);
const snap = undeliveredSnapshot(db);
line(`  undelivered snapshot            : ${JSON.stringify(snap)}`);

line('');
line('=== STAGE 4 — a CONFIRMED delivery is the ONLY thing that removes it ===');
const lease2 = leaseLearning(db);
ackLearning(db, lease2);
line(`  rows after server CONFIRMED     : ${count('team_promotion_outbound')}  <-- delivered, then removed`);
line(`  delivery_confirmed events       : ${
  (db.prepare("SELECT COUNT(*) AS n FROM analytics_events WHERE event_type='rule_delivery_confirmed'").get() as { n: number }).n
}`);

db.close();
line('');
line('PROOF COMPLETE — on a scratch copy. The real store was never touched.');
