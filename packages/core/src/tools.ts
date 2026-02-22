// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import { getMemoryToolDefinitions, handleMemoryToolCall, isMemoryTool } from './memory-tools.ts';
import { getMemoryDb } from './memory-db.ts';
import { getDocsToolDefinitions, handleDocsToolCall, isDocsTool } from './docs-tools.ts';
import { getObservabilityToolDefinitions, handleObservabilityToolCall, isObservabilityTool } from './observability-tools.ts';
import { getSentinelToolDefinitions, handleSentinelToolCall, isSentinelTool } from './sentinel-tools.ts';
import { getAnalyticsToolDefinitions, isAnalyticsTool, handleAnalyticsToolCall } from './analytics.ts';
import { getCostToolDefinitions, isCostTool, handleCostToolCall } from './cost-tracker.ts';
import { getPromptToolDefinitions, isPromptTool, handlePromptToolCall } from './prompt-analyzer.ts';
import { getAuditToolDefinitions, isAuditTool, handleAuditToolCall } from './audit-trail.ts';
import { getValidationToolDefinitions, isValidationTool, handleValidationToolCall } from './validation-engine.ts';
import { getAdrToolDefinitions, isAdrTool, handleAdrToolCall } from './adr-generator.ts';
import { getSecurityToolDefinitions, isSecurityTool, handleSecurityToolCall } from './security-scorer.ts';
import { getDependencyToolDefinitions, isDependencyTool, handleDependencyToolCall } from './dependency-scorer.ts';
import { getTeamToolDefinitions, isTeamTool, handleTeamToolCall } from './team-knowledge.ts';
import { getRegressionToolDefinitions, isRegressionTool, handleRegressionToolCall } from './regression-detector.ts';
import { getCoreToolDefinitions, isCoreTool, handleCoreToolCall, ensureIndexes } from './core-tools.ts';
import { getConfig } from './config.ts';
import { text } from './tool-helpers.ts';
import type { ToolDefinition, ToolResult } from './tool-helpers.ts';

export type { ToolDefinition, ToolResult } from './tool-helpers.ts';

/**
 * Run a function with a memoryDb instance, ensuring it is closed after use.
 */
function withMemoryDb<T>(fn: (db: Database.Database) => T): T {
  const memDb = getMemoryDb();
  try { return fn(memDb); }
  finally { memDb.close(); }
}

/**
 * Get all tool definitions for the MCP server.
 */
export function getToolDefinitions(): ToolDefinition[] {
  const config = getConfig();

  return [
    // Memory tools
    ...getMemoryToolDefinitions(),
    // Observability tools
    ...getObservabilityToolDefinitions(),
    // Docs tools
    ...getDocsToolDefinitions(),
    // Sentinel tools (feature registry)
    ...getSentinelToolDefinitions(),
    // Analytics layer (quality trends, cost tracking, prompt analysis)
    ...getAnalyticsToolDefinitions(),
    ...getCostToolDefinitions(),
    ...getPromptToolDefinitions(),
    // Governance layer (audit trail, validation, ADR)
    ...getAuditToolDefinitions(),
    ...getValidationToolDefinitions(),
    ...getAdrToolDefinitions(),
    // Security layer (security scoring, dependency risk)
    ...getSecurityToolDefinitions(),
    ...getDependencyToolDefinitions(),
    // Enterprise layer (team knowledge — cloud-only; regression detection — always)
    ...(config.cloud?.enabled ? getTeamToolDefinitions() : []),
    ...getRegressionToolDefinitions(),
    // Core tools (sync, context, impact, domains, schema, trpc_map, coupling_check)
    ...getCoreToolDefinitions(),
  ];
}

/**
 * Handle a tool call and return the result.
 */
export function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  dataDb: Database.Database,
  codegraphDb: Database.Database
): ToolResult {
  // Ensure indexes are built before any tool call
  ensureIndexes(dataDb, codegraphDb);

  try {
    // Route to module tools via isTool() matchers + withMemoryDb helper
    if (isMemoryTool(name)) return withMemoryDb(db => handleMemoryToolCall(name, args, db));
    if (isObservabilityTool(name)) return withMemoryDb(db => handleObservabilityToolCall(name, args, db));
    if (isDocsTool(name)) return handleDocsToolCall(name, args);
    if (isSentinelTool(name)) return handleSentinelToolCall(name, args, dataDb);
    if (isAnalyticsTool(name)) return withMemoryDb(db => handleAnalyticsToolCall(name, args, db));
    if (isCostTool(name)) return withMemoryDb(db => handleCostToolCall(name, args, db));
    if (isPromptTool(name)) return withMemoryDb(db => handlePromptToolCall(name, args, db));
    if (isAuditTool(name)) return withMemoryDb(db => handleAuditToolCall(name, args, db));
    if (isValidationTool(name)) return withMemoryDb(db => handleValidationToolCall(name, args, db));
    if (isAdrTool(name)) return withMemoryDb(db => handleAdrToolCall(name, args, db));
    if (isSecurityTool(name)) return withMemoryDb(db => handleSecurityToolCall(name, args, db));
    if (isDependencyTool(name)) return withMemoryDb(db => handleDependencyToolCall(name, args, db));
    if (isTeamTool(name)) {
      if (!getConfig().cloud?.enabled) {
        return text('This tool requires Cloud Team or Enterprise. Configure cloud sync to enable.');
      }
      return withMemoryDb(db => handleTeamToolCall(name, args, db));
    }
    if (isRegressionTool(name)) return withMemoryDb(db => handleRegressionToolCall(name, args, db));

    // Core tools (sync, context, trpc_map, coupling_check, impact, domains, schema)
    if (isCoreTool(name)) return handleCoreToolCall(name, args, dataDb, codegraphDb);

    return text(`Unknown tool: ${name}`);
  } catch (error) {
    return text(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
