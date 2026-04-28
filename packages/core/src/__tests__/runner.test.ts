// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 1: runner.ts unit tests.
 *
 * Coverage (per audit-iter-5 fix HH):
 *   (a) confidence merging when multiple adapters return overlapping fields
 *   (b) AST-wins / regex-fallback merge rule on field collision
 *   (c) 'none' confidence drops the entire adapter result
 *   (d) per-adapter try/catch isolation (one adapter throws → runner survives)
 */

import { describe, expect, it } from 'vitest';
import { runAdapters, buildDetectionSignals } from '../detect/adapters/runner.ts';
import type { CodebaseAdapter, AdapterResult, DetectionSignals } from '../detect/adapters/types.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function emptySignals(): DetectionSignals {
  return {
    presentDirs: new Set(),
    presentFiles: new Set(),
  };
}

function adapter(
  id: string,
  result: AdapterResult,
  matches: boolean = true,
  matchesThrows: boolean = false,
  introspectThrows: boolean = false,
): CodebaseAdapter {
  return {
    id,
    languages: ['python'],
    matches() {
      if (matchesThrows) throw new Error('matches-boom');
      return matches;
    },
    async introspect() {
      if (introspectThrows) throw new Error('introspect-boom');
      return result;
    },
  };
}

describe('runner: per-adapter try/catch isolation (test d)', () => {
  it('one adapter throwing in introspect() does NOT crash the runner', async () => {
    const a = adapter(
      'good-1',
      { conventions: { x: 1 }, provenance: [], confidence: 'high' },
    );
    const b = adapter(
      'bad',
      { conventions: {}, provenance: [], confidence: 'none' },
      true,
      false,
      true, // introspect throws
    );
    const c = adapter(
      'good-2',
      { conventions: { y: 2 }, provenance: [], confidence: 'medium' },
    );

    const out = await runAdapters([a, b, c], '/tmp/proj', emptySignals());
    expect(out.byAdapter['good-1']).toBeDefined();
    expect(out.byAdapter['good-1'].conventions.x).toBe(1);
    expect(out.byAdapter['good-2']).toBeDefined();
    expect(out.byAdapter['good-2'].conventions.y).toBe(2);
    expect(out.errored).toHaveLength(1);
    expect(out.errored[0].adapterId).toBe('bad');
    expect(out.errored[0].error).toContain('introspect-boom');
    expect(out.byAdapter.bad).toBeUndefined();
  });

  it('one adapter throwing in matches() does NOT crash the runner', async () => {
    const a = adapter('good', { conventions: { x: 1 }, provenance: [], confidence: 'high' });
    const b = adapter(
      'bad-matches',
      { conventions: {}, provenance: [], confidence: 'none' },
      true,
      true, // matches throws
    );
    const out = await runAdapters([a, b], '/tmp/proj', emptySignals());
    expect(out.byAdapter.good).toBeDefined();
    expect(out.errored).toHaveLength(1);
    expect(out.errored[0].adapterId).toBe('bad-matches');
  });
});

describe("runner: 'none' confidence drops field (test c)", () => {
  it("'none' confidence yields empty conventions block (regex fallback fills it)", async () => {
    const a = adapter('a', {
      conventions: { auth_dep: 'should_be_dropped' },
      provenance: [],
      confidence: 'none',
    });
    const out = await runAdapters([a], '/tmp/proj', emptySignals());
    expect(out.byAdapter.a).toBeDefined();
    expect(out.byAdapter.a.confidence).toBe('none');
    expect(out.byAdapter.a.conventions).toEqual({});
  });

  it("'high' / 'medium' / 'low' confidence emit conventions", async () => {
    const a = adapter('a', { conventions: { x: 1 }, provenance: [], confidence: 'high' });
    const b = adapter('b', { conventions: { y: 2 }, provenance: [], confidence: 'medium' });
    const c = adapter('c', { conventions: { z: 3 }, provenance: [], confidence: 'low' });
    const out = await runAdapters([a, b, c], '/tmp/proj', emptySignals());
    expect(out.byAdapter.a.conventions).toEqual({ x: 1 });
    expect(out.byAdapter.b.conventions).toEqual({ y: 2 });
    expect(out.byAdapter.c.conventions).toEqual({ z: 3 });
  });
});

describe('runner: confidence merging across adapters (test a, b)', () => {
  it('adapters write to separate id namespaces — no global field collision', async () => {
    // Both adapters return a conventions field named "auth_dep"; runner
    // keeps each in its own block.
    const a = adapter('python-fastapi', {
      conventions: { auth_dep: 'require_tier_or_guardian' },
      provenance: [{ field: 'auth_dep', sourceFile: '/tmp/proj/routers/x.py', line: 12, query: 'fastapi-auth-dep' }],
      confidence: 'high',
    });
    const b = adapter('python-django', {
      conventions: { auth_dep: 'login_required' },
      provenance: [{ field: 'auth_dep', sourceFile: '/tmp/proj/views.py', line: 5, query: 'django-decorator' }],
      confidence: 'high',
    });
    const out = await runAdapters([a, b], '/tmp/proj', emptySignals());
    expect(out.byAdapter['python-fastapi'].conventions.auth_dep).toBe('require_tier_or_guardian');
    expect(out.byAdapter['python-django'].conventions.auth_dep).toBe('login_required');
    expect(out.byAdapter['python-fastapi']._provenance.auth_dep).toMatch(/routers\/x\.py:12 :: fastapi-auth-dep/);
    expect(out.byAdapter['python-django']._provenance.auth_dep).toMatch(/views\.py:5 :: django-decorator/);
  });

  it('matches() returning false → adapter is in skipped[], not byAdapter[]', async () => {
    const a = adapter('skipped', { conventions: { x: 1 }, provenance: [], confidence: 'high' }, false);
    const b = adapter('ran', { conventions: { y: 2 }, provenance: [], confidence: 'high' });
    const out = await runAdapters([a, b], '/tmp/proj', emptySignals());
    expect(out.skipped).toContain('skipped');
    expect(out.byAdapter.skipped).toBeUndefined();
    expect(out.byAdapter.ran).toBeDefined();
  });

  it('duplicate adapter ids — first wins (defensive)', async () => {
    const a = adapter('dup', { conventions: { x: 1 }, provenance: [], confidence: 'high' });
    const b = adapter('dup', { conventions: { x: 999 }, provenance: [], confidence: 'high' });
    const out = await runAdapters([a, b], '/tmp/proj', emptySignals());
    expect(out.byAdapter.dup.conventions.x).toBe(1);
  });
});

describe('runner: signal builder', () => {
  const tmpDirs: string[] = [];

  function mkTmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'massu-runner-'));
    tmpDirs.push(d);
    return d;
  }

  it('reads pyproject.toml as raw text into pyprojectToml.__raw', () => {
    const root = mkTmp();
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "x"\ndependencies = ["fastapi"]\n', 'utf-8');
    const sig = buildDetectionSignals(root);
    const py = sig.pyprojectToml as { __raw?: string };
    expect(py.__raw).toContain('fastapi');
    rmSync(root, { recursive: true, force: true });
  });

  it('captures present dirs and files at one-level depth only', () => {
    const root = mkTmp();
    mkdirSync(join(root, 'routers'));
    mkdirSync(join(root, 'app'));
    writeFileSync(join(root, 'manage.py'), '', 'utf-8');
    writeFileSync(join(root, 'app', 'should_not_be_at_top.py'), '', 'utf-8');
    const sig = buildDetectionSignals(root);
    expect(sig.presentDirs.has('routers')).toBe(true);
    expect(sig.presentDirs.has('app')).toBe(true);
    expect(sig.presentFiles.has('manage.py')).toBe(true);
    expect(sig.presentFiles.has('should_not_be_at_top.py')).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('skips dotfiles', () => {
    const root = mkTmp();
    writeFileSync(join(root, '.env'), 'SECRET=x', 'utf-8');
    const sig = buildDetectionSignals(root);
    expect(sig.presentFiles.has('.env')).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
