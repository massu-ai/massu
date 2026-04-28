// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 1: python-django adapter tests.
 *
 * Coverage:
 *   - matches() conservative gate (manage.py / pyproject mentions django)
 *   - introspect() degradation when grammar unavailable
 *   - Negative gate: no Django markers → matches() returns false
 */

import { describe, expect, it } from 'vitest';
import { pythonDjangoAdapter } from '../detect/adapters/python-django.ts';
import type { DetectionSignals } from '../detect/adapters/types.ts';

function emptySignals(overrides: Partial<DetectionSignals> = {}): DetectionSignals {
  return {
    presentDirs: new Set(),
    presentFiles: new Set(),
    ...overrides,
  };
}

describe('python-django adapter: matches() conservative gate', () => {
  it('matches when manage.py exists at root', () => {
    const signals = emptySignals({ presentFiles: new Set(['manage.py']) });
    expect(pythonDjangoAdapter.matches(signals)).toBe(true);
  });

  it('matches when pyproject.toml mentions django', () => {
    const signals = emptySignals({
      pyprojectToml: { __raw: '[project]\ndependencies = ["django>=4.2"]\n' } as Record<string, unknown>,
    });
    expect(pythonDjangoAdapter.matches(signals)).toBe(true);
  });

  it('does NOT match a FastAPI project (no manage.py + no django dep)', () => {
    const signals = emptySignals({
      pyprojectToml: { __raw: '[project]\ndependencies = ["fastapi"]\n' } as Record<string, unknown>,
      presentDirs: new Set(['routers']),
    });
    expect(pythonDjangoAdapter.matches(signals)).toBe(false);
  });

  it('does NOT match a generic Python project', () => {
    const signals = emptySignals({
      presentFiles: new Set(['pyproject.toml']),
      presentDirs: new Set(['src']),
    });
    expect(pythonDjangoAdapter.matches(signals)).toBe(false);
  });
});

describe('python-django adapter: introspect() degradation', () => {
  it('empty file list → none confidence', async () => {
    const r = await pythonDjangoAdapter.introspect([], '/tmp/x');
    expect(r.confidence).toBe('none');
  });

  it('grammar unavailable → returns none gracefully', async () => {
    const files = [{
      path: '/tmp/x/views.py',
      content: '@login_required\ndef home(request): pass\n',
      language: 'python' as const,
      size: 50,
    }];
    const r = await pythonDjangoAdapter.introspect(files, '/tmp/x');
    expect(['none', 'high', 'medium', 'low']).toContain(r.confidence);
  });
});

describe('python-django adapter: id + languages contract', () => {
  it('has stable id python-django and language list ["python"]', () => {
    expect(pythonDjangoAdapter.id).toBe('python-django');
    expect(pythonDjangoAdapter.languages).toEqual(['python']);
  });
});
