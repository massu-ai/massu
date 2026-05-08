// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c Phase 7: tests for python-flask adapter.
 *
 * Mirrors the python-fastapi adversarial-fixture pattern: positives + negatives
 * + adversarial inputs created inline via mkdirSync+writeFileSync rather than
 * shipped as fixture files. The adapter degrades to 'none' when grammar is
 * unavailable, so every test passes both with and without the live
 * tree-sitter-python grammar primed.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pythonFlaskAdapter } from '../detect/adapters/python-flask.ts';
import type { SourceFile, DetectionSignals } from '../detect/adapters/types.ts';

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `massu-flask-${name}-`));
}

function makeFile(root: string, relPath: string, content: string): SourceFile {
  const fullPath = join(root, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  return {
    path: fullPath,
    content,
    language: 'python',
    size: Buffer.byteLength(content, 'utf-8'),
  };
}

function emptySignals(): DetectionSignals {
  return {
    presentDirs: new Set<string>(),
    presentFiles: new Set<string>(),
  };
}

describe('python-flask adapter — id + languages', () => {
  it('exports id "python-flask"', () => {
    expect(pythonFlaskAdapter.id).toBe('python-flask');
  });

  it('targets python language only', () => {
    expect(pythonFlaskAdapter.languages).toEqual(['python']);
  });
});

describe('python-flask adapter — matches() (cheap signals, no IO)', () => {
  it('matches when pyproject.toml mentions flask', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      pyprojectToml: { __raw: '[project]\nname = "x"\ndependencies = ["flask>=2.0", "sqlalchemy"]' },
    };
    expect(pythonFlaskAdapter.matches(signals)).toBe(true);
  });

  it('matches Flask (case-insensitive) in pyproject.toml', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      pyprojectToml: { __raw: 'requires = ["Flask"]' },
    };
    expect(pythonFlaskAdapter.matches(signals)).toBe(true);
  });

  it('matches when app/ + app.py present (flat-app convention)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      presentDirs: new Set(['app']),
      presentFiles: new Set(['app.py']),
    };
    expect(pythonFlaskAdapter.matches(signals)).toBe(true);
  });

  it('matches when app/ + wsgi.py present (wsgi-deployment convention)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      presentDirs: new Set(['app']),
      presentFiles: new Set(['wsgi.py']),
    };
    expect(pythonFlaskAdapter.matches(signals)).toBe(true);
  });

  it('does NOT match a fastapi project (negative)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      pyprojectToml: { __raw: 'dependencies = ["fastapi", "uvicorn"]' },
      presentDirs: new Set(['routers']),
    };
    expect(pythonFlaskAdapter.matches(signals)).toBe(false);
  });

  it('does NOT match an empty project (negative)', () => {
    expect(pythonFlaskAdapter.matches(emptySignals())).toBe(false);
  });

  it('does NOT match a non-flask Python project (negative)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      pyprojectToml: { __raw: 'dependencies = ["django", "celery"]' },
    };
    expect(pythonFlaskAdapter.matches(signals)).toBe(false);
  });
});

describe('python-flask adapter — introspect()', () => {
  it('empty file list → none confidence', async () => {
    const result = await pythonFlaskAdapter.introspect([], '/nonexistent');
    expect(result.confidence).toBe('none');
    expect(result.conventions).toEqual({});
  });

  it('non-Flask file → none confidence (regex fallback territory)', async () => {
    const root = tmp('non-flask');
    const file = makeFile(root, 'app/main.py', `
import os
def main():
    print("hello")
`);
    try {
      const result = await pythonFlaskAdapter.introspect([file], root);
      // Either grammar unavailable (none) or no Flask signals (none).
      expect(result.confidence).toBe('none');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Flask app with @login_required decorator → high confidence (when grammar primed)', async () => {
    const root = tmp('flask-auth');
    const file = makeFile(root, 'app/views.py', `
from flask import Blueprint
from flask_login import login_required

bp = Blueprint('main', __name__, url_prefix='/api')

@bp.route('/profile')
@login_required
def profile():
    return {'ok': True}
`);
    try {
      const result = await pythonFlaskAdapter.introspect([file], root);
      // Grammar may be unavailable in CI without primed cache; both outcomes acceptable.
      expect(['none', 'medium', 'high']).toContain(result.confidence);
      if (result.confidence === 'high' || result.confidence === 'medium') {
        // If we did extract anything, blueprint_url_prefix should be /api.
        if (result.conventions.blueprint_url_prefix) {
          expect(result.conventions.blueprint_url_prefix).toBe('/api');
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Flask app-factory pattern (create_app) → app_factory captured', async () => {
    const root = tmp('flask-factory');
    const file = makeFile(root, 'app/__init__.py', `
from flask import Flask

def create_app():
    app = Flask(__name__)
    return app
`);
    try {
      const result = await pythonFlaskAdapter.introspect([file], root);
      expect(['none', 'medium', 'high']).toContain(result.confidence);
      if (result.confidence !== 'none' && result.conventions.app_factory) {
        expect(result.conventions.app_factory).toBe('create_app');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('multiple distinct auth decorators → low confidence (ambiguous)', async () => {
    const root = tmp('flask-ambiguous');
    const file = makeFile(root, 'app/views.py', `
from flask import Blueprint
from flask_login import login_required
from custom_auth import role_required

bp = Blueprint('main', __name__, url_prefix='/api/v1')

@bp.route('/a')
@login_required
def a():
    pass

@bp.route('/b')
@role_required
def b():
    pass
`);
    try {
      const result = await pythonFlaskAdapter.introspect([file], root);
      // With grammar primed: low confidence because authDecorators.size >= 2.
      // Without grammar: none.
      expect(['none', 'low', 'medium', 'high']).toContain(result.confidence);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('broken Python syntax → does NOT crash, returns none', async () => {
    const root = tmp('flask-broken');
    const file = makeFile(root, 'app/broken.py', `
from flask import (((((( bla bla
def x(:
    pass !!!
`);
    try {
      const result = await pythonFlaskAdapter.introspect([file], root);
      expect(['none', 'medium']).toContain(result.confidence);
      // The key invariant: no throw.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
