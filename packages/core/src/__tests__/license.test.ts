// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';

/**
 * License module tests — covers tier enforcement, caching, grace period,
 * tool annotation, and the license_status MCP tool.
 *
 * Plan items: P3-023 through P3-031.
 */

// ============================================================
// Mocks
// ============================================================

// Track the cloud config returned by getConfig — tests mutate this.
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
  getResolvedPaths: vi.fn(() => ({
    memoryDbPath: ':memory:',
    codegraphDbPath: ':memory:',
    dataDbPath: ':memory:',
    srcDir: '/tmp/test/src',
    pathAlias: {},
    extensions: ['.ts'],
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
}));

// In-memory DB shared across tests that need it.
// We override close() to be a no-op because validateLicense() and
// updateLicenseCache() call memDb.close() in their finally blocks,
// which would close our shared test DB prematurely.
let testDb: Database.Database;

vi.mock('../memory-db.ts', () => ({
  getMemoryDb: vi.fn(() => {
    // Return the shared testDb but with a no-op close() so that
    // license.ts finally blocks don't destroy our shared connection.
    const proxy = Object.create(testDb);
    proxy.close = () => {}; // no-op
    // Ensure prepare() and other methods still work via prototype chain
    return proxy;
  }),
  sanitizeFts5Query: vi.fn((q: string) => `"${q}"`),
}));

// Import the module under test AFTER mocks are declared.
import {
  TOOL_TIER_MAP,
  type ToolTier,
  tierLevel,
  getToolTier,
  isToolAllowed,
  annotateToolDefinitions,
  validateLicense,
  updateLicenseCache,
  getCurrentTier,
  getLicenseInfo,
  daysUntilExpiry,
  getLicenseToolDefinitions,
  isLicenseTool,
  handleLicenseToolCall,
  _resetCachedTier,
} from '../license.ts';

// ============================================================
// Helpers
// ============================================================

/** Create a fresh in-memory DB with the license_cache table. */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS license_cache (
      api_key_hash TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      last_validated TEXT NOT NULL,
      features TEXT DEFAULT '[]'
    );
  `);
  return db;
}

/** Insert a row into license_cache for a given API key. */
function insertCache(
  db: Database.Database,
  apiKey: string,
  tier: string,
  validUntil: string,
  lastValidated: string,
  features: string[] = [],
): void {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  db.prepare(
    `INSERT OR REPLACE INTO license_cache (api_key_hash, tier, valid_until, last_validated, features)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(keyHash, tier, validUntil, lastValidated, JSON.stringify(features));
}

/** ISO date string offset from now by a number of hours. */
function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
}

/** ISO date string offset from now by a number of days. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** Future date string. */
function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
}

// ============================================================
// Setup / Teardown
// ============================================================

beforeEach(() => {
  _resetCachedTier();
  mockCloudConfig = undefined;
  testDb = createTestDb();
});

afterEach(() => {
  if (testDb && testDb.open) testDb.close();
});

// ============================================================
// P3-023: TOOL_TIER_MAP completeness
// ============================================================

describe('P3-023: TOOL_TIER_MAP completeness', () => {
  const validTiers: ToolTier[] = ['free', 'pro', 'team', 'enterprise'];

  it('has entries for known free-tier base names', () => {
    const freeTools = [
      'sync', 'context', 'impact', 'domains', 'schema',
      'trpc_map', 'coupling_check',
      'memory_search', 'memory_ingest',
      'regression_risk', 'feature_health',
      'license_status',
    ];
    for (const tool of freeTools) {
      expect(TOOL_TIER_MAP[tool], `Missing free tool: ${tool}`).toBe('free');
    }
  });

  it('has entries for known pro-tier base names', () => {
    const proTools = [
      'memory_timeline', 'memory_detail', 'memory_sessions', 'memory_failures',
      'knowledge_search', 'knowledge_rule', 'knowledge_incident',
      'knowledge_schema_check', 'knowledge_pattern', 'knowledge_verification',
      'knowledge_graph', 'knowledge_command', 'knowledge_correct',
      'knowledge_plan', 'knowledge_gaps', 'knowledge_effectiveness',
      'quality_score', 'quality_trend', 'quality_report',
      'cost_session', 'cost_trend', 'cost_feature',
      'prompt_effectiveness', 'prompt_suggestions',
      'validation_check', 'validation_report',
      'adr_list', 'adr_detail', 'adr_create',
      'session_replay', 'prompt_analysis', 'tool_patterns', 'session_stats',
      'docs_audit', 'docs_coverage',
    ];
    for (const tool of proTools) {
      expect(TOOL_TIER_MAP[tool], `Missing pro tool: ${tool}`).toBe('pro');
    }
  });

  it('has entries for known team-tier base names', () => {
    const teamTools = [
      'sentinel_search', 'sentinel_detail', 'sentinel_impact',
      'sentinel_validate', 'sentinel_register', 'sentinel_parity',
      'team_search', 'team_expertise', 'team_conflicts',
    ];
    for (const tool of teamTools) {
      expect(TOOL_TIER_MAP[tool], `Missing team tool: ${tool}`).toBe('team');
    }
  });

  it('has entries for known enterprise-tier base names', () => {
    const enterpriseTools = [
      'audit_log', 'audit_report', 'audit_chain',
      'security_score', 'security_heatmap', 'security_trend',
      'dep_score', 'dep_alternatives',
    ];
    for (const tool of enterpriseTools) {
      expect(TOOL_TIER_MAP[tool], `Missing enterprise tool: ${tool}`).toBe('enterprise');
    }
  });

  it('every entry maps to a valid tier', () => {
    for (const [name, tier] of Object.entries(TOOL_TIER_MAP)) {
      expect(validTiers, `Invalid tier "${tier}" for tool "${name}"`).toContain(tier);
    }
  });

  it('has a non-trivial number of entries (>30)', () => {
    expect(Object.keys(TOOL_TIER_MAP).length).toBeGreaterThan(30);
  });
});

// ============================================================
// P3-024: isToolAllowed()
// ============================================================

describe('P3-024: isToolAllowed()', () => {
  it('free user can access free tools', () => {
    expect(isToolAllowed('massu_sync', 'free')).toBe(true);
    expect(isToolAllowed('massu_context', 'free')).toBe(true);
    expect(isToolAllowed('massu_memory_search', 'free')).toBe(true);
  });

  it('free user cannot access pro tools', () => {
    expect(isToolAllowed('massu_quality_score', 'free')).toBe(false);
    expect(isToolAllowed('massu_knowledge_search', 'free')).toBe(false);
    expect(isToolAllowed('massu_cost_session', 'free')).toBe(false);
  });

  it('free user cannot access team tools', () => {
    expect(isToolAllowed('massu_sentinel_register', 'free')).toBe(false);
    expect(isToolAllowed('massu_team_expertise', 'free')).toBe(false);
  });

  it('free user cannot access enterprise tools', () => {
    expect(isToolAllowed('massu_audit_log', 'free')).toBe(false);
    expect(isToolAllowed('massu_security_score', 'free')).toBe(false);
  });

  it('pro user can access free and pro tools', () => {
    expect(isToolAllowed('massu_sync', 'pro')).toBe(true);
    expect(isToolAllowed('massu_quality_score', 'pro')).toBe(true);
    expect(isToolAllowed('massu_knowledge_search', 'pro')).toBe(true);
  });

  it('pro user cannot access team or enterprise tools', () => {
    expect(isToolAllowed('massu_sentinel_register', 'pro')).toBe(false);
    expect(isToolAllowed('massu_audit_log', 'pro')).toBe(false);
  });

  it('team user can access free, pro, and team tools', () => {
    expect(isToolAllowed('massu_sync', 'team')).toBe(true);
    expect(isToolAllowed('massu_quality_score', 'team')).toBe(true);
    expect(isToolAllowed('massu_sentinel_register', 'team')).toBe(true);
    expect(isToolAllowed('massu_team_expertise', 'team')).toBe(true);
  });

  it('team user cannot access enterprise tools', () => {
    expect(isToolAllowed('massu_audit_log', 'team')).toBe(false);
    expect(isToolAllowed('massu_security_score', 'team')).toBe(false);
    expect(isToolAllowed('massu_dep_score', 'team')).toBe(false);
  });

  it('enterprise user can access all tiers', () => {
    expect(isToolAllowed('massu_sync', 'enterprise')).toBe(true);
    expect(isToolAllowed('massu_quality_score', 'enterprise')).toBe(true);
    expect(isToolAllowed('massu_sentinel_register', 'enterprise')).toBe(true);
    expect(isToolAllowed('massu_audit_log', 'enterprise')).toBe(true);
    expect(isToolAllowed('massu_security_score', 'enterprise')).toBe(true);
    expect(isToolAllowed('massu_dep_score', 'enterprise')).toBe(true);
  });

  it('unknown tool defaults to free tier (accessible by all)', () => {
    expect(isToolAllowed('massu_unknown_tool', 'free')).toBe(true);
    expect(isToolAllowed('massu_nonexistent', 'pro')).toBe(true);
  });
});

// ============================================================
// P3-025: validateLicense() with mock DB
// ============================================================

describe('P3-025: validateLicense()', () => {
  const apiKey = 'ms_live_test_key_abc123';

  it('returns cached tier when cache is fresh (< 1 hour)', async () => {
    insertCache(testDb, apiKey, 'pro', '2027-01-01', hoursAgo(0.5), ['knowledge']);
    const result = await validateLicense(apiKey);
    expect(result.tier).toBe('pro');
    expect(result.validUntil).toBe('2027-01-01');
    expect(result.features).toEqual(['knowledge']);
  });

  it('returns cached tier within grace period when cache is stale (> 1 hour but < 7 days)', async () => {
    // Cache is 2 days old — stale but within grace period
    insertCache(testDb, apiKey, 'team', '2027-06-01', daysAgo(2), ['sentinel']);
    const result = await validateLicense(apiKey);
    expect(result.tier).toBe('team');
    expect(result.features).toEqual(['sentinel']);
  });

  it('returns free when cache is expired beyond grace period (> 7 days)', async () => {
    // Cache is 10 days old — beyond 7-day grace period
    insertCache(testDb, apiKey, 'enterprise', '2027-01-01', daysAgo(10));
    const result = await validateLicense(apiKey);
    expect(result.tier).toBe('free');
    expect(result.validUntil).toBe('');
    expect(result.features).toEqual([]);
  });

  it('returns free when no cache exists at all', async () => {
    const result = await validateLicense(apiKey);
    expect(result.tier).toBe('free');
    expect(result.validUntil).toBe('');
    expect(result.features).toEqual([]);
  });

  it('handles cache with empty features JSON gracefully', async () => {
    insertCache(testDb, apiKey, 'pro', '2027-01-01', hoursAgo(0.3), []);
    const result = await validateLicense(apiKey);
    expect(result.tier).toBe('pro');
    expect(result.features).toEqual([]);
  });

  it('uses endpoint from config for cloud validation path', async () => {
    // When cloud.endpoint is set, the code tries cloud validation
    // but falls back to grace period on network failure.
    mockCloudConfig = {
      enabled: true,
      apiKey,
      endpoint: 'https://api.massu.ai/v1/license',
    };
    // Cache is 3 hours old (> 1 hour, so not fresh, but < 7 days grace)
    insertCache(testDb, apiKey, 'pro', '2027-01-01', hoursAgo(3), ['knowledge']);
    const result = await validateLicense(apiKey);
    expect(result.tier).toBe('pro');
  });
});

// ============================================================
// P3-025 (supplement): updateLicenseCache()
// ============================================================

describe('updateLicenseCache()', () => {
  const apiKey = 'ms_live_update_test_key';

  it('inserts a new cache entry', () => {
    updateLicenseCache(apiKey, 'pro', '2027-12-31', ['knowledge', 'quality']);
    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const row = testDb.prepare(
      'SELECT tier, valid_until, features FROM license_cache WHERE api_key_hash = ?',
    ).get(keyHash) as { tier: string; valid_until: string; features: string };
    expect(row.tier).toBe('pro');
    expect(row.valid_until).toBe('2027-12-31');
    expect(JSON.parse(row.features)).toEqual(['knowledge', 'quality']);
  });

  it('replaces an existing cache entry', () => {
    updateLicenseCache(apiKey, 'pro', '2027-06-01');
    updateLicenseCache(apiKey, 'enterprise', '2028-01-01', ['all']);
    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const row = testDb.prepare(
      'SELECT tier, features FROM license_cache WHERE api_key_hash = ?',
    ).get(keyHash) as { tier: string; features: string };
    expect(row.tier).toBe('enterprise');
    expect(JSON.parse(row.features)).toEqual(['all']);
  });
});

// ============================================================
// P3-026: getCurrentTier() without API key
// ============================================================

describe('P3-026: getCurrentTier() without API key', () => {
  it('returns free when no cloud config exists', async () => {
    mockCloudConfig = undefined;
    const tier = await getCurrentTier();
    expect(tier).toBe('free');
  });

  it('returns free when cloud config has no apiKey', async () => {
    mockCloudConfig = { enabled: true, endpoint: 'https://api.massu.ai' };
    const tier = await getCurrentTier();
    expect(tier).toBe('free');
  });

  it('returns free when apiKey is empty string', async () => {
    mockCloudConfig = { apiKey: '' };
    const tier = await getCurrentTier();
    expect(tier).toBe('free');
  });
});

// ============================================================
// P3-027: getCurrentTier() with valid key
// ============================================================

describe('P3-027: getCurrentTier() with valid key', () => {
  const apiKey = 'ms_live_tier_test_key';

  it('returns the tier from a fresh cache', async () => {
    mockCloudConfig = { apiKey, endpoint: 'https://api.massu.ai' };
    insertCache(testDb, apiKey, 'pro', '2027-06-01', hoursAgo(0.25));
    const tier = await getCurrentTier();
    expect(tier).toBe('pro');
  });

  it('caches the result in-memory (second call does not re-query DB)', async () => {
    mockCloudConfig = { apiKey, endpoint: 'https://api.massu.ai' };
    insertCache(testDb, apiKey, 'team', '2027-06-01', hoursAgo(0.1));

    const tier1 = await getCurrentTier();
    expect(tier1).toBe('team');

    // Wipe the DB cache — the in-memory cache should still return 'team'
    testDb.prepare('DELETE FROM license_cache').run();
    const tier2 = await getCurrentTier();
    expect(tier2).toBe('team');
  });

  it('returns free when cache is expired and no network', async () => {
    mockCloudConfig = { apiKey, endpoint: 'https://api.massu.ai' };
    insertCache(testDb, apiKey, 'enterprise', '2025-01-01', daysAgo(10));
    const tier = await getCurrentTier();
    expect(tier).toBe('free');
  });
});

// ============================================================
// P3-028: Grace period
// ============================================================

describe('P3-028: grace period', () => {
  const apiKey = 'ms_live_grace_period_key';

  it('offline + cache < 7 days returns cached tier', async () => {
    mockCloudConfig = { apiKey, endpoint: 'https://api.massu.ai' };
    // Cache is 5 days old — within 7-day grace window
    insertCache(testDb, apiKey, 'pro', '2027-06-01', daysAgo(5), ['knowledge']);
    const result = await validateLicense(apiKey);
    expect(result.tier).toBe('pro');
    expect(result.features).toEqual(['knowledge']);
  });

  it('offline + cache exactly 6 days ago returns cached tier', async () => {
    mockCloudConfig = { apiKey, endpoint: 'https://api.massu.ai' };
    insertCache(testDb, apiKey, 'team', '2027-06-01', daysAgo(6));
    const result = await validateLicense(apiKey);
    expect(result.tier).toBe('team');
  });

  it('offline + cache > 7 days returns free', async () => {
    mockCloudConfig = { apiKey, endpoint: 'https://api.massu.ai' };
    // Cache is 8 days old — beyond 7-day grace window
    insertCache(testDb, apiKey, 'pro', '2027-06-01', daysAgo(8));
    const result = await validateLicense(apiKey);
    expect(result.tier).toBe('free');
    expect(result.validUntil).toBe('');
    expect(result.features).toEqual([]);
  });

  it('offline + cache > 7 days returns free even for enterprise tier', async () => {
    mockCloudConfig = { apiKey, endpoint: 'https://api.massu.ai' };
    insertCache(testDb, apiKey, 'enterprise', '2027-12-31', daysAgo(14));
    const result = await validateLicense(apiKey);
    expect(result.tier).toBe('free');
  });
});

// ============================================================
// P3-029: annotateToolDefinitions()
// ============================================================

describe('P3-029: annotateToolDefinitions()', () => {
  it('adds [PRO] prefix to pro tool descriptions', () => {
    const defs = [
      { name: 'massu_quality_score', description: 'Compute quality score', inputSchema: { type: 'object' } },
    ];
    const annotated = annotateToolDefinitions(defs);
    expect(annotated[0].description).toBe('[PRO] Compute quality score');
    expect(annotated[0].tier).toBe('pro');
  });

  it('adds [TEAM] prefix to team tool descriptions', () => {
    const defs = [
      { name: 'massu_sentinel_register', description: 'Register a feature', inputSchema: { type: 'object' } },
    ];
    const annotated = annotateToolDefinitions(defs);
    expect(annotated[0].description).toBe('[TEAM] Register a feature');
    expect(annotated[0].tier).toBe('team');
  });

  it('adds [ENTERPRISE] prefix to enterprise tool descriptions', () => {
    const defs = [
      { name: 'massu_audit_log', description: 'Log an audit event', inputSchema: { type: 'object' } },
    ];
    const annotated = annotateToolDefinitions(defs);
    expect(annotated[0].description).toBe('[ENTERPRISE] Log an audit event');
    expect(annotated[0].tier).toBe('enterprise');
  });

  it('does NOT add prefix to free tool descriptions', () => {
    const defs = [
      { name: 'massu_sync', description: 'Synchronize indexes', inputSchema: { type: 'object' } },
    ];
    const annotated = annotateToolDefinitions(defs);
    expect(annotated[0].description).toBe('Synchronize indexes');
    expect(annotated[0].tier).toBe('free');
  });

  it('sets tier field correctly on each definition', () => {
    const defs = [
      { name: 'massu_sync', description: 'Free tool', inputSchema: { type: 'object' } },
      { name: 'massu_cost_session', description: 'Pro tool', inputSchema: { type: 'object' } },
      { name: 'massu_team_search', description: 'Team tool', inputSchema: { type: 'object' } },
      { name: 'massu_security_score', description: 'Enterprise tool', inputSchema: { type: 'object' } },
    ];
    const annotated = annotateToolDefinitions(defs);
    expect(annotated[0].tier).toBe('free');
    expect(annotated[1].tier).toBe('pro');
    expect(annotated[2].tier).toBe('team');
    expect(annotated[3].tier).toBe('enterprise');
  });

  it('preserves other properties of tool definitions', () => {
    const defs = [
      {
        name: 'massu_quality_score',
        description: 'Score',
        inputSchema: { type: 'object', properties: { file: { type: 'string' } } },
      },
    ];
    const annotated = annotateToolDefinitions(defs);
    expect(annotated[0].name).toBe('massu_quality_score');
    expect(annotated[0].inputSchema).toEqual({
      type: 'object',
      properties: { file: { type: 'string' } },
    });
  });

  it('handles an empty definitions array', () => {
    const annotated = annotateToolDefinitions([]);
    expect(annotated).toEqual([]);
  });

  it('unknown tools default to free tier and get no label', () => {
    const defs = [
      { name: 'massu_totally_new_tool', description: 'New tool', inputSchema: { type: 'object' } },
    ];
    const annotated = annotateToolDefinitions(defs);
    expect(annotated[0].description).toBe('New tool');
    expect(annotated[0].tier).toBe('free');
  });
});

// ============================================================
// P3-030: Integration test — tool call gated (pro tool + free tier)
// ============================================================

describe('P3-030: tool call gated by tier', () => {
  it('calling a pro tool with free tier returns upgrade message', async () => {
    // Set up: user is on free tier (no API key)
    mockCloudConfig = undefined;
    _resetCachedTier();

    // Simulate the tier gate check that handleToolCall does in tools.ts
    const toolName = 'massu_quality_score';
    const userTier = await getCurrentTier(); // 'free'
    const requiredTier = getToolTier(toolName); // 'pro'
    const allowed = isToolAllowed(toolName, userTier);

    expect(allowed).toBe(false);
    expect(userTier).toBe('free');
    expect(requiredTier).toBe('pro');

    // The upgrade message from tools.ts
    const message = `This tool requires ${requiredTier} tier. Current tier: ${userTier}. Upgrade at https://massu.ai/pricing`;
    expect(message).toContain('Upgrade at https://massu.ai/pricing');
    expect(message).toContain('pro');
    expect(message).toContain('free');
  });

  it('calling a team tool with free tier returns upgrade message', async () => {
    mockCloudConfig = undefined;
    _resetCachedTier();

    const toolName = 'massu_sentinel_register';
    const userTier = await getCurrentTier();
    const requiredTier = getToolTier(toolName);
    const allowed = isToolAllowed(toolName, userTier);

    expect(allowed).toBe(false);
    expect(requiredTier).toBe('team');

    const message = `This tool requires ${requiredTier} tier. Current tier: ${userTier}. Upgrade at https://massu.ai/pricing`;
    expect(message).toContain('Upgrade at https://massu.ai/pricing');
  });

  it('calling an enterprise tool with pro tier returns upgrade message', async () => {
    const apiKey = 'ms_live_pro_key';
    mockCloudConfig = { apiKey, endpoint: 'https://api.massu.ai' };
    insertCache(testDb, apiKey, 'pro', '2027-06-01', hoursAgo(0.1));
    _resetCachedTier();

    const toolName = 'massu_audit_log';
    const userTier = await getCurrentTier(); // 'pro'
    const requiredTier = getToolTier(toolName); // 'enterprise'
    const allowed = isToolAllowed(toolName, userTier);

    expect(allowed).toBe(false);
    expect(userTier).toBe('pro');
    expect(requiredTier).toBe('enterprise');
  });
});

// ============================================================
// P3-031: Integration test — tool call allowed (free tool + free tier)
// ============================================================

describe('P3-031: tool call allowed', () => {
  it('calling a free tool with free tier does not gate', async () => {
    mockCloudConfig = undefined;
    _resetCachedTier();

    const toolName = 'massu_sync';
    const userTier = await getCurrentTier(); // 'free'
    const allowed = isToolAllowed(toolName, userTier);

    expect(allowed).toBe(true);
    expect(userTier).toBe('free');
  });

  it('calling a free tool with pro tier does not gate', async () => {
    const apiKey = 'ms_live_pro_ok';
    mockCloudConfig = { apiKey, endpoint: 'https://api.massu.ai' };
    insertCache(testDb, apiKey, 'pro', '2027-06-01', hoursAgo(0.1));
    _resetCachedTier();

    const toolName = 'massu_memory_search';
    const userTier = await getCurrentTier(); // 'pro'
    const allowed = isToolAllowed(toolName, userTier);

    expect(allowed).toBe(true);
  });

  it('calling a pro tool with pro tier does not gate', async () => {
    const apiKey = 'ms_live_pro_access';
    mockCloudConfig = { apiKey, endpoint: 'https://api.massu.ai' };
    insertCache(testDb, apiKey, 'pro', '2027-06-01', hoursAgo(0.1));
    _resetCachedTier();

    const toolName = 'massu_quality_score';
    const userTier = await getCurrentTier(); // 'pro'
    const allowed = isToolAllowed(toolName, userTier);

    expect(allowed).toBe(true);
  });

  it('calling an enterprise tool with enterprise tier does not gate', async () => {
    const apiKey = 'ms_live_enterprise_access';
    mockCloudConfig = { apiKey, endpoint: 'https://api.massu.ai' };
    insertCache(testDb, apiKey, 'enterprise', '2027-12-31', hoursAgo(0.1));
    _resetCachedTier();

    const toolName = 'massu_security_scan';
    const userTier = await getCurrentTier(); // 'enterprise'
    const allowed = isToolAllowed(toolName, userTier);

    expect(allowed).toBe(true);
  });
});

// ============================================================
// Additional: tierLevel() helper
// ============================================================

describe('tierLevel()', () => {
  it('returns increasing values for free < pro < team < enterprise', () => {
    expect(tierLevel('free')).toBeLessThan(tierLevel('pro'));
    expect(tierLevel('pro')).toBeLessThan(tierLevel('team'));
    expect(tierLevel('team')).toBeLessThan(tierLevel('enterprise'));
  });

  it('returns 0 for free', () => {
    expect(tierLevel('free')).toBe(0);
  });
});

// ============================================================
// Additional: getToolTier() edge cases
// ============================================================

describe('getToolTier()', () => {
  it('strips configured prefix before lookup', () => {
    expect(getToolTier('massu_quality_score')).toBe('pro');
    expect(getToolTier('massu_sync')).toBe('free');
  });

  it('handles base name without prefix', () => {
    expect(getToolTier('quality_score')).toBe('pro');
    expect(getToolTier('sync')).toBe('free');
  });

  it('returns free for unknown tool names', () => {
    expect(getToolTier('massu_nonexistent_tool')).toBe('free');
    expect(getToolTier('unknown')).toBe('free');
  });
});

// ============================================================
// Additional: getLicenseInfo() and daysUntilExpiry()
// ============================================================

describe('getLicenseInfo()', () => {
  it('returns full license info including validUntil and features', async () => {
    const apiKey = 'ms_live_info_key';
    mockCloudConfig = { apiKey, endpoint: 'https://api.massu.ai' };
    insertCache(testDb, apiKey, 'pro', '2027-06-01', hoursAgo(0.1), ['knowledge', 'quality']);
    _resetCachedTier();

    const info = await getLicenseInfo();
    expect(info.tier).toBe('pro');
    expect(info.validUntil).toBe('2027-06-01');
    expect(info.features).toEqual(['knowledge', 'quality']);
  });
});

describe('daysUntilExpiry()', () => {
  it('returns positive number for future expiry', async () => {
    const apiKey = 'ms_live_expiry_key';
    mockCloudConfig = { apiKey, endpoint: 'https://api.massu.ai' };
    const futureDate = daysFromNow(30).split('T')[0]; // YYYY-MM-DD
    insertCache(testDb, apiKey, 'pro', futureDate, hoursAgo(0.1));
    _resetCachedTier();

    const days = await daysUntilExpiry();
    // Should be approximately 30 (within a day tolerance)
    expect(days).toBeGreaterThanOrEqual(29);
    expect(days).toBeLessThanOrEqual(31);
  });

  it('returns -1 when no validUntil is set', async () => {
    mockCloudConfig = undefined;
    _resetCachedTier();

    const days = await daysUntilExpiry();
    expect(days).toBe(-1);
  });
});

// ============================================================
// Additional: License MCP tool (3-function pattern)
// ============================================================

describe('License MCP tool (3-function pattern)', () => {
  describe('getLicenseToolDefinitions()', () => {
    it('returns definitions with correct prefix', () => {
      const defs = getLicenseToolDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe('massu_license_status');
      expect(defs[0].description).toContain('license');
    });

    it('has valid inputSchema', () => {
      const defs = getLicenseToolDefinitions();
      expect(defs[0].inputSchema.type).toBe('object');
    });
  });

  describe('isLicenseTool()', () => {
    it('matches license_status tool name', () => {
      expect(isLicenseTool('massu_license_status')).toBe(true);
    });

    it('matches with any prefix ending in _license_status', () => {
      expect(isLicenseTool('myapp_license_status')).toBe(true);
    });

    it('does not match other tools', () => {
      expect(isLicenseTool('massu_quality_score')).toBe(false);
      expect(isLicenseTool('massu_sync')).toBe(false);
    });
  });

  describe('handleLicenseToolCall()', () => {
    it('returns license status text for free tier', async () => {
      mockCloudConfig = undefined;
      _resetCachedTier();

      const result = await handleLicenseToolCall('massu_license_status', {}, testDb);
      const text = result.content[0].text;
      expect(text).toContain('## License Status');
      expect(text).toContain('FREE');
      expect(text).toContain('Upgrade at https://massu.ai/pricing');
    });

    it('returns license status text for pro tier without upgrade prompt', async () => {
      const apiKey = 'ms_live_status_key';
      mockCloudConfig = { apiKey, endpoint: 'https://api.massu.ai' };
      insertCache(testDb, apiKey, 'pro', '2027-06-01', hoursAgo(0.1), ['knowledge']);
      _resetCachedTier();

      const result = await handleLicenseToolCall('massu_license_status', {}, testDb);
      const text = result.content[0].text;
      expect(text).toContain('PRO');
      expect(text).not.toContain('Upgrade at https://massu.ai/pricing');
      expect(text).toContain('knowledge');
    });

    it('returns tier capabilities section', async () => {
      mockCloudConfig = undefined;
      _resetCachedTier();

      const result = await handleLicenseToolCall('massu_license_status', {}, testDb);
      const text = result.content[0].text;
      expect(text).toContain('### Tier Capabilities');
      expect(text).toContain('Free');
      expect(text).toContain('Pro');
      expect(text).toContain('Team');
      expect(text).toContain('Enterprise');
    });

    it('returns unknown tool message for unrecognized name', async () => {
      const result = await handleLicenseToolCall('massu_license_unknown', {}, testDb);
      expect(result.content[0].text).toContain('Unknown license tool');
    });
  });
});
