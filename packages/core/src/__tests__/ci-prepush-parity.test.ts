// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P3-001 drift-guard (plan-2026-05-18-pre-push-ci-parity): asserts that every
 * multi-line shell block (>5 lines) in any .github/workflows/*.yml file
 * (excluding `*.public.yml` mirrors + workflows in WORKFLOW_FILE_EXCLUSIONS)
 * is extracted to scripts/ci-<name>.sh, and every such script is either
 * called from scripts/pre-push-light.sh OR carries a `# CI-ONLY: <reason>`
 * first-comment-line.
 *
 * This is the post-commit-time enforcement (npm test) of CR-50 / VR-CI-PARITY.
 * scripts/massu-pattern-scanner.sh Check 26 is the pre-commit-time equivalent.
 *
 * Eliminates the structural bug class where CI catches failure modes that
 * local pre-push-light cannot — discovered 2026-05-18 when SHA b26fbb1 passed
 * pre-push-light locally but failed CI on 4 distinct gates.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../../..');
const WORKFLOWS_DIR = resolve(REPO_ROOT, '.github/workflows');

/**
 * Workflows intentionally inline because they implement INFRASTRUCTURE /
 * SECURITY logic outside the "CI gate that local dev must mirror" scope.
 * Adding a future entry requires a one-line comment justifying inclusion.
 * Drift-guard sub-assertion enforces each entry corresponds to a file on disk.
 */
const WORKFLOW_FILE_EXCLUSIONS = new Set<string>([
  'ci.public.yml',                       // Public-repo mirror authored separately; synced via sync-public.sh → public/ci.yml. Not a local CI gate.
  // INFRASTRUCTURE / SECURITY workflows — intentionally inline, scope = "not a CI gate local dev must mirror":
  'apply-ruleset.yml',                   // GitHub-App token + ruleset reconciler (Rulesets-as-Code plan, ADR-0002). Runs only on rule changes, not on every push.
  'branch-protection-audit.yml',         // Daily cron audit invoking audit-ruleset-state.sh. Scheduled-only; no local equivalent needed.
  'leak-guard.yml',                      // PUBLIC-REPO-ONLY per-push leak gate (massu-ai/massu only). Internal repo doesn't need to mirror; sync-check.yml is the equivalent for internal.
  'leak-guard-retro.yml',                // PUBLIC-REPO-ONLY retro full-tree scan. Scheduled-only on public repo.
  'leak-guard-scheduled.yml',            // PUBLIC-REPO-ONLY scheduled leak-guard scan. Cron-driven, no per-push parity needed.
  'leak-guard-source-of-truth.yml',      // SoT discipline gate for leak-pattern definitions in scripts/lib/leak-patterns.sh. Runs only on pattern-file changes.
]);

/**
 * CI-ONLY scripts allowlist — single source of truth for both this test
 * AND scripts/massu-pattern-scanner.sh Check 26 (`CI_ONLY_SCRIPTS_BASH`).
 * Adding a future CI-ONLY script requires (a) adding the `# CI-ONLY: <reason>`
 * first-comment-line to the script AND (b) appending to this set AND the
 * bash mirror in pattern-scanner.sh.
 */
const CI_ONLY_SCRIPTS = new Set<string>([
  'ci-fresh-install.sh',   // matrix per-fixture variant — covered locally by [0/15] clean-state sim
  'ci-config-drift.sh',    // workspace-shadow avoidance scratch-dir setup is CI-environment-specific
]);

const MAX_INLINE_SHELL_LINES = 5;

interface WorkflowJobStep {
  run?: string;
  name?: string;
  [key: string]: unknown;
}

interface WorkflowJob {
  steps?: WorkflowJobStep[];
  [key: string]: unknown;
}

interface WorkflowDoc {
  jobs?: Record<string, WorkflowJob>;
  [key: string]: unknown;
}

function readWorkflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .filter((name) => !WORKFLOW_FILE_EXCLUSIONS.has(name))
    .sort();
}

function listCiScripts(): string[] {
  const scriptsDir = resolve(REPO_ROOT, 'scripts');
  return readdirSync(scriptsDir)
    .filter((name) => /^ci-.*\.sh$/.test(name))
    .sort();
}

function readPrePushLight(): string {
  return readFileSync(resolve(REPO_ROOT, 'scripts/pre-push-light.sh'), 'utf-8');
}

function firstCommentLines(scriptPath: string, n: number): string {
  const content = readFileSync(scriptPath, 'utf-8');
  return content.split('\n').slice(0, n).join('\n');
}

/**
 * Detect whether we're running inside the authoritative internal repo
 * (vs. inside the public-mirror tree produced by `scripts/sync-public.sh`
 * for sync-check verification). The internal repo carries `website/` and
 * `docs/`; the public mirror does NOT. Used to gate orphan-style asserts
 * that assume internal-tree workflow layout.
 *
 * Plan-2026-05-18-security-medium-sweep P8-001 follow-up — the orphan
 * check otherwise fails on `ci.public.yml` in the mirror because
 * `sync-public.sh` renames it to `ci.yml` (line 117 of sync-public.sh).
 */
const IS_INTERNAL_REPO = existsSync(resolve(REPO_ROOT, 'website')) && existsSync(resolve(REPO_ROOT, 'docs'));

describe('ci-prepush-parity (P3-001 drift-guard for CR-50 / VR-CI-PARITY)', () => {
  it('WORKFLOW_FILE_EXCLUSIONS entries all exist on disk (no orphans)', () => {
    if (!IS_INTERNAL_REPO) {
      // Sync-mirror tree: EXCLUSIONS list is internal-tree-authoritative.
      // In the mirror, `ci.public.yml` is renamed to `ci.yml` by
      // `scripts/sync-public.sh:117`, so it doesn't physically exist.
      // The orphan check is meaningful only against the live internal tree.
      return;
    }
    const missing: string[] = [];
    for (const entry of WORKFLOW_FILE_EXCLUSIONS) {
      const path = resolve(WORKFLOWS_DIR, entry);
      if (!existsSync(path)) missing.push(entry);
    }
    expect(missing, `Orphan WORKFLOW_FILE_EXCLUSIONS entries: ${missing.join(', ')}`).toEqual([]);
  });

  it('CI_ONLY_SCRIPTS entries all exist on disk AND start with # CI-ONLY:', () => {
    const missing: string[] = [];
    const missingMarker: string[] = [];
    for (const name of CI_ONLY_SCRIPTS) {
      const path = resolve(REPO_ROOT, 'scripts', name);
      if (!existsSync(path)) {
        missing.push(name);
        continue;
      }
      const first3 = firstCommentLines(path, 3);
      if (!/^#\s*CI-ONLY:/m.test(first3)) {
        missingMarker.push(name);
      }
    }
    expect(missing, `Orphan CI_ONLY_SCRIPTS entries: ${missing.join(', ')}`).toEqual([]);
    expect(
      missingMarker,
      `CI_ONLY_SCRIPTS entries missing '# CI-ONLY:' first-comment-line: ${missingMarker.join(', ')}`
    ).toEqual([]);
  });

  it('every multi-line run: block (>5 lines) in workflow YAMLs delegates to scripts/ci-*.sh', () => {
    const offenders: string[] = [];
    for (const filename of readWorkflowFiles()) {
      const path = resolve(WORKFLOWS_DIR, filename);
      const doc = parseYaml(readFileSync(path, 'utf-8')) as WorkflowDoc;
      if (!doc?.jobs) continue;
      for (const [jobName, job] of Object.entries(doc.jobs)) {
        const steps = job?.steps ?? [];
        for (let i = 0; i < steps.length; i++) {
          const run = steps[i].run;
          if (typeof run !== 'string') continue;
          const lineCount = run.split('\n').filter((l) => l.length > 0).length;
          if (lineCount <= MAX_INLINE_SHELL_LINES) continue;
          if (run.includes('bash scripts/ci-')) continue;
          offenders.push(`${filename}:${jobName}:step[${i}] (${lineCount} lines)`);
        }
      }
    }
    expect(
      offenders,
      `Workflow YAML has multi-line run: block (>${MAX_INLINE_SHELL_LINES} lines) not delegating to scripts/ci-*.sh:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('every scripts/ci-*.sh is either called from pre-push-light.sh OR has # CI-ONLY: AND is in CI_ONLY_SCRIPTS', () => {
    const offenders: string[] = [];
    const prePushLight = readPrePushLight();
    for (const name of listCiScripts()) {
      const scriptPath = resolve(REPO_ROOT, 'scripts', name);
      const calledFromPrePush = prePushLight.includes(name);
      if (calledFromPrePush) continue;
      const first3 = firstCommentLines(scriptPath, 3);
      const hasCiOnlyMarker = /^#\s*CI-ONLY:/m.test(first3);
      if (hasCiOnlyMarker && CI_ONLY_SCRIPTS.has(name)) continue;
      if (hasCiOnlyMarker && !CI_ONLY_SCRIPTS.has(name)) {
        offenders.push(
          `${name}: has '# CI-ONLY:' comment but NOT in CI_ONLY_SCRIPTS allowlist (add to CI_ONLY_SCRIPTS in ci-prepush-parity.test.ts AND scripts/massu-pattern-scanner.sh CI_ONLY_SCRIPTS_BASH — must mirror)`
        );
        continue;
      }
      offenders.push(`${name}: not referenced in pre-push-light.sh and no '# CI-ONLY:' opt-out comment`);
    }
    expect(offenders, `scripts/ci-*.sh policy violations:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('all 4 expected ci-*.sh scripts exist (filesystem invariant)', () => {
    const expected = ['ci-tarball-e2e.sh', 'ci-sync-check.sh', 'ci-fresh-install.sh', 'ci-config-drift.sh'];
    const missing = expected.filter((n) => !existsSync(resolve(REPO_ROOT, 'scripts', n)));
    expect(missing, `Missing extracted ci-*.sh scripts: ${missing.join(', ')}`).toEqual([]);
  });

  // Drift-guard mirror enforcement — the SAME bug class CR-50 closes would
  // re-open here if these mirrors silently diverge. Parses the bash arrays
  // and TS sets out of the live files and asserts byte-equivalence.
  it('CI_ONLY_SCRIPTS in vitest test mirrors CI_ONLY_SCRIPTS_BASH in massu-pattern-scanner.sh', () => {
    const scannerSrc = readFileSync(resolve(REPO_ROOT, 'scripts/massu-pattern-scanner.sh'), 'utf-8');
    const bashMatch = scannerSrc.match(/CI_ONLY_SCRIPTS_BASH="([^"]*)"/);
    expect(bashMatch, 'CI_ONLY_SCRIPTS_BASH variable not found in pattern-scanner').not.toBeNull();
    const bashSet = new Set((bashMatch![1].split(/\s+/).filter(Boolean)));
    expect(
      [...bashSet].sort(),
      'CI_ONLY_SCRIPTS (test) and CI_ONLY_SCRIPTS_BASH (pattern-scanner) diverged — keep in lockstep'
    ).toEqual([...CI_ONLY_SCRIPTS].sort());
  });

  it('WORKFLOW_FILE_EXCLUSIONS in vitest test mirrors the case-statement in massu-pattern-scanner.sh', () => {
    const scannerSrc = readFileSync(resolve(REPO_ROOT, 'scripts/massu-pattern-scanner.sh'), 'utf-8');
    // The Check 26b case-statement lists excluded workflows; format:
    //   case "$base" in
    //     ci.public.yml|apply-ruleset.yml|...|leak-guard-source-of-truth.yml)
    //       continue ;;
    const caseMatch = scannerSrc.match(/case "\$base" in\s*\n\s*(ci\.public\.yml\|[^)]+)\)/);
    expect(caseMatch, 'WORKFLOW exclusion case-statement not found in pattern-scanner Check 26b').not.toBeNull();
    const bashSet = new Set(caseMatch![1].split('|').map((s) => s.trim()).filter(Boolean));
    expect(
      [...bashSet].sort(),
      'WORKFLOW_FILE_EXCLUSIONS (test) and case-statement (pattern-scanner) diverged — keep in lockstep'
    ).toEqual([...WORKFLOW_FILE_EXCLUSIONS].sort());
  });
});
