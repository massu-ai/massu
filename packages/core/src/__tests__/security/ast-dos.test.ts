// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 3.5 Surface 1: AST parser DoS surface.
 *
 * Vectors covered:
 *   - oversized file (>1MB cap) → adapter skips, does NOT parse
 *   - pathological nesting depth → static gate rejects
 *   - NUL bytes mid-file → static gate rejects
 *   - 5MB file at runner tier → runner drops it BEFORE adapter sees it
 *   - parse-deadline observability — withParseDeadline emits stderr warning
 *
 * These tests do not require a primed grammar — they exercise the
 * Phase-3.5 mitigation layer (parse-guard.ts) which sits in front of
 * Tree-sitter. The mitigations are load-bearing; Tree-sitter never sees
 * the adversarial bytes when these gates fire.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  isParsableSource,
  MAX_AST_FILE_BYTES,
  MAX_AST_PARSE_DEPTH,
  withParseDeadline,
} from '../../detect/adapters/parse-guard.ts';
import { runAdapters, buildDetectionSignals } from '../../detect/adapters/runner.ts';
import type {
  CodebaseAdapter,
  AdapterResult,
  DetectionSignals,
  SourceFile,
} from '../../detect/adapters/types.ts';

describe('AST DoS — oversized files (Phase 3.5 Surface 1, F-001)', () => {
  it('5MB file is rejected by isParsableSource without invoking Tree-sitter', () => {
    // 5MB string of valid Python.
    const huge = 'x = 1\n'.repeat(900_000); // ~5.4MB
    expect(huge.length).toBeGreaterThan(MAX_AST_FILE_BYTES);
    const result = isParsableSource(huge);
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('size-cap');
  });

  it('exactly-at-cap content is accepted (boundary)', () => {
    const exact = 'a'.repeat(MAX_AST_FILE_BYTES);
    expect(isParsableSource(exact)).toBeNull();
  });

  it('runner drops oversized files before passing to adapter introspect()', async () => {
    // Build an adapter that records what it sees.
    let receivedFiles: SourceFile[] | null = null;
    const recordingAdapter: CodebaseAdapter = {
      id: 'recording-adapter',
      languages: ['python'],
      matches: () => true,
      introspect: async (files): Promise<AdapterResult> => {
        receivedFiles = files;
        return { conventions: {}, provenance: [], confidence: 'none' };
      },
    };

    const oversized = 'x = 1\n'.repeat(900_000);
    const tinyOk = 'x = 1';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const signals: DetectionSignals = {
        presentDirs: new Set(),
        presentFiles: new Set(),
      };
      await runAdapters([recordingAdapter], '/tmp', signals, {
        sampleFiles: () => [
          { path: '/tmp/oversized.py', content: oversized, language: 'python', size: oversized.length },
          { path: '/tmp/tiny.py', content: tinyOk, language: 'python', size: tinyOk.length },
        ],
      });
      // Adapter received only the tiny file — oversized was dropped.
      expect(receivedFiles).not.toBeNull();
      expect(receivedFiles!.length).toBe(1);
      expect(receivedFiles![0]?.path).toBe('/tmp/tiny.py');
      // stderr line emitted naming the dropped file.
      const lines = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(lines).toContain('oversized.py');
      expect(lines).toContain('size-cap');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe('AST DoS — pathological nesting depth (Phase 3.5 Surface 1, F-001b)', () => {
  it('rejects content with > MAX_AST_PARSE_DEPTH nested parens', () => {
    const depth = MAX_AST_PARSE_DEPTH + 100;
    const adversarial = '('.repeat(depth) + 'x' + ')'.repeat(depth);
    const result = isParsableSource(adversarial);
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('depth-cap');
  });

  it('accepts moderate nesting (depth < cap)', () => {
    const ok = '('.repeat(100) + 'x' + ')'.repeat(100);
    expect(isParsableSource(ok)).toBeNull();
  });

  it('balanced brackets do not accumulate depth', () => {
    // 1M instances of '()' — depth is always 1, not 1M.
    const balanced = '()'.repeat(50_000);
    expect(isParsableSource(balanced)).toBeNull();
  });
});

describe('AST DoS — control bytes and malformed input (Phase 3.5 Surface 1, F-001c)', () => {
  it('rejects content with NUL bytes (binary file mislabeled)', () => {
    const nul = 'def x(): pass\0\0\0';
    const result = isParsableSource(nul);
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('control-bytes');
  });

  it('accepts UTF-8 text without control bytes', () => {
    expect(isParsableSource('def 函数(): pass\n')).toBeNull();
  });

  it('accepts BOM mid-file (no NUL, just unusual whitespace)', () => {
    const bom = 'def x():\n﻿    return 1\n';
    expect(isParsableSource(bom)).toBeNull();
  });
});

describe('AST DoS — parse deadline observability (Phase 3.5 Surface 1, F-002)', () => {
  it('withParseDeadline emits stderr warning when budget exceeded', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = withParseDeadline(
        () => {
          // Simulate a slow synchronous op by busy-looping for 50ms.
          const start = Date.now();
          while (Date.now() - start < 50) {
            /* spin */
          }
          return 'ok';
        },
        '/tmp/slow.py',
        10, // 10ms budget — guaranteed exceeded
      );
      expect(result.value).toBe('ok');
      expect(result.overBudget).toBe(true);
      const lines = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(lines).toContain('took');
      expect(lines).toContain('budget 10ms');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('withParseDeadline stays silent under budget', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = withParseDeadline(() => 42, '/tmp/fast.py', 5000);
      expect(result.value).toBe(42);
      expect(result.overBudget).toBe(false);
      // No `took` warning when under budget.
      const lines = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(lines).not.toContain('took');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe('AST DoS — runner isolation (Phase 3.5 Surface 1)', () => {
  it('adapter throwing on a file does NOT crash the runner; reported in errored[]', async () => {
    const throwingAdapter: CodebaseAdapter = {
      id: 'throwing-adapter',
      languages: ['python'],
      matches: () => true,
      introspect: async () => {
        throw new Error('synthetic adapter failure');
      },
    };
    const signals: DetectionSignals = {
      presentDirs: new Set(),
      presentFiles: new Set(),
    };
    const out = await runAdapters([throwingAdapter], '/tmp', signals, {
      sampleFiles: () => [],
    });
    expect(out.errored.length).toBe(1);
    expect(out.errored[0]?.adapterId).toBe('throwing-adapter');
    expect(out.errored[0]?.error).toContain('synthetic adapter failure');
  });

  it('buildDetectionSignals on a non-existent dir does NOT throw', () => {
    expect(() => buildDetectionSignals('/nonexistent-path-xyz-12345')).not.toThrow();
  });
});
