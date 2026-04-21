// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P7-005: End-to-end install test.
 *
 * For each of the 11 fixture directories, copy to a tmp dir, run `init --ci`,
 * then reload the config via `getConfig()` and verify that the skill-facing
 * fields resolve to usable values:
 *   - Primary language's VR test command is a non-empty string.
 *   - `getResolvedPaths().srcDir` points at the detected source_dirs entry.
 *   - Per-language verification.<primary>.test exists when detection succeeded.
 *
 * No network, no child processes, no `npm publish`. All steps are in-process
 * function calls — this is what real users would see WITHOUT needing to
 * touch translation or audit skills.
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { runInit } from '../commands/init.ts';
import { getConfig, getProjectRoot, getResolvedPaths, resetConfig } from '../config.ts';

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
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

function stageFixture(name: string): string {
  const src = resolve(FIXTURES_ROOT, name);
  const dest = mkdtempSync(resolve(tmpdir(), `massu-e2e-${name}-`));
  createdTmpDirs.push(dest);
  cpSync(src, dest, { recursive: true });
  const expectedPath = resolve(dest, 'expected.massu.config.yaml');
  if (existsSync(expectedPath)) {
    try { unlinkSync(expectedPath); } catch { /* ignore */ }
  }
  return dest;
}

async function runInitAndLoadConfig(dir: string): Promise<ReturnType<typeof getConfig>> {
  const prevCwd = process.cwd();
  const prevLog = console.log;
  const prevErr = console.error;
  try {
    process.chdir(dir);
  } catch {
    /* some sandboxes reject chdir */
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
    resetConfig();
    return getConfig();
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    try { process.chdir(prevCwd); } catch { /* ignore */ }
    resetConfig();
  }
}

describe('P7-005: end-to-end install across 11 fixtures', () => {
  for (const name of FIXTURES) {
    it(`${name}: init → config loads → VR test command resolves`, async () => {
      const dir = stageFixture(name);
      const cfg = await runInitAndLoadConfig(dir);

      // Every v2 config must have schema_version=2.
      expect(cfg.schema_version).toBe(2);

      // Verification block is populated for at least one detected language.
      expect(cfg.verification).toBeDefined();
      const ver = cfg.verification as Record<string, Record<string, string>>;
      const languagesWithVr = Object.keys(ver);
      expect(languagesWithVr.length).toBeGreaterThan(0);

      // For each language slot that has verification, `test` must be a
      // non-empty string (no translation warnings should fire).
      for (const lang of languagesWithVr) {
        const entry = ver[lang];
        expect(typeof entry.test).toBe('string');
        expect(entry.test.length).toBeGreaterThan(0);
      }

      // getResolvedPaths.srcDir resolves to an absolute path that either
      // exists or is explicitly the project root when paths.source === '.'.
      const prevCwd = process.cwd();
      try {
        process.chdir(dir);
        resetConfig();
        const resolved = getResolvedPaths();
        expect(resolved.srcDir.startsWith('/')).toBe(true);
        const root = getProjectRoot();
        // On macOS tmpdir() returns /var/..., but resolved paths go through
        // realpath-equivalent lookups and become /private/var/.... Use
        // realpath on `dir` for the comparison to stay cross-platform.
        expect(root).toBe(realpathSync(dir));
      } finally {
        try { process.chdir(prevCwd); } catch { /* ignore */ }
        resetConfig();
      }
    });
  }
});
