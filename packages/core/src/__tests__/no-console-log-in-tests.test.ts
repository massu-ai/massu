// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * ⛔ `console.log` IS SWALLOWED BY THIS RUNNER. A TEST MAY NOT REPORT THROUGH IT.
 *
 * Probed 2026-09-21 on the real config — one file, three channels, captured run output:
 *
 *     console.log('PROBE_CONSOLE_LOG')        -> ABSENT
 *     process.stdout.write('PROBE_STDOUT\n')  -> present
 *     process.stderr.write('PROBE_STDERR\n')  -> present
 *
 * Seven sites across five files were reporting denominators into the absent one, each
 * carrying a comment saying it printed so a reviewer could read it. `stack-asset-
 * conformance.test.ts` said exactly that and printed nothing, for the life of the assertion.
 *
 * ⛔ WHY A GUARD RATHER THAN SEVEN EDITS. The edits fix today's sites and say nothing about
 * the next one, and `console.log` is what reporting looks like in every other JavaScript
 * codebase — so the wrong channel is the one an author reaches for by default. This makes it
 * unreachable by accident and names the right one in the failure message.
 *
 * ⛔ THE EXEMPTION IS DERIVED, NOT A ROSTER (G32). A file that calls
 * `vi.spyOn(console, 'log')` has `console.log` as its SUBJECT — asserting that some code
 * logs is a legitimate test, and rewriting those calls would break the very assertion. That
 * predicate is computed from the file, so a new such test is covered on its first commit and
 * nobody maintains a list. The exempted files and the reason are REPORTED, because an
 * exemption nobody can see is a blind spot you chose (G18).
 *
 * ⛔ COMMENTS AND STRING LITERALS ARE NOT CODE. `code-only-helper.test.ts` asserts on the
 * literal string `'console.log("hello");'`; `install-tracking.test.ts` writes it into a
 * fixture file. A rule that reads prose as code is one people learn to ignore, so the
 * repo's own `codeOnly()` strips both before matching — reused rather than re-derived
 * (Rule 25); a second stripper is a second set of bugs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { execFileSync } from 'child_process';
import { codeOnly } from './helpers/code-only.ts';
import { report } from './helpers/report.ts';

const REPO = resolve(__dirname, '../../../..');

/** Every tracked file in the test tree — the population is a command, never a list. */
function testTreeFiles(): string[] {
  const out = execFileSync('git', ['ls-files', 'packages/core/src/__tests__'], {
    cwd: REPO,
    encoding: 'utf-8',
  });
  return out.split('\n').filter((f) => f.endsWith('.ts')).sort();
}

/**
 * A file whose SUBJECT is console logging. Derived from the file, not declared.
 *
 * ⛔ IT TAKES CODE-ONLY TEXT, NOT THE RAW SOURCE, AND THAT IS NOT A DETAIL.
 *
 * The first version of this guard read the raw file here while stripping comments only for
 * the OFFENDER scan. THIS FILE'S OWN DOCSTRING names the spy call in prose to explain the
 * exemption — so the guard read its own explanation as evidence and EXEMPTED ITSELF, going
 * quiet over its own body. A sweep that cannot see the one file guaranteed to mention the
 * pattern is wrong in both directions at once, and a gate wrong in both directions looks
 * CALIBRATED rather than broken.
 *
 * The general form, paid for twice in this repo now: APPLY THE COMMENT FILTER TO EVERY
 * PREDICATE, never only to the detector. An asymmetry between what the detector reads and
 * what the exemption reads is exactly what makes blindness self-masking.
 *
 * ⛔ BUT EACH PREDICATE NEEDS THE FILTER IT ACTUALLY REQUIRES, AND THE SECOND DRAFT PROVED
 * IT. Passing `stripStringLiterals` here too looked like the consistent choice and blanked
 * `vi.spyOn(console, 'log')` to `vi.spyOn(console, '')` — erasing the very argument this
 * predicate keys on, so EVERY file stopped being exempt (4 -> 0) and three legitimate
 * console-testing files were suddenly offenders. Comments must go from both; string literals
 * must go only from the OFFENDER scan, where a `console.log` inside a fixture string is
 * prose. "Same filter everywhere" and "the right filter everywhere" are different rules, and
 * only the second one is correct.
 */
function spiesOnConsoleLog(code: string): boolean {
  return /vi\.spyOn\(\s*console\s*,\s*['"]log['"]\s*\)/.test(code);
}

describe('no test reports through the swallowed console channel', () => {
  const files = testTreeFiles();

  it('the derived population is non-empty (M1)', () => {
    // "0 files scanned, 0 violations" is what a broken derivation returns, and it passes.
    expect(files.length, 'git ls-files returned no test files — the sweep cannot see').toBeGreaterThan(50);
  });

  it('the guard file itself is IN the population AND NOT EXEMPT — it must judge its own body', () => {
    const self = 'packages/core/src/__tests__/no-console-log-in-tests.test.ts';
    expect(files).toContain(self);
    // ⛔ THE SECOND HALF IS THE ONE THAT CAUGHT A REAL DEFECT. Being in the population is not
    // enough: the first version of this guard exempted itself on its own docstring, so it was
    // scanned and then skipped. In scope and judged are different facts.
    const code = codeOnly(readFileSync(resolve(REPO, self), 'utf-8'), '.ts');
    expect(code).not.toBeNull();
    expect(
      spiesOnConsoleLog(code as string),
      'the guard exempts itself — its own text satisfies its exemption predicate',
    ).toBe(false);
  });

  it('no console.log call survives outside a file that tests console logging', () => {
    const offenders: string[] = [];
    const exempt: string[] = [];
    let scanned = 0;
    let unreadable = 0;

    for (const rel of files) {
      let src: string;
      try {
        src = readFileSync(resolve(REPO, rel), 'utf-8');
      } catch {
        // M2 — unreadable is an ERROR, never an empty one.
        unreadable++;
        continue;
      }
      scanned++;
      // Comments stripped for BOTH predicates; string literals only for the offender scan.
      // See spiesOnConsoleLog's note for what each one costs when it is wrong.
      const withStrings = codeOnly(src, '.ts');
      const code = codeOnly(src, '.ts', { stripStringLiterals: true });
      if (withStrings === null || code === null) continue;
      if (spiesOnConsoleLog(withStrings)) {
        exempt.push(rel);
        continue;
      }
      code.split('\n').forEach((line, i) => {
        if (/\bconsole\s*\.\s*log\s*\(/.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }

    report(
      `[no-console-log] scanned=${scanned} exempt=${exempt.length} ` +
        `offenders=${offenders.length}` +
        (exempt.length ? ` · exempt (spies on console.log): ${exempt.join(', ')}` : ''),
    );

    expect(unreadable, 'a test file could not be read — the sweep is incomplete').toBe(0);
    expect(
      offenders,
      `console.log is SWALLOWED by this runner — these lines print nothing:\n` +
        offenders.map((o) => `  ${o}`).join('\n') +
        `\n\nUse report() / reportSkip() from src/__tests__/helpers/report.ts, which write to` +
        ` a channel proven to surface (scripts/ops/live-fire-report-channel.sh).`,
    ).toEqual([]);
  });

  it('the stripper really removes a console.log that is only a string or a comment', () => {
    // The NEGATIVE CONTROL for the exclusion. Without it, "0 offenders" could equally mean
    // "the stripper removed everything", and the guard would be silent by construction.
    const sample = [
      '// console.log(1) in a comment',
      "const s = 'console.log(2) in a string';",
      'console.log(3);',
    ].join('\n');
    const code = codeOnly(sample, '.ts', { stripStringLiterals: true });
    expect(code).not.toBeNull();
    const hits = (code as string)
      .split('\n')
      .filter((l) => /\bconsole\s*\.\s*log\s*\(/.test(l));
    expect(hits.length, 'the stripper must keep the REAL call and drop the other two').toBe(1);
  });
});
