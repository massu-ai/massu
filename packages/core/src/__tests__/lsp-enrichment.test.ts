// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 4: end-to-end LSP enrichment integration test.
 *
 * Compares an AST-only AdapterResult vs the same result after `enrichAdapterResult`
 * runs against a mock LSP. Asserts that enrichment adds at least one extra
 * provenance entry without overwriting AST conventions (LSP is enrichment-only,
 * AST is authoritative — per spec §4 / plan line 173-175).
 */

import { describe, expect, it } from 'vitest';
import { LSPClient, type LSPTransport } from '../lsp/client.ts';
import { enrichAdapterResult } from '../lsp/enrich.ts';
import type { AdapterResult, SourceFile } from '../detect/adapters/types.ts';

// ============================================================
// Mock transport (re-used pattern from client.test.ts)
// ============================================================

interface ScriptedReply {
  method: string;
  result?: unknown;
}

function makeMockTransport(replies: ScriptedReply[]): {
  transport: LSPTransport;
  sent: Array<{ method: string; id?: number }>;
} {
  let messageHandler: ((env: unknown) => void) | null = null;
  const sent: Array<{ method: string; id?: number }> = [];
  const transport: LSPTransport = {
    send(json: string) {
      const parsed = JSON.parse(json);
      sent.push({ method: parsed.method, id: parsed.id });
      if (parsed.id !== undefined && parsed.method) {
        const reply = replies.find((r) => r.method === parsed.method);
        if (reply) {
          const idx = replies.indexOf(reply);
          replies.splice(idx, 1);
          setImmediate(() => {
            if (messageHandler) {
              messageHandler({
                jsonrpc: '2.0',
                id: parsed.id,
                result: reply.result,
              });
            }
          });
        }
      }
    },
    onMessage(fn) {
      messageHandler = fn;
    },
    onError() {
      /* unused */
    },
    close() {
      /* noop */
    },
  };
  return { transport, sent };
}

// ============================================================
// Tests
// ============================================================

describe('LSP enrichment: AST-only vs AST+LSP precision (mock LSP fixture)', () => {
  it('lspClient null → returns original result unchanged (no LSP path taken)', async () => {
    const original: AdapterResult = {
      conventions: { authDep: 'require_user' },
      provenance: [
        {
          field: 'authDep',
          sourceFile: '/tmp/x.py',
          line: 5,
          query: 'fastapi.dependency-symbol',
        },
      ],
      confidence: 'high',
    };
    const enriched = await enrichAdapterResult(original, null, []);
    expect(enriched).toEqual(original);
  });

  it('LSP enrichment adds provenance entries without mutating conventions', async () => {
    // AST adapter returned `authDep: "require_user"` from the python-fastapi
    // fixture. The mock LSP's `documentSymbol` returns a symbol named
    // `require_user` with detail `def require_user(...)` — which the enricher
    // attaches as an extra provenance entry.
    const astResult: AdapterResult = {
      conventions: { authDep: 'require_user' },
      provenance: [
        {
          field: 'authDep',
          sourceFile: '/tmp/api.py',
          line: 12,
          query: 'fastapi.dependency-symbol',
        },
      ],
      confidence: 'high',
    };

    const handle = makeMockTransport([
      {
        method: 'initialize',
        result: {
          capabilities: {
            documentSymbolProvider: true,
            workspaceSymbolProvider: true,
            definitionProvider: true,
          },
        },
      },
      {
        method: 'textDocument/documentSymbol',
        result: [
          {
            name: 'require_user',
            kind: 12, // Function
            range: { start: { line: 11, character: 0 }, end: { line: 14, character: 0 } },
            selectionRange: { start: { line: 11, character: 4 }, end: { line: 11, character: 16 } },
            detail: 'def require_user(token: str = Header(...))',
          },
        ],
      },
    ]);

    const client = LSPClient.with(handle.transport);
    await client.initialize();

    const sourceFiles: SourceFile[] = [
      {
        path: '/tmp/api.py',
        content: 'def require_user(...): pass',
        language: 'python',
        size: 30,
      },
    ];

    const enriched = await enrichAdapterResult(astResult, client, sourceFiles);

    // VR-1: AST conventions are UNCHANGED (LSP is enrichment-only).
    expect(enriched.conventions).toEqual(astResult.conventions);
    expect(enriched.confidence).toBe('high');

    // VR-2: enrichment APPENDED at least one LSP-sourced provenance entry.
    const lspEntries = enriched.provenance.filter((p) =>
      p.query.startsWith('lsp:')
    );
    expect(lspEntries.length).toBeGreaterThanOrEqual(1);
    expect(lspEntries[0]?.field).toBe('authDep');
    expect(lspEntries[0]?.query).toContain('def require_user');

    // VR-3: original AST provenance entries are PRESERVED.
    const astEntries = enriched.provenance.filter((p) =>
      p.query === 'fastapi.dependency-symbol'
    );
    expect(astEntries.length).toBe(1);

    await client.shutdown();
  });

  it('LSP times out / returns null → AST result returned unchanged, no throw', async () => {
    const astResult: AdapterResult = {
      conventions: { authDep: 'require_user' },
      provenance: [
        { field: 'authDep', sourceFile: '/tmp/api.py', line: 12, query: 'ast' },
      ],
      confidence: 'medium',
    };

    // Initialize returns ok, then documentSymbol returns null result (LSP
    // can return null per spec: "no symbols available").
    const handle = makeMockTransport([
      {
        method: 'initialize',
        result: {
          capabilities: { documentSymbolProvider: true },
        },
      },
      { method: 'textDocument/documentSymbol', result: null },
    ]);
    const client = LSPClient.with(handle.transport);
    await client.initialize();

    const sourceFiles: SourceFile[] = [
      { path: '/tmp/api.py', content: '', language: 'python', size: 0 },
    ];
    const enriched = await enrichAdapterResult(astResult, client, sourceFiles);
    expect(enriched.conventions).toEqual(astResult.conventions);
    // Provenance was NOT augmented (no LSP data) — equal to the original.
    expect(enriched.provenance.length).toBe(astResult.provenance.length);
    await client.shutdown();
  });

  it('empty source-file list → enrichment is a no-op (no LSP calls)', async () => {
    const astResult: AdapterResult = {
      conventions: { authDep: 'require_user' },
      provenance: [
        { field: 'authDep', sourceFile: '/tmp/api.py', line: 12, query: 'ast' },
      ],
      confidence: 'high',
    };
    const handle = makeMockTransport([
      {
        method: 'initialize',
        result: { capabilities: { documentSymbolProvider: true } },
      },
    ]);
    const client = LSPClient.with(handle.transport);
    await client.initialize();
    const enriched = await enrichAdapterResult(astResult, client, []);
    expect(enriched).toEqual(astResult);
    // No documentSymbol request was sent.
    expect(handle.sent.filter((s) => s.method === 'textDocument/documentSymbol')).toEqual([]);
    await client.shutdown();
  });
});
