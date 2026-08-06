// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-B-004 (plan-loop-multi-perspective-enforcement): unit test for the L2
 * completion-gate script `scripts/massu-loop-completion-gate.sh`.
 *
 * Covers:
 *   GATE-01 — PASS when ≥1 NEW-naming evidence file with matching plan_token
 *             exists and (no loop-start record → 24h fallback admits it).
 *   GATE-02 — FAIL (exit 1) when zero evidence files at all.
 *   GATE-03 — FAIL (exit 3) when NEW-naming files exist but plan_token in body
 *             mismatches.
 *   GATE-04 — FAIL (exit 2) on missing or invalid plan-token argument.
 *   GATE-05 — BYPASS via MASSU_SKIP_COMPLETION_GATE=1 exits 0 with stderr WARN.
 *   GATE-06 — LEGACY filename `*-security.json` accepted via filename+mtime
 *             when mtime ≥ loop_start.
 *
 * Each test isolates state by writing fixtures into a temp .massu/agent-results
 * directory inside a tmpdir and runs the gate with cwd-override.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
// G29/CR-92 — `cwd:` does not scope git; GIT_DIR outranks it. See the helper for why.
import { gitSafeEnv } from './helpers/git-safe-env.ts';

const REPO_ROOT = resolve(__dirname, '../../../..');
const GATE_SCRIPT_REAL = resolve(REPO_ROOT, 'scripts/massu-loop-completion-gate.sh');
const LIB_PLAN_TOKEN_REGEX = resolve(REPO_ROOT, 'scripts/lib/plan-token-regex.sh');
const LIB_HELPERS = resolve(REPO_ROOT, 'scripts/lib/loop-completion-helpers.sh');

const PLAN_TOKEN = 'plan-loop-multi-perspective-enforcement';

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the gate script with a sandbox repo root. We don't have a `--repo-root`
 * flag, so we copy the gate + libs into the sandbox so internal git-toplevel
 * lookups resolve to the sandbox. Sandbox is initialised as a minimal git repo.
 */
function setupSandbox(): string {
  const sandbox = mkdtempSync(join(tmpdir(), 'massu-gate-test-'));
  mkdirSync(join(sandbox, '.massu', 'agent-results'), { recursive: true });
  mkdirSync(join(sandbox, '.claude', 'loop-state'), { recursive: true });
  mkdirSync(join(sandbox, 'scripts', 'lib'), { recursive: true });

  // Copy the actual gate + libs into the sandbox (drift-free).
  writeFileSync(
    join(sandbox, 'scripts', 'massu-loop-completion-gate.sh'),
    readFileSync(GATE_SCRIPT_REAL, 'utf-8'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(sandbox, 'scripts', 'lib', 'plan-token-regex.sh'),
    readFileSync(LIB_PLAN_TOKEN_REGEX, 'utf-8'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(sandbox, 'scripts', 'lib', 'loop-completion-helpers.sh'),
    readFileSync(LIB_HELPERS, 'utf-8'),
    { mode: 0o755 },
  );

  // Initialise as a minimal git repo so `git rev-parse --show-toplevel` resolves
  // to the sandbox (not the real repo).
  //
  // G29/CR-92 — `cwd:` alone does NOT achieve that. GIT_DIR outranks it, and it is
  // inherited from any CALLER that sets it (git does NOT hand GIT_DIR to hooks —
  // measured, scripts/ops/probe-git-hook-env.sh). Under a leaked GIT_DIR this
  // `git init` re-inits the REAL repo and the gate's `--show-toplevel` resolves there
  // too: the sandbox is written to the wrong tree AND adjudicated against the wrong
  // tree. Incident #166.
  spawnSync('git', ['init', '-q'], { cwd: sandbox, env: gitSafeEnv() });

  return sandbox;
}

function runGate(sandbox: string, args: string[], env: Record<string, string> = {}): RunResult {
  const r = spawnSync(
    'bash',
    [join(sandbox, 'scripts', 'massu-loop-completion-gate.sh'), ...args],
    {
      cwd: sandbox,
      // The gate script itself runs git; a leaked GIT_DIR points it at the real repo.
      env: gitSafeEnv(env),
      encoding: 'utf-8',
    },
  );
  return {
    status: r.status ?? -1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

function writeNewEvidence(sandbox: string, planToken: string, reviewerType: string, body: Record<string, unknown> = {}): string {
  // Pattern review LOW-3 fix: use a properly-hyphenated ISO-8601 suffix.
  // Filename uniqueness is guaranteed within a single test run by the unique
  // (plan_token, reviewer_type) tuple — no need for sub-second resolution.
  const iso = isoFilenameSuffix();
  const fname = `${planToken}-post-impl-${reviewerType}-${iso}.json`;
  const fpath = join(sandbox, '.massu', 'agent-results', fname);
  const fullBody = {
    plan_token: planToken,
    reviewer_type: reviewerType,
    timestamp: new Date().toISOString(),
    gaps_discovered: 0,
    gaps_fixed: 0,
    findings: [],
    ...body,
  };
  writeFileSync(fpath, JSON.stringify(fullBody, null, 2));
  return fpath;
}

function writeLegacyEvidence(sandbox: string, reviewerType: string, mtimeOverrideEpochSec?: number): string {
  const ts = Math.floor(Date.now() / 1000);
  const fname = `${ts}-${reviewerType}.json`;
  const fpath = join(sandbox, '.massu', 'agent-results', fname);
  // Legacy bodies historically don't carry plan_token — mimic that.
  writeFileSync(
    fpath,
    JSON.stringify({
      iteration: 1,
      gaps_discovered: 0,
      gaps_fixed: 0,
      findings: [],
    }, null, 2),
  );
  if (typeof mtimeOverrideEpochSec === 'number') {
    utimesSync(fpath, mtimeOverrideEpochSec, mtimeOverrideEpochSec);
  }
  return fpath;
}

function isoFilenameSuffix(): string {
  // ISO-8601 UTC with hyphens (URL/filename safe). Example: 2026-05-19T05-12-36Z.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}Z`;
}

describe('P-B-004 massu-loop-completion-gate.sh (CR-52)', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = setupSandbox();
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('GATE-01: PASS when ≥1 NEW-naming evidence file with matching plan_token exists', () => {
    writeNewEvidence(sandbox, PLAN_TOKEN, 'security');
    const r = runGate(sandbox, [PLAN_TOKEN]);
    expect(r.status, `stdout=${r.stdout}\nstderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/PASS:.*valid evidence file/);
  });

  it('GATE-02: FAIL (exit 1) when zero evidence files exist', () => {
    const r = runGate(sandbox, [PLAN_TOKEN]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL: zero evidence files/);
  });

  it('GATE-03: FAIL (exit 3) when NEW-naming files exist but plan_token in body mismatches', () => {
    writeNewEvidence(sandbox, PLAN_TOKEN, 'security', { plan_token: 'plan-different-token' });
    const r = runGate(sandbox, [PLAN_TOKEN]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/FAIL: candidate evidence files exist/);
  });

  it('GATE-04: FAIL (exit 2) on missing or invalid plan-token argument', () => {
    const r1 = runGate(sandbox, []);
    expect(r1.status).toBe(2);
    expect(r1.stderr).toMatch(/missing <plan-token>/);

    const r2 = runGate(sandbox, ['INVALID/Token!']);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toMatch(/does not match/);
  });

  it('GATE-05: BYPASS via MASSU_SKIP_COMPLETION_GATE=1 exits 0 with stderr WARN', () => {
    // No evidence written — would normally FAIL.
    const r = runGate(sandbox, [PLAN_TOKEN], { MASSU_SKIP_COMPLETION_GATE: '1' });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARN: completion-gate bypassed by env override/);
  });

  it('GATE-06: LEGACY filename *-security.json accepted when MASSU_ACCEPT_LEGACY_EVIDENCE=1 + mtime ≥ loop_start + parseable body', () => {
    // Set loop-start to far past so the legacy file (current mtime) passes the filter.
    const farPastIso = '2020-01-01T00:00:00Z';
    writeFileSync(
      join(sandbox, '.claude', 'loop-state', `loop-start-${PLAN_TOKEN}.json`),
      JSON.stringify({ plan_token: PLAN_TOKEN, started_at_iso: farPastIso }),
    );

    writeLegacyEvidence(sandbox, 'security');
    // Legacy acceptance is OFF by default (Phase 1.5 architecture review fix).
    const rOff = runGate(sandbox, [PLAN_TOKEN]);
    expect(rOff.status, 'default: legacy OFF, gate should FAIL').toBe(1);

    // With opt-in env var, the file is accepted.
    const rOn = runGate(sandbox, [PLAN_TOKEN], { MASSU_ACCEPT_LEGACY_EVIDENCE: '1' });
    expect(rOn.status, `stdout=${rOn.stdout}\nstderr=${rOn.stderr}`).toBe(0);
    expect(rOn.stderr).toMatch(/accepting legacy-named evidence file/);
    expect(rOn.stdout).toMatch(/PASS:.*valid evidence file/);
  });

  it('GATE-07: strict plan-token check rejects newline-embedded input', () => {
    // Phase 1.5 security review HIGH-3 fix: newlines in the token must be rejected
    // by the strict check (the bare grep -qE "^...$" line-anchor was bypassable).
    const r = runGate(sandbox, ['plan-foo\nplan-bar']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/whitespace or control char|does not match/);
  });

  it('GATE-08: bypass writes durable audit-trail log file', () => {
    // Phase 1.5 security review MED-4 fix: bypass must persist to a log file.
    const auditLog = join(sandbox, '.claude', 'loop-state', 'bypass-audit.log');
    const r = runGate(sandbox, [PLAN_TOKEN], { MASSU_SKIP_COMPLETION_GATE: '1' });
    expect(r.status).toBe(0);
    const logContents = readFileSync(auditLog, 'utf-8');
    expect(logContents).toMatch(/WARN: completion-gate bypassed by env override/);
    expect(logContents).toMatch(new RegExp(`plan-token=${PLAN_TOKEN.replace(/-/g, '\\-')}`));
    expect(logContents).toMatch(/ts=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  });

  it('GATE-09: degenerate plan-token like `plan-.` is rejected by tightened regex', () => {
    // Phase 1.5 security review LOW-5 fix: `plan-.`, `plan-..` must be rejected.
    for (const bad of ['plan-.', 'plan-..', 'plan-...', 'plan-foo.', 'plan-.foo']) {
      const r = runGate(sandbox, [bad]);
      expect(r.status, `expected exit 2 for '${bad}'`).toBe(2);
    }
  });

  it('GATE-10: NEW-naming file with malformed JSON body is rejected (not silently accepted)', () => {
    // Phase 1.5 security review HIGH-1 + HIGH-2 fix: only jq-parseable JSON
    // counts as valid evidence. A file with `not valid json` containing a
    // `"plan_token"` substring used to pass under the sed fallback.
    const iso = isoFilenameSuffix();
    const fname = `${PLAN_TOKEN}-post-impl-security-${iso}.json`;
    const fpath = join(sandbox, '.massu', 'agent-results', fname);
    writeFileSync(
      fpath,
      `not valid json at all\n"plan_token":"${PLAN_TOKEN}"\n"reviewer_type":"security"\n`,
    );
    const r = runGate(sandbox, [PLAN_TOKEN]);
    expect(r.status, 'malformed JSON should NOT count as evidence').toBe(1);
    expect(r.stderr).toMatch(/malformed-JSON candidate file/);
  });
});
