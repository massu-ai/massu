// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PB-012 (plan-2026-05-28-team-shared-rule-promotion): tests for the hook-safe,
 * synchronous, NEVER-network `getCachedOrgId()` reader.
 *
 * Covers: signed row with orgId → that org; no apiKey → null; verifier rejects
 * (tampered) → null; verified payload without orgId → null; expired (>7d) row →
 * null; no row → null; and that NO network call ever occurs. org id is ALWAYS
 * derived from the VERIFIED payload — never a plain column.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';

let mockCloudConfig: Record<string, unknown> | undefined = undefined;

vi.mock('../config.ts', () => ({
  getConfig: vi.fn(() => ({
    toolPrefix: 'massu',
    project: { name: 'test', root: '/tmp/test' },
    framework: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' },
    paths: { source: 'src', aliases: {} },
    domains: [],
    rules: [],
    cloud: mockCloudConfig,
  })),
  getProjectRoot: vi.fn(() => '/tmp/test'),
  resetConfig: vi.fn(),
}));

vi.mock('../memory-db.ts', () => ({
  getMemoryDb: vi.fn(() => {
    const db = new Database(':memory:');
    db.exec(LICENSE_CACHE_DDL);
    return db;
  }),
  sanitizeFts5Query: vi.fn((q: string) => `"${q}"`),
}));

// Control the signature-verification verdict so we can exercise org-id
// extraction without the real private key. isLicenseSignatureRequired stays off
// (transition mode) — same as production default.
let mockVerdict: { kind: string } = { kind: 'valid' };
vi.mock('../security/license-response-verifier.ts', () => ({
  verifyLicenseResponse: vi.fn(() => mockVerdict),
  isLicenseSignatureRequired: vi.fn(() => false),
}));

import { getCachedOrgId } from '../license.ts';

const LICENSE_CACHE_DDL = `
  CREATE TABLE IF NOT EXISTS license_cache (
    api_key_hash TEXT PRIMARY KEY,
    tier TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    last_validated TEXT NOT NULL,
    features TEXT DEFAULT '[]',
    signed_payload_json TEXT NOT NULL DEFAULT ''
  );
`;

const API_KEY = 'ms_live_deadbeef_xxxxxxxxxxxxxxxx';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(LICENSE_CACHE_DDL);
  return db;
}

function insertRow(
  db: Database.Database,
  opts: { orgId?: string; lastValidated?: string; signed?: boolean } = {},
): void {
  const keyHash = createHash('sha256').update(API_KEY).digest('hex');
  const payload = opts.signed === false
    ? ''
    : JSON.stringify({
        valid: true,
        plan: 'cloud_team',
        tier: 'team',
        validUntil: '2030-01-01',
        features: [],
        ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
        _signature: 'sig',
        _signature_alg: 'ed25519',
        _signature_payload_keys: ['orgId', 'plan', 'tier', 'valid', 'validUntil', 'features'],
        _signature_pubkey_fingerprint: 'fp',
      });
  db.prepare(
    `INSERT OR REPLACE INTO license_cache (api_key_hash, tier, valid_until, last_validated, features, signed_payload_json)
     VALUES (?, 'team', '2030-01-01', ?, '[]', ?)`,
  ).run(keyHash, opts.lastValidated ?? new Date().toISOString(), payload);
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockCloudConfig = { apiKey: API_KEY };
  mockVerdict = { kind: 'valid' };
  fetchSpy = vi.fn(() => { throw new Error('network must not be called'); });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getCachedOrgId (PB-012)', () => {
  it('returns the org from a verified signed payload', () => {
    const db = makeDb();
    insertRow(db, { orgId: 'org-42' });
    expect(getCachedOrgId(db)).toBe('org-42');
    expect(fetchSpy).not.toHaveBeenCalled();
    db.close();
  });

  it('returns null when no apiKey is configured', () => {
    mockCloudConfig = undefined;
    const db = makeDb();
    insertRow(db, { orgId: 'org-42' });
    expect(getCachedOrgId(db)).toBeNull();
    db.close();
  });

  it('returns null when the signature verdict is not valid (tampered)', () => {
    mockVerdict = { kind: 'bad_signature' };
    const db = makeDb();
    insertRow(db, { orgId: 'org-42' });
    expect(getCachedOrgId(db)).toBeNull();
    db.close();
  });

  it('returns null when the verified payload omits orgId', () => {
    const db = makeDb();
    insertRow(db, {}); // no orgId field
    expect(getCachedOrgId(db)).toBeNull();
    db.close();
  });

  it('returns null for a stale (>7d) row', () => {
    const db = makeDb();
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    insertRow(db, { orgId: 'org-42', lastValidated: old });
    expect(getCachedOrgId(db)).toBeNull();
    db.close();
  });

  it('returns null when no cache row exists', () => {
    const db = makeDb();
    expect(getCachedOrgId(db)).toBeNull();
    db.close();
  });

  it('never calls the network', () => {
    const db = makeDb();
    insertRow(db, { orgId: 'org-42' });
    getCachedOrgId(db);
    expect(fetchSpy).not.toHaveBeenCalled();
    db.close();
  });
});
