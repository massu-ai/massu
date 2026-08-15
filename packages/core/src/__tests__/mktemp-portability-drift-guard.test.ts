// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Drift-guard: every `mktemp` TEMPLATE must carry at least three `X`s.
 *
 * THE DEFECT
 * ----------
 * BSD `mktemp` (macOS, where this repo is developed) accepts `-t PREFIX` and
 * appends the random suffix itself. GNU `mktemp` (Linux, where CI runs) treats
 * `-t` as "place it in $TMPDIR" and REQUIRES the template to end in at least three
 * `X`s. So this:
 *
 *     TMP="$(mktemp -d -t hook-entry-guard)"
 *
 * works on a developer's machine and dies on every runner with:
 *
 *     mktemp: too few X's in template 'hook-entry-guard'
 *
 * Measured 2026-08-10: five such sites shipped in two new gate scripts and made
 * BOTH of them unable to run at all on CI — `Anti-Vacuity` reported
 * `exited 1` for each, having executed none of their checks. The repo's eight
 * pre-existing `mktemp -t` sites all carried `XXXXXX` correctly; the convention was
 * right and the new code broke it.
 *
 * WHY A STATIC GUARD RATHER THAN "run the scripts on Linux"
 * --------------------------------------------------------
 * This is the same shape as the `require('*.ts')` failure the same day: a defect
 * that is invisible on the development platform and fatal on the CI platform. A
 * check that only fires on Linux reproduces the original asymmetry. Template
 * contents are a STATIC property of the source, so this goes red everywhere —
 * including in the pre-commit run on the machine that cannot reproduce the failure.
 *
 * NOTE ON SEVERITY: the failure mode is loud, not silent. Under `set -euo pipefail`
 * a failed `mktemp` aborts the script before any plant is applied, so no tree was
 * ever left dirty. What was lost is the GATE — two proofs that reported nothing on
 * CI, which is the blind-gate shape one level up: a check that cannot run is
 * indistinguishable from one that ran and found nothing.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

/** Every tracked shell script — the authoritative population. */
function trackedShellScripts(): string[] {
  const out = execFileSync('git', ['ls-files', '*.sh', '*.bash'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const files = out.split('\n').filter(Boolean);
  // M1 — PROVE IT LOOKED. "Scanned 0, found 0" must be a loud error, never a pass.
  if (files.length === 0) {
    throw new Error('git ls-files enumerated 0 shell scripts — refusing to report clean');
  }
  return files.sort();
}

export interface MktempHit {
  file: string;
  line: number;
  text: string;
}

/**
 * Find `mktemp` invocations whose template lacks the required `X`s.
 *
 * Only a `-t`/`--tmpdir` invocation with an explicit template is a hit. A bare
 * `mktemp` or `mktemp -d` supplies its own template and is portable — flagging
 * those would be crying wolf, and a gate that cries wolf gets ignored.
 */
export function findNonPortableMktemp(file: string, source: string): MktempHit[] {
  const hits: MktempHit[] = [];
  source.split('\n').forEach((raw, i) => {
    // Strip a full-line comment. A line-level filter, because a prose mention of
    // the broken form (this file's own docs, an incident report) is not code —
    // the failure that keeps recurring in this repo's scanners.
    if (/^\s*#/.test(raw)) return;
    const line = raw.replace(/(^|[^\\])#.*$/, '$1');

    // `mktemp [-d] -t TEMPLATE` / `--tmpdir=... TEMPLATE`
    const m = /\bmktemp\b(?:\s+-[A-Za-z-]+)*\s+(?:-t|--tmpdir(?:=\S*)?)\s+(['"]?)([^\s'";|&)]+)\1/.exec(
      line,
    );
    if (!m) return;
    const template = m[2];
    const xs = /X{3,}/.test(template);
    if (!xs) hits.push({ file, line: i + 1, text: raw.trim() });
  });
  return hits;
}

describe('mktemp portability drift-guard', () => {
  const files = trackedShellScripts();
  const hits: MktempHit[] = [];
  const unreadable: string[] = [];
  let parsed = 0;

  for (const rel of files) {
    let src: string;
    try {
      src = readFileSync(join(REPO_ROOT, rel), 'utf-8');
    } catch (e) {
      // M2 — FAIL CLOSED. An unreadable input is an ERROR, never an empty one.
      unreadable.push(`${rel}: ${(e as Error).message}`);
      continue;
    }
    parsed++;
    hits.push(...findNonPortableMktemp(rel, src));
  }

  it(`reports its denominator [listed: ${files.length} parsed: ${parsed} hits: ${hits.length}]`, () => {
    expect(unreadable, `unreadable:\n${unreadable.join('\n')}`).toEqual([]);
    expect(parsed).toBe(files.length);
    // Positive control: a population this small could plausibly be enumerated
    // wrongly, so require that the sweep saw a file known to exist in every
    // environment the suite runs in.
    expect(files, 'the sweep did not see a known tracked script').toContain(
      'scripts/massu-pattern-scanner.sh',
    );
  });

  it('no mktemp template omits the X placeholders', () => {
    const detail = hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join('\n');
    expect(
      hits,
      `${hits.length} non-portable mktemp template(s):\n${detail}\n\n` +
        "BSD mktemp (macOS) appends the suffix for you; GNU mktemp (Linux CI) requires the\n" +
        "template to end in >= 3 X's and dies with \"too few X's in template\". A script with\n" +
        'this shape passes locally and CANNOT RUN AT ALL on CI — which is worse than a\n' +
        'wrong answer, because a gate that cannot run reports the same silence as one that\n' +
        'ran and found nothing.\n\n' +
        "Fix: append -XXXXXX to the template, matching the repo's existing sites, e.g.\n" +
        '  TMP="$(mktemp -d -t my-thing-XXXXXX)"',
    ).toEqual([]);
  });

  // FIXTURES — one per detection path, each demanded to FIRE, plus the shapes that
  // must stay SILENT. A rule with N paths and fewer fixtures is decoration.
  it('detector fixtures: fires on the broken form, silent on the portable ones', () => {
    const fire = (s: string): number => findNonPortableMktemp('f.sh', s).length;

    // FIRES — the two real shapes that broke CI.
    expect(fire('TMP="$(mktemp -d -t hook-entry-guard)"'), '-d -t, no X').toBe(1);
    expect(fire('B="$(mktemp -t require-ts-guard-mutation)"'), '-t, no X').toBe(1);
    expect(fire('X=$(mktemp --tmpdir my-thing)'), '--tmpdir, no X').toBe(1);
    // Fewer than three X's is still rejected by GNU mktemp.
    expect(fire('T="$(mktemp -t thing-XX)"'), 'only two X').toBe(1);

    // SILENT — the portable form the repo already uses at 8 sites.
    expect(fire('T="$(mktemp -d -t massu-sync-check-XXXXXXXX)"'), 'template with X').toBe(0);
    expect(fire('L=$(mktemp -t massu-alias-poll.XXXXXX.log)'), 'X mid-template').toBe(0);
    // SILENT — no template at all; mktemp supplies its own.
    expect(fire('S="$(mktemp -d)"'), 'bare -d').toBe(0);
    expect(fire('S="$(mktemp)"'), 'bare mktemp').toBe(0);

    // SILENT — PROSE. This repo has repeatedly shipped scanners that flagged their
    // own documentation of the defect they detect.
    expect(fire('# never write mktemp -t my-thing without the X placeholders'), 'comment').toBe(0);
    expect(fire('  # mktemp -t broken-example'), 'indented comment').toBe(0);
    expect(fire('echo hi  # mktemp -t broken-example'), 'trailing comment').toBe(0);
  });
});
