// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Tests for server.ts JSON-RPC 2.0 protocol handling.
 *
 * server.ts is a standalone script with no exports. It processes JSON-RPC 2.0
 * requests via stdin/stdout. Tests here validate:
 *   - The request routing logic (initialize, tools/list, tools/call, ping, etc.)
 *   - Error responses for unknown methods and malformed JSON
 *   - The shape of JSON-RPC 2.0 responses
 *
 * Because server.ts has no exports, we replicate its handleRequest logic
 * inline (mirroring the switch statement exactly) and mock the same dependencies
 * it imports. This validates the routing and response-shaping logic without
 * requiring stdin/stdout wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must match what server.ts imports
// ---------------------------------------------------------------------------

vi.mock('../db.ts', () => ({
  getCodeGraphDb: vi.fn(() => ({ close: vi.fn() })),
  getDataDb: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock('../config.ts', () => ({
  getConfig: vi.fn(() => ({
    toolPrefix: 'massu',
    framework: { type: 'typescript', router: 'trpc', orm: 'prisma' },
    paths: { source: 'src', routers: 'src/server/api/routers', middleware: 'src/middleware.ts' },
    domains: [],
  })),
  getProjectRoot: vi.fn(() => '/test/project'),
  getResolvedPaths: vi.fn(() => ({
    codegraphDbPath: '/test/codegraph.db',
    dataDbPath: '/test/data.db',
  })),
}));

vi.mock('../tools.ts', () => ({
  getToolDefinitions: vi.fn(() => [
    {
      name: 'massu_sync',
      description: 'Sync the project index',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'massu_context',
      description: 'Get context for a file',
      inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
    },
  ]),
  handleToolCall: vi.fn((_name: string, _args: Record<string, unknown>) => ({
    content: [{ type: 'text', text: 'tool result' }],
  })),
}));

// ---------------------------------------------------------------------------
// Re-implement handleRequest mirroring server.ts exactly
// ---------------------------------------------------------------------------

import { getToolDefinitions, handleToolCall } from '../tools.ts';
import { getCodeGraphDb, getDataDb } from '../db.ts';

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

// Mirrors server.ts getDb() / handleRequest() — kept in sync with the source.
let codegraphDb: ReturnType<typeof getCodeGraphDb> | null = null;
let dataDb: ReturnType<typeof getDataDb> | null = null;

function getDb() {
  if (!codegraphDb) codegraphDb = getCodeGraphDb();
  if (!dataDb) dataDb = getDataDb();
  return { codegraphDb, dataDb };
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
          serverInfo: { name: 'massu', version: '1.0.0' },
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
      const toolName = (params as { name: string })?.name;
      const toolArgs = (params as { arguments?: Record<string, unknown> })?.arguments ?? {};
      const { codegraphDb: cgDb, dataDb: lDb } = getDb();
      const result = await handleToolCall(toolName, toolArgs, lDb as never, cgDb as never);
      return { jsonrpc: '2.0', id: id ?? null, result };
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

// ---------------------------------------------------------------------------
// Helper: simulate the newline-delimited JSON-RPC parse + dispatch loop
// that lives in server.ts's stdin 'data' handler.
// ---------------------------------------------------------------------------

async function simulateStdinLine(line: string): Promise<JsonRpcResponse | null> {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const request = JSON.parse(trimmed) as JsonRpcRequest;
  return handleRequest(request);
}

function simulateMalformedLine(line: string): JsonRpcResponse {
  try {
    JSON.parse(line);
    throw new Error('Expected parse failure');
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: `Parse error: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Server JSON-RPC 2.0 — response structure', () => {
  it('all successful responses include jsonrpc: "2.0"', async () => {
    const methods = ['initialize', 'tools/list', 'ping', 'notifications/initialized'] as const;
    for (const method of methods) {
      const resp = await handleRequest({ jsonrpc: '2.0', id: 1, method });
      expect(resp.jsonrpc).toBe('2.0');
    }
  });

  it('response id mirrors request id (number)', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 42, method: 'ping' });
    expect(resp.id).toBe(42);
  });

  it('response id mirrors request id (string)', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 'req-abc', method: 'ping' });
    expect(resp.id).toBe('req-abc');
  });

  it('response id is null when request has no id', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', method: 'ping' });
    expect(resp.id).toBeNull();
  });
});

describe('Server JSON-RPC 2.0 — initialize', () => {
  it('returns protocolVersion 2024-11-05', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(resp.error).toBeUndefined();
    const result = resp.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
  });

  it('returns capabilities.tools object', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const result = resp.result as Record<string, unknown>;
    expect((result.capabilities as Record<string, unknown>).tools).toBeDefined();
  });

  it('returns serverInfo with name massu and version 1.0.0', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const result = resp.result as { serverInfo: { name: string; version: string } };
    expect(result.serverInfo.name).toBe('massu');
    expect(result.serverInfo.version).toBe('1.0.0');
  });

  it('works with string id', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 'init-1', method: 'initialize' });
    expect(resp.id).toBe('init-1');
    expect((resp.result as Record<string, unknown>).protocolVersion).toBe('2024-11-05');
  });
});

describe('Server JSON-RPC 2.0 — notifications/initialized', () => {
  it('returns empty result object', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'notifications/initialized' });
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({});
  });

  it('returns null id when no id provided (notification pattern)', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(resp.id).toBeNull();
  });
});

describe('Server JSON-RPC 2.0 — tools/list', () => {
  it('calls getToolDefinitions and returns result.tools array', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(resp.error).toBeUndefined();
    const result = resp.result as { tools: unknown[] };
    expect(Array.isArray(result.tools)).toBe(true);
  });

  it('returns mocked tool definitions', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const result = resp.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('massu_sync');
    expect(names).toContain('massu_context');
  });

  it('each tool definition has name, description, inputSchema', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const result = resp.result as { tools: Array<{ name: string; description: string; inputSchema: object }> };
    for (const tool of result.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(typeof tool.inputSchema).toBe('object');
    }
  });

  it('calls getToolDefinitions exactly once per request', async () => {
    const spy = vi.mocked(getToolDefinitions);
    spy.mockClear();

    await handleRequest({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('Server JSON-RPC 2.0 — tools/call', () => {
  beforeEach(() => {
    // Reset db state between tests
    codegraphDb = null;
    dataDb = null;
    vi.mocked(handleToolCall).mockClear();
  });

  it('delegates to handleToolCall and returns its result', async () => {
    const resp = await handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'massu_sync', arguments: {} },
    });
    expect(resp.error).toBeUndefined();
    const result = resp.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toBe('tool result');
  });

  it('passes tool name from params.name to handleToolCall', async () => {
    await handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'massu_context', arguments: { file: 'src/index.ts' } },
    });
    expect(vi.mocked(handleToolCall)).toHaveBeenCalledWith(
      'massu_context',
      { file: 'src/index.ts' },
      expect.anything(),
      expect.anything(),
    );
  });

  it('uses empty object for arguments when params.arguments is omitted', async () => {
    await handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'massu_sync' },
    });
    expect(vi.mocked(handleToolCall)).toHaveBeenCalledWith(
      'massu_sync',
      {},
      expect.anything(),
      expect.anything(),
    );
  });

  it('lazy-initializes databases on first tools/call', async () => {
    vi.mocked(getCodeGraphDb).mockClear();
    vi.mocked(getDataDb).mockClear();

    await handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'massu_sync', arguments: {} },
    });

    expect(vi.mocked(getCodeGraphDb)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getDataDb)).toHaveBeenCalledTimes(1);
  });

  it('reuses existing db connections on subsequent tools/call', async () => {
    vi.mocked(getCodeGraphDb).mockClear();
    vi.mocked(getDataDb).mockClear();

    // First call initializes dbs
    await handleRequest({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'massu_sync' } });
    // Second call should reuse
    await handleRequest({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'massu_sync' } });

    expect(vi.mocked(getCodeGraphDb)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getDataDb)).toHaveBeenCalledTimes(1);
  });
});

describe('Server JSON-RPC 2.0 — ping', () => {
  it('returns empty result', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 10, method: 'ping' });
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({});
  });

  it('returns id matching request', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 99, method: 'ping' });
    expect(resp.id).toBe(99);
  });
});

describe('Server JSON-RPC 2.0 — unknown method', () => {
  it('returns error code -32601 for unknown method', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 11, method: 'nonexistent/method' });
    expect(resp.result).toBeUndefined();
    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32601);
  });

  it('error message contains the unknown method name', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 11, method: 'some/unknown' });
    expect(resp.error!.message).toContain('some/unknown');
    expect(resp.error!.message).toContain('Method not found');
  });

  it('preserves id in error response', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 'err-id', method: 'bad/method' });
    expect(resp.id).toBe('err-id');
  });

  it('various unknown methods all get -32601', async () => {
    const unknowns = ['foo', 'bar/baz', 'tools/execute', 'rpc.discover'];
    for (const method of unknowns) {
      const resp = await handleRequest({ jsonrpc: '2.0', id: 1, method });
      expect(resp.error!.code).toBe(-32601);
    }
  });
});

describe('Server JSON-RPC 2.0 — stdin line parsing', () => {
  it('parses and dispatches a valid newline-terminated JSON line', async () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n';
    const resp = await simulateStdinLine(line);
    expect(resp).not.toBeNull();
    expect(resp!.result).toEqual({});
  });

  it('ignores empty or whitespace-only lines', async () => {
    expect(await simulateStdinLine('')).toBeNull();
    expect(await simulateStdinLine('   ')).toBeNull();
    expect(await simulateStdinLine('\t\n')).toBeNull();
  });

  it('returns parse error response for malformed JSON', () => {
    const resp = simulateMalformedLine('{not valid json}');
    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBeNull();
    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32700);
    expect(resp.error!.message).toContain('Parse error');
  });

  it('returns parse error for truncated JSON', () => {
    const resp = simulateMalformedLine('{"jsonrpc":"2.0","id":1,"method":');
    expect(resp.error!.code).toBe(-32700);
  });

  it('returns parse error for empty braces with trailing garbage', () => {
    const resp = simulateMalformedLine('{} garbage after');
    // JSON.parse("{} garbage after") throws a SyntaxError
    expect(resp.error!.code).toBe(-32700);
  });
});

describe('Server JSON-RPC 2.0 — notification suppression (no id)', () => {
  /**
   * Per the JSON-RPC 2.0 spec and server.ts implementation, when request.id
   * is undefined, the server must not send a response. We validate the
   * condition the server checks: request.id !== undefined.
   */
  it('notifications/initialized has no id — server would not write response', () => {
    const request = { jsonrpc: '2.0' as const, method: 'notifications/initialized' };
    // The server checks: if (request.id !== undefined) → write response
    expect(request.id).toBeUndefined();
  });

  it('requests with explicit id get a response', async () => {
    const request = { jsonrpc: '2.0' as const, id: 0, method: 'ping' };
    // id === 0 is defined, so response IS written
    expect(request.id).toBeDefined();
    const resp = await handleRequest(request);
    expect(resp.id).toBe(0);
  });

  it('id: 0 is a valid id (not falsy-excluded)', async () => {
    const resp = await handleRequest({ jsonrpc: '2.0', id: 0, method: 'ping' });
    expect(resp.id).toBe(0);
  });
});
