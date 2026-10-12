// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P2.4 of docs/plans/2026-09-20-stack-conformant-asset-rendering.md.
 *
 * The stack roster is DERIVED from `readdirSync('templates/')`, never typed (G32): a 14th
 * stack is covered by these tests on its first commit rather than when someone remembers.
 * The denominator is asserted, because "0 stacks resolved cleanly" and "13 stacks resolved
 * cleanly" must not both read as green (M1).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import YAML from 'yaml';
import {
  resolveStackCapabilities,
  StackContractError,
  REQUIRED_VERIFY_KEYS,
  ALL_VERIFY_KEYS,
  STACK_CONTRACT_VERSION,
} from '../stack-capabilities.ts';
import type { Config } from '../config.ts';

const TEMPLATES_DIR = resolve(__dirname, '../../templates');

function stackNames(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((entry) => existsSync(join(TEMPLATES_DIR, entry, 'massu.config.yaml')))
    .sort();
}

function loadStack(stack: string): Config {
  const raw = readFileSync(join(TEMPLATES_DIR, stack, 'massu.config.yaml'), 'utf-8');
  return YAML.parse(raw) as Config;
}

describe('stack capability contract — the 13 shipped templates', () => {
  const stacks = stackNames();

  it('finds a non-empty stack roster (denominator asserted, M1)', () => {
    // A zero here would make every per-stack assertion below vacuously pass.
    expect(stacks.length).toBeGreaterThan(0);
    expect(stacks.length).toBe(13);
  });

  it.each(stacks)('%s resolves without throwing and declares every REQUIRED key', (stack) => {
    const caps = resolveStackCapabilities(loadStack(stack));
    expect(caps.contractVersion).toBe(STACK_CONTRACT_VERSION);
    expect(caps.primaryLanguage.length).toBeGreaterThan(0);
    for (const required of REQUIRED_VERIFY_KEYS) {
      expect(caps.verify[required], `${stack}: REQUIRED key '${required}'`).toBeTruthy();
      expect(caps.declared.has(required)).toBe(true);
    }
  });

  it('resolves all stacks cleanly, with the count asserted', () => {
    const resolved = stacks.filter((stack) => {
      try {
        resolveStackCapabilities(loadStack(stack));
        return true;
      } catch {
        return false;
      }
    });
    expect(resolved.length).toBe(stacks.length);
    expect(resolved.length).toBe(13);
  });
});

describe('resolution rules', () => {
  it('resolves via framework.type when framework.primary is undefined (the MAJORITY path)', () => {
    // Measured: only 1 of 13 templates sets `framework.primary`. The fallback is the
    // normal case, not an edge case, so it gets a first-class test.
    const withoutPrimary = stackNames()
      .map((stack) => ({ stack, config: loadStack(stack) }))
      .filter(({ config }) => config.framework?.primary === undefined);

    expect(withoutPrimary.length).toBeGreaterThan(0); // positive control: the path is exercised
    expect(withoutPrimary.length).toBe(12);

    for (const { stack, config } of withoutPrimary) {
      const caps = resolveStackCapabilities(config);
      expect(caps.primaryLanguage, `${stack}`).toBe(config.framework.type);
    }
  });

  it('multi-runtime resolves its primary to python, not typescript', () => {
    // Iteration 1 of the plan asserted `typescript` here and wrote a test for it. Measured:
    // `framework.primary` is `python`. An implementer trusting the prose would have
    // "corrected" the shipped template and silently changed what every multi-runtime
    // customer's {{verify.test}} runs.
    const config = loadStack('multi-runtime');
    expect(config.framework.primary).toBe('python');
    const caps = resolveStackCapabilities(config);
    expect(caps.primaryLanguage).toBe('python');
  });

  it('an OPTIONAL key with no declaration is undefined, never the empty string', () => {
    // `''` would render as a command that runs nothing and exits 0 — a check that reports
    // success precisely because it could not run.
    const fastapi = resolveStackCapabilities(loadStack('python-fastapi'));
    expect(fastapi.verify.build).toBeUndefined();
    expect(fastapi.verify.build).not.toBe('');
    expect(fastapi.declared.has('build')).toBe(false);
    expect(fastapi.verify.syntax).toBeTruthy(); // python declares `syntax`

    // multi-runtime declares `build` for rust/swift/typescript but its PRIMARY is python,
    // which does not — so the governing value is undefined even though the key exists in
    // the file. This is the primary-vs-any divergence, in one assertion.
    const multi = resolveStackCapabilities(loadStack('multi-runtime'));
    expect(multi.verify.build).toBeUndefined();
    expect(multi.verifyByLang.rust?.build).toBeTruthy();
  });

  it('exposes every declared language, so a multi-runtime asset can ask explicitly', () => {
    const multi = resolveStackCapabilities(loadStack('multi-runtime'));
    expect(Object.keys(multi.verifyByLang).sort()).toEqual(
      ['python', 'rust', 'swift', 'typescript'].sort(),
    );
    expect(multi.languages[0]).toBe('python'); // primary first
  });

  it('reads commands from verification:, never from framework.languages', () => {
    // `framework.languages.<lang>.test` is set in 0 of 13 templates. A resolver reading
    // there would return undefined for every key on every stack and fail closed everywhere.
    let langsCarryingTest = 0;
    for (const stack of stackNames()) {
      const config = loadStack(stack);
      for (const entry of Object.values(config.framework?.languages ?? {})) {
        if ((entry as { test?: string }).test !== undefined) langsCarryingTest++;
      }
    }
    expect(langsCarryingTest).toBe(0);
  });
});

describe('fails closed (M2)', () => {
  function mutate(stack: string, fn: (config: Config) => void): Config {
    const config = loadStack(stack);
    fn(config);
    return config;
  }

  it('a missing REQUIRED key throws, naming the stack AND the key', () => {
    const broken = mutate('python-fastapi', (config) => {
      delete (config.verification!['python'] as Record<string, unknown>)['test'];
    });
    expect(() => resolveStackCapabilities(broken)).toThrow(StackContractError);
    try {
      resolveStackCapabilities(broken);
      throw new Error('expected resolveStackCapabilities to throw');
    } catch (err) {
      const contractError = err as StackContractError;
      expect(contractError).toBeInstanceOf(StackContractError);
      expect(contractError.verifyKey).toBe('test');
      expect(contractError.message).toContain('test');
      expect(contractError.message).toContain('python');
    }
  });

  it('an absent verification: block throws rather than resolving to an empty map', () => {
    const broken = mutate('ts-nextjs', (config) => {
      delete (config as { verification?: unknown }).verification;
    });
    expect(() => resolveStackCapabilities(broken)).toThrow(/no top-level 'verification:' block/);
  });

  it('a primary language with no verification entry throws, listing what IS declared', () => {
    const broken = mutate('python-fastapi', (config) => {
      config.framework.primary = 'elixir';
    });
    expect(() => resolveStackCapabilities(broken)).toThrow(/declares no commands/);
    expect(() => resolveStackCapabilities(broken)).toThrow(/elixir/);
  });

  it('an empty-string command is treated as ABSENT, not as a declaration', () => {
    // The whole defect class in one assertion: a blank command must never satisfy a
    // REQUIRED key, because it renders as a check that does nothing and exits 0.
    const broken = mutate('python-fastapi', (config) => {
      (config.verification!['python'] as Record<string, unknown>)['test'] = '';
    });
    expect(() => resolveStackCapabilities(broken)).toThrow(StackContractError);
  });

  it('an unrecognised verification key is ignored, never promoted into verify', () => {
    // VerificationEntrySchema is .passthrough() by design and `verification_types` lets
    // customers declare new VR-* types. Such a key is DATA, not a command.
    const extended = mutate('python-fastapi', (config) => {
      (config.verification!['python'] as Record<string, unknown>)['bespoke_check'] = 'echo hi';
    });
    const caps = resolveStackCapabilities(extended);
    expect(Object.keys(caps.verify).sort()).toEqual([...ALL_VERIFY_KEYS].sort());
    expect((caps.verify as Record<string, unknown>)['bespoke_check']).toBeUndefined();
  });
});
