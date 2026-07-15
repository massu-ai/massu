// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P1-014 (plan-2026-05-27-tier-gate-auto-learning / CR-54): tests for the
 * hook-safe, synchronous, NEVER-network `getCachedTierReadOnly()` reader.
 *
 * Covers: no apiKey → free; fresh (transition-mode unsigned) cache row → that
 * tier; expired (>7d) row → free; no row → free; tampered/parse-error
 * signed payload → free; and that NO network call ever occurs (fetch spy).
 * Reuses a passed-in db handle (the hook contract).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';

// Control cloud config (apiKey) per test.
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

// getMemoryDb should never be called when we pass our own db handle. We still
// stub it so an accidental no-arg call doesn't open a real DB.
let stubMemoryDbCalls = 0;
vi.mock('../memory-db.ts', () => ({
  getMemoryDb: vi.fn(() => {
    stubMemoryDbCalls++;
    const db = new Database(':memory:');
    db.exec(LICENSE_CACHE_DDL);
    return db;
  }),
  sanitizeFts5Query: vi.fn((q: string) => `"${q}"`),
}));

import { getCachedTierReadOnly } from '../license.ts';

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

let testDb: Database.Database;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(LICENSE_CACHE_DDL);
  return db;
}

function insertCache(
  db: Database.Database,
  apiKey: string,
  tier: string,
  lastValidated: string,
  signedPayloadJson = '',
): void {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  db.prepare(
    `INSERT OR REPLACE INTO license_cache (api_key_hash, tier, valid_until, last_validated, features, signed_payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(keyHash, tier, '2027-01-01', lastValidated, '[]', signedPayloadJson);
}

function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
}
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// SEC-3 (2026-07-15): strict signature mode is now the DEFAULT. The unsigned-row
// tests below exercise the transition READ path, so pin them to the explicit
// opt-out; a dedicated test asserts the strict default drops an unsigned row.
const _origSecRequire = process.env.MASSU_REQUIRE_SIGNED_LICENSE;
beforeEach(() => {
  mockCloudConfig = undefined;
  stubMemoryDbCalls = 0;
  testDb = createTestDb();
  process.env.MASSU_REQUIRE_SIGNED_LICENSE = 'false';
});

afterEach(() => {
  if (testDb && testDb.open) testDb.close();
  vi.restoreAllMocks();
  if (_origSecRequire === undefined) delete process.env.MASSU_REQUIRE_SIGNED_LICENSE;
  else process.env.MASSU_REQUIRE_SIGNED_LICENSE = _origSecRequire;
});

describe('getCachedTierReadOnly() — cache-only, no-network, fail-closed', () => {
  it('returns free when no apiKey is configured (no db touch)', () => {
    mockCloudConfig = undefined;
    expect(getCachedTierReadOnly(testDb)).toBe('free');
    expect(stubMemoryDbCalls).toBe(0);
  });

  it('returns the cached tier for a fresh transition-mode (unsigned) row', () => {
    const apiKey = 'ms_live_readonly_key';
    mockCloudConfig = { apiKey };
    insertCache(testDb, apiKey, 'pro', hoursAgo(0.5));
    expect(getCachedTierReadOnly(testDb)).toBe('pro');
  });

  it('SEC-3: strict default drops a fresh UNSIGNED row to free', () => {
    // The read-only path enforces the strict default too: without the explicit
    // opt-out, the same unsigned row that returns 'pro' above returns 'free'.
    delete process.env.MASSU_REQUIRE_SIGNED_LICENSE;
    const apiKey = 'ms_live_readonly_key';
    mockCloudConfig = { apiKey };
    insertCache(testDb, apiKey, 'pro', hoursAgo(0.5));
    expect(getCachedTierReadOnly(testDb)).toBe('free');
  });

  it('returns free when the cache row is older than the 7-day grace window', () => {
    const apiKey = 'ms_live_readonly_key';
    mockCloudConfig = { apiKey };
    insertCache(testDb, apiKey, 'team', daysAgo(10));
    expect(getCachedTierReadOnly(testDb)).toBe('free');
  });

  it('returns free when there is no cache row for the key', () => {
    mockCloudConfig = { apiKey: 'ms_live_unknown_key' };
    expect(getCachedTierReadOnly(testDb)).toBe('free');
  });

  it('returns free when a signed payload row is tampered / unparseable', () => {
    const apiKey = 'ms_live_readonly_key';
    mockCloudConfig = { apiKey };
    // Non-JSON signed_payload_json → readTrustedCache JSON.parse throws → null → free.
    insertCache(testDb, apiKey, 'enterprise', hoursAgo(0.5), '{not valid json');
    expect(getCachedTierReadOnly(testDb)).toBe('free');
  });

  it('NEVER calls the network (fetch is not invoked)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    const apiKey = 'ms_live_readonly_key';
    mockCloudConfig = { apiKey, endpoint: 'https://api.massu.ai' };
    insertCache(testDb, apiKey, 'pro', hoursAgo(0.5));
    const tier = getCachedTierReadOnly(testDb);
    expect(tier).toBe('pro');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reuses the passed-in db handle (does not open its own) and leaves it open', () => {
    const apiKey = 'ms_live_readonly_key';
    mockCloudConfig = { apiKey };
    insertCache(testDb, apiKey, 'pro', hoursAgo(0.5));
    getCachedTierReadOnly(testDb);
    expect(stubMemoryDbCalls).toBe(0); // never opened its own
    expect(testDb.open).toBe(true); // caller still owns the handle
  });
});
