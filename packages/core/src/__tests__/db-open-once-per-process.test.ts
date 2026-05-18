import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

// plan-stage-d-medium-sweep P-M-010 drift-guard: dispatcher caches the
// codegraph + data + memory + knowledge SQLite handles for the process
// lifetime. Across N sequential tool dispatches, each connection factory
// must be invoked at most ONCE — the cache is the SOLE source of subsequent
// resolutions. Regression to per-call open would fsync-storm under load
// (57MB local memory.db, 200+ tool calls/session is realistic).

vi.mock('../db.ts', async () => {
  const actual = await vi.importActual<typeof import('../db.ts')>('../db.ts');
  return {
    ...actual,
    getCodeGraphDb: vi.fn(() => ({ close: vi.fn() }) as unknown as Database.Database),
    getDataDb: vi.fn(() => ({ close: vi.fn() }) as unknown as Database.Database),
  };
});

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
  getConfig: vi.fn(() => ({ toolPrefix: 'massu' })),
  getProjectRoot: vi.fn(() => '/test/project'),
  getResolvedPaths: vi.fn(() => ({
    codegraphDbPath: '/test/codegraph.db',
    dataDbPath: '/test/data.db',
    memoryDbPath: '/test/memory.db',
    knowledgeDbPath: '/test/knowledge.db',
  })),
}));

vi.mock('../tools.ts', () => ({
  getToolDefinitions: vi.fn(() => []),
  handleToolCall: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
}));

import { createDispatcher } from '../server-dispatch.ts';
import { getCodeGraphDb, getDataDb } from '../db.ts';
import { getMemoryDb } from '../memory-db.ts';
import { getKnowledgeDb } from '../knowledge-db.ts';

beforeEach(() => {
  vi.mocked(getCodeGraphDb).mockClear();
  vi.mocked(getDataDb).mockClear();
  vi.mocked(getMemoryDb).mockClear();
  vi.mocked(getKnowledgeDb).mockClear();
});

describe('P-M-010 dispatcher caches 4 SQLite handles for process lifetime', () => {
  it('memory.db is opened at most once across 100 memory tool dispatches', async () => {
    const dispatcher = createDispatcher({ serverInfoVersion: '1.0.0' });
    for (let i = 0; i < 100; i++) {
      await dispatcher.handleRequest({
        jsonrpc: '2.0',
        id: i,
        method: 'tools/call',
        params: { name: 'massu_memory_search', arguments: {} },
      });
    }
    expect(vi.mocked(getMemoryDb).mock.calls.length).toBeLessThanOrEqual(1);
    dispatcher.closeCachedDbs();
  });

  it('knowledge.db is opened at most once across 100 knowledge tool dispatches', async () => {
    const dispatcher = createDispatcher({ serverInfoVersion: '1.0.0' });
    for (let i = 0; i < 100; i++) {
      await dispatcher.handleRequest({
        jsonrpc: '2.0',
        id: i,
        method: 'tools/call',
        params: { name: 'massu_knowledge_search', arguments: {} },
      });
    }
    expect(vi.mocked(getKnowledgeDb).mock.calls.length).toBeLessThanOrEqual(1);
    dispatcher.closeCachedDbs();
  });

  it('all 4 caches close on dispatcher.closeCachedDbs()', async () => {
    const closeMem = vi.fn();
    const closeKnow = vi.fn();
    const closeCg = vi.fn();
    const closeData = vi.fn();
    vi.mocked(getMemoryDb).mockReturnValue({ close: closeMem } as unknown as Database.Database);
    vi.mocked(getKnowledgeDb).mockReturnValue({ close: closeKnow } as unknown as Database.Database);
    vi.mocked(getCodeGraphDb).mockReturnValue({ close: closeCg } as unknown as Database.Database);
    vi.mocked(getDataDb).mockReturnValue({ close: closeData } as unknown as Database.Database);

    const dispatcher = createDispatcher({ serverInfoVersion: '1.0.0' });
    // Hit one tool from each layer to populate every cache slot.
    await dispatcher.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'massu_memory_search' } });
    await dispatcher.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'massu_knowledge_search' } });
    await dispatcher.handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'massu_sync' } });
    await dispatcher.handleRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'massu_trpc_map' } });

    dispatcher.closeCachedDbs();

    expect(closeMem).toHaveBeenCalledTimes(1);
    expect(closeKnow).toHaveBeenCalledTimes(1);
    expect(closeCg).toHaveBeenCalledTimes(1);
    expect(closeData).toHaveBeenCalledTimes(1);
  });
});
