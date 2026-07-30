// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Drift-guard: no npm script may depend on POSIX shell semantics, and the esbuild
 * bundling contract has exactly ONE source of truth.
 *
 * Closes the class documented in `./helpers/npm-script-portability.ts`. `build:cli` and
 * `build:hooks` encoded esbuild invocations as single-quoted, multi-line SHELL STRINGS;
 * npm runs scripts through `cmd.exe` on Windows, which re-parsed them into a different
 * argv and failed `npm run build` on every Windows run (CI 30428800020). Separately the
 * `--external:` list existed at three hand-maintained sites — one of them carrying the
 * comment "keep in lockstep with build:cli externals" — and had already drifted to 11
 * entries against 14.
 *
 * If either regresses tomorrow, THIS goes red.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  findShellPortabilityHits,
  shellSegments,
  declaresBashInterpreter,
  DETECTION_KINDS,
  type ShellPortabilityKind,
} from './helpers/npm-script-portability.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

/** This guard's own path — the "prove it looked" anchor (M1). */
const SELF = 'packages/core/src/__tests__/npm-script-shell-portability-drift-guard.test.ts';

/** The single source of truth for the bundling contract. */
const BUILD_CONFIG = 'packages/core/scripts/build-config.mjs';

/**
 * Scripts permitted to depend on POSIX shell semantics, each with a cited reason.
 *
 * EMPTY, and that is the intended steady state. The `bash`-interpreter exemption is
 * DERIVED per segment inside the detector, not listed here — a script that names its own
 * interpreter needs no entry. Adding an entry here is a RULING that a script genuinely
 * cannot be expressed portably; write the reason, not just the key.
 */
const ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({});

/** Every tracked package.json, from git — the authoritative population. */
function trackedPackageJsons(): string[] {
  const out = execFileSync('git', ['ls-files', '*package.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const files = out
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.includes('node_modules/'));
  // M1 — PROVE IT LOOKED. "Scanned 0, found 0" must be a loud error, never a pass.
  if (files.length === 0) {
    throw new Error('git ls-files enumerated 0 package.json files — refusing to report clean');
  }
  return files.sort();
}

/** M2 — an unreadable or unparseable input is an ERROR, never an empty one. */
function readScripts(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(join(REPO_ROOT, file), 'utf-8');
  } catch (err) {
    throw new Error(`unreadable package.json ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`unparseable package.json ${file}: ${(err as Error).message}`);
  }
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (scripts === undefined) return {};
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) {
    throw new Error(`${file}: "scripts" is not an object — refusing to report clean`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new Error(`${file}: scripts.${k} is not a string — refusing to report clean`);
    }
    out[k] = v;
  }
  return out;
}

describe('npm scripts are shell-portable', () => {
  it('sweeps a non-empty population that includes this guard', () => {
    const files = trackedPackageJsons();
    // A denominator, printed and asserted — a gate that does not report what it looked at
    // cannot be audited (G18).
    expect(files.length).toBeGreaterThan(0);
    // SELF is a test file, not a package.json, so anchor on the two real workspaces that
    // must exist in every environment this suite runs in (including the pre-push Sync
    // Check's PARTIAL scratch copy, where an absolute file count is not an invariant).
    expect(files).toContain('packages/core/package.json');
    expect(existsSync(join(REPO_ROOT, SELF))).toBe(true);
  });

  it('no tracked npm script depends on POSIX shell semantics', () => {
    const files = trackedPackageJsons();
    let scriptCount = 0;
    const hits = [];
    for (const file of files) {
      for (const [script, body] of Object.entries(readScripts(file))) {
        scriptCount += 1;
        if (`${file}::${script}` in ALLOWLIST) continue;
        hits.push(...findShellPortabilityHits(file, script, body));
      }
    }
    // M1 again, one level down: files present but zero scripts read would be a silent pass.
    expect(scriptCount).toBeGreaterThan(0);
    expect(
      hits.map((h) => `${h.file}::${h.script} [${h.kind}] ${h.segment}`),
      `Scanned ${scriptCount} scripts across ${files.length} package.json files. ` +
        `A script here is handed to cmd.exe on Windows, which does not strip "'", does not ` +
        `expand $(…) or $VAR, and cannot carry a newline in an argument. Move the work into ` +
        `a node script (see packages/core/scripts/build-bundles.mjs) instead of quoting it.`,
    ).toEqual([]);
  });

  // CR-72 / G18 — one fixture per detection path, and EVERY path must fire. A rule with
  // five paths and two fixtures is three-fifths decoration.
  const FIXTURES: ReadonlyArray<{ kind: ShellPortabilityKind; body: string }> = [
    { kind: 'single-quote', body: "esbuild --banner:js='use strict'" },
    { kind: 'embedded-newline', body: 'esbuild --banner:js=a\nb' },
    { kind: 'backtick', body: 'node -e `hi`' },
    { kind: 'command-substitution', body: 'node build.js --rev=$(git rev-parse HEAD)' },
    { kind: 'variable-expansion', body: 'node build.js --root=$PWD' },
  ];

  it.each(FIXTURES)('detection path $kind fires on its fixture', ({ kind, body }) => {
    const hits = findShellPortabilityHits('fixture/package.json', 'demo', body);
    expect(hits.map((h) => h.kind)).toContain(kind);
  });

  it('every declared detection path has a fixture', () => {
    expect([...DETECTION_KINDS].sort()).toEqual([...new Set(FIXTURES.map((f) => f.kind))].sort());
  });

  // NEGATIVE CONTROL — without it, "the guard refused" and "the guard fires on everything"
  // look identical. A gate that reads a portable script as a defect gets ignored (CR-83).
  it.each([
    'node scripts/build-bundles.mjs --cli',
    'tsc --noEmit && npm run build:cli',
    'vitest run',
    'esbuild --bundle --outfile=dist/x.js src/x.ts --external:yaml',
  ])('stays silent on the portable script: %s', (body) => {
    expect(findShellPortabilityHits('p/package.json', 's', body)).toEqual([]);
  });

  it('the bash exemption is applied per SEGMENT, never to the whole script', () => {
    // The mixed case: a non-portable esbuild segment chained to a bash segment. Exempting
    // the whole script would swallow the real defect.
    const mixed = "esbuild --banner:js='x' && bash ../../scripts/publish-guard.sh \"$PWD\"";
    const hits = findShellPortabilityHits('p/package.json', 's', mixed);
    expect(hits.map((h) => h.kind)).toEqual(['single-quote']);

    // And the bash segment alone is genuinely excused.
    expect(
      findShellPortabilityHits('p/package.json', 's', 'bash ./g.sh "$PWD"'),
    ).toEqual([]);

    // The splitter and the interpreter test each do what the exemption claims.
    expect(shellSegments('a && b || c; d')).toEqual(['a', 'b', 'c', 'd']);
    expect(declaresBashInterpreter('bash ./x.sh')).toBe(true);
    expect(declaresBashInterpreter('npm run build')).toBe(false);
    // `bash` must be a command, not a substring of another word.
    expect(declaresBashInterpreter('node bashful.js')).toBe(false);
  });
});

describe('the esbuild bundling contract has one source of truth', () => {
  it('build-config.mjs exists and exports the contract', () => {
    const src = readFileSync(join(REPO_ROOT, BUILD_CONFIG), 'utf-8');
    for (const binding of ['EXTERNALS', 'BANNER_JS', 'SHEBANG', 'BASE_BUILD_OPTIONS']) {
      expect(src, `${BUILD_CONFIG} must export ${binding}`).toMatch(
        new RegExp(`export const ${binding}\\b`),
      );
    }
  });

  it('no npm script re-declares externals or a banner', () => {
    const files = trackedPackageJsons();
    const offenders: string[] = [];
    for (const file of files) {
      for (const [script, body] of Object.entries(readScripts(file))) {
        if (body.includes('--external:') || body.includes('--banner:')) {
          offenders.push(`${file}::${script}`);
        }
      }
    }
    expect(
      offenders,
      'externals and the banner belong to build-config.mjs; a package.json script ' +
        'restating them is the third-site drift this guard exists to prevent.',
    ).toEqual([]);
  });

  it('no build script hardcodes an externals array outside build-config.mjs', () => {
    const scripts = execFileSync('git', ['ls-files', 'packages/core/scripts/*'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    })
      .split('\n')
      .filter(Boolean);
    expect(scripts.length, 'enumerated 0 build scripts — refusing to report clean').toBeGreaterThan(
      0,
    );
    expect(scripts).toContain(BUILD_CONFIG);

    const offenders: string[] = [];
    for (const file of scripts) {
      if (file === BUILD_CONFIG) continue;
      const src = readFileSync(join(REPO_ROOT, file), 'utf-8');
      // `external:` assigned a literal array of strings — i.e. a second list. An identifier
      // (`external: EXTERNALS`) or a spread of one (`external: [...EXTERNALS]`) is fine.
      if (/external:\s*\[\s*['"`]/.test(src)) offenders.push(file);
    }
    expect(
      offenders,
      `these files declare their own externals list instead of importing it from ${BUILD_CONFIG}`,
    ).toEqual([]);
  });

  it('the externals-array detector actually fires (CR-72 — not a vacuous zero)', () => {
    const bad = `await build({ external: ['yaml', 'zod'] });`;
    const good = `await build({ external: [...EXTERNALS] });`;
    const alsoGood = `await build({ external: EXTERNALS });`;
    expect(/external:\s*\[\s*['"`]/.test(bad)).toBe(true);
    expect(/external:\s*\[\s*['"`]/.test(good)).toBe(false);
    expect(/external:\s*\[\s*['"`]/.test(alsoGood)).toBe(false);
  });
});
