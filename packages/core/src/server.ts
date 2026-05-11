#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Massu MCP Server
 *
 * An MCP server that provides project-specific intelligence on top of
 * vanilla CodeGraph. Communicates via JSON-RPC 2.0 over stdio.
 *
 * Tool names are configurable via massu.config.yaml toolPrefix.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';
import { getCodeGraphDb, getDataDb, CodegraphDbNotInitializedError } from './db.ts';
import { getConfig, getResolvedPaths } from './config.ts';
import { getToolDefinitions, handleToolCall } from './tools.ts';
import { getMemoryDb, pruneOldConversationTurns, pruneOldObservations } from './memory-db.ts';
import { getCurrentTier } from './license.ts';
import { getToolDbNeeds, UnknownToolError, type DbNeed } from './tool-db-needs.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// === Server state: lazy per-tool DB resolution ===
//
// Per plan-1.6.2-server-lazy-db-deps: DBs are opened ONLY when the
// currently-dispatched tool declares it needs them in `TOOL_DB_NEEDS`.
// Connections are cached at module scope so subsequent tool calls reuse
// the open handle without re-opening (CodeGraph is read-only — safe to
// share; Data DB has WAL journal — single-writer is fine).
//
// PRIOR DESIGN (eliminated 2026-05-10): `getDb()` eagerly opened BOTH
// CodeGraph + Data on every `tools/call`, even for memory/audit/knowledge
// tools that don't need codegraph. Missing `.codegraph/codegraph.db`
// broke ALL tools. See `docs/plans/2026-05-10-server-lazy-db-deps.md`.

let codegraphDbCache: Database.Database | null = null;
let dataDbCache: Database.Database | null = null;

/**
 * Resolve the SQLite connections a tool needs, opening cached singletons
 * lazily. Memory DB and Knowledge DB are opened per-call by their routed
 * handlers (existing pattern in tools.ts) — only CodeGraph + Data are
 * cached here.
 *
 * @throws {CodegraphDbNotInitializedError} when tool needs codegraph but
 *   `.codegraph/codegraph.db` is missing. Caller (handleRequest) catches
 *   and translates to a structured `-32001` JSON-RPC error.
 */
function resolveDbsForTool(toolName: string): {
  needs: readonly DbNeed[];
  dataDb?: Database.Database;
  codegraphDb?: Database.Database;
} {
  const needs = getToolDbNeeds(toolName, getConfig().toolPrefix);

  let dataDbResolved: Database.Database | undefined;
  let codegraphDbResolved: Database.Database | undefined;

  if (needs.includes('data')) {
    if (!dataDbCache) dataDbCache = getDataDb();
    dataDbResolved = dataDbCache;
  }

  if (needs.includes('codegraph')) {
    if (!codegraphDbCache) codegraphDbCache = getCodeGraphDb();  // throws CodegraphDbNotInitializedError on missing
    codegraphDbResolved = codegraphDbCache;
  }

  return { needs, dataDb: dataDbResolved, codegraphDb: codegraphDbResolved };
}

async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { method, params, id } = request;

  switch (method) {
    case 'initialize': {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: getConfig().toolPrefix || 'massu',
            version: PKG_VERSION,
          },
        },
      };
    }

    case 'notifications/initialized': {
      // Client acknowledges initialization - no response needed for notifications
      return { jsonrpc: '2.0', id: id ?? null, result: {} };
    }

    case 'tools/list': {
      const tools = getToolDefinitions();
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: { tools },
      };
    }

    case 'tools/call': {
      const toolName = (params as { name: string })?.name;
      const toolArgs = (params as { arguments?: Record<string, unknown> })?.arguments ?? {};

      // Lazy per-tool DB resolution. Throws if tool needs codegraph and
      // .codegraph/codegraph.db is missing; caught below and translated
      // to a structured -32001 error preserving the request id.
      try {
        const { dataDb: lDb, codegraphDb: cgDb } = resolveDbsForTool(toolName);
        const result = await handleToolCall(toolName, toolArgs, lDb, cgDb);
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result,
        };
      } catch (err) {
        if (err instanceof CodegraphDbNotInitializedError) {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: {
              code: -32001,
              message: `Tool requires CodeGraph database which is not initialized for this repo`,
              data: {
                remedy: 'npx @colbymchenry/codegraph@0.7.4 init . && npx @colbymchenry/codegraph@0.7.4 index .',
                codegraphDbPath: err.dbPath,
                tool: toolName,
              },
            },
          };
        }
        if (err instanceof UnknownToolError) {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: {
              code: -32602,
              message: `Unknown tool: ${err.toolName}`,
              data: {
                remedy: 'Tool not registered in TOOL_DB_NEEDS manifest. See packages/core/src/tool-db-needs.ts.',
                tool: toolName,
              },
            },
          };
        }
        // Other errors propagate to the outer catch in the stdio handler
        throw err;
      }
    }

    case 'ping': {
      return { jsonrpc: '2.0', id: id ?? null, result: {} };
    }

    default: {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    }
  }
}

// === Startup: prune stale memory data (non-blocking) ===

function pruneMemoryOnStartup(): void {
  try {
    const memDb = getMemoryDb();
    try {
      const turns = pruneOldConversationTurns(memDb, 7);
      const obsDeleted = pruneOldObservations(memDb, 90);

      const totalPruned = turns.turnsDeleted + turns.detailsDeleted + obsDeleted;
      if (totalPruned > 0) {
        process.stderr.write(
          `massu: Pruned memory DB on startup — ` +
          `${turns.turnsDeleted} conversation turns, ` +
          `${turns.detailsDeleted} tool call details (>7d), ` +
          `${obsDeleted} observations (>90d)\n`
        );
      }
    } finally {
      memDb.close();
    }
  } catch (error) {
    process.stderr.write(
      `massu: Memory pruning failed (non-fatal): ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

pruneMemoryOnStartup();

// === License init: pre-cache tier status ===
getCurrentTier().then(tier => {
  process.stderr.write(`massu: License tier: ${tier}\n`);
}).catch(error => {
  process.stderr.write(
    `massu: License check failed (non-fatal): ${error instanceof Error ? error.message : String(error)}\n`
  );
});

// === stdio JSON-RPC transport ===

let buffer = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', async (chunk: string) => {
  buffer += chunk;

  // Process complete messages (newline-delimited JSON-RPC)
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);

    if (!line) continue;

    // Two-phase error handling: separate JSON-parse failures (genuine
    // -32700) from request-processing failures (-32603 Internal error,
    // preserving the request id when parseable).
    let request: JsonRpcRequest | null = null;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch (parseError) {
      // Real JSON parse failure — -32700 per JSON-RPC §5.1, id MUST be null
      // because we couldn't extract one.
      const errorResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        },
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
      continue;
    }

    try {
      const response = await handleRequest(request);
      // Don't send responses for notifications (no id)
      if (request.id !== undefined) {
        const responseStr = JSON.stringify(response);
        process.stdout.write(responseStr + '\n');
      }
    } catch (error) {
      // Request-processing failure — propagate the request id (not null).
      // -32603 Internal error per JSON-RPC §5.1. Specific subclasses
      // (codegraph-not-init, unknown-tool) are caught earlier in the
      // tools/call handler and translated to structured -32001/-32602.
      const errorResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: {
          code: -32603,
          message: `Internal error: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
  }
});

process.stdin.on('end', () => {
  // Clean up cached DB connections (Memory + Knowledge are per-call,
  // already closed in their routing branches).
  if (codegraphDbCache) codegraphDbCache.close();
  if (dataDbCache) dataDbCache.close();
  process.exit(0);
});

// Handle errors gracefully
process.on('uncaughtException', (error) => {
  process.stderr.write(`massu: Uncaught exception: ${error.message}\n`);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`massu: Unhandled rejection: ${reason}\n`);
});
