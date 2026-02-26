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
import { getCodeGraphDb, getDataDb } from './db.ts';
import { getConfig } from './config.ts';
import { getToolDefinitions, handleToolCall } from './tools.ts';
import { getMemoryDb, pruneOldConversationTurns, pruneOldObservations } from './memory-db.ts';
import { getCurrentTier } from './license.ts';

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

// Server state
let codegraphDb: ReturnType<typeof getCodeGraphDb> | null = null;
let dataDb: ReturnType<typeof getDataDb> | null = null;

function getDb() {
  if (!codegraphDb) codegraphDb = getCodeGraphDb();
  if (!dataDb) dataDb = getDataDb();
  return { codegraphDb, dataDb: dataDb };
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

      const { codegraphDb: cgDb, dataDb: lDb } = getDb();
      const result = await handleToolCall(toolName, toolArgs, lDb, cgDb);

      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result,
      };
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

    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      const response = await handleRequest(request);

      // Don't send responses for notifications (no id)
      if (request.id !== undefined) {
        const responseStr = JSON.stringify(response);
        process.stdout.write(responseStr + '\n');
      }
    } catch (error) {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
  }
});

process.stdin.on('end', () => {
  // Clean up database connections
  if (codegraphDb) codegraphDb.close();
  if (dataDb) dataDb.close();
  process.exit(0);
});

// Handle errors gracefully
process.on('uncaughtException', (error) => {
  process.stderr.write(`massu: Uncaught exception: ${error.message}\n`);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`massu: Unhandled rejection: ${reason}\n`);
});
