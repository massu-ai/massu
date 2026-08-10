// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Drift-guard: every hook entry point must gate `main()` behind
 * `isDirectInvocation(import.meta.url)`.
 *
 * THE DEFECT
 * ----------
 * A bare `main()` at module scope means IMPORTING the module RUNS the hook — it
 * reads stdin (blocking until the stream closes), does its work, and calls
 * `process.exit`. Found 2026-08-10 when a test importing ONE constant from
 * `auto-learning-pipeline.ts` executed the hook: the suite reported `3704 passed`
 * and `exit 1`. Measured across the tree that day: **18 hook entry points, 15 with
 * no guard at all** and 2 more guarded by a filename suffix.
 *
 * WHY NOT `process.argv[1].endsWith('my-hook.js')`
 * ------------------------------------------------
 * That was the shape in `pre-delete-check.ts` and `security-gate.ts`. It works
 * until the file is renamed — the guard then predicates on a name nothing
 * produces, `main()` silently stops running, and nothing goes red, because a hook
 * that never ran and a hook that ran and exited 0 are the same observation. Same
 * class as memory `a-rename-turns-its-own-guards-vacuous`.
 *
 * WHAT THIS TEST IS AND IS NOT
 * ----------------------------
 * This is the STATIC half: it proves the source says the right thing, on every
 * hook, including one added tomorrow. It cannot prove the guard WORKS — text is
 * not execution. The behavioural half is
 * `scripts/tests/test-hook-entry-guard-behaviour.sh`, which imports each built
 * bundle and, for every hook, pairs that with a forced-open copy that MUST write
 * output, so a silent probe cannot pass as a clean one.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = resolve(__dirname, '..', 'hooks');
const HELPER = 'is-direct-invocation';

/** Every hook entry point: the `.ts` files directly under `src/hooks/`. */
function hookFiles(): string[] {
  const files = readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort();
  // M1 — PROVE IT LOOKED. "Scanned 0, found 0" must be a loud error, never a pass.
  if (files.length === 0) {
    throw new Error(`enumerated 0 hook files under ${HOOKS_DIR} — refusing to report clean`);
  }
  return files;
}

interface HookFacts {
  file: string;
  callsMain: boolean;
  guarded: boolean;
  importsHelper: boolean;
  bareMainLines: number[];
}

function read(file: string): HookFacts {
  const src = readFileSync(join(HOOKS_DIR, file), 'utf-8');
  const lines = src.split('\n');

  // A bare `main()` at column 0 is module-scope execution. Inside the sanctioned
  // guard it is indented, so indentation is what separates the two — the same
  // reason the guard is written as a block rather than a one-liner.
  const bareMainLines: number[] = [];
  lines.forEach((l, i) => {
    if (/^\s*(await\s+|void\s+)?main\(\)\s*;?\s*$/.test(l) && !/^\s+/.test(l)) {
      bareMainLines.push(i + 1);
    }
  });

  return {
    file,
    callsMain: /(^|\n)\s*(await\s+|void\s+)?main\(\)\s*;?\s*(\n|$)/.test(src),
    guarded: /if\s*\(\s*isDirectInvocation\(\s*import\.meta\.url\s*\)\s*\)\s*\{[\s\S]{0,80}?main\(\)/.test(
      src,
    ),
    importsHelper: new RegExp(`from\\s+['"][^'"]*${HELPER}(?:\\.ts)?['"]`).test(src),
    bareMainLines,
  };
}

describe('hook entry-point guard drift-guard', () => {
  const facts = hookFiles().map(read);
  const runners = facts.filter((f) => f.callsMain);

  it(`reports its denominator [hooks: ${facts.length}, invoking main(): ${runners.length}]`, () => {
    expect(facts.length, 'no hook files found').toBeGreaterThan(0);
    // Every file under src/hooks/ is an esbuild entry point, so every one of them
    // invokes main(). A file that does not is either a library in the wrong
    // directory or a hook that no longer runs — both worth a human look.
    expect(
      facts.filter((f) => !f.callsMain).map((f) => f.file),
      'hook files that never call main() — misplaced library, or a hook that stopped running?',
    ).toEqual([]);
  });

  it('every hook gates main() behind isDirectInvocation(import.meta.url)', () => {
    const offenders = runners.filter((f) => !f.guarded).map((f) => f.file);
    expect(
      offenders,
      `${offenders.length} hook(s) call main() without the entry-point guard:\n` +
        offenders.map((f) => `  packages/core/src/hooks/${f}`).join('\n') +
        '\n\nA bare `main()` at module scope means IMPORTING the module RUNS the hook —\n' +
        'it reads stdin, does its work, and exits the host process. A test that imports\n' +
        'one constant executes the whole hook.\n\n' +
        'Add, at the end of the file:\n' +
        `  import { isDirectInvocation } from './lib/${HELPER}.ts';\n` +
        '  if (isDirectInvocation(import.meta.url)) {\n' +
        '    main();\n' +
        '  }\n\n' +
        'Do NOT use `process.argv[1].endsWith(\'my-hook.js\')`. That duplicates the\n' +
        'filename inside its own module, so a rename disarms it silently.',
    ).toEqual([]);
  });

  it('no hook calls main() unguarded at module scope', () => {
    const offenders = facts
      .filter((f) => f.bareMainLines.length > 0)
      .map((f) => `packages/core/src/hooks/${f.file}:${f.bareMainLines.join(',')}`);
    expect(
      offenders,
      `module-scope main() call(s):\n${offenders.join('\n')}\n` +
        'Indentation is the discriminator: inside the sanctioned guard block main() is\n' +
        'indented. A call at column 0 runs on import.',
    ).toEqual([]);
  });

  it('every guarded hook actually imports the helper — the guard cannot be a bare identifier', () => {
    const offenders = runners.filter((f) => f.guarded && !f.importsHelper).map((f) => f.file);
    expect(
      offenders,
      `hook(s) referencing isDirectInvocation without importing it: ${offenders.join(', ')}\n` +
        'This would be a ReferenceError at load — which, for a hook that must never\n' +
        'block a session, is exactly the failure that gets swallowed.',
    ).toEqual([]);
  });

  // The helper is the single point of failure for all 18 hooks, so its own
  // contract is pinned here rather than left to inspection.
  it('the helper refuses to run when there is no entry point', async () => {
    const { isDirectInvocation } = await import('../hooks/lib/is-direct-invocation.ts');

    const realArgv = process.argv;
    try {
      // Fails CLOSED: no argv[1] (an embedder, a worker, a REPL) must NOT run the
      // hook — running it there would consume stdin and exit the host.
      process.argv = ['node'];
      expect(isDirectInvocation('file:///anything.js'), 'no argv[1] must not match').toBe(false);

      process.argv = ['node', '/tmp/some-other-entry.js'];
      expect(
        isDirectInvocation('file:///tmp/this-module.js'),
        'a different entry point must not match',
      ).toBe(false);

      // POSITIVE CONTROL: if this were false too, every assertion above would pass
      // for a function that simply always returns false.
      process.argv = ['node', '/tmp/this-module.js'];
      expect(
        isDirectInvocation('file:///tmp/this-module.js'),
        'the real entry point MUST match, or the helper is a constant',
      ).toBe(true);
    } finally {
      process.argv = realArgv;
    }
  });
});
