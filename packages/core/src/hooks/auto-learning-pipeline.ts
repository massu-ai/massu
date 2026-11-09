#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// Stop Hook: Auto-Learning Pipeline Enforcer
// At session end, checks if bug fixes were applied without
// completing the full incident → rule → enforcement pipeline.
// Outputs mandatory instructions for Claude to follow.
//
// Part of the Auto-Learning Pipeline:
//   Fix Detected → [SESSION END CHECK] → Pipeline Instructions
//
// This is the FORCING FUNCTION that ensures no fix goes
// undocumented. Claude cannot end the session without completing
// the pipeline steps.
// ============================================================

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getProjectRoot, getConfig } from '../config.ts';
import { writeHookContext, type HookEvent } from './lib/write-hook-message.ts';

/** Registered on Stop. Asserted against `.claude/settings.json` by
 *  `hook-context-delivery-drift-guard.test.ts`, so this constant cannot drift
 *  from the event the hook is actually wired to. */
const HOOK_EVENT: HookEvent = 'Stop';
import { recordHookFailure } from './lib/hook-failure-signal.ts';
import { isDirectInvocation } from './lib/is-direct-invocation.ts';
import { sessionTouchedFiles } from './lib/session-touched-files.ts';
import { gitSafeEnv } from './lib/git-safe-env.ts';

// P-H002 (plan-stage-c-high-batch): bound git-diff reads so monorepos with
// 10MB+ working trees don't trigger Stop-hook timeout. Short-stat first,
// only read full diff body when estimated bytes <= cap. execFileSync argv
// form is defense-in-depth (P-001 pattern).
// Exported so the DG-2 drift-guard binds to THIS value rather than restating
// it — a second copy of a cap is a cap that drifts.
export const MAX_FULL_DIFF_BYTES = 2 * 1024 * 1024; // 2MB; ~25k lines at 80 bytes/line

/**
 * Documentation is not a code fix. Applied as git PATHSPEC MAGIC (not a filtered file
 * list) so a tree with thousands of changed files cannot blow the argv limit.
 *
 * Exported so the drift-guard binds to THIS value rather than restating it.
 */
export const DOC_EXCLUDE_PATHSPEC = [
  ':(exclude)*.md',
  ':(exclude)*.markdown',
  ':(exclude)*.mdx',
  ':(exclude)*.rst',
  ':(exclude)*.adoc',
  ':(exclude)*.txt',
  ':(exclude)docs/**',
  // massu's OWN runtime artifacts: agent-result JSONL, workflow logs, rule candidates.
  // Audit findings quote source lines verbatim, so leaving these in scope re-creates the
  // prose-as-code false positive with the hook's own output as the input.
  ':(exclude).massu/**',
] as const;

/**
 * The whole tree, minus documentation.
 *
 * Kept as its own export because the drift-guard binds to THIS value. It is now derived
 * from {@link DOC_EXCLUDE_PATHSPEC} rather than restating the exclusions, so the two
 * cannot drift — the session-scoped form below reuses the same exclusion list with a
 * different positive pathspec.
 */
export const CODE_ONLY_PATHSPEC = ['--', '.', ...DOC_EXCLUDE_PATHSPEC] as const;

/**
 * Above this many session-touched files, fall back to the whole-tree pathspec rather than
 * naming each file in argv. Measured shape, not a guess: a session touches tens of files,
 * and `git diff -- <500 paths>` is still far below any argv ceiling; the cap exists so an
 * anomalous session cannot construct an unbounded command line.
 */
export const MAX_SESSION_PATHSPEC_FILES = 500;

/**
 * A fix-shaped ADDED line. WORD-BOUNDARIED on purpose: the unbounded form matched `try`
 * inside `retry`/`entry`/`country` and `throw` inside "the throw", so ordinary English
 * scored as code. Measured 2026-08-11 on a documentation-only diff: 8 matches, 0 code files.
 */
export const FIX_PATTERN_RE =
  /^\+.*(?:\b(?:try|except|catch|guard|throw|raise|assert|validate)\b|\bif\b.*\b(?:null|nil|None|undefined)\b)/gm;

/** A REMOVED line that reads like broken code. Word-boundaried for the same reason. */
export const REMOVED_BROKEN_RE =
  /^-.*\b(?:bug|broken|crash|wrong|incorrect|typo|fail|error|miss|stale)\b/gm;

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
}

interface FixSignal {
  file: string;
  signals: string[];
  timestamp: string;
}

function getSessionFlagPath(sessionId: string): string {
  return join(tmpdir(), 'massu-auto-learning', `fixes-${sessionId.slice(0, 12)}.jsonl`);
}

/** How recently an incident must have been written to count as "this session's work". */
export const RECENT_INCIDENT_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Incident files under `dir` modified within {@link RECENT_INCIDENT_WINDOW_MS}.
 *
 * Returns `[]` when the directory is missing or unreadable — deliberately, and this is the
 * one place a blind-gate reading is CORRECT: an empty result makes the notice MORE
 * insistent (it prints the full instructions), never less. Failing "closed" here means
 * nagging, which is the safe direction for a reminder.
 */
export function recentIncidentFiles(dir: string, nowMs: number = Date.now()): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => {
        try {
          return nowMs - statSync(join(dir, f)).mtimeMs <= RECENT_INCIDENT_WINDOW_MS;
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** Injectable so the scan can be attacked without a real repository. */
export type GitRunner = (args: readonly string[], timeoutMs: number, maxBuffer: number) => string;

export interface UncommittedScanResult {
  uncommittedFix: boolean;
  /** Why the verdict is what it is — so a `false` is never an unexplained silence. */
  reason: 'no-changes' | 'not-this-session' | 'unattributable' | 'over-cap' | 'no-signal' | 'fix-detected' | 'git-unavailable';
  /** Files actually scanned. The DENOMINATOR: a 0 here with a `false` verdict is a skip, not a clean bill. */
  filesScanned: number;
}

/**
 * Decide whether THIS session left an uncommitted fix in the tree.
 *
 * Three properties, each of which was previously absent:
 *
 * 1. **Every git invocation is documentation-scoped.** The name-only and shortstat calls
 *    were filtered and the body read was not, so the exclusion only held for a docs-ONLY
 *    tree: change one code file anywhere and the unfiltered body pulled the prose back in.
 * 2. **The diff is scoped to files THIS session touched.** A shared working tree says
 *    nothing about who edited it.
 * 3. **Unattributable is SILENT, never a demand.** If the actor cannot be established, the
 *    reminder has no legal way to be discharged by the session it would block, and a demand
 *    that cannot be met is one people route around — after which nothing is enforced. The
 *    per-edit detector still covers the ordinary case through `sessionFixes`.
 */
export function scanUncommittedForFix(opts: {
  root: string;
  sessionTouched: ReadonlySet<string> | null;
  git?: GitRunner;
}): UncommittedScanResult {
  const git = opts.git ?? ((args, t, m) =>
    execFileSync('git', [...args], {
      cwd: opts.root,
      // `cwd` does NOT scope git: GIT_DIR in the environment outranks it, and a leaked one
      // would make this read a different repository while looking correct. This hook runs
      // at Stop and is never reachable from a git hook, so nothing here depends on the
      // index a commit-time hook is handed — the variables are removed rather than asserted.
      env: gitSafeEnv(),
      timeout: t,
      encoding: 'utf-8',
      maxBuffer: m,
    }));

  // Property 3: no actor, no demand.
  if (opts.sessionTouched === null) {
    return { uncommittedFix: false, reason: 'unattributable', filesScanned: 0 };
  }
  if (opts.sessionTouched.size === 0) {
    return { uncommittedFix: false, reason: 'not-this-session', filesScanned: 0 };
  }

  try {
    const nameOnly = git(['diff', '--name-only', ...CODE_ONLY_PATHSPEC], 3000, 1024 * 1024);
    const changed = nameOnly.split('\n').map(s => s.trim()).filter(Boolean);
    if (changed.length === 0) {
      return { uncommittedFix: false, reason: 'no-changes', filesScanned: 0 };
    }

    // Property 2: intersect with the actor's own files.
    const mine = changed.filter(f => opts.sessionTouched!.has(f));
    if (mine.length === 0) {
      return { uncommittedFix: false, reason: 'not-this-session', filesScanned: 0 };
    }

    // Property 1 + 2: the body read carries BOTH the doc exclusion and the session scope.
    const scoped = mine.length <= MAX_SESSION_PATHSPEC_FILES
      ? ['--', ...mine, ...DOC_EXCLUDE_PATHSPEC]
      : [...CODE_ONLY_PATHSPEC];

    const shortstat = git(['diff', '--shortstat', ...scoped], 2000, 64 * 1024);
    const insertions = parseInt(shortstat.match(/(\d+) insertion/)?.[1] ?? '0', 10);
    const deletions = parseInt(shortstat.match(/(\d+) deletion/)?.[1] ?? '0', 10);
    if ((insertions + deletions) * 80 > MAX_FULL_DIFF_BYTES) {
      // Skip the body rather than risk a Stop-hook timeout. Reported, not silent.
      return { uncommittedFix: false, reason: 'over-cap', filesScanned: mine.length };
    }

    const fullDiff = git(['diff', ...scoped], 5000, MAX_FULL_DIFF_BYTES);
    const fixPatterns = (fullDiff.match(FIX_PATTERN_RE) || []).length;
    const removedBroken = (fullDiff.match(REMOVED_BROKEN_RE) || []).length;
    const hit = fixPatterns > 3 || removedBroken > 1;
    return {
      uncommittedFix: hit,
      reason: hit ? 'fix-detected' : 'no-signal',
      filesScanned: mine.length,
    };
  } catch {
    return { uncommittedFix: false, reason: 'git-unavailable', filesScanned: 0 };
  }
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const config = getConfig();

    // Check if auto-learning is enabled.
    //
    // `fixDetection.enabled` is read HERE as well as in the per-edit detector. It was
    // declared in the schema and consulted only by the detector, so switching it off
    // silenced the per-edit half while this hook's whole-tree scan kept firing — a knob
    // that reads as a control over fix detection but governed only part of it. Both
    // branches below now answer to it, at the point of use.
    if (
      config.autoLearning?.enabled === false ||
      config.autoLearning?.fixDetection?.enabled === false
    ) {
      process.exit(0);
      return;
    }

    const root = getProjectRoot();
    const incidentDir = config.autoLearning?.incidentDir ?? 'docs/incidents';
    const memoryDir = config.autoLearning?.memoryDir ?? 'memory';
    const autoLearn = config.autoLearning;

    // Source 1: Session fix flags from fix-detector
    const flagPath = getSessionFlagPath(hookInput.session_id);
    let sessionFixes: FixSignal[] = [];
    if (existsSync(flagPath)) {
      try {
        sessionFixes = readFileSync(flagPath, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as FixSignal);
      } catch { /* ignore parse errors */ }
    }

    // Source 2: Scan uncommitted git diff for fix patterns (language-agnostic).
    // Two-stage: (1) name-only to confirm any changes, (2) shortstat to estimate
    // bytes, (3) full diff body ONLY if estimate <= MAX_FULL_DIFF_BYTES.
    //
    // PROSE IS NOT CODE (2026-08-11). Documentation is excluded via git pathspec magic
    // rather than by filtering a file list, so there is no argv-length ceiling. Measured
    // before this exclusion existed: a documentation-only session scored `fixPatterns = 8`
    // and re-fired this whole notice on every Stop — every match was English in a `.md`
    // plan ("No spool, no re[try]", "never on a re[try]"), because the keyword list was
    // matched as SUBSTRINGS. `try` lives inside `retry`/`entry`/`country`; `throw` inside
    // "the throw". The regexes below are word-boundaried for exactly that reason.
    // Recorded 2026-08-11 as occurrence #2 of the read-prose-as-code class; the internal
    // incident write-up and the `a-scanner-that-reads-prose-as-code` memory carry the detail.
    // Deliberately no internal doc PATH here: this file syncs to the PUBLIC repo, where an
    // internal incident-doc citation both leaks a filename and resolves to nothing.
    const uncommittedFix = scanUncommittedForFix({
      root,
      sessionTouched: sessionTouchedFiles({
        root,
        transcriptPath: hookInput.transcript_path,
        flagPath,
      }),
    }).uncommittedFix;

    if (sessionFixes.length === 0 && !uncommittedFix) {
      // Clean up flag file
      cleanup(flagPath);
      process.exit(0);
      return;
    }

    // Build pipeline instructions
    const lines: string[] = [];
    lines.push('');
    lines.push('============================================================================');
    lines.push(' MASSU AUTO-LEARNING PIPELINE — ACTION REQUIRED BEFORE SESSION END');
    lines.push('============================================================================');

    if (sessionFixes.length > 0) {
      lines.push('');
      lines.push(`  ${sessionFixes.length} bug fix(es) detected during this session:`);
      lines.push('');
      // Deduplicate by file
      const byFile = new Map<string, string[]>();
      for (const fix of sessionFixes) {
        const existing = byFile.get(fix.file) ?? [];
        existing.push(...fix.signals);
        byFile.set(fix.file, [...new Set(existing)]);
      }
      for (const [file, signals] of byFile) {
        lines.push(`    - ${file} (${signals.join(', ')})`);
      }
    }

    if (uncommittedFix) {
      lines.push('');
      lines.push('  Additional uncommitted fix patterns detected in git diff.');
    }

    // A NOTICE MUST ACKNOWLEDGE THE ARTIFACT IT DEMANDS (2026-08-11). Previously this
    // asked for an incident report and then judged only `git diff` — which shows TRACKED
    // changes, so a freshly written (untracked) incident was invisible to it. Writing the
    // requested artifact therefore could not change the verdict, and the identical wall of
    // instructions re-fired on every Stop. A notice that repeats after compliance is one
    // people learn to ignore (CR-72: a brick gets disabled).
    //
    // Attribution caveat, stated rather than hidden (G15): mtime says something HAPPENED,
    // not that THIS session did it. That is acceptable for a REMINDER — the failure mode of
    // a false acknowledgement is one un-nagged session, versus permanent nagging that
    // trains the reader to skip it. The discharging file is NAMED so the judgement is
    // auditable instead of silent.
    const todaysIncidents = recentIncidentFiles(join(root, incidentDir));
    lines.push('');
    if (todaysIncidents.length > 0) {
      lines.push('  ALREADY SATISFIED TODAY (verify these cover the fixes above):');
      for (const f of todaysIncidents.slice(0, 5)) lines.push(`    - ${incidentDir}/${f}`);
      lines.push('');
      lines.push('  If they do, nothing further is required. Otherwise:');
    } else {
      lines.push('  Complete these steps before this session ends:');
    }
    lines.push('');

    if (autoLearn?.pipeline?.requireIncidentReport !== false && todaysIncidents.length === 0) {
      lines.push('  STEP 1: INCIDENT REPORT');
      lines.push(`    For each distinct bug fixed, create: ${incidentDir}/YYYY-MM-DD-<slug>.md`);
      lines.push('    Include: Date, Severity, Symptoms, Root Cause, Fix, Files Changed, Prevention Rules');
      lines.push('');
    }

    if (autoLearn?.pipeline?.requirePreventionRule !== false) {
      lines.push('  STEP 2: PREVENTION RULE');
      lines.push(`    For each incident, create: ${memoryDir}/feedback_<rule_name>.md`);
      lines.push('    Include frontmatter (name, description, type: feedback) + Why + How to apply');
      lines.push(`    Update ${config.autoLearning?.memoryIndexFile ?? 'MEMORY.md'} index`);
      lines.push('');
    }

    if (autoLearn?.pipeline?.requireEnforcement !== false) {
      lines.push('  STEP 3: ENFORCEMENT PLACEMENT');
      lines.push('    For each new rule, determine enforcement layer(s):');
      lines.push('    a) If statically detectable → add to pattern-feedback hook');
      lines.push('    b) If about editing certain files → add to blast-radius hook');
      lines.push('    c) If about dangerous commands → add to dangerous-command hook');
      lines.push('    d) If critical → add to pre-commit hook');
      lines.push('    e) If needs runtime monitoring → create monitoring producer');
      lines.push('');
    }

    lines.push('  STEP 4: VERIFY');
    lines.push('    Test any new enforcement hooks to confirm they detect violations.');
    lines.push('');
    lines.push('============================================================================');
    lines.push('');

    writeHookContext(HOOK_EVENT, lines.join('\n'));

    // Clean up flag file
    cleanup(flagPath);
  } catch (err) {
    // G-2: a hook may fail; it may not fail SILENTLY. Exit stays 0 (a Massu
    // bug must never block the user's session) but the failure now leaves a
    // durable trace: .massu/hook-failures.jsonl + stderr + hook_health.
    recordHookFailure('auto-learning-pipeline', err);
  }
  process.exit(0);
}

function cleanup(flagPath: string): void {
  try {
    if (existsSync(flagPath)) unlinkSync(flagPath);
    // Clean up old flag files (>24h)
    const dir = join(tmpdir(), 'massu-auto-learning');
    if (existsSync(dir)) {
      const now = Date.now();
      for (const file of readdirSync(dir)) {
        const fullPath = join(dir, file);
        try {
          const stat = statSync(fullPath);
          if (now - stat.mtimeMs > 86400000) {
            unlinkSync(fullPath);
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* best effort */ }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 5000);
  });
}

// ── RUN ONLY AS THE ENTRY POINT (2026-08-10) ─────────────────────────────────
// `main()` used to be called unconditionally at module scope, so merely IMPORTING
// this file executed the hook: it waited up to 5s on stdin, failed to parse the
// empty input, and called process.exit(0).
//
// `auto-learning-bounded-diff.test.ts` imports MAX_FULL_DIFF_BYTES from here, so
// every run of that suite silently ran the hook. Under vitest, process.exit is
// intercepted and throws — landing as an "Unhandled Rejection" AFTER the test file
// finished, which turned a fully-passing suite (3704 passed, 0 failed) into
// `Errors 1 error` and exit 1. It blocked pre-push [6/22] twice in a row, and it
// is the source of the `HOOK FAILURE ... Unexpected end of JSON input` noise in
// the test log.
//
// A module whose IMPORT has side effects cannot be imported for a constant. Guard
// the invocation instead of asking every future caller to remember.
// Run main() only when this file IS the process entry point. Written bare,
// `main()` at module scope means IMPORTING this module RUNS the hook: it reads
// stdin, does its work, and exits the host process.
if (isDirectInvocation(import.meta.url)) {
  main();
}
