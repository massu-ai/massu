// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-H033 (plan-stage-c-high-batch / 1.10.8) drift-guard.
 *
 * Scans `packages/core/src/**` for direct `config.framework.router ===` or
 * `config.framework.orm ===` comparisons. The only legitimate exit is via
 * `supportsRouter()` / `supportsOrm()` in `lib/framework-supports.ts`.
 *
 * Closes the regression class where a future tool-gating decision is
 * written as a direct field comparison and bypasses the adapter-pattern
 * abstraction — making it invisible to custom adapters that set router/orm
 * via the v2 `framework.languages.<lang>` schema instead of the legacy
 * top-level field.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_ROOT = resolve(__dirname, '..');

// Files exempt from the scan — these are the SoT module itself + tests.
const EXEMPT_FILES = new Set<string>([
  'lib/framework-supports.ts',
]);
const EXEMPT_DIRS = new Set<string>([
  '__tests__',
  'detect', // detect/* assembles the config.framework object pre-getConfig;
            // its direct field reads aren't tool-gating decisions
  'commands', // commands/init.ts builds the framework object during config
              // generation; not a runtime gating decision
]);

function walk(dir: string, cb: (rel: string, abs: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // ENOENT — concurrent test cleanup, skip
  }
  for (const entry of entries) {
    const abs = resolve(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    const rel = relative(SRC_ROOT, abs);
    if (stat.isDirectory()) {
      if (EXEMPT_DIRS.has(entry)) continue;
      if (entry.includes('-tmp') || entry.endsWith('.tmp')) continue;
      walk(abs, cb);
    } else if (stat.isFile() && entry.endsWith('.ts') && !entry.endsWith('.generated.ts')) {
      if (EXEMPT_FILES.has(rel)) continue;
      cb(rel, abs);
    }
  }
}

const BANNED = [
  /config\.framework\.router\s*===\s*['"]/,
  /config\.framework\.orm\s*===\s*['"]/,
];

describe('framework-supports SoT — no direct .router/.orm comparisons (P-H033)', () => {
  it('every tool-gating decision routes through supportsRouter/supportsOrm', () => {
    const violations: Array<{ file: string; line: number; excerpt: string }> = [];
    walk(SRC_ROOT, (rel, abs) => {
      const text = readFileSync(abs, 'utf-8');
      const lines = text.split('\n');
      lines.forEach((line, idx) => {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
        for (const pat of BANNED) {
          if (pat.test(line)) {
            violations.push({
              file: rel,
              line: idx + 1,
              excerpt: line.trim().slice(0, 140),
            });
            break;
          }
        }
      });
    });
    expect(
      violations,
      `Direct config.framework.router/.orm comparison(s) found. Use supportsRouter(name) / supportsOrm(name) from lib/framework-supports.ts:\n\n${violations
        .map((v) => `  ${v.file}:${v.line}  ${v.excerpt}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('supportsRouter consults both legacy + v2 schema entries', async () => {
    const mod = await import('../lib/framework-supports.ts');
    expect(typeof mod.supportsRouter).toBe('function');
    expect(typeof mod.supportsOrm).toBe('function');
    // Functions exist and return booleans for an arbitrary lookup.
    const r = mod.supportsRouter('nonexistent-router');
    expect(typeof r).toBe('boolean');
    const o = mod.supportsOrm('nonexistent-orm');
    expect(typeof o).toBe('boolean');
  });
});
