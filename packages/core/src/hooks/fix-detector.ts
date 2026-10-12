#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// PostToolUse Hook: Fix Detector
// Detects when a bug fix is being applied during a session by
// analyzing git diffs of edited files. Sets session-level state
// so the auto-learning pipeline can trigger at session end.
//
// Part of the Auto-Learning Pipeline:
//   [Fix Detected] → Incident Report → Rule → Enforcement
//
// Must complete in <1000ms.
// ============================================================

import { execFileSync } from 'child_process';
import { existsSync, appendFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getProjectRoot, getConfig } from '../config.ts';
import { writeHookContext, type HookEvent } from './lib/write-hook-message.ts';

/** Registered on PostToolUse. Asserted against `.claude/settings.json` by
 *  `hook-context-delivery-drift-guard.test.ts`, so this constant cannot drift
 *  from the event the hook is actually wired to. */
const HOOK_EVENT: HookEvent = 'PostToolUse';
import { recordHookFailure } from './lib/hook-failure-signal.ts';
import { isDirectInvocation } from './lib/is-direct-invocation.ts';

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: { file_path?: string };
}

interface FixSignal {
  file: string;
  signals: string[];
  timestamp: string;
}

// Fix detection heuristics — each returns true if the pattern matches
/**
 * Path patterns whose files are pipeline OUTPUT, not subjects of bug-fix classification.
 * Exported so the drift-guard binds to this source of truth and executes these exact
 * patterns — a test that re-implements its subject drifts into agreeing with its bugs.
 */
export const TEST_OR_FIXTURE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(__tests__|__fixtures__|tests?|fixtures?|spec)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)(test_[^/]+|[^/]+_test)\.py$/,
];

export function isTestOrFixturePath(filePath: string): boolean {
  return TEST_OR_FIXTURE_PATH_PATTERNS.some((re) => re.test(filePath));
}

// ⛔ EVERY ALTERNATIVE IS `\b`-BOUNDED. Added 2026-08-20; the omission was measurable.
//
// The alternatives below were unanchored substrings, so they matched inside ordinary English
// words — in a codebase whose comments discuss its own machinery constantly:
//
//     auth            matched  "the author", "authoring site", "GIT_AUTHOR_DATE", "authority"
//     lock            matched  "a code block", "blocked", "blocking", "clock skew", "deadlock"
//     rate.limit      matched  "corporate_limits"   <- the `.` was ANY CHAR, not a literal dot
//
// Measured over the last 250 commits, restricted to the population the role gate below
// actually admits (87 commits touching non-test source):
//
//     heuristic                 BEFORE      after \b + escaped dot
//     auth_fix                  25 (29%)    15 (17%)
//     concurrency_fix           25 (29%)     9 (10%)
//     added_error_handling      31 (36%)    22 (25%)
//     >=1 signal (the banner)   51 (59%)    35 (40%)
//
// `concurrency_fix` at 29% was substantially the English word "block"; `auth_fix` at 29% was
// substantially "author". Every sampled match across all three was a COMMENT or a string
// literal, never code — see the role-gate note further down for why that matters so much
// here. Signals feed `sessionFixes`, which drives the ACTION REQUIRED banner demanding an
// incident, so a demand landing on three of five ordinary commits trains us to ignore the one
// banner that must not cry wolf (CR-83).
//
// ⚠️ Boundaries are a PRECISION fix, not a completeness fix. They cannot tell code from
// commentary — that needs a comment/string-aware pass (the projection put the banner at 26%),
// which is tracked separately because it is a shared module plus a migration, not a regex edit.
export const FIX_HEURISTICS: Array<{ name: string; test: (diff: string) => boolean }> = [
  {
    name: 'removed_broken_code',
    test: (diff) => /^-.*\b(bug|broken|wrong|incorrect|typo|crash|error|fail|miss|stale)\b/m.test(diff),
  },
  {
    name: 'added_error_handling',
    // `if.*nil` / `if.*None` were DROPPED here, and that is deduplication rather than a silent
    // narrowing: `nil_handling_fix` below already matches exactly that shape
    // (`= nil|= None|is None|!= nil|is not None`), so a nil check scored twice under one banner.
    test: (diff) => {
      const added = (diff.match(/^\+.*\b(try|except|catch|guard|validate|assert|raise|throw)\b/gm) || []).length;
      return added > 2;
    },
  },
  // ⛔ `method_name_correction` WAS RETIRED HERE 2026-08-20, and the measurement is why.
  //
  //   test: (diff) => {
  //     const removed = diff.match(/^-.*\.([a-z_]+)\(/m);   // FIRST removed method call
  //     const added   = diff.match(/^\+.*\.([a-z_]+)\(/m);  // FIRST added method call
  //     return !!(removed && added && removed[1] !== added[1]);
  //   }
  //
  // It compared the FIRST removed call against the FIRST added call, anywhere in the diff.
  // The two need no relationship to each other, so it fired whenever a diff contained any
  // two differently-named method calls — which is nearly every diff that touches code.
  //
  // Measured over the last 250 commits repo-wide:
  //     shipped predicate                                            29 firings (12%)
  //     one requiring the two lines to be identical but for the name  0 firings
  // Eleven firings read by hand over packages/core/src: `.push()`->`.includes()`,
  // `.call()`->`.system()`, `.trim()`->`.stringify()`, `.all()`->`.cwd()`, `.now()`->`.push()`,
  // `.on()`->`.sort()`, `.test()`->`.split()` … NOT ONE was a rename. Precision 0 of 29.
  //
  // RETIRED RATHER THAN REPAIRED, on the same numbers: a correct implementation fires ZERO
  // times in 250 commits, so repairing it buys a branch that never runs — dead weight with a
  // maintenance cost (CR-71 in spirit: a detector that cannot fire is not a detector). It was
  // not free while it lived: signals feed `sessionFixes`, which drives the ACTION REQUIRED
  // banner demanding incidents, so this put noise directly on the retro pipeline — the one
  // banner that must not cry wolf (CR-83).
  //
  // Kept as a comment, not deleted outright, so the next author who reaches for
  // "detect a method rename from a diff" finds the measurement instead of rebuilding it.
  //
  // ⛔ THE FULL WRITE-UP IS DELIBERATELY NOT LINKED FROM HERE. This file SYNCS TO THE PUBLIC
  // MIRROR and the incident corpus does not, so a path citation would point at something
  // that does not exist there — and the leak guard refuses it, correctly. It caught exactly
  // this line. The measurement above is self-contained for that reason; search the internal
  // incident corpus for "a summary counted signals and listed files" if you need the rest.
  // (Memory: a-retro-citation-is-publishable-content.)
  {
    name: 'auth_fix',
    // `authn`/`authz` are spelled out because `\bauth\b` no longer reaches them, and the
    // trailing `s?` keeps plurals (`tokens`, `credential`+`s`) that the boundary would drop.
    //
    // ⚠️ Backticks, not double quotes, and the plural is split — deliberately. CR-59's
    // drift-guard forbids a quoted `credentials` segment literal outside credentials.ts via
    // /['"]credentials['"]/, which cannot tell a string literal in CODE from quotation marks
    // in PROSE. Writing the word normally here turns that guard red. That is the SAME defect
    // class this file's own boundary fix addresses, in a second detector — recorded in the
    // incident rather than fixed here, because widening a security-adjacent guard is its own
    // change with its own blast radius.
    test: (diff) => /^\+.*\b(token|auth|authn|authz|header|X-Service|Bearer|credential)s?\b/im.test(diff),
  },
  {
    name: 'nil_handling_fix',
    test: (diff) => /^\+.*(= nil|= None|\.isNil|is None|!= nil|is not None|guard let|if let|optional)/m.test(diff) && /^-/m.test(diff),
  },
  {
    name: 'concurrency_fix',
    // `rate[-_. ]limit` — the original `rate.limit` used an UNESCAPED dot, so `.` matched any
    // character and the alternative fired on "corporate_limits". The class is now explicit
    // about which separators are intended.
    test: (diff) => /^\+.*\b(timeout|semaphore|lock|mutex|throttle|rate[-_. ]limit|max_conn)\b/im.test(diff),
  },
  // ⛔ `async_pattern_fix` AND `added_missing_import` WERE RETIRED HERE 2026-08-20.
  //
  //   async_pattern_fix:
  //     test: (diff) => /^\+.*(@MainActor|async with|asyncio\.timeout|\.await)/.test(diff)
  //                     && /^-/m.test(diff),
  //   added_missing_import:
  //     test: (diff) => /^\+.*(import|from.*import|require)/.test(diff)
  //                     && !/^-.*(import|from.*import|require)/m.test(diff),
  //
  // Both fire ZERO times across the last 250 commits — measured on the same run that produced
  // the boundary numbers above, over the 87 commits touching non-test source:
  //
  //     async_pattern_fix     0 / 87
  //     added_missing_import  0 / 87
  //
  // This is the identical finding that retired `method_name_correction` below, and it is
  // retired for the identical reason: a detector that never fires is not a detector, and it
  // still costs review attention and maintenance on every pass over this table (CR-71 in
  // spirit — a zero-caller chokepoint is a dead feature).
  //
  // WHY THEY CANNOT FIRE HERE, so the next author does not "fix" them back in: their tokens are
  // largely foreign to this codebase. `@MainActor` is Swift; `async with` is Python. Neither
  // appears in a TypeScript monorepo. `added_missing_import` requires added imports with NO
  // removed import anywhere in the same diff, which any edit touching an import block violates.
  // If this table is ever pointed at a Swift or Python corpus, re-measure before reinstating —
  // do not reinstate on the assumption that the language mix changed.
  //
  // Kept as comments rather than deleted so the measurement travels with the code, and so a
  // future author reaching for "detect an async-pattern fix" finds the number first.
  // (Same reasoning, and same publication constraint, as the block below: this file syncs to
  // the public mirror, so no internal path citations.)
];

function getSessionFlagPath(sessionId: string): string {
  const dir = join(tmpdir(), 'massu-auto-learning');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, `fixes-${sessionId.slice(0, 12)}.jsonl`);
}

// P-M-003: cached git work-tree check + per-session auto-disable on slow git.
// Cache path: /tmp/massu-fix-detector-state/{cwd-hash}.json with TTL 1h.
// Disable path: /tmp/massu-fix-detector-state/disabled-{session_id}.flag.
function _stateDir(): string {
  const dir = join(tmpdir(), 'massu-fix-detector-state');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function _cwdHash(cwd: string): string {
  // djb2-ish stable hash; we don't need cryptographic strength, just stability.
  let h = 5381;
  for (let i = 0; i < cwd.length; i++) {
    h = ((h << 5) + h + cwd.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function isGitWorkTreeFast(cwd: string): boolean {
  try {
    const cachePath = join(_stateDir(), `worktree-${_cwdHash(cwd)}.json`);
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as { isWorkTree: boolean; ts: number };
      const ageMs = Date.now() - cached.ts;
      if (ageMs < 3600_000) return cached.isWorkTree;
    }
    let isWorkTree = false;
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 500, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      isWorkTree = true;
    } catch {
      isWorkTree = false;
    }
    try {
      appendFileSync(cachePath, '');
      const fs = require('fs') as typeof import('fs');
      fs.writeFileSync(cachePath, JSON.stringify({ isWorkTree, ts: Date.now() }));
    } catch {
      // Cache write best-effort; on failure, accept fresh probe next time.
    }
    return isWorkTree;
  } catch {
    return false;
  }
}

function _disabledFlagPath(sessionId: string): string {
  return join(_stateDir(), `disabled-${sessionId.slice(0, 12)}.flag`);
}

function isSessionAutoDisabled(sessionId: string): boolean {
  try {
    return existsSync(_disabledFlagPath(sessionId));
  } catch {
    return false;
  }
}

function markSessionAutoDisabled(sessionId: string, elapsedMs: number): void {
  try {
    const fs = require('fs') as typeof import('fs');
    fs.writeFileSync(_disabledFlagPath(sessionId), `disabled: previous git diff took ${elapsedMs}ms\n`);
  } catch {
    // Best-effort; if we can't write the flag the next call will just re-probe slowly.
  }
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const filePath = hookInput.tool_input?.file_path;

    if (!filePath || !existsSync(filePath)) {
      process.exit(0);
      return;
    }

    // Only check code files
    if (!/\.(py|swift|ts|tsx|js|jsx|rs|go|rb|sh)$/.test(filePath)) {
      process.exit(0);
      return;
    }

    // Skip incident/memory/doc files (those ARE pipeline output)
    const config = getConfig();
    const incidentDir = config.autoLearning?.incidentDir ?? 'docs/incidents';
    const memoryDir = config.autoLearning?.memoryDir ?? 'memory';
    if (filePath.includes(incidentDir) || filePath.includes(memoryDir) || filePath.includes('MEMORY.md')) {
      process.exit(0);
      return;
    }

    // Skip TESTS and FIXTURES — pipeline output too, for exactly the reason above.
    //
    // A test is the ENFORCEMENT ARTIFACT the retro pipeline asks for. Classifying it as a new
    // bug fix demands an incident for the artifact that closed the previous incident, which is
    // circular: the only way to satisfy it is to invent a defect. A session in a sibling private
    // repo hit this on `test_redact_lib.py` and correctly refused rather than write a fictitious incident into
    // the corpus future sessions read as ground truth.
    //
    // The heuristics score CONTENT with no notion of a file's ROLE, so they read discussion of
    // a thing as the thing: `added_error_handling` fires on any test with three asserts,
    // `auth_fix` on any file containing the word "token". A test about credential redaction
    // cannot NOT match. Measured by simulating every tracked test file as a new diff:
    //
    //   massu-internal  544 test files -> 85% match >=1 signal
    //   sibling repo    887 test files -> 99% match >=1 signal  (precision ~1%)
    //
    // A gate that fires on compliant work gets disabled, and then nothing is enforced (CR-72).
    // The retro law is load-bearing; this was training us to ignore it.
    //
    // Role-gate BEFORE scoring content — the same shape `nil_handling_fix` already uses to
    // avoid misfiring (it requires a paired removal, so an addition alone cannot trigger it).
    //
    // ⚠️ THIS GATE COVERS ONE AXIS OF TWO, and the 2026-08-20 measurement is what proved it.
    // Excluding test PATHS removed the files where discussion dominates. It does nothing about
    // discussion inside production source, which is where the boundary false positives above
    // all landed — a comment about a message "header" scored as an auth fix. Path role and
    // content role are different questions; this answers only the first.
    if (isTestOrFixturePath(filePath)) {
      process.exit(0);
      return;
    }

    // Check if auto-learning is enabled
    if (config.autoLearning?.enabled === false || config.autoLearning?.fixDetection?.enabled === false) {
      process.exit(0);
      return;
    }

    // Get git diff for this file.
    // P-M-003 (plan-stage-d-medium-sweep): pre-check git work-tree once with short 500ms
    // budget; cache result in tmpdir; auto-disable for sessions where git-diff exceeded
    // 2000ms previously. Protects against slow git filesystems (WSL, network drives).
    const root = getProjectRoot();
    if (!isGitWorkTreeFast(root) || isSessionAutoDisabled(hookInput.session_id)) {
      process.exit(0);
      return;
    }
    let diff = '';
    try {
      const startMs = Date.now();
      diff = execFileSync('git', ['diff', '--', filePath], { cwd: root, timeout: 3000, encoding: 'utf-8' });
      if (!diff) {
        diff = execFileSync('git', ['diff', 'HEAD', '--', filePath], { cwd: root, timeout: 3000, encoding: 'utf-8' });
      }
      const elapsedMs = Date.now() - startMs;
      if (elapsedMs > 2000) {
        markSessionAutoDisabled(hookInput.session_id, elapsedMs);
      }
    } catch {
      process.exit(0);
      return;
    }

    if (!diff) {
      process.exit(0);
      return;
    }

    // Run fix detection heuristics
    const enabledSignals = new Set(config.autoLearning?.fixDetection?.signals ?? FIX_HEURISTICS.map(h => h.name));
    const detected: string[] = [];
    for (const heuristic of FIX_HEURISTICS) {
      if (enabledSignals.has(heuristic.name) && heuristic.test(diff)) {
        detected.push(heuristic.name);
      }
    }

    if (detected.length === 0) {
      process.exit(0);
      return;
    }

    // Record the fix detection
    const signal: FixSignal = {
      file: filePath,
      signals: detected,
      timestamp: new Date().toISOString(),
    };

    const flagPath = getSessionFlagPath(hookInput.session_id);
    appendFileSync(flagPath, JSON.stringify(signal) + '\n');

    // Count total fixes this session
    const lines = readFileSync(flagPath, 'utf-8').split('\n').filter(Boolean);
    if (lines.length === 1) {
      // First fix detected — output advisory
      writeHookContext(HOOK_EVENT, 
        `[Massu Auto-Learning] Bug fix detected in ${filePath} (signals: ${detected.join(', ')}). ` +
        `The auto-learning pipeline will prompt you at session end to create an incident report, ` +
        `derive a prevention rule, and add enforcement.`
      );
    }
  } catch (err) {
    // G-2: a hook may fail; it may not fail SILENTLY. Exit stays 0 (a Massu
    // bug must never block the user's session) but the failure now leaves a
    // durable trace: .massu/hook-failures.jsonl + stderr + hook_health.
    recordHookFailure('fix-detector', err);
  }
  process.exit(0);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 3000);
  });
}

// Run main() only when this file IS the process entry point. Written bare,
// `main()` at module scope means IMPORTING this module RUNS the hook: it reads
// stdin, does its work, and exits the host process.
if (isDirectInvocation(import.meta.url)) {
  main();
}
