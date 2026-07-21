// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P7-001 (plan-massu-resilience-layer1, CR-65) — filesystem-derived structural
 * drift-guards for the SSOT SQLite loader. These make the invariants STRUCTURAL
 * (`feedback_drift_guard_filesystem_derived_over_static`) rather than a matter of the
 * next session's good intentions:
 *
 *   (a) NO value/dynamic `better-sqlite3` load lives outside `lib/sqlite-loader.ts`
 *       (`import type` is erased at compile time → EXEMPT).
 *   (b) `attemptNativeHeal` drives every child with `process.execPath` and never a shell.
 *   (c) `doctor.ts` AND `server.ts` both use the SHARED `probeMemoryDbUsable` (so the
 *       health signal and the runtime can never diverge — the lying-doctor class).
 *   (d) every DB-opening file under `hooks/` passes `selfHeal:false` (5s budget / CR-12).
 *
 * Mirrored by pattern-scanner Check 42 (grep layer) and enforced by the loader being
 * the sole construction site — three layers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const LOADER_REL = 'lib/sqlite-loader.ts';

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

function rel(p: string): string {
  return p.slice(SRC.length).replace(/\\/g, '/');
}

describe('sqlite-loader SSOT drift-guard (CR-65)', () => {
  const files = allSourceFiles();

  it('(a) no value/dynamic better-sqlite3 load outside the loader (import type exempt)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (rel(f) === LOADER_REL) continue; // the one sanctioned construction site
      const src = readFileSync(f, 'utf-8');
      for (const line of src.split('\n')) {
        // Value default-import (NOT `import type Database …`).
        if (/^import Database from 'better-sqlite3'/.test(line)) offenders.push(`${rel(f)}: ${line.trim()}`);
        // Dynamic value load.
        if (/await import\('better-sqlite3'\)/.test(line)) offenders.push(`${rel(f)}: ${line.trim()}`);
      }
    }
    expect(offenders, `value-loads outside the loader:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('(b) attemptNativeHeal drives children with process.execPath and never a shell', () => {
    const src = readFileSync(join(SRC, LOADER_REL), 'utf-8');
    expect(src).toMatch(/spawnSync\(process\.execPath,\s*\[/);
    expect(/shell:\s*true/.test(src)).toBe(false);
  });

  it('(c) doctor.ts and server.ts both reference the shared probeMemoryDbUsable', () => {
    const doctor = readFileSync(join(SRC, 'commands', 'doctor.ts'), 'utf-8');
    const server = readFileSync(join(SRC, 'server.ts'), 'utf-8');
    expect(doctor).toMatch(/probeMemoryDbUsable/);
    expect(server).toMatch(/probeMemoryDbUsable/);
  });

  it('(e) hook-runner marks the hook process AND the loader vetoes healing there (P0-003, indirect opens)', () => {
    const hookRunner = readFileSync(join(SRC, 'commands', 'hook-runner.ts'), 'utf-8');
    const loader = readFileSync(join(SRC, LOADER_REL), 'utf-8');
    expect(hookRunner).toMatch(/MASSU_HOOK_RUNTIME:\s*'1'/);
    // The loader must consult the marker so getMemoryDb() from a hook cannot trigger a rebuild.
    expect(loader).toMatch(/MASSU_HOOK_RUNTIME/);
  });

  it('(d) every DB-opening hook passes selfHeal:false (P0-003 — hooks never rebuild)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (!rel(f).startsWith('hooks/')) continue;
      const src = readFileSync(f, 'utf-8');
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!/openDatabase\(/.test(lines[i])) continue;
        // Allow the selfHeal flag to appear on the same line or the next few (multi-line calls).
        const window = lines.slice(i, i + 4).join(' ');
        if (!/selfHeal:\s*false/.test(window)) {
          offenders.push(`${rel(f)}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    expect(offenders, `hook openDatabase() calls missing selfHeal:false:\n${offenders.join('\n')}`).toEqual([]);
  });
});
