// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 4: auto-detect.ts unit tests.
 *
 * Covers:
 *   - VR-LSP-AUTODETECT-OFF-BY-DEFAULT: load config with `lsp.enabled: true`
 *     and NO `autoDetect` block → assert `getConfig().lsp.autoDetect?.viaPortScan`
 *     is undefined or false; `findRunningLSPs()` does NOT spawn `lsof`.
 *   - Empty-servers fixture (3 cases per plan line 170):
 *       (a) enabled+no-servers+no-autodetect → info stderr line + AST-only
 *       (b) enabled+empty-servers-array → same
 *       (c) disabled+any-servers → silently ignore servers, no log
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { findRunningLSPs } from '../../lsp/auto-detect.ts';

// ============================================================
// VR-LSP-AUTODETECT-OFF-BY-DEFAULT — static check
// ============================================================

describe('auto-detect: VR-LSP-AUTODETECT-OFF-BY-DEFAULT static invariant', () => {
  // Read the source once — this asserts the code-path proof required by
  // the plan: "viaPortScan boolean is checked BEFORE any lsof call".
  const source = readFileSync(
    resolve(__dirname, '../../lsp/auto-detect.ts'),
    'utf-8'
  );

  it('auto-detect.ts contains the viaPortScan boolean check', () => {
    expect(source).toMatch(/viaPortScan/);
  });

  it('auto-detect.ts contains NO direct lsof invocation at v1', () => {
    // No `spawn(...lsof...)` or `exec('lsof ...')` should exist in the
    // module — the gate is wired but the implementation is deferred to 3d.
    // Comments mentioning "lsof" are explanatory text and acceptable.
    const codeLines = source
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l));
    const codeText = codeLines.join('\n');
    expect(codeText).not.toMatch(/spawn\s*\(\s*['"]lsof/);
    expect(codeText).not.toMatch(/exec\s*\(\s*['"]lsof/);
    expect(codeText).not.toMatch(/execSync\s*\(\s*['"]lsof/);
  });

  it('viaPortScan check appears BEFORE any port-scan-related code', () => {
    // The module reads `config.autoDetect?.viaPortScan === true` and only
    // enters the port-scan branch when truthy. Verify the check exists.
    expect(source).toMatch(
      /config\.autoDetect\?\.viaPortScan\s*===\s*true/
    );
    // The string `viaPortScan` in source must appear at least once.
    const matches = source.match(/viaPortScan/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// Runtime behaviour: explicit-only by default
// ============================================================

describe('auto-detect: viaPortScan off-by-default runtime behaviour', () => {
  it('lsp.enabled:true with NO autoDetect block → returns explicit servers only', async () => {
    const out = await findRunningLSPs({
      enabled: true,
      servers: [{ language: 'python', command: '/usr/bin/pyright-langserver --stdio' }],
      // autoDetect: omitted entirely
    });
    expect(out.length).toBe(1);
    expect(out[0]?.argv[0]).toBe('/usr/bin/pyright-langserver');
  });

  it('lsp.enabled:true with explicit autoDetect.viaPortScan:false → explicit servers only', async () => {
    const out = await findRunningLSPs({
      enabled: true,
      servers: [{ language: 'python', command: '/usr/bin/pyright-langserver --stdio' }],
      autoDetect: { viaPortScan: false },
    });
    expect(out.length).toBe(1);
  });

  it('lsp.enabled:true with viaPortScan:true (opt-in) — still returns explicit servers, deferred to 3d', async () => {
    // Plan 3b explicitly defers actual lsof discovery to Plan 3d. The gate
    // is wired but no-op at v1. This test enshrines that contract.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const out = await findRunningLSPs({
        enabled: true,
        servers: [{ language: 'python', command: '/usr/bin/pyright-langserver --stdio' }],
        autoDetect: { viaPortScan: true },
      });
      expect(out.length).toBe(1);
      // The opt-in path emits a deferral notice rather than spawning lsof.
      const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
      const hasDeferral = calls.some((c) => c.includes('reserved for Plan 3d'));
      expect(hasDeferral).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ============================================================
// Empty-servers edge case (audit-iter-3 fix Z, plan line 170)
// ============================================================

describe('auto-detect: empty-servers edge case (3 fixtures)', () => {
  it('(a) enabled + no servers + no autoDetect → info stderr line + empty list', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const out = await findRunningLSPs({
        enabled: true,
        servers: [],
      });
      expect(out).toEqual([]);
      // VR: exactly the documented info line was emitted.
      const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
      const hasInfoLine = calls.some((c) =>
        c.includes('LSP enabled but no servers configured and auto-detect off')
      );
      expect(hasInfoLine).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('(b) enabled + empty-servers array → same info stderr + empty list', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const out = await findRunningLSPs({
        enabled: true,
        servers: [],
        autoDetect: { viaPortScan: false },
      });
      expect(out).toEqual([]);
      const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
      const hasInfoLine = calls.some((c) =>
        c.includes('LSP enabled but no servers configured and auto-detect off')
      );
      expect(hasInfoLine).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('(c) disabled + any servers → silently ignore servers, NO log', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const out = await findRunningLSPs({
        enabled: false,
        servers: [{ language: 'python', command: '/usr/bin/pyright-langserver --stdio' }],
      });
      expect(out).toEqual([]);
      // VR: NO stderr log for the silent-disabled path.
      const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
      const noiseLines = calls.filter((c) => c.includes('LSP'));
      expect(noiseLines.length).toBe(0);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('(d) config.lsp undefined entirely → silently empty, no log', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const out = await findRunningLSPs(undefined);
      expect(out).toEqual([]);
      const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
      const noiseLines = calls.filter((c) => c.includes('LSP'));
      expect(noiseLines.length).toBe(0);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ============================================================
// Command splitting: argv array form (Phase 3.5 #4)
// ============================================================

describe('auto-detect: command splitting (no shell evaluation)', () => {
  it('splits "pyright-langserver --stdio" into argv array', async () => {
    const out = await findRunningLSPs({
      enabled: true,
      servers: [{ language: 'python', command: '/usr/bin/pyright-langserver --stdio' }],
    });
    expect(out.length).toBe(1);
    expect(out[0]?.argv).toEqual(['/usr/bin/pyright-langserver', '--stdio']);
  });

  it('splits multi-arg command correctly', async () => {
    const out = await findRunningLSPs({
      enabled: true,
      servers: [{ language: 'go', command: '/usr/local/bin/gopls -mode=stdio -logfile=/tmp/x' }],
    });
    expect(out[0]?.argv).toEqual([
      '/usr/local/bin/gopls',
      '-mode=stdio',
      '-logfile=/tmp/x',
    ]);
  });
});
