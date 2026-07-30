// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * CR-71 — Workspace ↔ @massu/core dependency + engine + lockfile coherence.
 *
 * THE BUG THIS CLOSES (incident 2026-07-23-npm-ci-workspace-peer-drift):
 * `@massu/core` was bumped to the 2.x major (2.0.0), but the first-party workspace adapters
 * (`@massu/adapter-rails`, `@massu/adapter-spring`) kept `peerDependencies["@massu/core"]:
 * "^1.6.0"` and `engines.node: ">=20.0.0 <26.0.0"`. `^1.6.0` cannot be satisfied by core 2.x, so a
 * clean `npm ci` (what CI runs) FAILED with ERESOLVE on EVERY job — while `npm test` (which reuses
 * the already-installed node_modules) stayed green. The breakage shipped through 2.0.0/2.1.0/2.2.0
 * because (a) no local gate ran a clean `npm ci`, and (b) every push admin-BYPASSED the red
 * required checks. A gate that is always bypassed is decoration (CR-64 spirit).
 *
 * This guard runs inside `npm test` (always, locally + CI) so the class is caught the moment a
 * bump makes a workspace incoherent with core — long before push. Filesystem-derived over ALL
 * `packages/*`, so a new adapter is covered automatically.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import semver from 'semver';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const PKGS_DIR = resolve(REPO_ROOT, 'packages');

interface Pkg {
  name?: string;
  version?: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPkg(dir: string): Pkg {
  return JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf-8')) as Pkg;
}

const corePkg = readPkg(resolve(PKGS_DIR, 'core'));
const CORE_VERSION = corePkg.version!;
const CORE_ENGINE = corePkg.engines?.node;

// Every workspace package under packages/* except core itself (filesystem-derived — a new
// adapter is covered without touching this test).
const workspaces = readdirSync(PKGS_DIR).filter(
  (d) => d !== 'core' && existsSync(resolve(PKGS_DIR, d, 'package.json')),
);

describe('CR-71 workspace ↔ @massu/core dependency + engine + lockfile coherence', () => {
  it('discovers workspace packages + a core version (non-vacuous)', () => {
    expect(workspaces.length).toBeGreaterThan(0);
    expect(semver.valid(CORE_VERSION)).not.toBeNull();
  });

  for (const ws of workspaces) {
    const pkg = readPkg(resolve(PKGS_DIR, ws));
    const name = pkg.name ?? ws;

    // (a) Every declared @massu/core range MUST semver-satisfy the current core version. `^1.6.0`
    //     vs core 2.2.0 → false → RED (the exact bug). `workspace:`/`file:` protocols are coherent
    //     by construction (they resolve to the local core).
    for (const field of ['dependencies', 'peerDependencies', 'devDependencies'] as const) {
      const range = pkg[field]?.['@massu/core'];
      if (!range) continue;
      // G-1 (plan-2026-07-26-anti-vacuity-9-unproven-gates): `workspace:`/`file:` ranges are coherent BY CONSTRUCTION (they resolve to
      // the local core), and `range` is known at collection time — so this is
      // it.skipIf, reported SKIPPED, not a `return` reported as a satisfied range.
      it.skipIf(range.startsWith('workspace:') || range.startsWith('file:'))(
        `${name}: ${field}["@massu/core"] "${range}" must satisfy core ${CORE_VERSION}`,
        () => {
        // NO includePrerelease — the guard must mirror npm's ACTUAL resolver (standard semver): a
        // prerelease core (e.g. 2.2.1-dev.0) does NOT satisfy `>=2.0.0` in `npm ci`, so the guard
        // must agree, or it would read green while `npm ci` ERESOLVEs (the exact class this closes).
        expect(semver.satisfies(CORE_VERSION, range)).toBe(true);
      });
    }

    // (b) A workspace that ships ALONGSIDE core must run wherever core runs: its engines.node set
    //     must be a SUPERSET of core's. Core's floor must satisfy the workspace range, and the
    //     workspace must not exclude any major core allows (an adapter `<26` cap vs core-uncapped
    //     was a real EBADENGINE leak to customers on Node 26).
    // G-1 (plan-2026-07-26-anti-vacuity-9-unproven-gates): both operands are known at collection time -> skipIf, reported SKIPPED.
    // A workspace that declares no engines.node, or a core that declares none, cannot
    // be checked for superset-ness; that is a genuine absence, not a passing check.
    it.skipIf(!pkg.engines?.node || !CORE_ENGINE)(
      `${name}: engines.node must be a superset of core engines.node (${CORE_ENGINE ?? 'n/a'})`,
      () => {
      const wsEngine = pkg.engines?.node;
      const coreMin = semver.minVersion(CORE_ENGINE);
      expect(coreMin).not.toBeNull();
      expect(semver.satisfies(coreMin!.version, wsEngine)).toBe(true);
      // Every major core permits within a practical horizon, the workspace must also permit.
      for (const maj of [22, 23, 24, 25, 26, 27, 28]) {
        const v = `${maj}.13.0`;
        if (semver.satisfies(v, CORE_ENGINE)) {
          expect(semver.satisfies(v, wsEngine)).toBe(true);
        }
      }
    });
  }

  // (d) Every literal `node-version:` pin in .github/workflows/*.yml MUST be >= core's engines.node
  //     floor. CI's Test + Anti-Vacuity jobs were pinned to Node 20 while core's 2.0.0 default
  //     engine (`node:sqlite`) needs >=22.16 — so those jobs failed "No such built-in module:
  //     node:sqlite" the moment `npm ci` was fixed enough for them to run (incident 2026-07-23).
  // G-1 (plan-2026-07-26-anti-vacuity-9-unproven-gates): CORE_ENGINE is a collection-time value -> skipIf. `.github/workflows`, by
  // contrast, is a REPO INVARIANT present in both the internal tree and the public
  // mirror (`sync-public.sh` writes ci.yml into it) — its absence means REPO_ROOT
  // resolved wrong and the scan covered nothing, so that one FAILS CLOSED.
  it.skipIf(!CORE_ENGINE)('every literal node-version pin in .github/workflows/*.yml is >= core engines.node floor', () => {
    const floor = semver.minVersion(CORE_ENGINE);
    expect(floor).not.toBeNull();
    const wfDir = resolve(REPO_ROOT, '.github', 'workflows');
    expect(
      existsSync(wfDir),
      `${wfDir} missing — REPO_ROOT resolved wrong, so ZERO workflow files were ` +
        'scanned for node-version pins. Do NOT restore the skip.',
    ).toBe(true);
    const offenders: string[] = [];
    for (const f of readdirSync(wfDir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))) {
      const text = readFileSync(resolve(wfDir, f), 'utf-8');
      // Only LITERAL numeric pins — `${{ matrix.node }}` / 'latest' are not our concern.
      for (const m of text.matchAll(/node-version:\s*['"]?(\d+(?:\.\d+){0,2})['"]?/g)) {
        const raw = m[1];
        const pin = semver.coerce(raw);
        if (!pin) continue;
        // A bare major (`'22'`) resolves via setup-node to the LATEST 22.x (>= floor as long as
        // its major >= floor.major); only a full pin below the floor, or an older major, fails.
        const majorOnly = /^\d+$/.test(raw);
        const bad = majorOnly ? pin.major < floor!.major : semver.lt(pin.version, floor!.version);
        if (bad) offenders.push(`${f}: node-version ${raw} < floor ${floor!.version}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // (c) package-lock.json workspace version entries MUST match their package.json — a version bump
  //     without regenerating the lock is exactly what makes a clean `npm ci` drift (mixed versions).
  it('package-lock.json workspace versions match package.json (no bump-without-lock-regen drift)', () => {
    const lock = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package-lock.json'), 'utf-8')) as {
      packages?: Record<string, { version?: string }>;
    };
    for (const ws of ['core', ...workspaces]) {
      const pkgVer = readPkg(resolve(PKGS_DIR, ws)).version;
      const lockVer = lock.packages?.[`packages/${ws}`]?.version;
      if (lockVer !== undefined) expect(lockVer).toBe(pkgVer);
    }
  });
});
