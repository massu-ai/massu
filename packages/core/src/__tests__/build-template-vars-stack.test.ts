// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P2.3 of docs/plans/2026-09-20-stack-conformant-asset-rendering.md.
 *
 * `buildTemplateVars()` exposes the Stack Capability Contract to the template engine.
 * BOTH branches are exercised here, because the UNSATISFIED branch is the one that
 * decides whether a legacy customer's install works at all:
 *
 *   satisfied    -> `verify` / `verifyByLang` present; assets render real commands.
 *   unsatisfied  -> `verify` ABSENT and `stack.satisfied === false` with the reason,
 *                   the install still proceeds, and one stderr line names the cause.
 *
 * The first implementation of P2.3 let the resolver's error propagate. A
 * StackContractError is not a MissingVariableError, so the render path at
 * install-commands.ts:508 does not catch it and :515 re-throws — aborting the WHOLE
 * install for every config predating the `verification:` block. Twelve tests built from
 * faithful copies of four real consumer repos went red on exactly that. These tests exist
 * so that regression cannot return silently.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import { buildTemplateVars } from '../commands/asset-render.ts';
import { resetConfig } from '../config.ts';
import { STACK_CONTRACT_VERSION } from '../stack-capabilities.ts';

const created: string[] = [];

function fixtureRepo(configYaml: string): string {
  const root = mkdtempSync(join(tmpdir(), 'massu-btv-'));
  created.push(root);
  mkdirSync(resolve(root, '.claude', 'commands'), { recursive: true });
  writeFileSync(resolve(root, 'massu.config.yaml'), configYaml);
  return root;
}

function inRepo<T>(root: string, fn: () => T): T {
  const prevCwd = process.cwd();
  resetConfig();
  try {
    process.chdir(root);
    return fn();
  } finally {
    try {
      process.chdir(prevCwd);
    } catch {
      /* ignore */
    }
    resetConfig();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const CONFORMING = [
  'schema_version: 2',
  'project:',
  '  name: "conforming-fixture"',
  '  root: auto',
  'framework:',
  '  type: python',
  '  router: fastapi-router',
  '  orm: none',
  '  ui: none',
  'paths:',
  '  source: app',
  'toolPrefix: massu',
  'domains: []',
  'rules: []',
  'verification:',
  '  python:',
  '    test: cd app && python3 -m pytest -q',
  '    type: cd app && python3 -m mypy .',
  '    lint: cd app && python3 -m ruff check .',
  '',
].join('\n');

// A config exactly as an older massu wrote it: no `verification:` block at all.
const LEGACY = [
  'schema_version: 2',
  'project:',
  '  name: "legacy-fixture"',
  '  root: auto',
  'framework:',
  '  type: typescript',
  '  router: none',
  '  orm: none',
  '  ui: none',
  'paths:',
  '  source: src',
  'toolPrefix: massu',
  'domains: []',
  'rules: []',
  '',
].join('\n');

describe('buildTemplateVars — the stack capability contract is satisfied', () => {
  it('exposes verify, verifyByLang and a satisfied stack', () => {
    const vars = inRepo(fixtureRepo(CONFORMING), () => buildTemplateVars());

    const verify = vars.verify as Record<string, string | undefined>;
    expect(verify).toBeDefined();
    expect(verify.test).toBe('cd app && python3 -m pytest -q');
    expect(verify.type).toBe('cd app && python3 -m mypy .');
    expect(verify.lint).toBe('cd app && python3 -m ruff check .');

    // An undeclared OPTIONAL key is undefined, never '' — '' renders as a command that
    // runs nothing and exits 0.
    expect(verify.build).toBeUndefined();
    expect(verify.build).not.toBe('');

    expect(vars.verifyByLang).toBeDefined();
    const stack = vars.stack as { primaryLanguage: string; contractVersion: number };
    expect(stack.primaryLanguage).toBe('python');
    expect(stack.contractVersion).toBe(STACK_CONTRACT_VERSION);
  });

  it('keeps `config` in scope — assets already render against {{config.*}}', () => {
    // CR-10 blast radius: 4 shipped assets reference `{{config.`. Removing it would
    // break them, so the contract ADDS keys and removes none.
    const vars = inRepo(fixtureRepo(CONFORMING), () => buildTemplateVars());
    expect(vars.config).toBeDefined();
    expect(vars.framework).toBeDefined();
    expect(vars.paths).toBeDefined();
    expect(vars.ARGUMENTS).toBe('{{ARGUMENTS}}');
  });
});

describe('buildTemplateVars — the contract is UNSATISFIED (a legacy config)', () => {
  it('does NOT throw: a hard failure here would abort the whole install', () => {
    expect(() => inRepo(fixtureRepo(LEGACY), () => buildTemplateVars())).not.toThrow();
  });

  it('omits `verify` rather than rendering an empty command', () => {
    const vars = inRepo(fixtureRepo(LEGACY), () => buildTemplateVars());
    // Absent, so an asset that needs a command fails ITS OWN file loudly via the engine's
    // MissingVariableError path — never a blank command that exits 0.
    expect('verify' in vars).toBe(false);
    expect('verifyByLang' in vars).toBe(false);
  });

  it('reports the contract state as first-class data, naming the real cause', () => {
    const vars = inRepo(fixtureRepo(LEGACY), () => buildTemplateVars());
    const stack = vars.stack as { satisfied?: boolean; reason?: string; stackName?: string };
    expect(stack).toBeDefined();
    expect(stack.satisfied).toBe(false);
    expect(stack.stackName).toBe('legacy-fixture');
    expect(stack.reason).toMatch(/verification:/);
  });

  it('writes exactly one actionable stderr line naming the stack and the fix', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // Positive control: the spy is real and does capture writes.
    process.stderr.write('');
    expect(stderr).toHaveBeenCalled();
    stderr.mockClear();

    inRepo(fixtureRepo(LEGACY), () => buildTemplateVars());

    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('UNSATISFIED');
    expect(written).toContain('legacy-fixture');
    expect(written).toContain('massu.config.yaml');
  });

  it('still keeps config/framework/paths in scope, so unrelated assets render', () => {
    const vars = inRepo(fixtureRepo(LEGACY), () => buildTemplateVars());
    expect(vars.config).toBeDefined();
    expect(vars.framework).toBeDefined();
    expect(vars.ARGUMENTS).toBe('{{ARGUMENTS}}');
  });
});
