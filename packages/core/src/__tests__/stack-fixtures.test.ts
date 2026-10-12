// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P7.1 of docs/plans/2026-09-20-stack-conformant-asset-rendering.md.
 *
 * Thirteen minimal real trees, one per shipped stack, so that "the assets render correctly"
 * can be asserted against something other than this repository. *A fix proven on one stack
 * is proven on one stack.*
 *
 * THE ROSTER IS DERIVED from `readdirSync('templates/')` — the same source
 * `stack-template-conformance.test.ts` uses — so a 14th stack is RED on its FIRST COMMIT
 * rather than when somebody remembers to add a fixture (G32).
 *
 * ⛔ WHY THESE ARE NOT GIT REPOSITORIES, AND WHY THAT IS THE POINT
 * ---------------------------------------------------------------
 * The plan anticipated 13 harnesses each calling `git init`, and wrapped them in the G29
 * machinery: the repo's git-env helpers, the sandbox drift-guard's candidate set, and a
 * four-value poisoning proof. That is thirteen live instances of the class that, on this
 * machine, committed a 5,543-file deletion to a real repository — guarded, but present.
 *
 * MEASURED instead of assumed: nothing on the acceptance path invokes git.
 *   `scripts/measure-asset-conformance.sh`  — grep for a git invocation: exit 1, no matches
 *   `commands/install-commands.ts`          — no git child process at all
 *   `config.ts findProjectRoot()`           — tests `existsSync('.git')`; never RUNS git,
 *                                             and anchors on massu.config.yaml first
 *   `commands/doctor.ts:315`                — no `.git` ⇒ a `warn`, not a failure
 * So the fixtures need no repository, and a hazard that does not exist cannot leak (G21 —
 * prefer impossible to guarded). The G29 obligations on P7.1 are discharged by REMOVAL, and
 * the plan's P7.1/S11 rows were amended to say so rather than left to be read as skipped.
 *
 * ⛔ AND NO FIXTURE CARRIES ITS OWN massu.config.yaml. A stack's config is what `massu init`
 * writes for that stack — i.e. the template. Committing a copy beside the template creates
 * two sources for one fact, and nothing would assert they agree (G32/CR-74). The harness
 * writes it from `templates/<stack>/` at setup, so a template change reaches every fixture
 * with no second site to update. Both invariants are asserted below, because a design that
 * nothing checks is a comment.
 *
 * BLIND-GATE POSTURE: M1 the denominator is asserted non-zero AND equal to the template
 * count; M2 an unreadable fixture is an ERROR, never an implicit exemption.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { resolve, join } from 'path';
import YAML from 'yaml';

const TEMPLATES_DIR = resolve(__dirname, '../../templates');
const FIXTURES_DIR = resolve(__dirname, 'fixtures/stacks');

function stackNames(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((entry) => existsSync(join(TEMPLATES_DIR, entry, 'massu.config.yaml')))
    .sort();
}

/** Every file under a directory, relative to it. M2: an unreadable entry throws. */
function filesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...filesUnder(abs, join(prefix, entry)));
    else out.push(join(prefix, entry));
  }
  return out;
}

const STACKS = stackNames();

describe('P7.1 — one minimal fixture tree per shipped stack', () => {
  it('the roster is derived and non-empty (M1: a zero denominator makes everything below vacuous)', () => {
    expect(STACKS.length).toBeGreaterThan(0);
    expect(STACKS.length).toBe(13);
  });

  it('every shipped stack HAS a fixture — a 14th template with no fixture is RED here', () => {
    const missing = STACKS.filter((s) => !existsSync(join(FIXTURES_DIR, s)));
    expect(missing, 'templates with no fixture tree').toEqual([]);
  });

  it('every fixture names a stack that still ships — a stale fixture is RED too', () => {
    const present = readdirSync(FIXTURES_DIR)
      .filter((e) => statSync(join(FIXTURES_DIR, e)).isDirectory())
      .sort();
    const orphaned = present.filter((s) => !STACKS.includes(s));
    expect(orphaned, 'fixture trees for stacks that no longer exist').toEqual([]);
    expect(present.length).toBe(STACKS.length);
  });

  it.each(STACKS)('%s carries a source file under the path its TEMPLATE declares', (stack) => {
    // Not a hardcoded path per stack: the expectation is read from the template, so a
    // template that moves `paths.source` makes its fixture RED instead of quietly
    // describing a layout the product no longer ships.
    const config = YAML.parse(
      readFileSync(join(TEMPLATES_DIR, stack, 'massu.config.yaml'), 'utf-8'),
    ) as { paths?: { source?: string } };
    const declared = config.paths?.source;
    expect(declared, `${stack}: template declares no paths.source`).toBeTruthy();

    const root = join(FIXTURES_DIR, stack);
    const files = filesUnder(root);
    expect(files.length, `${stack}: fixture is empty`).toBeGreaterThan(0);

    const prefix = declared === '.' ? '' : `${declared}/`;
    const underSource = files.filter((f) => f.startsWith(prefix));
    expect(
      underSource.length,
      `${stack}: no file under declared paths.source '${declared}' (files: ${files.join(', ')})`,
    ).toBeGreaterThan(0);
  });

  it.each(STACKS)('%s is NOT a git repository (the hazard is removed, not guarded)', (stack) => {
    // If this ever goes red, 13 `git init` harnesses came back and the G29 obligations in
    // the plan's P7.1 are live again. That is a design change, not a test failure to patch.
    expect(existsSync(join(FIXTURES_DIR, stack, '.git'))).toBe(false);
  });

  it.each(STACKS)('%s carries NO massu.config.yaml — the harness derives it from the template', (stack) => {
    const files = filesUnder(join(FIXTURES_DIR, stack));
    expect(
      files.filter((f) => f.endsWith('massu.config.yaml')),
      `${stack}: a committed config here is a second copy of the template, and nothing asserts they agree`,
    ).toEqual([]);
  });
});

describe('P7.1 — G25 payload safety across every fixture byte', () => {
  /**
   * ⛔ "A test payload must be INERT UNDER EVERY PLANT, not inert because of the property
   * being tested." On this machine a fixture of exactly the forbidden shape executed
   * `rm -rf ~` twice on CI when a mutation harness disabled the property that made it safe.
   *
   * These fixtures are inert source files today. This asserts they stay that way, so a
   * future edit cannot quietly put a destructive token next to a shell metacharacter in a
   * tree that harnesses copy, render into, and execute commands against.
   */
  const DESTRUCTIVE = /\b(rm|rmdir|unlink|rmtree|shred|mkfs|dd)\b/;
  const METACHAR = /[;&|`]|\$\(/;

  it('reports its denominator — 0 files scanned would be a loud error, not a pass', () => {
    const all = STACKS.flatMap((s) => filesUnder(join(FIXTURES_DIR, s)));
    expect(all.length).toBeGreaterThan(0);
    expect(all.length).toBe(26);
  });

  it.each(STACKS)('%s: no destructive token shares a line with a shell metacharacter', (stack) => {
    const root = join(FIXTURES_DIR, stack);
    const offenders: string[] = [];
    for (const rel of filesUnder(root)) {
      // M2: readFileSync throws on an unreadable fixture rather than yielding '' and passing.
      const text = readFileSync(join(root, rel), 'utf-8');
      text.split('\n').forEach((line, i) => {
        if (DESTRUCTIVE.test(line) && METACHAR.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, `${stack}: G25 payload-safety violation`).toEqual([]);
  });
});
