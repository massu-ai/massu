// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * License module — tier enforcement for Massu tools.
 *
 * Exports:
 * - ToolTier type and TOOL_TIER_MAP constant
 * - getCurrentTier() — cached license status for the session
 * - getToolTier(name) — required tier for a tool
 * - isToolAllowed(toolName, userTier) — gate check
 * - annotateToolDefinitions(defs) — add tier labels to descriptions
 * - getLicenseToolDefinitions / isLicenseTool / handleLicenseToolCall — 3-function pattern
 */

import { createHash } from 'crypto';
import type { ToolDefinition, ToolResult } from './tools.ts';
import { getConfig } from './config.ts';
import { getMemoryDb } from './memory-db.ts';

// ============================================================
// Types
// ============================================================

export type ToolTier = 'free' | 'pro' | 'team' | 'enterprise';

// ============================================================
// Tier Ordering (for comparison)
// ============================================================

const TIER_LEVELS: Record<ToolTier, number> = {
  free: 0,
  pro: 1,
  team: 2,
  enterprise: 3,
};

/** Return numeric level for tier comparison. Higher = more permissive. */
export function tierLevel(tier: ToolTier): number {
  return TIER_LEVELS[tier] ?? 0;
}

// ============================================================
// P3-002: Tool Tier Map
// ============================================================

/**
 * Maps every tool base name (without prefix) to its required tier.
 * Tools not in this map default to 'free'.
 *
 * Free: core navigation + basic memory + regression
 * Pro: knowledge, quality, cost, prompt, validation, ADR, observability, docs
 * Team: sentinel, team knowledge
 * Enterprise: audit, security, dependency
 */
export const TOOL_TIER_MAP: Record<string, ToolTier> = {
  // --- Free tier (12 tools: core navigation + basic memory + regression + license) ---
  sync: 'free',
  context: 'free',
  impact: 'free',
  domains: 'free',
  schema: 'free',
  trpc_map: 'free',
  coupling_check: 'free',
  memory_search: 'free',
  memory_ingest: 'free',
  regression_risk: 'free',
  feature_health: 'free',
  license_status: 'free',

  // --- Pro tier (35 tools: knowledge, quality, cost, prompt, validation, ADR, observability, docs, advanced memory) ---
  memory_timeline: 'pro',
  memory_detail: 'pro',
  memory_sessions: 'pro',
  memory_failures: 'pro',
  knowledge_search: 'pro',
  knowledge_rule: 'pro',
  knowledge_incident: 'pro',
  knowledge_schema_check: 'pro',
  knowledge_pattern: 'pro',
  knowledge_verification: 'pro',
  knowledge_graph: 'pro',
  knowledge_command: 'pro',
  knowledge_correct: 'pro',
  knowledge_plan: 'pro',
  knowledge_gaps: 'pro',
  knowledge_effectiveness: 'pro',
  quality_score: 'pro',
  quality_trend: 'pro',
  quality_report: 'pro',
  cost_session: 'pro',
  cost_trend: 'pro',
  cost_feature: 'pro',
  prompt_effectiveness: 'pro',
  prompt_suggestions: 'pro',
  validation_check: 'pro',
  validation_report: 'pro',
  adr_list: 'pro',
  adr_detail: 'pro',
  adr_create: 'pro',
  session_replay: 'pro',
  prompt_analysis: 'pro',
  tool_patterns: 'pro',
  session_stats: 'pro',
  docs_audit: 'pro',
  docs_coverage: 'pro',

  // --- Team tier (9 tools: sentinel feature registry + team knowledge) ---
  sentinel_search: 'team',
  sentinel_detail: 'team',
  sentinel_impact: 'team',
  sentinel_validate: 'team',
  sentinel_register: 'team',
  sentinel_parity: 'team',
  team_search: 'team',
  team_expertise: 'team',
  team_conflicts: 'team',

  // --- Enterprise tier (8 tools: audit trail + security scoring + dependency analysis) ---
  audit_log: 'enterprise',
  audit_report: 'enterprise',
  audit_chain: 'enterprise',
  security_score: 'enterprise',
  security_heatmap: 'enterprise',
  security_trend: 'enterprise',
  dep_score: 'enterprise',
  dep_alternatives: 'enterprise',
};

// ============================================================
// P3-002: Plan-to-tier mapping (from organizations.plan values)
// ============================================================

export const PLAN_TO_TIER_MAP: Record<string, ToolTier> = {
  free: 'free',
  cloud_pro: 'pro',
  cloud_team: 'team',
  cloud_enterprise: 'enterprise',
};

// ============================================================
// P3-003: getToolTier
// ============================================================

/**
 * Get the required tier for a tool by name.
 * Strips the configured prefix, looks up in TOOL_TIER_MAP, defaults to 'free'.
 */
export function getToolTier(name: string): ToolTier {
  const pfx = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;
  return TOOL_TIER_MAP[baseName] ?? 'free';
}

// ============================================================
// P3-001: isToolAllowed
// ============================================================

/**
 * Check if a tool is accessible at the given user tier.
 * A user can access tools at their tier level or below.
 */
export function isToolAllowed(toolName: string, userTier: ToolTier): boolean {
  const requiredTier = getToolTier(toolName);
  return tierLevel(userTier) >= tierLevel(requiredTier);
}

// ============================================================
// P3-004: annotateToolDefinitions
// ============================================================

const TIER_LABELS: Record<ToolTier, string> = {
  free: '',
  pro: '[PRO] ',
  team: '[TEAM] ',
  enterprise: '[ENTERPRISE] ',
};

/**
 * Annotate tool definitions with tier labels in descriptions.
 * Also sets the `tier` field on each definition.
 * Free tools get no label prefix.
 */
export function annotateToolDefinitions(defs: ToolDefinition[]): ToolDefinition[] {
  return defs.map(def => {
    const tier = getToolTier(def.name);
    const label = TIER_LABELS[tier];
    return {
      ...def,
      tier,
      description: label ? `${label}${def.description}` : def.description,
    };
  });
}

// ============================================================
// P3-005/P3-006/P3-007/P3-013: License validation & caching
// ============================================================

interface LicenseInfo {
  tier: ToolTier;
  validUntil: string;
  features: string[];
}

/** In-memory cache for the current session. Refreshes every 15 minutes. */
let cachedTier: LicenseInfo | null = null;
let cachedTierTimestamp: number = 0;
const IN_MEMORY_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Validate a license key against the cloud endpoint.
 * Uses local cache in memory.db with 1-hour freshness window.
 * Performs async cloud validation via fetch() (Node 18+).
 * Falls back to 7-day grace period on network failure.
 */
export async function validateLicense(apiKey: string): Promise<LicenseInfo> {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');

  // 1. Check local cache
  const memDb = getMemoryDb();
  try {
    const cached = memDb.prepare(
      'SELECT tier, valid_until, last_validated, features FROM license_cache WHERE api_key_hash = ?'
    ).get(keyHash) as { tier: string; valid_until: string; last_validated: string; features: string } | undefined;

    if (cached) {
      const lastValidated = new Date(cached.last_validated);
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

      // Cache is fresh (< 1 hour old)
      if (lastValidated > hourAgo) {
        return {
          tier: cached.tier as ToolTier,
          validUntil: cached.valid_until,
          features: JSON.parse(cached.features || '[]'),
        };
      }
    }

    // 2. Try cloud validation via fetch (Node 18+ has native fetch)
    const config = getConfig();
    const endpoint = config.cloud?.endpoint;

    if (endpoint && /^https?:\/\/.+/.test(endpoint)) {
      try {
        const response = await fetch(`${endpoint}/validate-key`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(10_000), // 10s timeout
        });

        if (response.ok) {
          const data = await response.json() as {
            valid: boolean;
            plan?: string;
            tier?: string;
            validUntil?: string;
            features?: string[];
            reason?: string;
          };

          if (data.valid) {
            // Map plan name to tier using PLAN_TO_TIER_MAP
            const tier: ToolTier = data.plan
              ? (PLAN_TO_TIER_MAP[data.plan] ?? 'free')
              : (data.tier as ToolTier ?? 'free');
            const validUntil = data.validUntil ?? '';
            const features = data.features ?? [];

            // Update local cache
            updateLicenseCache(apiKey, tier, validUntil, features);

            return { tier, validUntil, features };
          }
          // Server said key is not valid — return free tier
          return { tier: 'free', validUntil: '', features: [] };
        }
        // Non-OK response — fall through to grace period
      } catch {
        // Network failure — fall through to grace period check
      }
    }

    // 3. Grace period: cache exists but stale (up to 7 days)
    if (cached) {
      const lastValidated = new Date(cached.last_validated);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // P3-013: 7-day grace period
      if (lastValidated > sevenDaysAgo) {
        return {
          tier: cached.tier as ToolTier,
          validUntil: cached.valid_until,
          features: JSON.parse(cached.features || '[]'),
        };
      }
    }

    // 4. No valid cache — default to free
    return { tier: 'free', validUntil: '', features: [] };
  } finally {
    memDb.close();
  }
}

/**
 * Update the license cache in memory.db.
 * Called by the session-start hook after async cloud validation.
 */
export function updateLicenseCache(
  apiKey: string,
  tier: ToolTier,
  validUntil: string,
  features: string[] = []
): void {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const memDb = getMemoryDb();
  try {
    memDb.prepare(`
      INSERT OR REPLACE INTO license_cache (api_key_hash, tier, valid_until, last_validated, features)
      VALUES (?, ?, ?, datetime('now'), ?)
    `).run(keyHash, tier, validUntil, JSON.stringify(features));
  } finally {
    memDb.close();
  }
}

// ============================================================
// P3-007: getCurrentTier
// ============================================================

/**
 * Get the current user's tier. Cached in-memory for the server process lifetime.
 * If no API key configured, returns 'free'.
 */
export async function getCurrentTier(): Promise<ToolTier> {
  // Check if in-memory cache is still fresh (15-minute TTL)
  if (cachedTier && (Date.now() - cachedTierTimestamp) < IN_MEMORY_CACHE_TTL_MS) {
    return cachedTier.tier;
  }

  const config = getConfig();
  const apiKey = config.cloud?.apiKey;

  if (!apiKey) {
    cachedTier = { tier: 'free', validUntil: '', features: [] };
    cachedTierTimestamp = Date.now();
    return 'free';
  }

  const info = await validateLicense(apiKey);
  cachedTier = info;
  cachedTierTimestamp = Date.now();
  return info.tier;
}

/**
 * Get full license info (tier, validUntil, features).
 * Triggers getCurrentTier() if not already cached.
 */
export async function getLicenseInfo(): Promise<LicenseInfo> {
  if (!cachedTier || (Date.now() - cachedTierTimestamp) >= IN_MEMORY_CACHE_TTL_MS) {
    await getCurrentTier();
  }
  return cachedTier!;
}

/**
 * Days remaining until license expires. Returns -1 if no expiry set.
 */
export async function daysUntilExpiry(): Promise<number> {
  const info = await getLicenseInfo();
  if (!info.validUntil) return -1;
  const expiry = new Date(info.validUntil);
  const now = new Date();
  const diffMs = expiry.getTime() - now.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

// ============================================================
// P3-021: License Status Tool (3-function pattern)
// ============================================================

/**
 * Tool definitions for the license status tool.
 * Always available (free tier).
 */
export function getLicenseToolDefinitions(): ToolDefinition[] {
  const pfx = getConfig().toolPrefix;
  return [
    {
      name: `${pfx}_license_status`,
      description: 'Show current license status, tier, features, and upgrade options.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  ];
}

/**
 * Check if a tool name matches a license tool.
 */
export function isLicenseTool(name: string): boolean {
  return name.endsWith('_license_status');
}

/**
 * Handle license tool calls.
 */
export async function handleLicenseToolCall(
  name: string,
  _args: Record<string, unknown>,
  _memDb: import('better-sqlite3').Database
): Promise<ToolResult> {
  if (name.endsWith('_license_status')) {
    const info = await getLicenseInfo();
    const days = await daysUntilExpiry();

    const lines: string[] = [];
    lines.push('## License Status');
    lines.push('');
    lines.push(`**Tier**: ${info.tier.toUpperCase()}`);

    if (info.validUntil) {
      lines.push(`**Valid Until**: ${info.validUntil}`);
      if (days >= 0) {
        lines.push(`**Days Remaining**: ${days}`);
      }
    }

    if (info.features.length > 0) {
      lines.push('');
      lines.push('**Features**:');
      for (const f of info.features) {
        lines.push(`- ${f}`);
      }
    }

    lines.push('');
    lines.push('### Tier Capabilities');
    lines.push('- **Free**: Core navigation, memory, regression detection');
    lines.push('- **Pro**: Knowledge search, quality analytics, cost tracking, observability');
    lines.push('- **Team**: Sentinel feature registry, team knowledge sharing');
    lines.push('- **Enterprise**: Audit trail, security scoring, dependency analysis');

    if (info.tier === 'free') {
      lines.push('');
      lines.push('Upgrade at https://massu.ai/pricing');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  return { content: [{ type: 'text', text: `Unknown license tool: ${name}` }] };
}

// ============================================================
// Reset (for testing)
// ============================================================

/** Reset cached tier (for testing only). */
export function _resetCachedTier(): void {
  cachedTier = null;
  cachedTierTimestamp = 0;
}
