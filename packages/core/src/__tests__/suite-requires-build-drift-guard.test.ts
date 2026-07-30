// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Drift-guard: every CI job that RUNS THE TEST SUITE must first BUILD.
 *
 * THE CLASS
 * ---------
 * The suite's fail-closed tests assert on `packages/core/dist/**` — the hook
 * bundles, the CLI, the embedder assets, the adapter bundle. A job that runs the
 * suite without producing those artifacts makes those tests fail for a reason
 * that has nothing to do with the change under test, or — worse — lets them take
 * a degraded branch and pass while asserting nothing.
 *
 * It happened three times:
 *   2026-07-2x  ci-sync-check.sh    ran the suite after build:adapters   -> fixed fe15b78f
 *   2026-07-28  ci.yml::native-module  same                              -> fixed d566e49e
 *   2026-07-28  ci.yml::windows-bootstrap  same, and it did NOT go red — its only
 *               dist-dependent test took an `unresolved` branch that PASSED, so the
 *               sole Windows leg of CR-70 was green and blind.
 *
 * Each was repaired at the one site in front of it. That is the shape CR-74 names:
 * a fix is a SET of sites. This guard enumerates the set from the YAML so job #5
 * cannot be added wrong.
 *
 * WHY A GUARD AND NOT A CONVENTION
 * --------------------------------
 * `d566e49e` enumerated the obligated jobs by hand and recorded the Windows row as
 * "scoped subset; its only dist/ hit is a COMMENT — verified". That was wrong: the
 * dependency is real (doctor-hook-execution-drift-guard -> checkHookExecution ->
 * dist/hooks/session-start.js), it simply did not fail. A hand enumeration by the
 * person who just fixed two other sites is exactly the enumeration that misses the
 * third.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const WORKFLOWS_DIR = resolve(REPO_ROOT, '.github/workflows');

/**
 * Jobs that run the suite WITHOUT a full build, each with a cited reason.
 *
 * EMPTY, and that is the intended steady state. Adding an entry is a RULING that
 * the job's scoped suite touches no `dist/**` oracle — which must be established
 * by RUNNING it with dist withdrawn, not by reading the test list. The Windows leg
 * was believed to be exactly this kind of exception and was not.
 */
const ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({});

/** A step invokes the vitest suite (as opposed to a lint/type/build command). */
function runsSuite(run: string): boolean {
  // `npm test`, `npm test -- <names>`, `npm run test`, `npx vitest run …`.
  // NOT `npm run build`, and NOT `tsc`.
  //
  // The lookahead is load-bearing: `\b` after `test` also matches before a colon,
  // so `npm run test:coverage:report` — a DIFFERENT script — read as the suite.
  // Caught by the fixture below, which is the entire reason it exists.
  return /(^|\s|&&|\|\|)(npm\s+(run\s+)?test(?![\w:-])|npx\s+vitest\b|vitest\s+run\b)/.test(run);
}

/**
 * A step performs the FULL build.
 *
 * `npm run build` at the root chains build:types -> build:adapters -> build:core,
 * and build:core produces dist/cli.js, dist/hooks/, the embedder assets and the
 * adapter bundle. A partial (`build:adapters`, `build:hooks` alone) does NOT count:
 * the whole class is jobs that built *something* and believed it sufficient.
 */
function isFullBuild(run: string): boolean {
  return /(^|\s|&&|\|\|)npm\s+run\s+build(\s|$|&&)/.test(run);
}

interface JobReport {
  workflow: string;
  job: string;
  key: string;
  buildsFirst: boolean;
}

interface Sweep {
  workflowsListed: number;
  workflowsParsed: number;
  unparseable: string[];
  jobsScanned: number;
  suiteJobs: JobReport[];
}

function sweep(): Sweep {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
  // M1 — PROVE IT LOOKED. An empty workflow dir is a loud error, never a pass.
  if (files.length === 0) {
    throw new Error(`no workflow files under ${WORKFLOWS_DIR} — refusing to report clean`);
  }

  const unparseable: string[] = [];
  const suiteJobs: JobReport[] = [];
  let parsed = 0;
  let jobsScanned = 0;

  for (const file of files) {
    let doc: { jobs?: Record<string, { steps?: Array<{ run?: string }> }> };
    try {
      doc = parseYaml(readFileSync(resolve(WORKFLOWS_DIR, file), 'utf-8')) as typeof doc;
    } catch (e) {
      // M2 — FAIL CLOSED. Unparseable is an ERROR, never a zero-job file.
      unparseable.push(`${file}: ${(e as Error).message}`);
      continue;
    }
    parsed++;
    for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
      jobsScanned++;
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      // ORDER MATTERS: the build must come BEFORE the suite step, so scan forward
      // and remember whether a full build has been seen yet.
      let built = false;
      for (const step of steps) {
        const run = typeof step?.run === 'string' ? step.run : '';
        if (!run) continue;
        if (isFullBuild(run)) built = true;
        if (runsSuite(run)) {
          suiteJobs.push({
            workflow: file,
            job: jobName,
            key: `${file}::${jobName}`,
            buildsFirst: built,
          });
          break; // one report per job is enough
        }
      }
    }
  }
  return { workflowsListed: files.length, workflowsParsed: parsed, unparseable, jobsScanned, suiteJobs };
}

describe('CI suite-requires-build drift-guard', () => {
  const report = sweep();
  const DENOMINATOR =
    `workflows: ${report.workflowsParsed}/${report.workflowsListed}  ` +
    `unparseable: ${report.unparseable.length}  jobs: ${report.jobsScanned}  ` +
    `suite-running jobs: ${report.suiteJobs.length}`;

  it(`reports its denominator and parses every workflow [${DENOMINATOR}]`, () => {
    expect(report.unparseable, `unparseable:\n${report.unparseable.join('\n')}`).toEqual([]);
    expect(report.workflowsParsed).toBe(report.workflowsListed);
    // PROVE IT LOOKED: a sweep that found no suite-running job at all is not a
    // clean repo, it is a broken matcher — this repo demonstrably has several.
    expect(
      report.suiteJobs.length,
      'found 0 jobs running the suite — the matcher is broken, not the repo clean',
    ).toBeGreaterThan(0);
  });

  it('every CI job that runs the test suite builds first', () => {
    const offending = report.suiteJobs.filter((j) => !j.buildsFirst && !(j.key in ALLOWLIST));
    const detail = offending.map((j) => `  ${j.key}`).join('\n');
    expect(
      offending,
      `${offending.length} job(s) run the suite without a full build first:\n${detail}\n\n` +
        'The suite asserts on packages/core/dist/** (hook bundles, cli.js, embedder\n' +
        'assets, the adapter bundle). A job that skips the build makes those tests fail\n' +
        'for reasons unrelated to the change — or lets one take a degraded branch and\n' +
        'PASS while asserting nothing, which is how ci.yml::windows-bootstrap ran the\n' +
        'only Windows leg of CR-70 green and blind.\n\n' +
        'Add `run: npm run build` before the test step. A partial build\n' +
        '(build:adapters / build:hooks alone) does NOT satisfy this — that partial is\n' +
        'the defect, fixed three times at one site each.',
    ).toEqual([]);
  });

  // FIXTURES — one per detection path, each demanded to FIRE, plus what must stay
  // SILENT. The matcher decides the candidate set, and the candidate set IS the gate.
  it('matcher fixtures: recognises suite steps and full builds, rejects partials', () => {
    // FIRES as a suite step:
    expect(runsSuite('npm test'), 'npm test').toBe(true);
    expect(runsSuite('npm test -- node-bootstrap-windows foo'), 'npm test -- <names>').toBe(true);
    expect(runsSuite('npx vitest run src/x.test.ts'), 'npx vitest run').toBe(true);
    expect(runsSuite('cd packages/core && npm test'), 'chained npm test').toBe(true);
    // SILENT — not the suite:
    expect(runsSuite('npm run build'), 'build is not the suite').toBe(false);
    expect(runsSuite('npx tsc --noEmit'), 'tsc is not the suite').toBe(false);
    expect(runsSuite('npm run test:coverage:report'), 'a different script').toBe(false);

    // FIRES as a full build:
    expect(isFullBuild('npm run build'), 'npm run build').toBe(true);
    expect(isFullBuild('npm ci && npm run build'), 'chained build').toBe(true);
    // SILENT — a PARTIAL build is exactly the defect, and must not satisfy the rule:
    expect(isFullBuild('npm run build:adapters'), 'build:adapters is partial').toBe(false);
    expect(isFullBuild('npm run build:hooks'), 'build:hooks is partial').toBe(false);
    expect(isFullBuild('npm run build:bundle-adapters'), 'build:bundle-adapters is partial').toBe(false);
  });
});
