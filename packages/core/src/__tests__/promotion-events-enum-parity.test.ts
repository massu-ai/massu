// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Drift-guard (P1-004, plan-2026-06-01-auto-learning-analytics-dashboard /
 * CR-39): the promotion-funnel event enum MUST be byte-identical across the four
 * surfaces that read or write it. A drift between any two would silently break
 * the funnel (the server's DB CHECK rejects an event the client emits, or the
 * dashboard reader counts a stage that never arrives).
 *
 * The four surfaces:
 *   1. CLIENT SoT      — `RulePromotionEventType` union (memory-db.ts). The
 *                        single client literal; cloud-sync.ts references the type.
 *   2. SERVER INGEST   — `RULE_PROMOTION_EVENT_TYPES` allowlist (functions/sync/index.ts).
 *   3. MIGRATION CHECK — `event_type IN (...)` (migrations/046_rule_promotion_events.sql).
 *   4. DASHBOARD READER— `PROMOTION_FUNNEL_EVENT_TYPES` (src/lib/promotion-analytics-data.ts).
 *
 * `revoked` is deliberately NOT in this enum — it is a tombstone on
 * promoted_rules.revoked_at, surfaced as its own funnel stage, never a synced event.
 *
 * Public-mirror note: this test ships to the public repo and runs in
 * `CI (public-mirror)` where `website/` is absent. The three website surfaces are
 * read with a skipIf guard so the test is a no-op there; the bash mirror
 * (pattern-scanner Check 35) is the private-side enforcement that always has the
 * full tree. The client SoT surface (memory-db.ts) is always checked.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const CORE_SRC = path.resolve(__dirname, '..')

const MEMORY_DB = path.join(CORE_SRC, 'memory-db.ts')
const SYNC_FN = path.join(REPO_ROOT, 'website/supabase/functions/sync/index.ts')
const MIGRATION = path.join(REPO_ROOT, 'website/supabase/migrations/046_rule_promotion_events.sql')
const DASHBOARD = path.join(REPO_ROOT, 'website/src/lib/promotion-analytics-data.ts')

const websitePresent =
  fs.existsSync(SYNC_FN) && fs.existsSync(MIGRATION) && fs.existsSync(DASHBOARD)

/** Extract the single-quoted tokens from a source snippet, sorted + deduped. */
function quotedTokens(snippet: string): string[] {
  const out = new Set<string>()
  const re = /'([a-z_]+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(snippet)) !== null) out.add(m[1])
  return Array.from(out).sort()
}

/** The canonical expected enum — the test's own assertion anchor. */
const EXPECTED = ['approved', 'dismissed', 'proposed', 'shown']

function clientSotEnum(): string[] {
  const src = fs.readFileSync(MEMORY_DB, 'utf-8')
  const m = src.match(/export type RulePromotionEventType\s*=\s*([^;]+);/)
  expect(m, 'RulePromotionEventType union not found in memory-db.ts').not.toBeNull()
  return quotedTokens(m![1])
}

describe('Promotion-funnel event-enum parity (P1-004)', () => {
  it('client SoT (memory-db RulePromotionEventType) equals the canonical enum', () => {
    expect(clientSotEnum()).toEqual(EXPECTED)
  })

  describe.skipIf(!websitePresent)('website surfaces (skipped in public-mirror CI)', () => {
    it('server ingest allowlist (functions/sync) matches the client SoT', () => {
      const src = fs.readFileSync(SYNC_FN, 'utf-8')
      const m = src.match(/const RULE_PROMOTION_EVENT_TYPES\s*=\s*\[([^\]]+)\]/)
      expect(m, 'RULE_PROMOTION_EVENT_TYPES not found in sync/index.ts').not.toBeNull()
      expect(quotedTokens(m![1])).toEqual(clientSotEnum())
    })

    it('migration 046 event_type CHECK matches the client SoT', () => {
      const src = fs.readFileSync(MIGRATION, 'utf-8')
      const m = src.match(/event_type\s+IN\s*\(([^)]+)\)/i)
      expect(m, 'event_type IN (...) CHECK not found in migration 046').not.toBeNull()
      expect(quotedTokens(m![1])).toEqual(clientSotEnum())
    })

    it('dashboard reader (PROMOTION_FUNNEL_EVENT_TYPES) matches the client SoT', () => {
      const src = fs.readFileSync(DASHBOARD, 'utf-8')
      const m = src.match(/PROMOTION_FUNNEL_EVENT_TYPES\s*=\s*\[([^\]]+)\]/)
      expect(m, 'PROMOTION_FUNNEL_EVENT_TYPES not found in promotion-analytics-data.ts').not.toBeNull()
      expect(quotedTokens(m![1])).toEqual(clientSotEnum())
    })
  })
})
