// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { TOOL_TIER_MAP, type ToolTier } from '../license.ts';

/**
 * P4-011: Tier coverage test.
 *
 * Verifies that every tool base name has a valid tier mapping in TOOL_TIER_MAP,
 * that no tier values are invalid, and that the expected tool count is maintained.
 *
 * Approach: We verify the TOOL_TIER_MAP directly rather than calling
 * getToolDefinitions() (which requires a live DB). This is the same approach
 * used by the existing license.test.ts P3-023 tests.
 */

const VALID_TIERS: ToolTier[] = ['free', 'pro', 'team', 'enterprise'];

// Complete list of all expected tool base names across all modules.
// Keep this in sync when adding or removing tools.
const EXPECTED_TOOL_NAMES: string[] = [
  // --- Free tier: core tools (inline in tools.ts) ---
  'sync',
  'context',
  'impact',
  'domains',
  'schema',
  'trpc_map',
  'coupling_check',

  // --- Free tier: memory tools ---
  'memory_search',
  'memory_ingest',

  // --- Free tier: regression tools ---
  'regression_risk',
  'feature_health',

  // --- Free tier: license tool ---
  'license_status',

  // --- Pro tier: advanced memory tools ---
  'memory_timeline',
  'memory_detail',
  'memory_sessions',
  'memory_failures',

  // --- Pro tier: knowledge tools ---
  'knowledge_search',
  'knowledge_rule',
  'knowledge_incident',
  'knowledge_schema_check',
  'knowledge_pattern',
  'knowledge_verification',
  'knowledge_graph',
  'knowledge_command',
  'knowledge_correct',
  'knowledge_plan',
  'knowledge_gaps',
  'knowledge_effectiveness',

  // --- Pro tier: analytics tools ---
  'quality_score',
  'quality_trend',
  'quality_report',

  // --- Pro tier: cost tools ---
  'cost_session',
  'cost_trend',
  'cost_feature',

  // --- Pro tier: prompt tools ---
  'prompt_effectiveness',
  'prompt_suggestions',

  // --- Pro tier: validation tools ---
  'validation_check',
  'validation_report',

  // --- Pro tier: ADR tools ---
  'adr_list',
  'adr_detail',
  'adr_create',

  // --- Pro tier: observability tools ---
  'session_replay',
  'prompt_analysis',
  'tool_patterns',
  'session_stats',

  // --- Pro tier: docs tools ---
  'docs_audit',
  'docs_coverage',

  // --- Team tier: sentinel tools ---
  'sentinel_search',
  'sentinel_detail',
  'sentinel_impact',
  'sentinel_validate',
  'sentinel_register',
  'sentinel_parity',

  // --- Team tier: team knowledge tools ---
  'team_search',
  'team_expertise',
  'team_conflicts',

  // --- Enterprise tier: audit tools ---
  'audit_log',
  'audit_report',
  'audit_chain',

  // --- Enterprise tier: security tools ---
  'security_score',
  'security_heatmap',
  'security_trend',

  // --- Enterprise tier: dependency tools ---
  'dep_score',
  'dep_alternatives',
];

describe('P4-011: Tier Coverage', () => {
  it('every tier value in TOOL_TIER_MAP is valid', () => {
    for (const [toolName, tier] of Object.entries(TOOL_TIER_MAP)) {
      expect(
        VALID_TIERS.includes(tier as ToolTier),
        `Tool "${toolName}" has invalid tier: "${tier}". Must be one of: ${VALID_TIERS.join(', ')}`,
      ).toBe(true);
    }
  });

  it('every expected tool name has a tier mapping', () => {
    const missingTools: string[] = [];
    for (const toolName of EXPECTED_TOOL_NAMES) {
      if (!(toolName in TOOL_TIER_MAP)) {
        missingTools.push(toolName);
      }
    }
    if (missingTools.length > 0) {
      expect.fail(
        `${missingTools.length} tool(s) missing from TOOL_TIER_MAP:\n` +
          missingTools.map((t) => `  - ${t}`).join('\n'),
      );
    }
  });

  it('TOOL_TIER_MAP has no extra entries beyond expected tools', () => {
    const expectedSet = new Set(EXPECTED_TOOL_NAMES);
    const extraTools: string[] = [];
    for (const toolName of Object.keys(TOOL_TIER_MAP)) {
      if (!expectedSet.has(toolName)) {
        extraTools.push(toolName);
      }
    }
    if (extraTools.length > 0) {
      expect.fail(
        `${extraTools.length} unexpected tool(s) in TOOL_TIER_MAP not in expected list:\n` +
          extraTools.map((t) => `  - ${t} (tier: ${TOOL_TIER_MAP[t]})`).join('\n') +
          '\n\nAdd these to EXPECTED_TOOL_NAMES in tier-coverage.test.ts if they are intentional.',
      );
    }
  });

  it('has the expected total tool count (~67)', () => {
    const count = Object.keys(TOOL_TIER_MAP).length;
    // Allow a small tolerance for in-progress additions
    expect(count).toBeGreaterThanOrEqual(60);
    expect(count).toBeLessThanOrEqual(80);
    // Exact count check — update this when tools are added/removed
    expect(count).toBe(EXPECTED_TOOL_NAMES.length);
  });

  it('expected tool names list has no duplicates', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const name of EXPECTED_TOOL_NAMES) {
      if (seen.has(name)) {
        duplicates.push(name);
      }
      seen.add(name);
    }
    if (duplicates.length > 0) {
      expect.fail(
        `Duplicate entries in EXPECTED_TOOL_NAMES:\n` +
          duplicates.map((d) => `  - ${d}`).join('\n'),
      );
    }
  });

  it('tier distribution is reasonable', () => {
    const tierCounts: Record<string, number> = { free: 0, pro: 0, team: 0, enterprise: 0 };
    for (const tier of Object.values(TOOL_TIER_MAP)) {
      tierCounts[tier] = (tierCounts[tier] || 0) + 1;
    }

    // Free tier should have core tools (7 core + 2 memory + 2 regression + 1 license = 12)
    expect(tierCounts.free).toBeGreaterThanOrEqual(10);

    // Pro tier should have the most tools (analytics + cost + prompt + validation + adr + obs + docs + knowledge)
    expect(tierCounts.pro).toBeGreaterThanOrEqual(20);

    // Team tier should have sentinel + team knowledge tools
    expect(tierCounts.team).toBeGreaterThanOrEqual(4);

    // Enterprise tier should have audit + security + dependency tools
    expect(tierCounts.enterprise).toBeGreaterThanOrEqual(6);
  });
});
