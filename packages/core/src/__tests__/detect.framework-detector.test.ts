// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import {
  detectFrameworks,
  DETECTION_RULES,
} from '../detect/framework-detector.ts';
import type { PackageManifest } from '../detect/package-detector.ts';

function manifest(partial: Partial<PackageManifest>): PackageManifest {
  return {
    path: partial.path ?? '/tmp/fake',
    relativePath: partial.relativePath ?? 'fake',
    directory: partial.directory ?? '/tmp',
    language: partial.language ?? 'python',
    runtime: partial.runtime ?? 'python3',
    name: partial.name ?? null,
    version: partial.version ?? null,
    dependencies: partial.dependencies ?? [],
    devDependencies: partial.devDependencies ?? [],
    scripts: partial.scripts ?? [],
    manifestType: partial.manifestType ?? 'pyproject.toml',
  };
}

describe('detect/framework-detector', () => {
  it('infers fastapi + pytest + sqlalchemy for Python', () => {
    const map = detectFrameworks([
      manifest({
        language: 'python',
        dependencies: ['fastapi', 'sqlalchemy', 'pydantic'],
        devDependencies: ['pytest', 'pytest-asyncio'],
      }),
    ]);
    expect(map.python?.framework).toBe('fastapi');
    expect(map.python?.test_framework).toBe('pytest');
    expect(map.python?.orm).toBe('sqlalchemy');
  });

  it('infers next + vitest + prisma for TS/JS', () => {
    const map = detectFrameworks([
      manifest({
        language: 'typescript',
        dependencies: ['next', 'react', '@prisma/client'],
        devDependencies: ['typescript', 'vitest'],
      }),
    ]);
    expect(map.typescript?.framework).toBe('next');
    expect(map.typescript?.test_framework).toBe('vitest');
    expect(map.typescript?.orm).toBe('prisma');
    expect(map.typescript?.ui_library).toBe('next');
  });

  it('infers actix-web + diesel for Rust', () => {
    const map = detectFrameworks([
      manifest({
        language: 'rust',
        dependencies: ['actix-web', 'tokio', 'diesel'],
        devDependencies: [],
      }),
    ]);
    expect(map.rust?.framework).toBe('actix-web');
    expect(map.rust?.orm).toBe('diesel');
  });

  it('infers gin + gorm for Go', () => {
    const map = detectFrameworks([
      manifest({
        language: 'go',
        dependencies: ['github.com/gin-gonic/gin', 'gorm.io/gorm'],
        devDependencies: ['github.com/stretchr/testify'],
      }),
    ]);
    expect(map.go?.framework).toBe('gin');
    expect(map.go?.orm).toBe('gorm');
    expect(map.go?.test_framework).toBe('testify');
  });

  it('higher-priority rule wins when multiple match', () => {
    const map = detectFrameworks([
      manifest({
        language: 'typescript',
        dependencies: ['next', 'react'], // next prio 10 beats react prio 5
        devDependencies: [],
      }),
    ]);
    expect(map.typescript?.framework).toBe('next');
  });

  it('returns null framework for unknown deps', () => {
    const map = detectFrameworks([
      manifest({
        language: 'python',
        dependencies: ['some-obscure-lib'],
        devDependencies: [],
      }),
    ]);
    expect(map.python?.framework).toBeNull();
    expect(map.python?.test_framework).toBeNull();
  });

  it('user-added detection rule appends to built-ins', () => {
    const map = detectFrameworks(
      [
        manifest({
          language: 'python',
          dependencies: ['custom-framework-xyz'],
          devDependencies: [],
        }),
      ],
      {
        rules: {
          python: {
            custom_fw: {
              signals: ['custom-framework-xyz'],
              priority: 50,
            },
          },
        },
      }
    );
    expect(map.python?.framework).toBe('custom_fw');
  });

  it('user rule with higher priority overrides built-in', () => {
    const map = detectFrameworks(
      [
        manifest({
          language: 'python',
          dependencies: ['fastapi'],
          devDependencies: [],
        }),
      ],
      {
        rules: {
          python: {
            my_fast: {
              signals: ['fastapi'],
              priority: 500,
            },
          },
        },
      }
    );
    expect(map.python?.framework).toBe('my_fast');
  });

  it('disable_builtin removes built-in rules', () => {
    const map = detectFrameworks(
      [
        manifest({
          language: 'python',
          dependencies: ['fastapi'],
          devDependencies: [],
        }),
      ],
      { disable_builtin: true }
    );
    expect(map.python?.framework).toBeNull();
  });

  it('detects multiple languages from multi-manifest monorepo', () => {
    const map = detectFrameworks([
      manifest({
        language: 'python',
        dependencies: ['django'],
        devDependencies: ['pytest'],
      }),
      manifest({
        language: 'typescript',
        dependencies: ['express'],
        devDependencies: ['jest'],
      }),
    ]);
    expect(map.python?.framework).toBe('django');
    expect(map.typescript?.framework).toBe('express');
    expect(map.typescript?.test_framework).toBe('jest');
  });

  it('exports DETECTION_RULES table for external inspection', () => {
    expect(Array.isArray(DETECTION_RULES)).toBe(true);
    expect(DETECTION_RULES.length).toBeGreaterThan(20);
    const hasFastapi = DETECTION_RULES.some(
      (r) => r.language === 'python' && r.value === 'fastapi'
    );
    expect(hasFastapi).toBe(true);
  });
});
