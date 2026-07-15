// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// P3-001 (plan-2026-06-01-auto-learning-analytics-dashboard): unit tests for the
// promotion-funnel outbound store (enqueue/drain) + the P1-002a recurrence_count
// mapping (getRecurrenceCountForPromptHash). The mapping is the CR-39 effectiveness
// data path: a wrong key would silently send `null` for EVERY rule and break the
// dashboard's effectiveness table with nothing catching it — so it is tested at its
// source (buildSyncPayload is thin glue over getRecurrenceCountForPromptHash).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initMemorySchema,
  createSession,
  enqueueRulePromotionEvent,
  getRecurrenceCountForPromptHash,
} from '../memory-db.ts';
import { leaseLearning, ackLearning, nackLearning } from '../rule-delivery.ts';
import { logAuditEntry } from '../audit-trail.ts';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initMemorySchema(db);
});

afterEach(() => {
  db.close();
});

const HASH = 'a'.repeat(16);

// Layer 2: `drainRulePromotionEvents` (SELECT-then-DELETE) is GONE. Reading no
// longer destroys. These tests now pin the lease/ack contract that replaced it.
describe('rule_promotion_events outbound store (P1-002) — lease/ack', () => {
  it('lease → ack round-trips append-only events in order, with metadata', () => {
    enqueueRulePromotionEvent(db, { prompt_hash: HASH, event_type: 'proposed', created_at: '2026-06-01T00:00:00.000Z', metadata: { score: 7 } });
    enqueueRulePromotionEvent(db, { prompt_hash: HASH, event_type: 'shown', created_at: '2026-06-01T00:00:01.000Z' });
    enqueueRulePromotionEvent(db, { prompt_hash: HASH, event_type: 'approved', created_at: '2026-06-01T00:00:02.000Z', metadata: { destination: 'corrections-md' } });

    const lease = leaseLearning(db);
    expect(lease.events.map((e) => e.event_type)).toEqual(['proposed', 'shown', 'approved']);
    expect(lease.events[0].metadata).toEqual({ score: 7 });
    expect(lease.events[1].metadata).toEqual({});
    expect(lease.events[2].prompt_hash).toBe(HASH);
  });

  it('is append-only: the SAME (prompt_hash, event_type) can repeat', () => {
    enqueueRulePromotionEvent(db, { prompt_hash: HASH, event_type: 'shown', created_at: '2026-06-01T00:00:00.000Z' });
    enqueueRulePromotionEvent(db, { prompt_hash: HASH, event_type: 'shown', created_at: '2026-06-01T00:00:05.000Z' });
    expect(leaseLearning(db).events.length).toBe(2);
  });

  it('A LEASE DOES NOT DELETE — the row survives until the server confirms it', () => {
    enqueueRulePromotionEvent(db, { prompt_hash: HASH, event_type: 'proposed', created_at: '2026-06-01T00:00:00.000Z' });
    const lease = leaseLearning(db);
    expect(lease.events.length).toBe(1);
    // The old drain deleted here. Nothing may be gone until ack.
    const still = db.prepare('SELECT COUNT(*) AS n FROM rule_promotion_events_outbound').get() as { n: number };
    expect(still.n).toBe(1);
    ackLearning(db, lease);
    const after = db.prepare('SELECT COUNT(*) AS n FROM rule_promotion_events_outbound').get() as { n: number };
    expect(after.n).toBe(0);
  });

  it('THE REGRESSION THAT KILLED 17 RULES: a failed delivery must KEEP the row', () => {
    enqueueRulePromotionEvent(db, { prompt_hash: HASH, event_type: 'proposed', created_at: '2026-06-01T00:00:00.000Z' });
    const lease = leaseLearning(db);
    nackLearning(db, lease, 'HTTP 401: ');
    const row = db
      .prepare('SELECT COUNT(*) AS n, MAX(attempts) AS a FROM rule_promotion_events_outbound')
      .get() as { n: number; a: number };
    expect(row.n).toBe(1);   // survived a failure
    expect(row.a).toBe(1);   // and counted the attempt
    // ...and it is claimable again on the next session.
    expect(leaseLearning(db).events.length).toBe(1);
  });

  it('empty store leases to []', () => {
    expect(leaseLearning(db).events).toEqual([]);
  });
});

describe('getRecurrenceCountForPromptHash — P1-002a CR-39 mapping', () => {
  function seedPromotedAudit(promptHash: string, recurrenceCount: number): void {
    createSession(db, 'sess-1');
    logAuditEntry(db, {
      eventType: 'rule_promoted',
      actor: 'human',
      sessionId: 'sess-1',
      metadata: { prompt_hash: promptHash, score: 90, recurrence_count: recurrenceCount },
    });
  }

  it('returns N when a rule_promoted row exists for the prompt_hash', () => {
    seedPromotedAudit(HASH, 3);
    expect(getRecurrenceCountForPromptHash(db, HASH)).toBe(3);
  });

  it('returns 0 (NOT null) when the rule is effective (recurrence_count = 0)', () => {
    seedPromotedAudit(HASH, 0);
    expect(getRecurrenceCountForPromptHash(db, HASH)).toBe(0);
  });

  it('returns null when NO rule_promoted row exists — so the synced column stays NULL, not a fake 0', () => {
    // No audit row seeded at all.
    expect(getRecurrenceCountForPromptHash(db, HASH)).toBeNull();
  });

  it('returns null for a DIFFERENT prompt_hash (the join must not leak across rules)', () => {
    seedPromotedAudit(HASH, 5);
    expect(getRecurrenceCountForPromptHash(db, 'b'.repeat(16))).toBeNull();
  });
});
