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
import {
  verifyLicenseResponse,
  isLicenseSignatureRequired,
  type SignedLicenseResponse,
} from './security/license-response-verifier.ts';

// P-H019 one-shot warning gate. We emit the stderr warning at most once
// per process lifetime so the customer's terminal isn't spammed every
// session-start until the operator provisions the Edge Function signing key.
let _warnedLicenseSig = false;
function warnLicenseSigOnce(reason: string): void {
  if (_warnedLicenseSig) return;
  _warnedLicenseSig = true;
  process.stderr.write(
    `[massu] WARNING: license-validate response is unsigned or signature invalid (${reason}). ` +
    `Acceptance permitted under transition mode. Operator: provision Supabase Edge Function ` +
    `LICENSE_RESPONSE_SIGNING_PRIVATE_KEY_B64 then set MASSU_REQUIRE_SIGNED_LICENSE=true to enforce strict mode.\n`,
  );
}

// ============================================================
// Types
// ============================================================

// P-E-025 (plan-stage-e-low-info-sweep): tier names live in the shared
// `@massu/types` workspace package so the website + core share a single
// SoT. `ToolTier` is preserved as an alias for `TierName` so existing
// imports across the codebase continue to resolve without a wide
// refactor.
import type { TierName } from '@massu/types';
export type ToolTier = TierName;

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
  // P-M-042 (plan-stage-d-medium-sweep): memory_backfill serves the
  // customer's MEMORY.md ingestion workflow and was registered in
  // memory-tools.ts but missing from TOOL_TIER_MAP. The bijection
  // drift-guard (P-M-033) would have caught it on next add; we land it
  // explicitly as Free since it's a customer-owned-data ingestion path.
  memory_backfill: 'free',
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

  // Pro tier — Python code intelligence
  py_imports: 'pro',
  py_routes: 'pro',
  py_coupling: 'pro',
  py_models: 'pro',
  py_migrations: 'pro',
  py_domains: 'pro',
  py_impact: 'pro',
  py_context: 'pro',

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

// P-E-011 (plan-stage-e-low-info-sweep, wave1-mcp-tools:F-MCP-007):
// Free-tier tools now carry an explicit `[FREE]` prefix so the
// listing surface is symmetric. Customers browsing `ListTools` no
// longer have to infer "no prefix == free" — the tier is named on
// every tool. Idempotent strip below handles existing un-prefixed
// descriptions on first run.
const TIER_LABELS: Record<ToolTier, string> = {
  free: '[FREE] ',
  pro: '[PRO] ',
  team: '[TEAM] ',
  enterprise: '[ENTERPRISE] ',
};

/**
 * Annotate tool definitions with tier labels in descriptions.
 * Stores the structured tier under `annotations.tier` (MCP-spec-sanctioned
 * extension point) — never as a top-level field, which violates the
 * canonical Tool schema (schema/2025-11-25/schema.ts line 1251) and is
 * silently rejected by Claude Code 2.1.143+ (massu-ai/massu#4).
 * Free tools get no label prefix.
 */
export function annotateToolDefinitions(defs: ToolDefinition[]): ToolDefinition[] {
  // P-M-033 (plan-stage-d-medium-sweep): runtime bijection assertion BEFORE
  // we override. If a def arrives with annotations.tier already set, the
  // value MUST match TOOL_TIER_MAP. A divergence indicates someone
  // hand-edited a tool def's tier field — structural drift surface that
  // would otherwise be silently corrected here and ship with mismatched
  // wire / placement tier. Throwing forces the source-of-truth back into
  // TOOL_TIER_MAP.
  for (const def of defs) {
    const expectedTier = getToolTier(def.name);
    const incomingTier = (def.annotations as { tier?: ToolTier } | undefined)?.tier;
    if (incomingTier !== undefined && incomingTier !== expectedTier) {
      throw new Error(
        `TOOL_TIER_MAP bijection violation (P-M-033): tool "${def.name}" has annotations.tier="${incomingTier}" but TOOL_TIER_MAP says "${expectedTier}". TOOL_TIER_MAP is the SoT — fix the source instead.`
      );
    }
    const expectedPrefix = TIER_LABELS[expectedTier];
    // Description must NOT already have a wrong prefix. An empty/missing
    // prefix is fine (we add it below); a wrong prefix would compound.
    for (const otherPrefix of Object.values(TIER_LABELS)) {
      if (otherPrefix && otherPrefix !== expectedPrefix && def.description.startsWith(otherPrefix)) {
        throw new Error(
          `TOOL_TIER_MAP bijection violation (P-M-033): tool "${def.name}" description starts with "${otherPrefix}" but TOOL_TIER_MAP tier is "${expectedTier}" (expected prefix "${expectedPrefix}").`
        );
      }
    }
  }

  return defs.map(def => {
    const tier = getToolTier(def.name);
    const label = TIER_LABELS[tier];
    // Re-prefix idempotently: strip any existing matching prefix so
    // re-running annotation doesn't produce "[PRO] [PRO] foo".
    const stripped = label && def.description.startsWith(label)
      ? def.description.slice(label.length)
      : def.description;
    return {
      ...def,
      annotations: { ...(def.annotations ?? {}), tier },
      description: label ? `${label}${stripped}` : stripped,
    };
  });
}

// ============================================================
// plan-1.7.0-cohesive-cleanup P-A-003: Cloud feature availability gate
// ============================================================

/**
 * Whether cloud-gated tool surfaces (team knowledge, etc.) are exposed.
 *
 * Returns true ONLY when `massu.config.yaml` opts the workspace into the
 * cloud feature surface via `cloud.enabled: true`. Defaults to false for
 * fresh installs (the schema's `enabled` default is `false`).
 *
 * This is distinct from {@link isLicenseTool} (which matches tool NAMES);
 * `isCloudFeatureAvailable` is a runtime feature-availability check used
 * by `tools.ts` to gate team-tool registration and routing at the
 * tools-list and dispatch boundaries.
 */
export function isCloudFeatureAvailable(): boolean {
  return getConfig().cloud?.enabled === true;
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
/** Offline grace window: a cached row not re-validated within this span drops to free. */
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
      'SELECT tier, valid_until, last_validated, features, signed_payload_json FROM license_cache WHERE api_key_hash = ?'
    ).get(keyHash) as {
      tier: string;
      valid_until: string;
      last_validated: string;
      features: string;
      signed_payload_json: string;
    } | undefined;

    // P-M-023 (plan-stage-d-medium-sweep): read cache through the signed
    // wire payload, never the plain columns. Editing tier/valid_until in
    // SQLite is a no-op because we re-extract from the verified payload.
    // Returns the trusted LicenseInfo, or null when the row is missing /
    // unsigned / has an invalid signature.
    const trusted = cached ? readTrustedCache(cached) : null;

    if (cached && trusted) {
      const lastValidated = new Date(cached.last_validated);
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

      // Cache is fresh (< 1 hour old)
      if (lastValidated > hourAgo) {
        return trusted;
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
            _signature?: string;
            _signature_alg?: string;
            _signature_payload_keys?: readonly string[];
            _signature_pubkey_fingerprint?: string;
          };

          // P-H019 (plan-stage-c-high-batch / 1.10.5): verify Ed25519
          // signature on the validate-key response. Closes the bug class
          // where MITM / malicious-cloud-endpoint / local SQLite edit
          // could grant arbitrary tier.
          //
          // Transition mode (default): unsigned/invalid-sig responses are
          // accepted with a one-shot stderr warning. Lets existing customers
          // keep working while operators provision the Edge Function signing
          // key.
          //
          // Strict mode (MASSU_REQUIRE_SIGNED_LICENSE=true, post-cutover):
          // unsigned/invalid-sig responses are rejected; caller falls
          // through to the grace-period cache or free tier.
          const sigResult = verifyLicenseResponse(data);
          if (sigResult.kind !== 'valid') {
            if (isLicenseSignatureRequired()) {
              // Strict mode — reject. Caller falls through to grace period.
              throw new Error(`License response signature invalid: ${sigResult.kind}`);
            }
            // Transition mode — one-shot stderr warning per session.
            warnLicenseSigOnce(sigResult.kind);
          }

          if (data.valid) {
            // Map plan name to tier using PLAN_TO_TIER_MAP
            const tier: ToolTier = data.plan
              ? (PLAN_TO_TIER_MAP[data.plan] ?? 'free')
              : (data.tier as ToolTier ?? 'free');
            const validUntil = data.validUntil ?? '';
            const features = data.features ?? [];

            // P-M-023: persist the entire signed payload so cache reads
            // re-verify the Ed25519 signature instead of trusting plain
            // SQLite columns. Pre-1.11.0 cache rows without
            // signed_payload_json fall through to free tier on read.
            updateLicenseCache(
              apiKey,
              tier,
              validUntil,
              features,
              sigResult.kind === 'valid' ? data : null,
            );

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

    // 3. Grace period: cache exists but stale (up to 7 days). P-M-023:
    // only honour the grace window when the cached row was authoritatively
    // signed; an unsigned / tampered row drops straight to free tier.
    if (cached && trusted) {
      const lastValidated = new Date(cached.last_validated);
      const sevenDaysAgo = new Date(Date.now() - GRACE_PERIOD_MS);

      // P3-013: 7-day grace period
      if (lastValidated > sevenDaysAgo) {
        return trusted;
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
 *
 * P-M-023: the optional `signedPayload` carries the entire signed
 * /validate-key wire response (with `_signature` triplet). Stored verbatim
 * as JSON so cache reads can re-verify the Ed25519 signature. Pass `null`
 * if the upstream response was unsigned (transition mode) — the row will
 * NOT be honoured on subsequent reads under strict mode.
 */
export function updateLicenseCache(
  apiKey: string,
  tier: ToolTier,
  validUntil: string,
  features: string[] = [],
  signedPayload: SignedLicenseResponse | null = null,
): void {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const memDb = getMemoryDb();
  try {
    memDb.prepare(`
      INSERT OR REPLACE INTO license_cache (api_key_hash, tier, valid_until, last_validated, features, signed_payload_json)
      VALUES (?, ?, ?, datetime('now'), ?, ?)
    `).run(
      keyHash,
      tier,
      validUntil,
      JSON.stringify(features),
      signedPayload ? JSON.stringify(signedPayload) : '',
    );
  } finally {
    memDb.close();
  }
}

/** Shape of a license_cache row as read from SQLite. */
interface LicenseCacheRow {
  tier: string;
  valid_until: string;
  last_validated: string;
  features: string;
  signed_payload_json: string;
}

/**
 * P-M-023: read a license_cache row through the signed wire payload.
 * Returns the trusted LicenseInfo when the stored signature verifies, or
 * `null` when the row is missing, unsigned, or tampered. Strict mode
 * (MASSU_REQUIRE_SIGNED_LICENSE=true) rejects unsigned rows; transition
 * mode accepts them but emits a one-shot stderr warning.
 */
function readTrustedCache(cached: LicenseCacheRow): LicenseInfo | null {
  // Unsigned row (pre-P-M-023 or upstream-unsigned-during-transition).
  if (!cached.signed_payload_json) {
    if (isLicenseSignatureRequired()) return null;
    warnLicenseSigOnce('cache_unsigned_transition');
    return {
      tier: cached.tier as ToolTier,
      validUntil: cached.valid_until,
      features: JSON.parse(cached.features || '[]'),
    };
  }

  let parsed: SignedLicenseResponse;
  try {
    parsed = JSON.parse(cached.signed_payload_json) as SignedLicenseResponse;
  } catch {
    return null;
  }

  const result = verifyLicenseResponse(parsed);
  if (result.kind !== 'valid') return null;

  // Re-derive tier from the VERIFIED payload, NOT the plain SQLite column.
  // Editing the tier column directly is structurally a no-op now.
  const verifiedPlan = typeof parsed.plan === 'string' ? parsed.plan : null;
  const verifiedTierField = typeof parsed.tier === 'string' ? (parsed.tier as ToolTier) : null;
  const tier: ToolTier = verifiedPlan
    ? (PLAN_TO_TIER_MAP[verifiedPlan] ?? 'free')
    : (verifiedTierField ?? 'free');
  const validUntil = typeof parsed.validUntil === 'string' ? parsed.validUntil : '';
  const features = Array.isArray(parsed.features) ? (parsed.features as string[]) : [];
  return { tier, validUntil, features };
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
 * Hook-safe, SYNCHRONOUS tier reader. NEVER calls the network — does one
 * indexed SQLite read against `license_cache` and resolves the tier through
 * the SAME signed-payload trust path as {@link validateLicense}
 * ({@link readTrustedCache}). Used by short-lived hook processes
 * (e.g. user-prompt) where the network path of {@link getCurrentTier}
 * (10s timeout) would blow the <5s hook budget.
 *
 * Fail-closed at every branch: no API key, missing/unsigned-in-strict/
 * tampered/parse-error row, or a row older than the 7-day grace window → `'free'`.
 *
 * @param memDb Optional caller-owned memory-db handle. When provided, the
 *              reader reuses it (and does NOT close it — caller owns its
 *              lifecycle) to avoid a second SQLite open inside a hook that
 *              already has the connection open. When omitted, opens its own
 *              via `getMemoryDb()` and closes it before returning.
 */
export function getCachedTierReadOnly(memDb?: import('better-sqlite3').Database): ToolTier {
  const config = getConfig();
  const apiKey = config.cloud?.apiKey;
  if (!apiKey) return 'free';

  const ownsDb = !memDb;
  const db = memDb ?? getMemoryDb();
  try {
    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const cached = db.prepare(
      'SELECT tier, valid_until, last_validated, features, signed_payload_json FROM license_cache WHERE api_key_hash = ?'
    ).get(keyHash) as LicenseCacheRow | undefined;

    if (!cached) return 'free';

    // Resolve through the signed-payload trust path (shared with
    // validateLicense). For a SIGNED row the tier is re-derived from the
    // verified payload, so editing the plain `tier` column is a no-op. In
    // default transition mode (MASSU_REQUIRE_SIGNED_LICENSE unset) an UNSIGNED
    // row's plain `tier` column is still trusted (one-shot warn) — same posture
    // as validateLicense; this is the disclosed freemium-OSS threat model, not
    // a regression. Strict mode rejects unsigned rows.
    const trusted = readTrustedCache(cached);
    if (!trusted) return 'free';

    // Offline grace window: a row not re-validated within GRACE_PERIOD_MS
    // drops to free (gated on last_validated, mirroring validateLicense's
    // grace path — intentionally NOT a valid_until check; server-side
    // /validate-key is the authoritative expiry boundary).
    const lastValidated = new Date(cached.last_validated);
    const sevenDaysAgo = new Date(Date.now() - GRACE_PERIOD_MS);
    if (!(lastValidated > sevenDaysAgo)) return 'free';

    return trusted.tier;
  } catch {
    // Any parse / DB / verify error → fail-closed.
    return 'free';
  } finally {
    if (ownsDb) {
      try { db.close(); } catch { /* best-effort */ }
    }
  }
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

/**
 * Seed the in-memory tier cache (for testing only). Mirrors
 * {@link _resetCachedTier}; lets async-path tests simulate a Pro/Team session
 * without a live license server. The seeded value is honored by
 * {@link getCurrentTier} for the in-memory TTL window.
 */
export function _setCachedTierForTest(tier: ToolTier): void {
  cachedTier = { tier, validUntil: '', features: [] };
  cachedTierTimestamp = Date.now();
}
