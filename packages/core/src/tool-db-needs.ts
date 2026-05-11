// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Per-tool SQLite database dependency manifest.
 *
 * **Role**: SOLE source of truth declaring which SQLite connections each MCP
 * tool needs. The dispatcher (`server.ts` → `tools.ts:handleToolCall`) reads
 * this map to lazy-resolve connections, opening ONLY the DBs a tool requires.
 *
 * **Why this exists**:
 * Before plan `plan-1.6.2-server-lazy-db-deps`, the dispatcher eagerly opened
 * BOTH CodeGraph + Data DBs on every tool/call (see legacy `server.ts:51-55,96`
 * and `tools.ts:279`). When `.codegraph/codegraph.db` was missing, EVERY tool
 * call failed — even memory/audit/knowledge tools that have no codegraph
 * dependency. This manifest makes that bug class structurally impossible:
 * a missing peripheral DB only blocks the tools that need it.
 *
 * **Structural drift-prevention (3 layers)**:
 *   - L1: TypeScript compile time — exhaustiveness check via `keyof TOOL_DB_NEEDS`.
 *   - L2: `tool-db-needs-completeness.test.ts` — TypeScript AST walk of every
 *         tool module verifies declared needs match actual DB access pattern.
 *         Aliasing/destructuring renames cannot bypass the AST walk.
 *   - L3: `scripts/massu-pattern-scanner.sh` Check 14 — grep-level enforcement
 *         that every tool in `getToolDefinitions()` has a manifest entry.
 *
 * **Adding a new MCP tool**:
 *   1. Register in `tools.ts` (CR-11).
 *   2. Add an entry here. Missing entries throw `UnknownToolError` at first
 *      dispatch AND fail L2 + L3 above.
 *
 * @see `docs/plans/2026-05-10-server-lazy-db-deps.md` (`plan-1.6.2-server-lazy-db-deps`)
 */

/** SQLite connections the MCP server can resolve for a tool call. */
export type DbNeed = 'codegraph' | 'data' | 'memory' | 'knowledge';

/**
 * Custom error thrown when `getToolDbNeeds()` is called with a tool name that
 * isn't in the manifest. Caught at the JSON-RPC layer and translated to a
 * structured `-32602` (Invalid params) error to the client.
 */
export class UnknownToolError extends Error {
  readonly toolName: string;
  constructor(toolName: string) {
    super(`Tool not registered in TOOL_DB_NEEDS manifest: ${toolName}. Add an entry to packages/core/src/tool-db-needs.ts.`);
    this.name = 'UnknownToolError';
    this.toolName = toolName;
  }
}

/**
 * Per-tool DB-need declarations. Keys are tool SHORT-NAMES (without the
 * `${toolPrefix}_` prefix). Values are the SQLite connections the handler
 * (or its routed module) actually accesses.
 *
 * Sourced from exhaustive grep of `packages/core/src/{*-tools,analytics,
 * cost-tracker,prompt-analyzer,audit-trail,validation-engine,adr-generator,
 * security-scorer,dependency-scorer,team-knowledge,regression-detector,
 * python-tools,license}.ts` on 2026-05-10. Verified line citations in
 * `docs/plans/2026-05-10-server-lazy-db-deps.md §1.4`.
 */
export const TOOL_DB_NEEDS = {
  // === Core code-intel tools (tools.ts:393-406) ===
  // Use CodeGraph DB (read-only AST) + Data DB (Massu's import/trpc/sentinel
  // tables). All call `ensureIndexes` directly or via shared infrastructure.
  sync: ['codegraph', 'data'],
  context: ['codegraph', 'data'],
  coupling_check: ['codegraph', 'data'],
  impact: ['codegraph', 'data'],
  domains: ['codegraph', 'data'],

  // `trpc_map` reads only Data DB (tRPC index lives there); no CodeGraph access.
  trpc_map: ['data'],

  // `schema` reads filesystem (Prisma schema files); no DB access at all.
  schema: [],

  // === Memory tools (memory-tools.ts) ===
  // Routed via `name.startsWith(pfx + '_memory_')` at tools.ts:284-290.
  // Handler opens memory DB per-call (with try/finally close).
  memory_search: ['memory'],
  memory_timeline: ['memory'],
  memory_detail: ['memory'],
  memory_sessions: ['memory'],
  memory_failures: ['memory'],
  memory_ingest: ['memory'],
  memory_backfill: ['memory'],

  // === Observability tools (observability-tools.ts) ===
  // Routed via `isObservabilityTool(name)` at tools.ts:294-300. Memory DB only.
  session_replay: ['memory'],
  session_stats: ['memory'],
  tool_patterns: ['memory'],
  prompt_analysis: ['memory'],

  // === Docs tools (docs-tools.ts) ===
  // Routed via `name.startsWith(pfx + '_docs_')` at tools.ts:303-306.
  // No DB access — pure filesystem traversal.
  docs_audit: [],
  docs_coverage: [],

  // === Sentinel registry tools (sentinel-tools.ts:180-184) ===
  // Routed via `name.startsWith(pfx + '_sentinel_')` at tools.ts:308.
  // Handler signature: `(name, args, dataDb)` — Data DB only.
  sentinel_register: ['data'],
  sentinel_validate: ['data'],
  sentinel_search: ['data'],
  sentinel_detail: ['data'],
  sentinel_impact: ['data'],
  sentinel_parity: ['data'],

  // === Knowledge layer tools (knowledge-tools.ts) ===
  // Routed via `isKnowledgeTool(name)` at tools.ts:372-376. Primary DB is
  // `knowledgeDb` (separate SQLite file). Handlers ALSO call `getDataDb()`
  // (knowledge-tools.ts:1187,1275) and `getMemoryDb()` (knowledge-tools.ts:1332)
  // for cross-DB joins — declare all three so the AST completeness test
  // (P-B-002) verifies the full access pattern.
  knowledge_search: ['knowledge', 'data', 'memory'],
  knowledge_pattern: ['knowledge', 'data', 'memory'],
  knowledge_rule: ['knowledge', 'data', 'memory'],
  knowledge_correct: ['knowledge', 'data', 'memory'],
  knowledge_incident: ['knowledge', 'data', 'memory'],
  knowledge_plan: ['knowledge', 'data', 'memory'],
  knowledge_command: ['knowledge', 'data', 'memory'],
  knowledge_gaps: ['knowledge', 'data', 'memory'],
  knowledge_verification: ['knowledge', 'data', 'memory'],
  knowledge_effectiveness: ['knowledge', 'data', 'memory'],
  knowledge_graph: ['knowledge', 'data', 'memory'],
  knowledge_schema_check: ['knowledge', 'data', 'memory'],

  // === Analytics / quality (analytics.ts) ===
  // Routed via `isAnalyticsTool(name)`. Memory DB only.
  quality_score: ['memory'],
  quality_report: ['memory'],
  quality_trend: ['memory'],

  // === Cost tracker (cost-tracker.ts) ===
  cost_session: ['memory'],
  cost_feature: ['memory'],
  cost_trend: ['memory'],

  // === Prompt analyzer (prompt-analyzer.ts) ===
  prompt_effectiveness: ['memory'],
  prompt_suggestions: ['memory'],

  // === Audit trail (audit-trail.ts) ===
  audit_chain: ['memory'],
  audit_log: ['memory'],
  audit_report: ['memory'],

  // === Validation engine (validation-engine.ts) ===
  validation_check: ['memory'],
  validation_report: ['memory'],

  // === ADR generator (adr-generator.ts) ===
  adr_create: ['memory'],
  adr_list: ['memory'],
  adr_detail: ['memory'],

  // === Security scorer (security-scorer.ts) ===
  security_score: ['memory'],
  security_heatmap: ['memory'],
  security_trend: ['memory'],

  // === Dependency scorer (dependency-scorer.ts) ===
  dep_score: ['memory'],
  dep_alternatives: ['memory'],

  // === Team knowledge (team-knowledge.ts) ===
  team_expertise: ['memory'],
  team_conflicts: ['memory'],
  team_search: ['memory'],

  // === Regression detector (regression-detector.ts) ===
  regression_risk: ['memory'],
  feature_health: ['memory'],

  // === Python code-intel tools (python-tools.ts) ===
  // Routed via `isPythonTool(name)` at tools.ts:379-381. Data DB only.
  py_imports: ['data'],
  py_routes: ['data'],
  py_models: ['data'],
  py_migrations: ['data'],
  py_coupling: ['data'],
  py_context: ['data'],
  py_impact: ['data'],
  py_domains: ['data'],

  // === License tool (license.ts) ===
  license_status: ['memory'],
} as const satisfies Readonly<Record<string, readonly DbNeed[]>>;

/**
 * Configured tool-prefix-stripping helper. Pulled from the runtime config
 * so this module stays project-prefix-agnostic.
 */
function stripConfiguredPrefix(toolName: string, prefix: string): string {
  const pfx = `${prefix}_`;
  return toolName.startsWith(pfx) ? toolName.slice(pfx.length) : toolName;
}

/**
 * Look up the DB needs for a tool by its full name (with prefix). Strips the
 * configured prefix and consults `TOOL_DB_NEEDS`. Throws `UnknownToolError`
 * for tool names not in the manifest — the dispatcher MUST catch this and
 * translate to a structured JSON-RPC error.
 *
 * @param toolName Full tool name including prefix (e.g., `"massu_memory_search"`)
 * @param prefix Tool prefix (e.g., `"massu"`) — read from config at dispatch time
 * @returns Array of DB connections the tool requires (may be empty)
 * @throws {UnknownToolError} if `stripPrefix(toolName)` not in the manifest
 */
export function getToolDbNeeds(toolName: string, prefix: string): readonly DbNeed[] {
  const shortName = stripConfiguredPrefix(toolName, prefix);
  const needs = (TOOL_DB_NEEDS as Record<string, readonly DbNeed[]>)[shortName];
  if (needs === undefined) {
    throw new UnknownToolError(toolName);
  }
  return needs;
}

/** Convenience predicate: does a tool need CodeGraph DB? */
export function toolNeedsCodegraph(toolName: string, prefix: string): boolean {
  return getToolDbNeeds(toolName, prefix).includes('codegraph');
}
