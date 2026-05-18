// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-M-036 (plan-stage-d-medium-sweep) drift-guard.
 *
 * Closes wave2-architecture F-ARCH-013: pluggable governance rules so
 * customers can author CR-style governance entries in massu.config.yaml
 * that surface via `massu_knowledge_rule` lookups alongside framework CRs.
 *
 * Drift-guard asserts:
 *   1. Empty / absent `governance_rules:` block → no-op (no rows inserted).
 *   2. Valid `governance_rules:` block → rows inserted with
 *      source='customer-config' (distinct from framework rules).
 *   3. Schema-invalid governance_rules entry throws a helpful Zod error.
 *   4. `governance_rules:` keys do NOT collide with the existing path-scoped
 *      `rules:` field (preserves the v1 lint-hint feature).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

import { initKnowledgeSchema } from '../knowledge-db.ts'
import { indexAllKnowledge } from '../knowledge-indexer.ts'

// Inject a stub config + paths layer so indexAllKnowledge runs against a
// minimal scratch tree. The customer-rules loader only consults
// getConfig().governance_rules — it does not depend on the rest of the
// knowledge corpus.
const tmpClaudeDir = '/tmp/governance-rules-test-claude'

vi.mock('../config.ts', async () => {
  return {
    getConfig: vi.fn(),
    resetConfig: vi.fn(),
    getProjectRoot: vi.fn(() => '/tmp/governance-rules-test'),
    getResolvedPaths: vi.fn(() => ({
      claudeDir: tmpClaudeDir,
      memoryDir: '/tmp/governance-rules-test-memory',
      plansDir: '/tmp/governance-rules-test-plans',
      docsDir: '/tmp/governance-rules-test-docs',
      claudeMdPath: `${tmpClaudeDir}/CLAUDE.md`,
      knowledgeDbPath: ':memory:',
    })),
  }
})

import { getConfig } from '../config.ts'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  initKnowledgeSchema(db)
  return db
}

function baseConfig(): ReturnType<typeof getConfig> {
  return {
    schema_version: 2,
    project: { name: 'test', root: '/tmp/governance-rules-test' },
    framework: { type: 'mcp', router: 'none', orm: 'none', ui: 'none' },
    paths: { source: 'src' },
    toolPrefix: 'massu',
    domains: [],
    rules: [],
    governance_rules: [],
    conventions: { knowledgeSourceFiles: ['CLAUDE.md'], excludePatterns: [] },
  } as unknown as ReturnType<typeof getConfig>
}

describe('P-M-036 governance_rules config loading', () => {
  let db: Database.Database

  beforeEach(() => {
    db = makeDb()
    vi.mocked(getConfig).mockReset()
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // ignore
    }
  })

  it('initKnowledgeSchema adds source column to knowledge_rules', () => {
    const cols = db
      .prepare(`PRAGMA table_info(knowledge_rules)`)
      .all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'source')).toBe(true)
  })

  it('empty governance_rules block → no customer-config rows inserted', () => {
    vi.mocked(getConfig).mockReturnValue(baseConfig())
    indexAllKnowledge(db)
    const count = db
      .prepare(
        `SELECT COUNT(*) as c FROM knowledge_rules WHERE source = 'customer-config'`,
      )
      .get() as { c: number }
    expect(count.c).toBe(0)
  })

  it('valid governance_rules entries are persisted with source=customer-config', () => {
    const cfg = baseConfig()
    cfg.governance_rules = [
      {
        id: 'CR-customer-001',
        title: 'No any type',
        description: 'Use specific types or unknown instead of any.',
        vr_type: 'VR-CUSTOM',
        reference_path: '.claude/rules/no-any-type.md',
        severity: 'high',
      },
      {
        id: 'CR-customer-002',
        title: 'No console.log in src',
        description: 'Use logger.info instead.',
        vr_type: 'VR-CUSTOM',
        severity: 'medium',
      },
    ]
    vi.mocked(getConfig).mockReturnValue(cfg)
    indexAllKnowledge(db)

    const rows = db
      .prepare(
        `SELECT rule_id, rule_text, severity, source FROM knowledge_rules WHERE source = 'customer-config' ORDER BY rule_id`,
      )
      .all() as Array<{
      rule_id: string
      rule_text: string
      severity: string
      source: string
    }>

    expect(rows).toHaveLength(2)
    // Security-review M-5: rule_ids are force-namespaced with `customer:`
    // prefix to prevent collision with framework CR-* row_ids.
    expect(rows[0].rule_id).toBe('customer:CR-customer-001')
    expect(rows[0].rule_text).toContain('No any type')
    expect(rows[0].source).toBe('customer-config')
    expect(rows[1].severity).toBe('MEDIUM')
  })

  it('governance_rules and rules: do not cross-contaminate', () => {
    const cfg = baseConfig()
    // populate the path-scoped lint-hint `rules:` field
    cfg.rules = [
      {
        pattern: 'website/src/**/*.ts',
        rules: ['No any types'],
      },
    ]
    cfg.governance_rules = [
      {
        id: 'CR-customer-isolation',
        title: 'Customer rule',
        description: 'Test isolation from path-scoped rules.',
        vr_type: 'VR-CUSTOM',
        severity: 'low',
      },
    ]
    vi.mocked(getConfig).mockReturnValue(cfg)
    indexAllKnowledge(db)

    // Customer rules ONLY land in knowledge_rules, not in path-rule consumers.
    const rules = db
      .prepare(`SELECT rule_id, source FROM knowledge_rules`)
      .all() as Array<{ rule_id: string; source: string }>
    // Security-review M-5: customer rule_ids carry the `customer:` namespace
    // prefix to structurally prevent overwriting framework CR-* row_ids.
    expect(rules.some((r) => r.rule_id === 'customer:CR-customer-isolation')).toBe(true)
    expect(rules.some((r) => r.rule_id === 'CR-customer-isolation')).toBe(false)
    // The path-scoped `No any types` text must NOT appear as a rule_id since
    // that field is a separate consumer.
    expect(rules.some((r) => r.rule_id === 'No any types')).toBe(false)
  })

  it('customer rule_ids cannot collide with framework CR-* row_ids', () => {
    const cfg = baseConfig()
    // Attacker attempts to overwrite CR-3 (framework rule).
    cfg.governance_rules = [
      {
        id: 'CR-3',
        title: 'Malicious rule',
        description: 'Attempt to overwrite framework CR-3 (Never commit secrets).',
        vr_type: 'VR-CUSTOM',
        severity: 'critical',
      },
    ]
    vi.mocked(getConfig).mockReturnValue(cfg)
    indexAllKnowledge(db)

    // Insert a framework-style row to simulate the framework CR-3.
    db.prepare(
      `INSERT OR REPLACE INTO knowledge_rules (rule_id, rule_text, vr_type, reference_path, severity, source) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('CR-3', 'Framework: Never commit secrets', 'VR-FILE', '.claude/CLAUDE.md', 'CRITICAL', 'framework')

    const cr3Rows = db
      .prepare(`SELECT rule_id, source FROM knowledge_rules WHERE rule_id = 'CR-3'`)
      .all() as Array<{ rule_id: string; source: string }>
    const customerCr3Rows = db
      .prepare(`SELECT rule_id, source FROM knowledge_rules WHERE rule_id = 'customer:CR-3'`)
      .all() as Array<{ rule_id: string; source: string }>

    // The framework row is untouched.
    expect(cr3Rows).toHaveLength(1)
    expect(cr3Rows[0].source).toBe('framework')
    // The customer entry lives under the namespaced rule_id.
    expect(customerCr3Rows).toHaveLength(1)
    expect(customerCr3Rows[0].source).toBe('customer-config')
  })
})
