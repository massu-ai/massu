// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P2-002 (plan-2026-06-01-curated-rule-packs): tests for the client PULL path
 * `pullInstalledPackRules`. Covers the tier gate, signature verification, org
 * match, the unsigned-field defense, per-rule schema validation, T4 dedup, the
 * hardened (executable-destination) flag, the `pack_slug`/`pack_version`
 * provenance, and the materialize-NOT-apply invariant. The promotion pubkey is
 * mocked with an ephemeral key so valid envelopes can be produced — identical
 * scheme to `team-rule-sync.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createPrivateKey, sign as nodeSign } from 'crypto';
import Database from 'better-sqlite3';
import { resetConfig } from '../config.ts';

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
import { pullInstalledPackRules } from '../rule-pack-sync.ts';

interface PackRuleSeed {
  title: string;
  description: string;
  destination: string;
  severity: string;
  rule_type?: string;
  pattern?: string;
  check?: string;
}
interface PackSeed {
  pack_id: string;
  slug: string;
  name: string;
  installed_version: string;
  current_version: string;
  update_available?: boolean;
  auto_update?: boolean;
  installed_at?: string;
  rules: PackRuleSeed[];
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

function envelopeFor(orgId: string, packs: PackSeed[]): Record<string, unknown> {
  return signEnvelope({
    orgId,
    pack_count: packs.length,
    updates_only: false,
    packs_json: JSON.stringify(packs),
  });
}

function rule(over: Partial<PackRuleSeed> = {}): PackRuleSeed {
  return {
    title: 'Always use getConfig',
    description: 'Read config via getConfig() never parse YAML directly',
    destination: 'corrections-md',
    severity: 'medium',
    ...over,
  };
}

function pack(over: Partial<PackSeed> = {}): PackSeed {
  return {
    pack_id: 'pk_1',
    slug: 'massu-core-conventions',
    name: 'Massu Core Conventions',
    installed_version: '1.0.0',
    current_version: '1.2.0',
    update_available: true,
    auto_update: false,
    installed_at: '2026-05-30T00:00:00Z',
    rules: [rule()],
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

function candidateDir(): string {
  return join(projectRoot, '.massu', 'rule-candidates');
}
function listCandidates(): Record<string, unknown>[] {
  const dir = candidateDir();
  if (!existsSync(dir)) return [];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readdirSync } = require('node:fs');
  return (readdirSync(dir) as string[])
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}
function auditPromotedCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type='rule_promoted'").get() as { n: number }).n;
}
function telemetryCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM analytics_events WHERE event_type LIKE 'pack_rules%'").get() as { n: number }).n;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'massu-rps-'));
  mkdirSync(candidateDir(), { recursive: true });
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initMemorySchema(db);
});

afterEach(() => {
  db.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('pullInstalledPackRules — tier gate', () => {
  it('Free/Pro seats no-op without touching the network', async () => {
    const spy = vi.fn(fakeFetch(envelopeFor(ORG, [pack()])));
    const resFree = await pullInstalledPackRules(db, { ...BASE, tier: 'free', fetchImpl: spy as unknown as typeof fetch, projectRoot });
    const resPro = await pullInstalledPackRules(db, { ...BASE, tier: 'pro', fetchImpl: spy as unknown as typeof fetch, projectRoot });
    expect(resFree.materialized).toBe(0);
    expect(resPro.materialized).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('no endpoint / apiKey → no-op', async () => {
    // ⚠️ THIS TEST WAS MAKING A LIVE NETWORK CALL TO PRODUCTION — and it PASSED ONLY
    // BECAUSE THE ENDPOINT WAS BROKEN.
    //
    // It passes no `fetchImpl`, so it used the real `fetch`. It resolves no `apiKey`,
    // so on CI it correctly no-op'd — but on a DEVELOPER'S machine, CR-59 resolves a
    // real key from `~/.massu/credentials`, and `rule-pack-sync.ts:139` only bails when
    // BOTH endpoint and key are absent. The endpoint always resolves (DEFAULT_CLOUD_ENDPOINT).
    // So on a real machine this "unit test" hit `api.massu.ai/v1/installed-rules` with the
    // operator's live API key — and got a 404, because that route was never routed (E-1).
    // `!res.ok -> return ZERO` turned the 404 into the exact zeros this test asserts.
    //
    // The moment E-1 was fixed and the endpoint answered 401 instead of 404, this test
    // went red. **It was green because the feature was dead.** That is this entire bug
    // class in a single test case.
    //
    // Made HERMETIC: a temp HOME so no user-level credential leaks in, and a fetchImpl
    // that FAILS THE TEST if it is called at all — which is what "no-op" actually means.
    const isolatedHome = mkdtempSync(join(tmpdir(), 'massu-nohome-'));
    const realHome = process.env.HOME;
    const realKey = process.env.MASSU_API_KEY;
    process.env.HOME = isolatedHome;
    delete process.env.MASSU_API_KEY;
    // The config is a CACHED module singleton, so redirecting HOME is NOT enough — the
    // real key had already been resolved and memoized. Without this reset, the test still
    // shipped the developer's LIVE `ms_live_...` production key to api.massu.ai. Verified
    // by watching it appear in the outbound Authorization header.
    resetConfig();
    try {
      const fetchSpy = vi.fn(async () => {
        throw new Error(
          'NETWORK CALL ATTEMPTED with no API key configured. "No-op" means NO REQUEST.',
        );
      });
      const res = await pullInstalledPackRules(db, {
        tier: 'team',
        orgId: ORG,
        projectRoot,
        apiKey: undefined,
        endpoint: undefined,
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      expect(res).toEqual({ pulled: 0, materialized: 0, skipped: 0, dropped_unverified: 0 });
      expect(fetchSpy, 'a no-op must not touch the network').not.toHaveBeenCalled();
    } finally {
      if (realHome !== undefined) process.env.HOME = realHome;
      if (realKey !== undefined) process.env.MASSU_API_KEY = realKey;
      resetConfig();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});

describe('pullInstalledPackRules — materialize (NOT apply)', () => {
  it('Team: a verified envelope materializes a provenance-tagged pack candidate, applies nothing', async () => {
    const res = await pullInstalledPackRules(db, { ...BASE, fetchImpl: fakeFetch(envelopeFor(ORG, [pack()])), projectRoot });
    expect(res.materialized).toBe(1);
    expect(res.pulled).toBe(1);

    const written = listCandidates();
    expect(written).toHaveLength(1);
    const c = written[0] as Record<string, any>;
    expect(c.provenance.origin).toBe('pack');
    expect(c.provenance.signature_verified).toBe(true);
    expect(c.provenance.org_id).toBe(ORG);
    expect(c.provenance.pack_slug).toBe('massu-core-conventions');
    expect(c.provenance.pack_version).toBe('1.2.0');
    expect(c.provenance.promoted_by).toBe('pack:massu-core-conventions');
    expect(c.provenance.hardened).toBeUndefined(); // corrections-md is NOT hardened
    expect(c.destination).toBe('corrections-md');
    expect(/^[a-f0-9]{16}$/.test(c.prompt_hash)).toBe(true);

    // materialize ≠ apply: no rule_promoted audit row.
    expect(auditPromotedCount()).toBe(0);
  });

  it('an executable-destination pack rule materializes as hardened-pending (provenance.hardened===true)', async () => {
    const p = pack({
      rules: [rule({ destination: 'pattern-scanner', pattern: 'grep -rn "TODO" src/', title: 'No TODOs' })],
    });
    const res = await pullInstalledPackRules(db, { ...BASE, fetchImpl: fakeFetch(envelopeFor(ORG, [p])), projectRoot });
    expect(res.materialized).toBe(1);
    const c = listCandidates()[0] as Record<string, any>;
    expect(c.provenance.hardened).toBe(true);
    expect(c.destination).toBe('pattern-scanner');
    expect(c.draft_text).toBe('grep -rn "TODO" src/');
  });

  it('skips schema-invalid pack rules and counts them', async () => {
    const p = pack({
      rules: [
        rule(), // valid
        rule({ destination: 'unknown-dest' }), // invalid destination
        rule({ destination: 'pattern-scanner', pattern: undefined, check: undefined, title: 'inert' }), // inert
      ],
    });
    const res = await pullInstalledPackRules(db, { ...BASE, fetchImpl: fakeFetch(envelopeFor(ORG, [p])), projectRoot });
    expect(res.materialized).toBe(1);
    expect(res.skipped).toBe(2);
  });
});

describe('pullInstalledPackRules — drops', () => {
  it('an invalid signature drops the whole response with telemetry', async () => {
    const bad = envelopeFor(ORG, [pack()]);
    (bad as Record<string, unknown>).packs_json = JSON.stringify([pack({ slug: 'TAMPERED' })]);
    const res = await pullInstalledPackRules(db, { ...BASE, fetchImpl: fakeFetch(bad), projectRoot });
    expect(res.materialized).toBe(0);
    expect(res.dropped_unverified).toBeGreaterThan(0);
    expect(telemetryCount()).toBeGreaterThan(0);
    expect(listCandidates()).toHaveLength(0);
  });

  it('a wrong-org envelope is dropped', async () => {
    const res = await pullInstalledPackRules(db, { ...BASE, fetchImpl: fakeFetch(envelopeFor('org-OTHER', [pack()])), projectRoot });
    expect(res.materialized).toBe(0);
    expect(res.dropped_unverified).toBeGreaterThan(0);
    expect(listCandidates()).toHaveLength(0);
  });

  it('a non-ok HTTP response FAILS loudly — distinct from an empty pull (BND-3)', async () => {
    const res = await pullInstalledPackRules(db, { ...BASE, fetchImpl: fakeFetch(envelopeFor(ORG, [pack()]), false), projectRoot });
    // No rules were pulled...
    expect(res.pulled).toBe(0);
    expect(res.materialized).toBe(0);
    // ...but the failure must NOT be byte-identical to "nothing to sync":
    // sync_error is set so callers / outcome-watchers can distinguish the two.
    expect(res.sync_error).toBeDefined();
    expect(res.sync_error).toMatch(/^http_/);
  });
});

describe('pullInstalledPackRules — dedup (T4)', () => {
  it('re-pulling the same pack rule is skipped (stable prompt_hash → existing sidecar)', async () => {
    const env = envelopeFor(ORG, [pack()]);
    const first = await pullInstalledPackRules(db, { ...BASE, fetchImpl: fakeFetch(env), projectRoot });
    expect(first.materialized).toBe(1);
    const second = await pullInstalledPackRules(db, { ...BASE, fetchImpl: fakeFetch(env), projectRoot });
    expect(second.materialized).toBe(0);
    expect(second.skipped).toBe(1);
    expect(listCandidates()).toHaveLength(1);
  });

  it('an already-applied prompt_hash (audit_log) is skipped', async () => {
    // Materialize once to discover the deterministic prompt_hash.
    await pullInstalledPackRules(db, { ...BASE, fetchImpl: fakeFetch(envelopeFor(ORG, [pack()])), projectRoot });
    const hash = (listCandidates()[0] as Record<string, any>).prompt_hash;
    // Remove the sidecar, record an audit row → next pull must skip via audit dedup.
    rmSync(join(candidateDir(), `${hash}.json`));
    db.prepare(
      "INSERT OR IGNORE INTO sessions (session_id, started_at, started_at_epoch) VALUES ('s1', datetime('now'), 0)",
    ).run();
    db.prepare(
      "INSERT INTO audit_log (session_id, event_type, metadata) VALUES ('s1', 'rule_promoted', ?)",
    ).run(JSON.stringify({ prompt_hash: hash }));
    const res = await pullInstalledPackRules(db, { ...BASE, fetchImpl: fakeFetch(envelopeFor(ORG, [pack()])), projectRoot });
    expect(res.materialized).toBe(0);
    expect(res.skipped).toBe(1);
  });
});

describe('pullInstalledPackRules — endpoint', () => {
  it('passes ?updates_only=1 to /installed-rules when updatesOnly is set', async () => {
    let seenUrl = '';
    const capture = (async (url: string) => {
      seenUrl = url;
      return { ok: true, json: async () => envelopeFor(ORG, []) };
    }) as unknown as typeof fetch;
    await pullInstalledPackRules(db, { ...BASE, fetchImpl: capture, projectRoot, updatesOnly: true });
    expect(seenUrl).toBe('https://cloud.test/installed-rules?updates_only=1');
  });

  it('targets /installed-rules (not /promoted-rules) by default', async () => {
    let seenUrl = '';
    const capture = (async (url: string) => {
      seenUrl = url;
      return { ok: true, json: async () => envelopeFor(ORG, []) };
    }) as unknown as typeof fetch;
    await pullInstalledPackRules(db, { ...BASE, fetchImpl: capture, projectRoot });
    expect(seenUrl).toBe('https://cloud.test/installed-rules');
  });
});
