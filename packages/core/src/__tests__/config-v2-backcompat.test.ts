// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getConfig, resetConfig } from '../config.ts';

/**
 * P2-009: CR-10 blast-radius backcompat test for config schema v2.
 *
 * Verifies that:
 * 1. A v1-shape config (no schema_version, flat framework) loads unchanged and
 *    every legacy access path (framework.router/.orm/.ui) still works.
 * 2. A v2-shape config (schema_version: 2, multi-runtime, verification,
 *    canonical_paths, verification_types, detection) loads all new fields AND
 *    preserves legacy framework.router/.orm/.ui reads via backcompat mirroring.
 * 3. The existing config.test.ts v1 shape assertions keep passing is verified
 *    by running vitest on that file (no modification required here).
 */

const TEST_DIR = resolve(__dirname, '../test-config-v2-backcompat-tmp');
const CONFIG_PATH = resolve(TEST_DIR, 'massu.config.yaml');

function writeConfig(yaml: string) {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, yaml, 'utf-8');
}

describe('Config Schema v2 — CR-10 Backcompat (P2-009)', () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    resetConfig();
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    process.chdir(TEST_DIR);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    resetConfig();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------
  // Test 1: v1-shape config — every legacy access path still works.
  // -------------------------------------------------------
  it('loads a v1-shape config without schema_version and preserves legacy framework reads', () => {
    writeConfig(`
project:
  name: v1-legacy
framework:
  type: typescript
  router: trpc
  orm: prisma
  ui: next
paths:
  source: src
rules:
  - pattern: "src/**/*.ts"
    rules:
      - "Use ESM imports"
`);
    const config = getConfig();

    // schema_version defaults to 1 when absent (v1 backcompat)
    expect(config.schema_version).toBe(1);

    // Legacy access paths — must still work exactly as in v1
    expect(config.framework.type).toBe('typescript');
    expect(config.framework.router).toBe('trpc');
    expect(config.framework.orm).toBe('prisma');
    expect(config.framework.ui).toBe('next');

    // New v2 fields are undefined when absent
    expect(config.framework.primary).toBeUndefined();
    expect(config.framework.languages).toBeUndefined();
    expect(config.verification).toBeUndefined();
    expect(config.canonical_paths).toBeUndefined();
    expect(config.verification_types).toBeUndefined();
    expect(config.detection).toBeUndefined();

    // Rules without `language` field remain valid (P2-003)
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0].language).toBeUndefined();
  });

  // -------------------------------------------------------
  // Test 2: v2-shape config — new fields AND legacy reads both work.
  // -------------------------------------------------------
  it('loads a v2-shape multi-runtime config and exposes all new fields', () => {
    writeConfig(`
schema_version: 2
project:
  name: v2-multi
framework:
  type: multi
  primary: python
  languages:
    python:
      framework: fastapi
      test_framework: pytest
      orm: sqlalchemy
    typescript:
      framework: nextjs
      test_framework: vitest
      router: trpc
      ui: next
rules:
  - pattern: "apps/ai-service/**"
    rules:
      - "no-sync-io"
    language: python
  - pattern: "apps/web/**"
    rules:
      - "use-esm"
verification:
  python:
    test: pytest -xvs
    lint: ruff check
    type: mypy --strict
  typescript:
    test: vitest run
    type: tsc --noEmit
canonical_paths:
  feature_config: config/features.yaml
  event_log_db: apps/data/events.db
verification_types:
  "VR-IBKR-CONTRACT": "IBKR contract parity check"
  "VR-POLICY": "Policy enforcement verification"
detection:
  rules:
    python:
      fastapi:
        signals:
          - "from fastapi import"
          - "FastAPI("
        priority: 10
  signal_weights:
    "package.json": 5
    "pyproject.toml": 8
`);
    const config = getConfig();

    // schema_version explicitly set
    expect(config.schema_version).toBe(2);

    // P2-002: multi-runtime declarations
    expect(config.framework.type).toBe('multi');
    expect(config.framework.primary).toBe('python');
    expect(config.framework.languages).toBeDefined();
    expect(config.framework.languages!.python.framework).toBe('fastapi');
    expect(config.framework.languages!.python.test_framework).toBe('pytest');
    expect(config.framework.languages!.typescript.framework).toBe('nextjs');

    // CRITICAL: legacy framework.router/.orm/.ui must still be readable.
    // In multi-mode they are mirrored from the primary language entry when
    // the top-level value is the schema default 'none'. Here the primary is
    // python with orm: sqlalchemy, so config.framework.orm === 'sqlalchemy'.
    // For tools.ts:246 — this keeps `config.framework.orm === 'prisma'` style
    // checks working because the legacy path still resolves to a real string.
    expect(typeof config.framework.router).toBe('string');
    expect(typeof config.framework.orm).toBe('string');
    expect(typeof config.framework.ui).toBe('string');
    expect(config.framework.orm).toBe('sqlalchemy');

    // P2-003: rules with/without language both valid
    expect(config.rules).toHaveLength(2);
    expect(config.rules[0].language).toBe('python');
    expect(config.rules[1].language).toBeUndefined();

    // P2-004: verification command map
    expect(config.verification).toBeDefined();
    expect(config.verification!.python.test).toBe('pytest -xvs');
    expect(config.verification!.python.lint).toBe('ruff check');
    expect(config.verification!.typescript.type).toBe('tsc --noEmit');

    // P2-005: canonical_paths — arbitrary keys returned verbatim
    expect(config.canonical_paths).toBeDefined();
    expect(config.canonical_paths!.feature_config).toBe('config/features.yaml');
    expect(config.canonical_paths!.event_log_db).toBe('apps/data/events.db');

    // P2-006: verification_types — user-declared VR-* names
    expect(config.verification_types).toBeDefined();
    expect(config.verification_types!['VR-IBKR-CONTRACT']).toBe('IBKR contract parity check');
    expect(config.verification_types!['VR-POLICY']).toBe('Policy enforcement verification');

    // P2-008: detection rules and signal weights
    expect(config.detection).toBeDefined();
    expect(config.detection!.rules).toBeDefined();
    expect(config.detection!.rules!.python.fastapi.signals).toEqual([
      'from fastapi import',
      'FastAPI(',
    ]);
    expect(config.detection!.rules!.python.fastapi.priority).toBe(10);
    expect(config.detection!.signal_weights!['pyproject.toml']).toBe(8);
  });

  // -------------------------------------------------------
  // Test 3: v2 multi-runtime without primary — legacy reads default to 'none'.
  // -------------------------------------------------------
  it('v2 config with no primary language falls back to schema defaults for legacy keys', () => {
    writeConfig(`
schema_version: 2
project:
  name: v2-no-primary
framework:
  type: multi
  languages:
    python:
      framework: fastapi
`);
    const config = getConfig();
    expect(config.schema_version).toBe(2);
    expect(config.framework.type).toBe('multi');
    // No primary => no mirroring => defaults stay 'none'
    expect(config.framework.router).toBe('none');
    expect(config.framework.orm).toBe('none');
    expect(config.framework.ui).toBe('none');
  });

  // -------------------------------------------------------
  // Test 4: top-level router/orm/ui override multi-runtime primary language.
  // -------------------------------------------------------
  it('user-provided top-level framework.router wins over primary language mirror', () => {
    writeConfig(`
schema_version: 2
project:
  name: v2-explicit-override
framework:
  type: multi
  primary: python
  router: trpc
  languages:
    python:
      framework: fastapi
      router: fastapi-router
`);
    const config = getConfig();
    // Explicit user value at top level (trpc) wins, even though primary says fastapi-router
    expect(config.framework.router).toBe('trpc');
  });

  // -------------------------------------------------------
  // Test 5: P2-007 — malformed config produces a clear actionable error.
  // -------------------------------------------------------
  it('throws a named, actionable error when schema_version is invalid', () => {
    writeConfig(`
schema_version: 99
project:
  name: bad-version
`);
    expect(() => getConfig()).toThrow(/Invalid massu\.config\.yaml/);
  });

  it('throws a named, actionable error listing the bad field path', () => {
    writeConfig(`
project:
  name: bad-domain-field
domains:
  - name: 123
    routers: "not-an-array"
`);
    // Either the field path or the remediation hint must be surfaced.
    expect(() => getConfig()).toThrow(/Invalid massu\.config\.yaml/);
    try {
      getConfig();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/domains/);
      expect(msg).toMatch(/massu config refresh/);
    }
  });
});
