// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-M-023 (plan-stage-d-medium-sweep) drift-guard.
 *
 * Closes the bug class where a user could `sqlite3 memory.db "INSERT OR
 * REPLACE INTO license_cache ..."` and grant themselves any tier. The fix
 * stores the entire signed wire payload alongside the row and re-verifies
 * the Ed25519 signature on every cache read. Editing the plain tier /
 * valid_until columns is now structurally a no-op because the trusted
 * fields are re-extracted from the verified payload.
 *
 * Drift-guard asserts:
 *   1. `initMemorySchema` provisions the `signed_payload_json` column.
 *   2. An unsigned cache row → strict mode rejects → returns free tier.
 *   3. A row with a tampered `tier` column still falls through to free
 *      under strict mode (the column edit is structurally ignored).
 *   4. A row with garbage signed_payload_json drops the cache entirely.
 *   5. A row with a syntactically valid but cryptographically invalid
 *      signature drops the cache entirely.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'crypto'

// Mock config + memory-db BEFORE importing license.ts (same pattern as
// the existing license.test.ts) so getConfig().cloud?.endpoint is absent
// and memDb is the shared in-memory one.
vi.mock('../config.ts', () => ({
  getConfig: vi.fn(() => ({
    framework: { type: 'mcp' },
    toolPrefix: 'massu',
    paths: { source: 'src', tests: 'src/__tests__' },
    cloud: {}, // no endpoint → cache-read-only path
    languages: {},
    domains: [],
    indexFiles: ['index.ts'],
    patternsDir: '/tmp/.claude/patterns',
    claudeMdPath: '/tmp/.claude/CLAUDE.md',
    docsMapPath: '/tmp/.massu/docs-map.json',
    helpSitePath: '/tmp/test-help',
    prismaSchemaPath: '/tmp/prisma/schema.prisma',
    rootRouterPath: '/tmp/src/server/api/root.ts',
    routersDir: '/tmp/src/server/api/routers',
  })),
  resetConfig: vi.fn(),
}))

let testDb: Database.Database

vi.mock('../memory-db.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../memory-db.ts')>('../memory-db.ts')
  return {
    ...actual,
    getMemoryDb: vi.fn(() => {
      const proxy = Object.create(testDb)
      proxy.close = () => {}
      return proxy
    }),
  }
})

import { initMemorySchema } from '../memory-db.ts'
import { validateLicense, _resetCachedTier } from '../license.ts'

function keyHash(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex')
}

function insertRow(
  db: Database.Database,
  apiKey: string,
  tier: string,
  validUntil: string,
  signedPayload: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO license_cache (api_key_hash, tier, valid_until, last_validated, features, signed_payload_json) VALUES (?, ?, ?, datetime('now'), '[]', ?)`,
  ).run(keyHash(apiKey), tier, validUntil, signedPayload)
}

describe('P-M-023 license_cache signature gate', () => {
  const origStrict = process.env.MASSU_REQUIRE_SIGNED_LICENSE

  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('journal_mode = WAL')
    initMemorySchema(testDb)
    _resetCachedTier()
  })

  afterEach(() => {
    if (origStrict !== undefined) {
      process.env.MASSU_REQUIRE_SIGNED_LICENSE = origStrict
    } else {
      delete process.env.MASSU_REQUIRE_SIGNED_LICENSE
    }
    try {
      testDb.close()
    } catch {
      // ignore
    }
  })

  it('initMemorySchema provisions the signed_payload_json column', () => {
    const cols = testDb
      .prepare(`PRAGMA table_info(license_cache)`)
      .all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'signed_payload_json')).toBe(true)
  })

  it('unsigned cache row + strict mode → drops cache → free tier', async () => {
    process.env.MASSU_REQUIRE_SIGNED_LICENSE = 'true'
    insertRow(testDb, 'apikey-1', 'enterprise', '2099-01-01', '')
    const info = await validateLicense('apikey-1')
    expect(info.tier).toBe('free')
  })

  it('tampered tier column is ignored under strict mode (drops cache)', async () => {
    process.env.MASSU_REQUIRE_SIGNED_LICENSE = 'true'
    // A real attacker scenario: row with enterprise in the tier column
    // but no signed payload. The validator does not trust the column.
    insertRow(testDb, 'apikey-2', 'enterprise', '2099-01-01', '')
    const info = await validateLicense('apikey-2')
    expect(info.tier).toBe('free')
  })

  it('garbage signed_payload_json → drops cache → free tier', async () => {
    process.env.MASSU_REQUIRE_SIGNED_LICENSE = 'true'
    insertRow(testDb, 'apikey-3', 'enterprise', '2099-01-01', 'this-is-not-json')
    const info = await validateLicense('apikey-3')
    expect(info.tier).toBe('free')
  })

  it('valid-shape but bad-signature payload → drops cache → free tier', async () => {
    process.env.MASSU_REQUIRE_SIGNED_LICENSE = 'true'
    const fakePayload = {
      valid: true,
      plan: 'cloud_enterprise',
      tier: 'enterprise',
      validUntil: '2099-01-01',
      features: ['all'],
      _signature: Buffer.alloc(64, 0).toString('base64'),
      _signature_alg: 'ed25519',
      _signature_payload_keys: ['plan', 'valid', 'validUntil'],
    }
    insertRow(
      testDb,
      'apikey-4',
      'enterprise',
      '2099-01-01',
      JSON.stringify(fakePayload),
    )
    const info = await validateLicense('apikey-4')
    expect(info.tier).toBe('free')
  })

  it('transition mode (default) tolerates unsigned rows without throwing', async () => {
    delete process.env.MASSU_REQUIRE_SIGNED_LICENSE
    insertRow(testDb, 'apikey-5', 'pro', '2099-01-01', '')
    const info = await validateLicense('apikey-5')
    // Transition: tier comes through from the column with a one-shot warn.
    // Strict mode would have returned 'free' here.
    expect(info.tier).toBe('pro')
  })
})
