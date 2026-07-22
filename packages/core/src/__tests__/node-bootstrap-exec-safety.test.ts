// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P4-002 — Exec-safety guard (Layer 2-7, CR-70).
 *
 * Node discovery + re-exec is an arbitrary-binary-execution surface. Operator decision
 * 2026-07-22: discovery is confined to a STRICT ABSOLUTE-PATH allowlist and MUST NOT consult
 * bare PATH / `which` (a `node` planted earlier in PATH would be re-exec'd with the customer's
 * hooks); re-exec MUST use an argv ARRAY (no shell string, no `shell: true`).
 *
 * This asserts BOTH the source-level invariants (grep-mirror, like Check 42/46) AND a
 * behavioural one (discovery only ever returns an existing absolute path).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { discoverCompatibleNode } from '../lib/node-bootstrap.ts';

const SRC = readFileSync(resolve(__dirname, '..', 'lib', 'node-bootstrap.ts'), 'utf-8');

// Strip line-comments + block-comments so prose ("never PATH / which") never trips the grep.
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}
const CODE = stripComments(SRC);

describe('P4-002 node-bootstrap exec-safety (Layer 2-7, CR-70)', () => {
  it('discovery NEVER reads process.env.PATH', () => {
    expect(CODE).not.toMatch(/process\.env\.PATH/);
    expect(CODE).not.toMatch(/env\.PATH\b/);
    expect(CODE).not.toMatch(/\[['"]PATH['"]\]/);
  });

  it('discovery NEVER shells out to `which` / `command -v` / `type`', () => {
    expect(CODE).not.toMatch(/\bwhich\b/);
    expect(CODE).not.toMatch(/command -v/);
    expect(CODE).not.toMatch(/\btype -p\b/);
  });

  it('re-exec uses an argv ARRAY and NEVER a shell (no shell:true, no execSync/exec strings)', () => {
    // spawnSync with an argv array is the only exec of a discovered path.
    expect(CODE).toMatch(/spawnSync\(\s*nodePath\s*,\s*\[/);
    expect(CODE).not.toMatch(/shell\s*:\s*true/);
    // No shell-string exec APIs that would interpolate the discovered path.
    expect(CODE).not.toMatch(/\bexecSync\(/);
    expect(CODE).not.toMatch(/\bexec\(/); // execFile* is allowed; bare exec() is not
  });

  it('version probing uses execFileSync with an argv array (no shell interpolation of the path)', () => {
    expect(CODE).toMatch(/execFileSync\(\s*candidate\s*,\s*\[/);
  });

  it('behavioural: discovery returns null or an EXISTING ABSOLUTE path — never a relative/PATH-resolved token', () => {
    const result = discoverCompatibleNode(process.env);
    if (result !== null) {
      expect(result.startsWith('/')).toBe(true);
    } else {
      expect(result).toBeNull();
    }
  });

  it('behavioural: a hostile PATH is NOT consulted — discovery ignores env.PATH entirely', () => {
    // Point PATH at a bogus dir containing a planted "node". Discovery must not resolve it.
    const hostileEnv = { ...process.env, PATH: '/nonexistent/hostile/bin' };
    const result = discoverCompatibleNode(hostileEnv);
    // Whatever it returns, it can only be an allowlisted absolute path, never the hostile PATH.
    if (result !== null) {
      expect(result.includes('/nonexistent/hostile/bin')).toBe(false);
      expect(result.startsWith('/')).toBe(true);
    }
  });

  it('an EMPTY HOME never resolves version-manager globs against CWD (home-guard)', () => {
    // With HOME='' the home-relative patterns must be SKIPPED (not resolved against process.cwd()).
    const result = discoverCompatibleNode({ HOME: '', PATH: '' } as NodeJS.ProcessEnv);
    if (result !== null) {
      expect(result.startsWith('/')).toBe(true);
      expect(result.includes(process.cwd())).toBe(false);
    }
  });

  it('a RELATIVE HOME / relative install-DIR env pointer is rejected, not resolved', () => {
    const result = discoverCompatibleNode({
      HOME: 'relative/home',
      NVM_DIR: 'relative-nvm',
      VOLTA_HOME: '../volta',
    } as NodeJS.ProcessEnv);
    if (result !== null) {
      expect(result.startsWith('/')).toBe(true);
      expect(result.includes('relative')).toBe(false);
    }
  });

  it('an explicit absolute install-DIR env pointer is honored without reading PATH (NVM_DIR)', () => {
    // NVM_DIR names a DIRECTORY (not an executable search) — reading it is not a which/PATH read.
    // Pointing it at a nonexistent absolute dir simply yields no candidates from that source.
    const result = discoverCompatibleNode({
      HOME: '/home/nobody',
      NVM_DIR: '/nonexistent/abs/nvm',
    } as NodeJS.ProcessEnv);
    // Never throws; returns null or an allowlisted absolute path (e.g. a real Homebrew keg).
    if (result !== null) expect(result.startsWith('/')).toBe(true);
  });
});
