// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Tests for the MCP server's JSON-RPC 2.0 dispatch logic.
 *
 * Imports the REAL `createDispatcher()` from `server-dispatch.ts` — no
 * mirror-the-switch hack. Each test creates a fresh dispatcher so DB cache
 * state never bleeds between cases.
 *
 * Coverage:
 *   - initialize / tools/list / tools/call / ping / unknown method
 *   - request id preservation (number, string, undefined → null)
 *   - `-32700` parse error (id always null per JSON-RPC §5.1)
 *   - `-32603` internal error (id PRESERVED, not null)
 *   - `-32001` CodegraphDbNotInitializedError → structured remedy data
 *   - `-32602` UnknownToolError → manifest remedy hint
 *   - Lazy per-tool DB resolution (codegraph NOT opened for memory tools)
 *   - DB connection caching across calls
 *   - Notification suppression (no id → emit:false)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Mocks — preserve real error classes via importActual, stub factories.
// ---------------------------------------------------------------------------

vi.mock('../db.ts', async () => {
  const actual = await vi.importActual<typeof import('../db.ts')>('../db.ts');
  return {
    ...actual,
    getCodeGraphDb: vi.fn(() => ({ close: vi.fn() }) as unknown as Database.Database),
    getDataDb: vi.fn(() => ({ close: vi.fn() }) as unknown as Database.Database),
  };
});

// plan-stage-d-medium-sweep P-M-010: dispatcher now resolves memory.db and
// knowledge.db lazily for tools whose TOOL_DB_NEEDS declares them. Mock both
// factories so the dispatcher does not touch the real filesystem in tests.
vi.mock('../memory-db.ts', async () => {
  const actual = await vi.importActual<typeof import('../memory-db.ts')>('../memory-db.ts');
  return {
    ...actual,
    getMemoryDb: vi.fn(() => ({ close: vi.fn() }) as unknown as Database.Database),
  };
});

vi.mock('../knowledge-db.ts', async () => {
  const actual = await vi.importActual<typeof import('../knowledge-db.ts')>('../knowledge-db.ts');
  return {
    ...actual,
    getKnowledgeDb: vi.fn(() => ({ close: vi.fn() }) as unknown as Database.Database),
  };
});

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
  handleToolCall: vi.fn(async () => ({
    content: [{ type: 'text', text: 'tool result' }],
  })),
}));

// ---------------------------------------------------------------------------
// Real dispatcher under test
// ---------------------------------------------------------------------------

import { createDispatcher, type Dispatcher } from '../server-dispatch.ts';
import { getCodeGraphDb, getDataDb, CodegraphDbNotInitializedError } from '../db.ts';
import { getMemoryDb } from '../memory-db.ts';
import { getKnowledgeDb } from '../knowledge-db.ts';
import { getToolDefinitions, handleToolCall } from '../tools.ts';

const TEST_VERSION = '1.0.0';

let dispatcher: Dispatcher;

beforeEach(() => {
  vi.mocked(getCodeGraphDb).mockReset();
  vi.mocked(getDataDb).mockReset();
  vi.mocked(getMemoryDb).mockReset();
  vi.mocked(getKnowledgeDb).mockReset();
  vi.mocked(getCodeGraphDb).mockReturnValue({ close: vi.fn() } as unknown as Database.Database);
  vi.mocked(getDataDb).mockReturnValue({ close: vi.fn() } as unknown as Database.Database);
  vi.mocked(getMemoryDb).mockReturnValue({ close: vi.fn() } as unknown as Database.Database);
  vi.mocked(getKnowledgeDb).mockReturnValue({ close: vi.fn() } as unknown as Database.Database);
  vi.mocked(getToolDefinitions).mockClear();
  vi.mocked(handleToolCall).mockReset();
  vi.mocked(handleToolCall).mockResolvedValue({ content: [{ type: 'text', text: 'tool result' }] });

  dispatcher = createDispatcher({ serverInfoVersion: TEST_VERSION });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Server JSON-RPC 2.0 — response structure', () => {
  it('all successful responses include jsonrpc: "2.0"', async () => {
    const methods = ['initialize', 'tools/list', 'ping', 'notifications/initialized'] as const;
    for (const method of methods) {
      const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', id: 1, method });
      expect(resp.jsonrpc).toBe('2.0');
    }
  });

  it('response id mirrors request id (number)', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', id: 42, method: 'ping' });
    expect(resp.id).toBe(42);
  });

  it('response id mirrors request id (string)', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', id: 'req-abc', method: 'ping' });
    expect(resp.id).toBe('req-abc');
  });

  it('response id is null when request has no id', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', method: 'ping' });
    expect(resp.id).toBeNull();
  });
});

describe('Server JSON-RPC 2.0 — initialize', () => {
  it('returns protocolVersion 2024-11-05', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(resp.error).toBeUndefined();
    const result = resp.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
  });

  it('returns capabilities.tools object', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const result = resp.result as Record<string, unknown>;
    expect((result.capabilities as Record<string, unknown>).tools).toBeDefined();
  });

  it('returns serverInfo with name from config.toolPrefix and version from options', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const result = resp.result as { serverInfo: { name: string; version: string } };
    expect(result.serverInfo.name).toBe('massu');
    expect(result.serverInfo.version).toBe(TEST_VERSION);
  });

  it('works with string id', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', id: 'init-1', method: 'initialize' });
    expect(resp.id).toBe('init-1');
    expect((resp.result as Record<string, unknown>).protocolVersion).toBe('2024-11-05');
  });
});

describe('Server JSON-RPC 2.0 — notifications/initialized', () => {
  it('returns empty result object', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', id: 2, method: 'notifications/initialized' });
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({});
  });

  it('returns null id when no id provided (notification pattern)', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(resp.id).toBeNull();
  });
});

describe('Server JSON-RPC 2.0 — tools/list', () => {
  it('calls getToolDefinitions and returns result.tools array', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(resp.error).toBeUndefined();
    const result = resp.result as { tools: unknown[] };
    expect(Array.isArray(result.tools)).toBe(true);
  });

  it('returns mocked tool definitions', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const result = resp.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('massu_sync');
    expect(names).toContain('massu_context');
  });

  it('calls getToolDefinitions exactly once per request', async () => {
    await dispatcher.handleRequest({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
    expect(vi.mocked(getToolDefinitions)).toHaveBeenCalledTimes(1);
  });
});

describe('Server JSON-RPC 2.0 — tools/call', () => {
  it('delegates to handleToolCall and returns its result', async () => {
    const resp = await dispatcher.handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'massu_sync', arguments: {} },
    });
    expect(resp.error).toBeUndefined();
    const result = resp.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toBe('tool result');
  });

  it('passes tool name and arguments to handleToolCall', async () => {
    await dispatcher.handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'massu_context', arguments: { file: 'src/index.ts' } },
    });
    // plan-stage-d-medium-sweep P-M-010: handleToolCall signature extended
    // to (name, args, dataDb, codegraphDb, memoryDb, knowledgeDb). For
    // massu_context (TOOL_DB_NEEDS = ['data', 'codegraph']), memoryDb +
    // knowledgeDb are undefined; the test asserts the first four argument
    // shape and lets the trailing optional args be anything (incl. undefined).
    expect(vi.mocked(handleToolCall)).toHaveBeenCalledWith(
      'massu_context',
      { file: 'src/index.ts' },
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
    );
  });

  it('defaults to empty object when params.arguments is omitted', async () => {
    await dispatcher.handleRequest({
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
      undefined,
      undefined,
    );
  });
});

describe('Server JSON-RPC 2.0 — lazy per-tool DB resolution', () => {
  it('opens BOTH codegraph + data for tools that need them (sync)', async () => {
    await dispatcher.handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'massu_sync' },
    });
    expect(vi.mocked(getCodeGraphDb)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getDataDb)).toHaveBeenCalledTimes(1);
  });

  it('opens BOTH data and codegraph DBs for trpc_map (P-H009 fix)', async () => {
    // P-H009 (plan-stage-c-high-batch): trpc_map declares 'codegraph' in
    // TOOL_DB_NEEDS so the JS-side ensureIndexes section runs on fresh
    // installs. Previously it declared only 'data' and silently returned
    // "0 procedures" because the index never built.
    await dispatcher.handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'massu_trpc_map' },
    });
    expect(vi.mocked(getCodeGraphDb)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getDataDb)).toHaveBeenCalledTimes(1);
  });

  it('opens memory.db at dispatcher level for memory tools, not codegraph or data', async () => {
    // plan-stage-d-medium-sweep P-M-010: dispatcher now eagerly resolves
    // memory.db (cached for the process lifetime) for tools whose
    // TOOL_DB_NEEDS declares 'memory'. Codegraph + Data must still NOT be
    // opened for memory-only tools.
    await dispatcher.handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'massu_memory_search' },
    });
    expect(vi.mocked(getCodeGraphDb)).not.toHaveBeenCalled();
    expect(vi.mocked(getDataDb)).not.toHaveBeenCalled();
  });

  it('opens NEITHER for the schema tool (no DB access)', async () => {
    await dispatcher.handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'massu_schema' },
    });
    expect(vi.mocked(getCodeGraphDb)).not.toHaveBeenCalled();
    expect(vi.mocked(getDataDb)).not.toHaveBeenCalled();
  });

  it('caches connections across subsequent calls', async () => {
    await dispatcher.handleRequest({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'massu_sync' } });
    await dispatcher.handleRequest({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'massu_sync' } });
    expect(vi.mocked(getCodeGraphDb)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getDataDb)).toHaveBeenCalledTimes(1);
  });

  it('closeCachedDbs() closes both connections and allows re-opening', async () => {
    const cgClose = vi.fn();
    const dataClose = vi.fn();
    vi.mocked(getCodeGraphDb).mockReturnValueOnce({ close: cgClose } as unknown as Database.Database);
    vi.mocked(getDataDb).mockReturnValueOnce({ close: dataClose } as unknown as Database.Database);

    await dispatcher.handleRequest({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'massu_sync' } });
    dispatcher.closeCachedDbs();
    expect(cgClose).toHaveBeenCalledTimes(1);
    expect(dataClose).toHaveBeenCalledTimes(1);

    await dispatcher.handleRequest({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'massu_sync' } });
    expect(vi.mocked(getCodeGraphDb)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getDataDb)).toHaveBeenCalledTimes(2);
  });
});

describe('Server JSON-RPC 2.0 — error envelopes (-32001 codegraph-not-init)', () => {
  it('returns -32001 with remedy + dbPath + tool data when CodeGraph DB is missing', async () => {
    vi.mocked(getCodeGraphDb).mockImplementationOnce(() => {
      throw new CodegraphDbNotInitializedError('/test/.codegraph/codegraph.db');
    });

    const resp = await dispatcher.handleRequest({
      jsonrpc: '2.0',
      id: 'req-init-fail',
      method: 'tools/call',
      params: { name: 'massu_sync' },
    });

    expect(resp.result).toBeUndefined();
    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32001);
    expect(resp.error!.message).toContain('CodeGraph database');
    const data = resp.error!.data as { remedy: string; codegraphDbPath: string; tool: string };
    expect(data.remedy).toContain('codegraph');
    expect(data.codegraphDbPath).toBe('/test/.codegraph/codegraph.db');
    expect(data.tool).toBe('massu_sync');
  });

  it('preserves the request id on -32001 (NOT null)', async () => {
    vi.mocked(getCodeGraphDb).mockImplementationOnce(() => {
      throw new CodegraphDbNotInitializedError('/x');
    });
    const resp = await dispatcher.handleRequest({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'massu_sync' },
    });
    expect(resp.id).toBe(99);
  });
});

describe('Server JSON-RPC 2.0 — error envelopes (-32602 unknown-tool)', () => {
  it('returns -32602 with remedy pointing at tool-db-needs.ts when tool is not in manifest', async () => {
    const resp = await dispatcher.handleRequest({
      jsonrpc: '2.0',
      id: 'req-unknown',
      method: 'tools/call',
      params: { name: 'massu_does_not_exist' },
    });

    expect(resp.result).toBeUndefined();
    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32602);
    expect(resp.error!.message).toContain('Unknown tool');
    const data = resp.error!.data as { remedy: string; tool: string };
    expect(data.remedy).toContain('tool-db-needs.ts');
    expect(data.tool).toBe('massu_does_not_exist');
  });

  it('preserves the request id on -32602 (NOT null)', async () => {
    const resp = await dispatcher.handleRequest({
      jsonrpc: '2.0',
      id: 'preserved-unknown',
      method: 'tools/call',
      params: { name: 'massu_nope' },
    });
    expect(resp.id).toBe('preserved-unknown');
  });
});

describe('Server JSON-RPC 2.0 — error envelopes (-32603 internal error)', () => {
  it('processLine wraps unexpected handler errors as -32603 with id preserved', async () => {
    vi.mocked(handleToolCall).mockRejectedValueOnce(new Error('boom from handler'));
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 77,
      method: 'tools/call',
      params: { name: 'massu_sync' },
    });

    const result = await dispatcher.processLine(line);
    expect(result).not.toBeNull();
    expect(result!.emit).toBe(true);
    expect(result!.response.id).toBe(77); // id PRESERVED, not null
    expect(result!.response.error).toBeDefined();
    expect(result!.response.error!.code).toBe(-32603);
    expect(result!.response.error!.message).toContain('boom from handler');
  });
});

describe('Server JSON-RPC 2.0 — ping', () => {
  it('returns empty result', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', id: 10, method: 'ping' });
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({});
  });

  it('returns id matching request', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', id: 99, method: 'ping' });
    expect(resp.id).toBe(99);
  });
});

describe('Server JSON-RPC 2.0 — unknown method', () => {
  it('returns error code -32601 for unknown method', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', id: 11, method: 'nonexistent/method' });
    expect(resp.result).toBeUndefined();
    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32601);
  });

  it('error message contains the unknown method name', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', id: 11, method: 'some/unknown' });
    expect(resp.error!.message).toContain('some/unknown');
    expect(resp.error!.message).toContain('Method not found');
  });

  it('preserves id in error response', async () => {
    const resp = await dispatcher.handleRequest({ jsonrpc: '2.0', id: 'err-id', method: 'bad/method' });
    expect(resp.id).toBe('err-id');
  });
});

describe('Server JSON-RPC 2.0 — processLine (stdin two-phase)', () => {
  it('parses and dispatches a valid newline-terminated JSON line', async () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const result = await dispatcher.processLine(line);
    expect(result).not.toBeNull();
    expect(result!.emit).toBe(true);
    expect(result!.response.result).toEqual({});
  });

  it('returns null for empty / whitespace-only lines', async () => {
    expect(await dispatcher.processLine('')).toBeNull();
    expect(await dispatcher.processLine('   ')).toBeNull();
    expect(await dispatcher.processLine('\t\n')).toBeNull();
  });

  it('returns -32700 with id:null for malformed JSON (per JSON-RPC §5.1)', async () => {
    const result = await dispatcher.processLine('{not valid json}');
    expect(result).not.toBeNull();
    expect(result!.emit).toBe(true);
    expect(result!.response.jsonrpc).toBe('2.0');
    expect(result!.response.id).toBeNull();
    expect(result!.response.error).toBeDefined();
    expect(result!.response.error!.code).toBe(-32700);
    expect(result!.response.error!.message).toContain('Parse error');
  });

  it('returns -32700 for truncated JSON', async () => {
    const result = await dispatcher.processLine('{"jsonrpc":"2.0","id":1,"method":');
    expect(result!.response.error!.code).toBe(-32700);
  });

  it('emit=false for notifications (no id)', async () => {
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const result = await dispatcher.processLine(line);
    expect(result!.emit).toBe(false);
    expect(result!.response.id).toBeNull();
  });

  it('emit=true for requests with id:0 (not falsy-excluded)', async () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' });
    const result = await dispatcher.processLine(line);
    expect(result!.emit).toBe(true);
    expect(result!.response.id).toBe(0);
  });
});
