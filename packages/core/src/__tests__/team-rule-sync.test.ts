// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PB-009 (plan-2026-05-28-team-shared-rule-promotion): tests for the client PULL
 * path `pullTeamPromotions`. Covers the tier gate, signature verification, org
 * match, the H1 destination allowlist, H3 revocation, T4 dedup, H2 monotonic
 * cursor, and the materialize-NOT-apply invariant. The promotion pubkey is
 * mocked with an ephemeral key so valid envelopes can be produced.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createPrivateKey, sign as nodeSign } from 'crypto';
import Database from 'better-sqlite3';

const testKey = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { generateKeyPairSync, createHash } = require('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki: Buffer = publicKey.export({ format: 'der', type: 'spki' });
  const rawPub: Buffer = spki.subarray(spki.length - 32);
  const fp: string = createHash('sha256').update(rawPub).digest('hex');
  return {
    rawPub: Array.from(rawPub) as number[],
    fp,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
  };
});

vi.mock('../security/promotion-pubkey.generated.ts', () => ({
  PROMOTION_PUBKEY_ED25519: new Uint8Array(testKey.rawPub),
  PROMOTION_PUBKEY_FINGERPRINT_HEX: testKey.fp,
  KNOWN_PROMOTION_PUBKEY_FINGERPRINTS: new Set([testKey.fp]),
}));

import { initMemorySchema } from '../memory-db.ts';
import { pullTeamPromotions } from '../team-rule-sync.ts';

interface WirePromo {
  prompt_hash: string;
  destination: string;
  draft_text: string;
  score?: number;
  signals?: unknown[];
  promoted_by: string;
  promoted_at: string;
  seq: number;
  revoked_at?: string | null;
}

function signEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(payload).filter((k) => !k.startsWith('_')).sort();
  const canonicalObj: Record<string, unknown> = {};
  for (const k of keys) canonicalObj[k] = payload[k];
  const canonical = JSON.stringify(canonicalObj, keys);
  const sig = nodeSign(null, Buffer.from(canonical, 'utf-8'), createPrivateKey(testKey.privateKeyPem));
  return {
    ...payload,
    _signature: sig.toString('base64'),
    _signature_alg: 'ed25519',
    _signature_payload_keys: keys,
    _signature_pubkey_fingerprint: testKey.fp,
  };
}

function envelopeFor(orgId: string, promos: WirePromo[]): Record<string, unknown> {
  const cursor = promos.reduce((m, p) => Math.max(m, p.seq), 0);
  return signEnvelope({ orgId, cursor, promotions_json: JSON.stringify(promos) });
}

function promo(over: Partial<WirePromo> = {}): WirePromo {
  return {
    prompt_hash: 'a'.repeat(16),
    destination: 'corrections-md',
    draft_text: 'always prefer getConfig()',
    score: 70,
    signals: [{ name: 'strong_correction_phrase', baseWeight: 40, applied: 40 }],
    promoted_by: 'u2',
    promoted_at: '2026-05-31T00:00:00Z',
    seq: 5,
    revoked_at: null,
    ...over,
  };
}

let db: Database.Database;
let projectRoot: string;
const ORG = 'org-1';
const BASE = { tier: 'team' as const, orgId: ORG, endpoint: 'https://cloud.test', apiKey: 'ms_live_x' };

function fakeFetch(envelope: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => envelope })) as unknown as typeof fetch;
}

function sidecar(hash: string): string {
  return join(projectRoot, '.massu', 'rule-candidates', `${hash}.json`);
}
function cursorVal(): string | null {
  const row = db.prepare("SELECT value FROM memory_meta WHERE key='team_promotions_cursor'").get() as { value: string } | undefined;
  return row ? row.value : null;
}
function sharedObsCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM shared_observations').get() as { n: number }).n;
}
function auditPromotedCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type='rule_promoted'").get() as { n: number }).n;
}
function telemetryCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM analytics_events WHERE event_type LIKE 'team_promotion%'").get() as { n: number }).n;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'massu-trs-'));
  mkdirSync(join(projectRoot, '.massu', 'rule-candidates'), { recursive: true });
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initMemorySchema(db);
});

afterEach(() => {
  db.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('pullTeamPromotions — gate', () => {
  it('Free/Pro seats no-op without touching the network', async () => {
    const spy = vi.fn(fakeFetch(envelopeFor(ORG, [promo()])));
    const resFree = await pullTeamPromotions(db, { ...BASE, tier: 'free', fetchImpl: spy as unknown as typeof fetch, projectRoot });
    const resPro = await pullTeamPromotions(db, { ...BASE, tier: 'pro', fetchImpl: spy as unknown as typeof fetch, projectRoot });
    expect(resFree.materialized).toBe(0);
    expect(resPro.materialized).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('pullTeamPromotions — materialize (NOT apply)', () => {
  it('Team: a verified envelope materializes a provenance-tagged candidate + shared_observations row, applies nothing', async () => {
    const res = await pullTeamPromotions(db, { ...BASE, fetchImpl: fakeFetch(envelopeFor(ORG, [promo()])), projectRoot });
    expect(res.materialized).toBe(1);
    expect(res.pulled).toBe(1);

    const path = sidecar('a'.repeat(16));
    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf-8'));
    expect(written.provenance.origin).toBe('team');
    expect(written.provenance.signature_verified).toBe(true);
    expect(written.provenance.org_id).toBe(ORG);
    expect(written.destination).toBe('corrections-md');
    expect(written.draft_text).toBe('always prefer getConfig()');

    // materialize ≠ apply: no destination edit, no rule_promoted audit row.
    expect(auditPromotedCount()).toBe(0);
    expect(sharedObsCount()).toBe(1);
    // H2: cursor advanced to the max seq.
    expect(cursorVal()).toBe('5');
  });
});

describe('pullTeamPromotions — drops', () => {
  it('an invalid signature drops the whole response with telemetry, cursor unchanged', async () => {
    const bad = envelopeFor(ORG, [promo()]);
    (bad as Record<string, unknown>).promotions_json = JSON.stringify([promo({ draft_text: 'TAMPERED' })]);
    const res = await pullTeamPromotions(db, { ...BASE, fetchImpl: fakeFetch(bad), projectRoot });
    expect(res.materialized).toBe(0);
    expect(res.dropped_unverified).toBeGreaterThan(0);
    expect(telemetryCount()).toBeGreaterThan(0);
    expect(cursorVal()).toBeNull();
    expect(existsSync(sidecar('a'.repeat(16)))).toBe(false);
  });

  it('a wrong-org envelope is dropped', async () => {
    const res = await pullTeamPromotions(db, { ...BASE, fetchImpl: fakeFetch(envelopeFor('org-OTHER', [promo()])), projectRoot });
    expect(res.materialized).toBe(0);
    expect(res.dropped_unverified).toBeGreaterThan(0);
    expect(existsSync(sidecar('a'.repeat(16)))).toBe(false);
  });

  it('(H1) a non-shareable destination is dropped as dropped_nonshareable, never materialized', async () => {
    const envelope = envelopeFor(ORG, [
      promo({ prompt_hash: 'b'.repeat(16), destination: 'pattern-scanner' }),
      promo({ prompt_hash: 'c'.repeat(16), destination: 'custom-destination' }),
      promo({ prompt_hash: 'd'.repeat(16), destination: 'corrections-md' }),
    ]);
    const res = await pullTeamPromotions(db, { ...BASE, fetchImpl: fakeFetch(envelope), projectRoot });
    expect(res.dropped_nonshareable).toBe(2);
    expect(res.materialized).toBe(1);
    expect(existsSync(sidecar('b'.repeat(16)))).toBe(false);
    expect(existsSync(sidecar('c'.repeat(16)))).toBe(false);
    expect(existsSync(sidecar('d'.repeat(16)))).toBe(true);
  });
});

describe('pullTeamPromotions — revocation (H3) + dedup (T4) + cursor (H2)', () => {
  it('(H3) a revoked promotion deletes a pending sidecar', async () => {
    // First materialize, then pull a revocation for the same hash.
    await pullTeamPromotions(db, { ...BASE, fetchImpl: fakeFetch(envelopeFor(ORG, [promo({ seq: 5 })])), projectRoot });
    expect(existsSync(sidecar('a'.repeat(16)))).toBe(true);

    const rev = envelopeFor(ORG, [promo({ seq: 6, revoked_at: '2026-05-31T01:00:00Z' })]);
    const res = await pullTeamPromotions(db, { ...BASE, fetchImpl: fakeFetch(rev), projectRoot });
    expect(res.revoked_handled).toBe(1);
    expect(existsSync(sidecar('a'.repeat(16)))).toBe(false);
    expect(cursorVal()).toBe('6');
  });

  it('(T4) a duplicate prompt_hash (sidecar already present) is skipped', async () => {
    // Pre-place a sidecar for the hash.
    writeFileSync(sidecar('a'.repeat(16)), JSON.stringify({ prompt_hash: 'a'.repeat(16) }), 'utf-8');
    const res = await pullTeamPromotions(db, { ...BASE, fetchImpl: fakeFetch(envelopeFor(ORG, [promo()])), projectRoot });
    expect(res.skipped).toBe(1);
    expect(res.materialized).toBe(0);
  });

  it('(H2) interleaved seq ordering loses no row and advances the cursor to the max seq', async () => {
    const envelope = envelopeFor(ORG, [
      promo({ prompt_hash: 'b'.repeat(16), seq: 7 }),
      promo({ prompt_hash: 'c'.repeat(16), seq: 3 }),
      promo({ prompt_hash: 'd'.repeat(16), seq: 5 }),
    ]);
    const res = await pullTeamPromotions(db, { ...BASE, fetchImpl: fakeFetch(envelope), projectRoot });
    expect(res.materialized).toBe(3);
    expect(cursorVal()).toBe('7');
  });

  it('passes the stored cursor as the ?since= query parameter', async () => {
    db.prepare("INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('team_promotions_cursor','42')").run();
    let seenUrl = '';
    const capture = (async (url: string) => {
      seenUrl = url;
      return { ok: true, json: async () => envelopeFor(ORG, []) };
    }) as unknown as typeof fetch;
    await pullTeamPromotions(db, { ...BASE, fetchImpl: capture, projectRoot });
    expect(seenUrl).toContain('since=42');
  });
});
