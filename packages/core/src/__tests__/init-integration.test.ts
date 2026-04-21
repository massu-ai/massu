// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P7-002: Init integration tests.
 *
 * For each of the 11 fixture directories from P7-001, copy the fixture tree to
 * a tmp directory, run `runInit({ ci: true, skipSideEffects: true })` on it,
 * and compare the generated `massu.config.yaml` to the checked-in
 * `expected.massu.config.yaml` sibling (Zod-equivalence, not byte-identity).
 *
 * The fixtures MUST NOT be mutated in place — every test copies to tmpdir.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { parse as yamlParse } from 'yaml';
import { runInit } from '../commands/init.ts';

const FIXTURES_ROOT = resolve(__dirname, '..', 'detect', '__tests__', 'fixtures');

const FIXTURES = [
  'python-fastapi',
  'python-django',
  'ts-nextjs',
  'ts-nestjs',
  'rust-actix',
  'swift-ios',
  'go-gin',
  'multi-runtime',
  'monorepo-turbo',
  'monorepo-nx',
  'monorepo-pnpm',
] as const;

const createdTmpDirs: string[] = [];

afterAll(() => {
  for (const d of createdTmpDirs) {
    if (existsSync(d)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
});

/**
 * Copy a fixture to a fresh tmp directory, stripping the expected config file
 * (we do NOT want the pre-existing expected YAML confusing `runInit`'s
 * "config already exists" guard).
 */
function stageFixture(name: string): string {
  const src = resolve(FIXTURES_ROOT, name);
  const dest = mkdtempSync(resolve(tmpdir(), `massu-init-int-${name}-`));
  createdTmpDirs.push(dest);
  cpSync(src, dest, { recursive: true });
  const expectedPath = resolve(dest, 'expected.massu.config.yaml');
  if (existsSync(expectedPath)) {
    unlinkSync(expectedPath);
  }
  return dest;
}

/** Silent wrapper around runInit that sets cwd and skips side effects. */
async function runInitOnFixture(dir: string): Promise<void> {
  const prevCwd = process.cwd();
  const prevLog = console.log;
  const prevErr = console.error;
  try {
    process.chdir(dir);
  } catch {
    /* some CI sandboxes reject chdir */
  }
  console.log = () => {};
  console.error = () => {};
  try {
    await runInit(['--ci'], {
      ci: true,
      skipSideEffects: true,
      silent: true,
      cwd: dir,
    });
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    try {
      process.chdir(prevCwd);
    } catch {
      /* ignore */
    }
  }
}

function normalizeForCompare(cfg: Record<string, unknown>): Record<string, unknown> {
  // Drop fields that are not meaningful for equivalence (e.g. trailing-whitespace
  // differences will not affect the parsed object).
  // We don't mutate input.
  const clone = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  // Project name is derived from tmpdir basename — both actual and expected are
  // allowed to have different names since the tmpdir fixture name changes every
  // run. Strip it for comparison.
  if (clone.project && typeof clone.project === 'object') {
    const proj = clone.project as Record<string, unknown>;
    delete proj.name;
  }
  // P5-002: detection.fingerprint is a content hash that varies with fixture
  // contents; strip from structural-equivalence check.
  delete clone.detection;
  return clone;
}

describe('P7-002: init integration across 11 fixtures', () => {
  for (const name of FIXTURES) {
    it(`init --ci on ${name} produces expected v2 config`, async () => {
      const dir = stageFixture(name);
      await runInitOnFixture(dir);

      const actualPath = resolve(dir, 'massu.config.yaml');
      expect(existsSync(actualPath)).toBe(true);

      const actual = yamlParse(readFileSync(actualPath, 'utf-8')) as Record<string, unknown>;
      const expectedPath = resolve(FIXTURES_ROOT, name, 'expected.massu.config.yaml');
      const expected = yamlParse(readFileSync(expectedPath, 'utf-8')) as Record<string, unknown>;

      expect(actual.schema_version).toBe(2);
      expect(normalizeForCompare(actual)).toEqual(normalizeForCompare(expected));
    });
  }
});

// P2-003: targeted regression block for the multi-runtime monorepo shape that
// surfaced the 2026-04-20 bug (docs/incidents/2026-04-20-massu-core-monorepo-
// paths-source.md). The assertions below pin the exact values the permanent
// fix must produce, so any future regression that reverts paths.source back
// to 'src' (or drops monorepo_roots) fails loudly.
describe('multi-runtime monorepo (P2-003 regression pin)', () => {
  it('produces paths.source=apps and paths.monorepo_roots=[apps]', async () => {
    const dir = stageFixture('multi-runtime');
    await runInitOnFixture(dir);
    const cfg = yamlParse(readFileSync(resolve(dir, 'massu.config.yaml'), 'utf-8')) as Record<string, unknown>;
    const paths = cfg.paths as Record<string, unknown>;
    expect(paths.source).toBe('apps');
    expect(paths.monorepo_roots).toEqual(['apps']);
  });
});
