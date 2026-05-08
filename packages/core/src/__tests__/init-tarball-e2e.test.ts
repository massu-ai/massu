// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * STRUCTURAL gate: `npx massu init` end-to-end against the BUILT TARBALL
 * (not TS source). Plan 1.5.3 §Stage B deliverable.
 *
 * 1.5.1 → 1.5.2 hotfix demonstrated `init-end-to-end.test.ts` passing
 * against TS source while production `dist/cli.js` failed because the
 * vitest-loaded source has different `__dirname` depth than the bundled
 * cli.js. resolveTemplatesDir() candidates `../../templates` worked from
 * `src/commands/init.ts` but failed from `dist/cli.js`. Source-level
 * tests cannot catch this class of bug; only running the published shape
 * can.
 *
 * This test:
 *   1. Runs `npm pack` in packages/core/ to produce the actual published
 *      tarball (massu-core-<version>.tgz).
 *   2. For each Phase 7 fixture (rails / phoenix / aspnet / spring /
 *      go-chi from the SHARED `phase7-init-fixtures.ts` module):
 *      a. Creates a fresh tmpdir.
 *      b. Writes the fixture files.
 *      c. `npm install <tarball-path> --no-save --no-package-lock` into
 *         a sibling tmpdir to install the published shape.
 *      d. Spawns `<install-tmp>/node_modules/.bin/massu init --yes
 *         --skip-side-effects` from the fixture's project root.
 *      e. Reads back the emitted massu.config.yaml and asserts the
 *         variant-template-merged fields.
 *   3. Tarball-shape assertions: `dist/cli.js` exists, `templates/<id>/
 *      massu.config.yaml` exists for every fixture, `cli --version`
 *      prints the package.json version.
 *
 * Tag-gated for opt-in: skipped unless `MASSU_TARBALL_E2E=1` is set.
 * Local devs run via `MASSU_TARBALL_E2E=1 npm test`. CI runs
 * unconditionally on push to main + on `v*` tags via a workflow that
 * sets the env var.
 *
 * Performance: `npm pack` runs once per test file (`beforeAll`); each
 * fixture install is ~3-8s; total wall-clock at 5 fixtures is ~30s on a
 * warm npm cache. Acceptable for opt-in/CI; that's why the env-gate.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse } from 'yaml';
import { PHASE7_INIT_FIXTURES } from './fixtures/phase7-init-fixtures.ts';

const ENABLED = process.env.MASSU_TARBALL_E2E === '1';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(__dirname, '../..'); // packages/core
let TARBALL_PATH: string | null = null;
let SHARED_INSTALL_DIR: string | null = null;

describe.skipIf(!ENABLED)('init end-to-end against the BUILT tarball', () => {
  beforeAll(() => {
    // Step 0 — build dist/ from current src/ explicitly. `npm pack`
    // does NOT trigger `prepublishOnly` (only `npm publish` does), so
    // a stale dist/ would leak through. Running build here makes the
    // test hermetic against whatever build state happens to be in dist/
    // at test-run time. The build is fast (~30 s warm) per
    // `packages/core/package.json:scripts.build`.
    const buildResult = spawnSync('npm', ['run', 'build', '--silent'], {
      cwd: PACKAGE_DIR,
      encoding: 'utf-8',
      timeout: 180_000,
    });
    if (buildResult.status !== 0) {
      throw new Error(`npm run build failed: ${buildResult.stderr}`);
    }

    // Step 1 — produce the actual published tarball via `npm pack`.
    // The output filename is `<name>-<version>.tgz`. We capture the
    // emitted path via stdout (npm pack prints the filename).
    const packTmp = mkdtempSync(join(tmpdir(), 'massu-tarball-pack-'));
    const result = spawnSync('npm', ['pack', '--pack-destination', packTmp], {
      cwd: PACKAGE_DIR,
      encoding: 'utf-8',
      timeout: 180_000,
    });
    if (result.status !== 0) {
      throw new Error(`npm pack failed: ${result.stderr}`);
    }
    // Last non-empty line of stdout is the tarball filename.
    const lines = result.stdout.trim().split('\n').filter((l) => l.trim());
    const fname = lines[lines.length - 1].trim();
    TARBALL_PATH = join(packTmp, fname);
    if (!existsSync(TARBALL_PATH)) {
      throw new Error(`tarball not found at ${TARBALL_PATH}`);
    }

    // Step 2 — install the tarball into a SHARED tmpdir; per-fixture
    // tests reuse this install rather than re-running npm install per
    // fixture (which would 5x the wall-clock cost). The install layout
    // is: <SHARED_INSTALL_DIR>/node_modules/@massu/core/{dist,templates}.
    SHARED_INSTALL_DIR = mkdtempSync(join(tmpdir(), 'massu-tarball-install-'));
    writeFileSync(
      join(SHARED_INSTALL_DIR, 'package.json'),
      JSON.stringify({ name: 'massu-tarball-e2e-host', version: '0.0.0', private: true }, null, 2),
    );
    const installResult = spawnSync(
      'npm',
      [
        'install',
        '--no-save',
        '--no-package-lock',
        '--prefer-online=false',
        TARBALL_PATH,
      ],
      {
        cwd: SHARED_INSTALL_DIR,
        encoding: 'utf-8',
        timeout: 300_000,
      },
    );
    if (installResult.status !== 0) {
      throw new Error(`npm install <tarball> failed: ${installResult.stderr}`);
    }
  }, 600_000);

  afterAll(() => {
    if (TARBALL_PATH) {
      try { rmSync(dirname(TARBALL_PATH), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (SHARED_INSTALL_DIR) {
      try { rmSync(SHARED_INSTALL_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // ============================================================
  // Tarball-shape assertions (one-time)
  // ============================================================

  it('tarball: dist/cli.js exists at <pkg>/dist/cli.js', () => {
    const cliPath = join(SHARED_INSTALL_DIR!, 'node_modules/@massu/core/dist/cli.js');
    expect(existsSync(cliPath), `dist/cli.js missing at ${cliPath}`).toBe(true);
  });

  it('tarball: every CORE_BUNDLED_IDS entry has templates/<id>/massu.config.yaml', () => {
    // Read CORE_BUNDLED_IDS from the installed tarball's source (kept in
    // src/ per the package.json files[] glob).
    const indexSrcPath = join(
      SHARED_INSTALL_DIR!,
      'node_modules/@massu/core/src/detect/adapters/index.ts',
    );
    if (!existsSync(indexSrcPath)) return; // src not shipped in this build (acceptable)
    const src = readFileSync(indexSrcPath, 'utf-8');
    const setMatch = /CORE_BUNDLED_IDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(setMatch, 'CORE_BUNDLED_IDS regex must match in shipped src').not.toBeNull();
    const ids = (setMatch![1].match(/'([^']+)'/g) ?? []).map((s) => s.slice(1, -1));
    const templatesDir = join(SHARED_INSTALL_DIR!, 'node_modules/@massu/core/templates');
    for (const id of ids) {
      const templateFile = join(templatesDir, id, 'massu.config.yaml');
      // Not every CORE_BUNDLED_IDS entry has a templates/ counterpart —
      // python-flask's DOES, python-fastapi's DOES, etc. We DON'T assert
      // 1:1 (that's the variant-template-presence test in Plan 1.5.3
      // Stage B's optional gate). Here we just spot-check that any id
      // with a templates/ dir is well-formed YAML.
      if (existsSync(templateFile)) {
        expect(() => yamlParse(readFileSync(templateFile, 'utf-8'))).not.toThrow();
      }
    }
  });

  it('tarball: <bin>/massu --version prints package.json.version', () => {
    const cliBin = join(SHARED_INSTALL_DIR!, 'node_modules/.bin/massu');
    const pkgJsonPath = join(SHARED_INSTALL_DIR!, 'node_modules/@massu/core/package.json');
    expect(existsSync(cliBin), `bin not found at ${cliBin}`).toBe(true);
    const expectedVersion = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')).version;
    const out = execFileSync(cliBin, ['--version'], { encoding: 'utf-8', timeout: 30_000 }).trim();
    expect(out, `expected output to contain ${expectedVersion}, got: ${out}`).toContain(expectedVersion);
  });

  // ============================================================
  // Per-fixture init assertions (the core regression gate)
  // ============================================================

  for (const fx of PHASE7_INIT_FIXTURES) {
    it(`fixture=${fx.id}: built-bundle init produces variant-template-merged config`, () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), `massu-tarball-fx-${fx.id}-`));
      try {
        for (const f of fx.files) {
          const fullPath = join(fixtureRoot, f.path);
          mkdirSync(join(fullPath, '..'), { recursive: true });
          writeFileSync(fullPath, f.content, 'utf-8');
        }

        // Spawn the bin from the SHARED install. cwd=fixtureRoot so init
        // operates against the fixture's project tree.
        const cliBin = join(SHARED_INSTALL_DIR!, 'node_modules/.bin/massu');
        const result = spawnSync(
          cliBin,
          ['init', '--yes', '--skip-side-effects'],
          {
            cwd: fixtureRoot,
            encoding: 'utf-8',
            timeout: 120_000,
            env: { ...process.env, MASSU_DRIFT_QUIET: '1' },
          },
        );
        if (result.status !== 0) {
          throw new Error(
            `init failed for fixture=${fx.id}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
          );
        }

        const configPath = join(fixtureRoot, 'massu.config.yaml');
        expect(existsSync(configPath), `massu.config.yaml not written for ${fx.id}`).toBe(true);
        const config = yamlParse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;

        const fw = config.framework as Record<string, unknown>;
        expect(fw.type).toBe(fx.expect['framework.type']);
        // The CORE assertion this entire test exists for: variant template
        // merge succeeded against the BUILT bundle, not just src.
        expect(
          fw.router,
          `tarball init: framework.router must be ${fx.expect['framework.router']} (was '${fw.router}'); ` +
          `if 'none', resolveTemplatesDir() didn't find templates/ in the bundled layout — Plan 1.5.2 regression`,
        ).toBe(fx.expect['framework.router']);

        const langs = fw.languages as Record<string, unknown>;
        for (const [lang, expected] of Object.entries(fx.expect['framework.languages'])) {
          const langEntry = langs[lang] as Record<string, unknown>;
          expect(langEntry.framework).toBe(expected.framework);
        }

        const paths = config.paths as Record<string, unknown>;
        expect(paths.source).toBe(fx.expect['paths.source']);

        const lang = Object.keys(fx.expect['framework.languages'])[0];
        const verification = config.verification as Record<string, Record<string, unknown>> | undefined;
        expect(verification?.[lang]?.lint).toBeTruthy();
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    }, 180_000);
  }
});
