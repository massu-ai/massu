// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * D-001 (plan-massu-resilience-layer2, CR-69) — filesystem-derived structural
 * drift-guards for the db-driver adapter (Layer 2). These make the engine-swap
 * invariants STRUCTURAL (`feedback_drift_guard_filesystem_derived_over_static`) rather
 * than a matter of the next session's good intentions:
 *
 *   (a) the DEFAULT engine constant IS `node:sqlite` (native-free) — the whole point;
 *   (b) `node:sqlite` is value-loaded in EXACTLY ONE file (`db-driver.ts`) — no scattered
 *       `new DatabaseSync()` / `require('node:sqlite')` that could bypass the adapter;
 *   (c) `openDatabase` is imported from the adapter (`db-driver.ts`) everywhere — the
 *       ONLY file allowed to import it from the Layer-1 loader is the adapter itself;
 *   (d) `engines.node` is locked to the node:sqlite FTS5/isTransaction floor `>=22.16.0`.
 *
 * Mirrored by pattern-scanner Check 46 (grep layer) — two structural layers atop the
 * adapter being the sole open chokepoint.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_DB_ENGINE } from '../db-driver.ts';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const ADAPTER_REL = 'db-driver.ts';

function allSourceFiles(dir: string = SRC, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      allSourceFiles(p, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(p);
    }
  }
  return acc;
}
const rel = (p: string) => p.slice(SRC.length).replace(/\\/g, '/');

describe('db-driver adapter drift-guard (Layer 2, CR-69)', () => {
  const files = allSourceFiles();

  it('(a) the default engine constant is node:sqlite (native-free)', () => {
    expect(DEFAULT_DB_ENGINE).toBe('node-sqlite');
  });

  it('(b) node:sqlite is value-loaded ONLY in the adapter (db-driver.ts)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (rel(f) === ADAPTER_REL) continue; // the one sanctioned node:sqlite importer
      const src = readFileSync(f, 'utf-8');
      for (const line of src.split('\n')) {
        // Static import, the DatabaseSync ctor, OR any CALL-form load of node:sqlite.
        // The call-form `(['"]node:sqlite['"])` catches require(), import(), AND the
        // createRequire-alias `req('node:sqlite')` idiom the adapter uses — a plain
        // require/import-only set missed it (closed after the CR-69 pattern review).
        if (/from ['"]node:sqlite['"]/.test(line)) offenders.push(`${rel(f)}: ${line.trim()}`);
        if (/\(['"]node:sqlite['"]\)/.test(line)) offenders.push(`${rel(f)}: ${line.trim()}`);
        if (/new DatabaseSync\(/.test(line)) offenders.push(`${rel(f)}: ${line.trim()}`);
      }
    }
    expect(offenders, `node:sqlite loads outside the adapter:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('(c) openDatabase is imported from the Layer-1 loader ONLY by the adapter', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (rel(f) === ADAPTER_REL) continue; // the adapter delegates to the loader (bs3 driver)
      const src = readFileSync(f, 'utf-8');
      for (const line of src.split('\n')) {
        // Any other file importing openDatabase from the loader bypasses the engine dispatch.
        if (/import\s*\{[^}]*\bopenDatabase\b[^}]*\}\s*from\s*['"][^'"]*lib\/sqlite-loader\.ts['"]/.test(line)) {
          offenders.push(`${rel(f)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, `openDatabase imported from the loader outside the adapter:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('(d) engines.node is locked to the node:sqlite floor >=22.16.0', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf-8')) as {
      engines?: { node?: string };
    };
    expect(pkg.engines?.node).toBe('>=22.16.0');
  });

  // (e) P1-003 (plan-2026-07-23-hook-latency-silent-loss-fixes). BOTH engine paths must
  // arm the busy-timeout before handing the connection out, or a concurrent writer fails
  // instantly and the hook silently drops its row. Structural, because the behavioural
  // proof (db-busy-timeout.test.ts) only exercises whichever engine the suite runs under —
  // this clause is what stops the OTHER path from regressing unnoticed.
  it('(e) both open functions arm PRAGMA busy_timeout before returning the handle', () => {
    const adapter = readFileSync(join(SRC, ADAPTER_REL), 'utf-8');

    // Slice each function body from its declaration to the next top-level declaration,
    // so the assertion is about THAT function, not merely about the file containing the
    // string somewhere (a file-level grep passes even if only one path is armed).
    const bodyOf = (fnName: string): string => {
      const start = adapter.indexOf(`function ${fnName}(`);
      expect(start, `${fnName} not found in ${ADAPTER_REL} — did it get renamed?`).toBeGreaterThan(-1);
      const after = adapter.slice(start);
      const nextDecl = after.slice(1).search(/\n(?:export )?(?:function|const|class) /);
      return nextDecl === -1 ? after : after.slice(0, nextDecl + 1);
    };

    for (const fn of ['openNodeSqlite', 'openBetterSqlite3']) {
      const body = bodyOf(fn);
      const pragmaAt = body.indexOf('PRAGMA busy_timeout');
      expect(pragmaAt, `${fn}() does not arm PRAGMA busy_timeout — a locked writer will fail instantly and lose its row`).toBeGreaterThan(-1);

      // Before the LAST return, not merely present: a pragma after the handle is returned
      // is unreachable, and would read identically to a correct one on a plain grep.
      const lastReturn = body.lastIndexOf('return ');
      expect(lastReturn, `${fn}() has no return`).toBeGreaterThan(-1);
      expect(pragmaAt, `${fn}() arms PRAGMA busy_timeout AFTER its return — unreachable`).toBeLessThan(lastReturn);
    }
  });

  it('(e2) the busy-timeout value is resolved, never a hard-coded literal in the PRAGMA', () => {
    const adapter = readFileSync(join(SRC, ADAPTER_REL), 'utf-8');
    // A literal would silently ignore MASSU_DB_BUSY_TIMEOUT_MS, which is the knob the
    // RED half of db-busy-timeout.test.ts depends on — the gate would lose its can-fail proof.
    const literalPragmas = adapter.match(/PRAGMA busy_timeout\s*=\s*\d/g) ?? [];
    expect(literalPragmas, `hard-coded busy_timeout literal(s): ${literalPragmas.join(', ')}`).toEqual([]);
    expect(adapter).toMatch(/PRAGMA busy_timeout = \$\{resolveBusyTimeoutMs\(\)\}/);
  });
});
