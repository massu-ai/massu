// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * MCP server dispatch logic — pure, factory-based, no module-level mutable state.
 *
 * Production (`server.ts`) calls `createDispatcher()` once at startup and wires
 * its `processLine` into stdin. Tests call `createDispatcher()` per test for
 * fresh DB cache state (no test bleed).
 *
 * Three error envelopes live here (CR-12 / plan-1.6.2-server-lazy-db-deps):
 *   -32001  Tool needs CodeGraph but `.codegraph/codegraph.db` is missing
 *           (CodegraphDbNotInitializedError → structured remedy data)
 *   -32602  Tool not registered in `TOOL_DB_NEEDS` manifest
 *           (UnknownToolError → points at tool-db-needs.ts)
 *   -32603  Other internal errors raised by handleToolCall — request id
 *           is preserved (NOT id:null, which is reserved for -32700 parse
 *           failures per JSON-RPC §5.1).
 */

import type Database from 'better-sqlite3';
import { getCodeGraphDb, getDataDb, CodegraphDbNotInitializedError } from './db.ts';
import { getConfig } from './config.ts';
import { getToolDefinitions, handleToolCall } from './tools.ts';
import { getToolDbNeeds, UnknownToolError, type DbNeed } from './tool-db-needs.ts';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Per-line dispatch result. `emit=false` when the request was a notification (no id). */
export interface ProcessLineResult {
  response: JsonRpcResponse;
  emit: boolean;
}

export interface DispatcherOptions {
  /** Version string surfaced in `initialize.result.serverInfo.version`. */
  serverInfoVersion: string;
}

export interface Dispatcher {
  handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse>;
  processLine(line: string): Promise<ProcessLineResult | null>;
  closeCachedDbs(): void;
}

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  let codegraphDbCache: Database.Database | null = null;
  let dataDbCache: Database.Database | null = null;

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
      // Throws CodegraphDbNotInitializedError when .codegraph/codegraph.db is missing.
      if (!codegraphDbCache) codegraphDbCache = getCodeGraphDb();
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
            capabilities: { tools: {} },
            serverInfo: {
              name: getConfig().toolPrefix || 'massu',
              version: options.serverInfoVersion,
            },
          },
        };
      }

      case 'notifications/initialized': {
        return { jsonrpc: '2.0', id: id ?? null, result: {} };
      }

      case 'tools/list': {
        const tools = getToolDefinitions();
        return { jsonrpc: '2.0', id: id ?? null, result: { tools } };
      }

      case 'tools/call': {
        const toolName = (params as { name?: string })?.name ?? '';
        const toolArgs = (params as { arguments?: Record<string, unknown> })?.arguments ?? {};

        try {
          const { dataDb, codegraphDb } = resolveDbsForTool(toolName);
          const result = await handleToolCall(toolName, toolArgs, dataDb, codegraphDb);
          return { jsonrpc: '2.0', id: id ?? null, result };
        } catch (err) {
          if (err instanceof CodegraphDbNotInitializedError) {
            return {
              jsonrpc: '2.0',
              id: id ?? null,
              error: {
                code: -32001,
                message: 'Tool requires CodeGraph database which is not initialized for this repo',
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

  async function processLine(line: string): Promise<ProcessLineResult | null> {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch (parseError) {
      // JSON-RPC §5.1: parse failure → -32700 + id:null (no id is extractable).
      return {
        response: {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: `Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
          },
        },
        emit: true,
      };
    }

    try {
      const response = await handleRequest(request);
      // Notifications (no id) MUST NOT receive a response per JSON-RPC §4.1.
      return { response, emit: request.id !== undefined };
    } catch (error) {
      // Request-processing failure: -32603 with the request id preserved.
      // Specific subclasses (-32001/-32602) are handled inside tools/call.
      return {
        response: {
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: {
            code: -32603,
            message: `Internal error: ${error instanceof Error ? error.message : String(error)}`,
          },
        },
        emit: true,
      };
    }
  }

  function closeCachedDbs(): void {
    if (codegraphDbCache) {
      codegraphDbCache.close();
      codegraphDbCache = null;
    }
    if (dataDbCache) {
      dataDbCache.close();
      dataDbCache = null;
    }
  }

  return { handleRequest, processLine, closeCachedDbs };
}
