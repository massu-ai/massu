// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-H004 (plan-stage-c-high-batch).
 *
 * Closes the bug-class where `massu init` outright failed on a fresh Next.js
 * App Router repo (`app/` + `package.json`, no `src/`). The validator rejected
 * `paths.source: 'src'` because `src/` doesn't exist, and init rolled the
 * config back — leaving the customer no obvious recovery path.
 *
 * Structural fix: when pathsSource would default to 'src' but src/ is absent,
 * fall back through `app/` → `pages/` → `.` (root) before failing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildConfigFromDetection } from '../commands/init.ts';
import type { DetectionResult } from '../detect/index.ts';

function makeMinimalDetection(): DetectionResult {
  return {
    schema_version: 2,
    manifests: [
      { language: 'typescript', path: 'package.json', kind: 'package.json' },
    ],
    frameworks: {
      typescript: { framework: 'next', test_framework: 'vitest', orm: 'none', router: 'none', ui_library: 'none' },
    },
    sourceDirs: {
      typescript: { source_dirs: [], test_dirs: [], colocated: false, file_count: 0 },
    },
    monorepo: { type: 'single', packages: [] },
    verificationCommands: {},
    domains: [],
  } as unknown as DetectionResult;
}

describe('init App Router fallback (P-H004)', () => {
  let appRouterRepo = '';
  let pagesRouterRepo = '';
  let flatRepo = '';

  beforeAll(() => {
    // App Router fixture: ./app/ but no ./src/
    appRouterRepo = mkdtempSync(join(tmpdir(), 'massu-app-router-'));
    mkdirSync(join(appRouterRepo, 'app'));
    writeFileSync(join(appRouterRepo, 'package.json'), JSON.stringify({ name: 'next-app' }));

    // Pages Router fixture: ./pages/ but no ./src/ or ./app/
    pagesRouterRepo = mkdtempSync(join(tmpdir(), 'massu-pages-router-'));
    mkdirSync(join(pagesRouterRepo, 'pages'));
    writeFileSync(join(pagesRouterRepo, 'package.json'), JSON.stringify({ name: 'next-pages' }));

    // Flat repo: neither src/ nor app/ nor pages/
    flatRepo = mkdtempSync(join(tmpdir(), 'massu-flat-'));
    writeFileSync(join(flatRepo, 'package.json'), JSON.stringify({ name: 'flat' }));
  });

  afterAll(() => {
    if (appRouterRepo) rmSync(appRouterRepo, { recursive: true, force: true });
    if (pagesRouterRepo) rmSync(pagesRouterRepo, { recursive: true, force: true });
    if (flatRepo) rmSync(flatRepo, { recursive: true, force: true });
  });

  it('falls back to app/ when src/ is absent and app/ exists', () => {
    const cfg = buildConfigFromDetection({
      projectRoot: appRouterRepo,
      detection: makeMinimalDetection(),
    });
    expect((cfg.paths as Record<string, unknown>).source).toBe('app');
  });

  it('falls back to pages/ when src/ and app/ are absent and pages/ exists', () => {
    const cfg = buildConfigFromDetection({
      projectRoot: pagesRouterRepo,
      detection: makeMinimalDetection(),
    });
    expect((cfg.paths as Record<string, unknown>).source).toBe('pages');
  });

  it('falls back to . (root) when no recognized framework dir exists', () => {
    const cfg = buildConfigFromDetection({
      projectRoot: flatRepo,
      detection: makeMinimalDetection(),
    });
    expect((cfg.paths as Record<string, unknown>).source).toBe('.');
  });

  it('keeps src when both src/ and app/ are present (src wins, no surprise rebinding)', () => {
    const dualRepo = mkdtempSync(join(tmpdir(), 'massu-dual-'));
    try {
      mkdirSync(join(dualRepo, 'src'));
      mkdirSync(join(dualRepo, 'app'));
      writeFileSync(join(dualRepo, 'package.json'), JSON.stringify({ name: 'dual' }));

      const cfg = buildConfigFromDetection({
        projectRoot: dualRepo,
        detection: makeMinimalDetection(),
      });
      // src/ exists → no fallback triggers; pathsSource stays at 'src'
      expect((cfg.paths as Record<string, unknown>).source).toBe('src');
    } finally {
      rmSync(dualRepo, { recursive: true, force: true });
    }
  });
});
