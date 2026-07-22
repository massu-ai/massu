// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Living Memory Slice 5 A-01 drift-guard — ONE origin vocabulary, ONE predicate.
 *
 * Locks the invariants that make "a cross-repo memory renders to this repo's disk
 * as if the human wrote it" structurally impossible:
 *
 *  (a) memory-origin.ts is the ONLY module in packages/core/src that declares the
 *      origin literal set. No other source file compares a memory row's `origin`
 *      against a bare `'local'` string literal — the inline 4B gate
 *      (memory-renderer.ts) is refactored to call isLocalOrigin().
 *  (b) isLocalOrigin is FAIL-CLOSED: null / undefined / '' are NOT local.
 *  (c) isCrossRepoOrigin / parseOriginRepoId accept ONLY a well-formed
 *      `repo:<uuid>` and reject everything else.
 *  (d) memory-renderer.ts imports isLocalOrigin (proves the refactor landed).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  LOCAL_ORIGIN,
  isLocalOrigin,
  isCrossRepoOrigin,
  parseOriginRepoId,
} from '../memory-origin.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, '..');
const MEMORY_ORIGIN = resolve(SRC_DIR, 'memory-origin.ts');
const MEMORY_RENDERER = resolve(SRC_DIR, 'memory-renderer.ts');

/** Recursively collect every `.ts` file under src/ (excluding __tests__). */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return acc;
    throw e;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      collectSourceFiles(full, acc);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('Slice 5 A-01: single origin vocabulary', () => {
  const files = collectSourceFiles(SRC_DIR);

  it('compares a memory origin against the bare literal ONLY in memory-origin.ts', () => {
    // A bare `origin`-vs-`'local'` (or "local") comparison anywhere else is a
    // second, drifting definition of "what counts as local". memory-origin.ts is
    // the SoT; every other site must ask isLocalOrigin(). Build the literal
    // without spelling it inline so this test does not match itself.
    const L = "'" + 'local' + "'";
    const forbidden = [
      new RegExp('origin\\s*(?:===|!==)\\s*' + L),
      new RegExp('origin\\s*(?:===|!==)\\s*"local"'),
    ];
    const offenders: string[] = [];
    for (const f of files) {
      if (f === MEMORY_ORIGIN) continue; // the SoT is allowed to name the literal
      const src = readFileSync(f, 'utf-8');
      if (forbidden.some((re) => re.test(src))) offenders.push(f);
    }
    expect(offenders, `bare origin===/!=='local' outside memory-origin.ts:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('memory-renderer.ts refuses non-local rows via isLocalOrigin (the refactored 4B gate)', () => {
    const src = readFileSync(MEMORY_RENDERER, 'utf-8');
    expect(src).toMatch(/import\s*\{[^}]*isLocalOrigin[^}]*\}\s*from\s*'\.\/memory-origin\.ts'/);
    expect(src).toMatch(/if\s*\(\s*!isLocalOrigin\(/);
  });

  it('isLocalOrigin is fail-closed: only the exact literal is local', () => {
    expect(isLocalOrigin(LOCAL_ORIGIN)).toBe(true);
    expect(isLocalOrigin('local')).toBe(true);
    expect(isLocalOrigin(undefined)).toBe(false);
    expect(isLocalOrigin(null)).toBe(false);
    expect(isLocalOrigin('')).toBe(false);
    expect(isLocalOrigin('LOCAL')).toBe(false);
    expect(isLocalOrigin(' local')).toBe(false);
    expect(isLocalOrigin('team')).toBe(false);
    expect(isLocalOrigin('repo:abc')).toBe(false);
  });

  it('isCrossRepoOrigin / parseOriginRepoId accept ONLY a well-formed repo:<uuid>', () => {
    const good = 'repo:1b4e28ba-2fa1-11d2-883f-0016d3cca427';
    expect(isCrossRepoOrigin(good)).toBe(true);
    expect(parseOriginRepoId(good)).toBe('1b4e28ba-2fa1-11d2-883f-0016d3cca427');

    for (const bad of ['local', 'team', 'pack', 'repo:', 'repo:not-a-uuid', 'repo:1b4e28ba2fa111d2883f0016d3cca427', '', null, undefined]) {
      expect(isCrossRepoOrigin(bad as string), `should reject ${JSON.stringify(bad)}`).toBe(false);
      expect(parseOriginRepoId(bad as string)).toBeNull();
    }
    // A cross-repo origin is not local, and local is not cross-repo.
    expect(isLocalOrigin(good)).toBe(false);
    expect(isCrossRepoOrigin(LOCAL_ORIGIN)).toBe(false);
  });
});
