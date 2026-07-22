#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P3-002: PostToolUse Observation Hook
// Captures tool usage as observations (lightweight, no AI needed).
// Must complete in <500ms.
// ============================================================

import { getMemoryDb, addObservation, createSession, deduplicateFailedAttempt, addSummary } from '../memory-db.ts';
import { classifyRealTimeToolCall, detectPlanProgress } from '../observation-extractor.ts';
import { logAuditEntry } from '../audit-trail.ts';
import { trackModification, recordTestResult } from '../regression-detector.ts';
import { validateFile, storeValidationResult } from '../validation-engine.ts';
import { scoreFileSecurity, storeSecurityScore } from '../security-scorer.ts';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, basename as pathBasename, dirname as pathDirname, resolve as pathResolve } from 'path';
import { getResolvedPaths } from '../config.ts';
import { incrementRecurrenceCountsForScannerFailures } from '../lib/recurrence-incrementer.ts';
import { normalizeToolResponse, type RawToolResponse } from './lib/tool-response.ts';
import { recordHookFailure } from './lib/hook-failure-signal.ts';
// P-E-018 (plan-stage-e-low-info-sweep): defer yaml dependency load
// until first parse call. Most hook invocations don't need YAML
// parsing (the massu.config.yaml read happens only when the relevant
// convention-resolution path fires). Cold-start invocations now skip
// yaml's module load entirely.
//
// Hooks are esbuild-bundled with `--external:yaml` AND a `createRequire`
// banner — synchronous `require` defers resolution to first call.
// `parseYaml` keeps the same name as the original direct import so the
// post-tool-use-config-cache.test.ts grep-based drift-guard
// (mtime-before-parseYaml-call) continues to work. The lazy import
// resolves only ONCE thanks to the closure-cached `_yamlParser`.
let _yamlParser: ((input: string) => unknown) | null = null;
const parseYaml: (content: string) => unknown = (content) => {
  if (!_yamlParser) {
    // pattern-scanner-allow: require
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _yamlParser = (require('yaml') as { parse: (s: string) => unknown }).parse;
  }
  return _yamlParser(content);
};
import { ingestMemoryFile } from '../memory-file-ingest.ts';

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  /**
   * S-1 (plan-silent-failure-remediation): this was declared `string`. IT IS NOT.
   * Measured across every real transcript for this repo: 97.6% object, 2.4% string.
   * The lie type-checked, so `tsc` was happy, the tests (which passed string literals)
   * were green — and `.trim()` threw a TypeError on 96% of real calls, straight into
   * an outer `catch {}` and `exit 0`. 251,956 tool calls produced 0 observations.
   * NEVER narrow this to `string` again. Normalize via the ONE parser instead.
   */
  tool_response: RawToolResponse;
}

// In-memory dedup for Read calls within this session
const seenReads = new Set<string>();
let currentSessionId: string | null = null;

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const { session_id, tool_name, tool_input } = hookInput;

    // S-1: NORMALIZE AT THE BOUNDARY. Every consumer below (classifyRealTimeToolCall,
    // detectPlanProgress, parseTestRunOutput, the scanner excerpt) expects TEXT. The
    // raw field is an object 97.6% of the time. Converting it here, once, through the
    // one parser, is what makes the other six call sites in this file correct — and
    // stringifying instead of extracting `stdout` would have silently broken all of
    // the parsers rather than crashing them, which is worse.
    const { text: tool_response, isError: toolErrored } = normalizeToolResponse(
      hookInput.tool_response,
    );

    // Reset seen reads if session changed
    if (currentSessionId !== session_id) {
      seenReads.clear();
      currentSessionId = session_id;
    }

    const db = getMemoryDb();
    try {
      // Ensure session exists
      createSession(db, session_id);

      // Classify and filter
      const observation = classifyRealTimeToolCall(tool_name, tool_input, tool_response, seenReads);
      if (!observation) {
        process.exit(0);
        return;
      }

      // Deduplicate failed attempts
      if (observation.type === 'failed_attempt') {
        deduplicateFailedAttempt(db, session_id, observation.title, observation.detail, observation.opts);
      } else {
        addObservation(db, session_id, observation.type, observation.title, observation.detail, observation.opts);
      }

      // plan-memory-ingestion-decision-noise-fix (D-A): the former P3-001 structured
      // decision capture keyed on `observation.type === 'decision'` — but that type is no
      // longer produced from tool responses (the substring-match noise source was removed
      // from `classifyRealTimeToolCall`). Structured architecture_decisions are captured
      // via the explicit `massu_adr_create` tool and the assistant-reasoning backfill path,
      // never from echoed tool output. This block was dead once the source was removed.

      // Auto-detect plan progress
      if (tool_response) {
        const progress = detectPlanProgress(tool_response);
        if (progress.length > 0) {
          // Update plan_progress in session summary
          updatePlanProgress(db, session_id, progress);
        }
      }

      // Audit trail logging for file changes
      try {
        if (tool_name === 'Edit' || tool_name === 'Write') {
          const filePath = (tool_input.file_path as string) ?? '';
          logAuditEntry(db, {
            sessionId: session_id,
            eventType: 'code_change',
            actor: 'ai',
            filePath,
            changeType: tool_name === 'Write' ? 'create' : 'edit',
          });

          // Track modification for regression detection
          if (filePath) {
            const featureMatch = filePath.match(/(?:routers|components|app\/\(([^)]+)\))\/([^/.]+)/);
            if (featureMatch) {
              const featureKey = featureMatch[1] ?? featureMatch[2];
              trackModification(db, featureKey);
            }
          }
        }
      } catch (_auditErr) {
        // Best-effort: never block post-tool-use
      }

      // Real-time validation for Edit/Write
      try {
        if (tool_name === 'Edit' || tool_name === 'Write') {
          const filePath = (tool_input.file_path as string) ?? '';
          if (filePath && (filePath.endsWith('.ts') || filePath.endsWith('.tsx'))) {
            const projectRoot = hookInput.cwd;
            const checks = validateFile(filePath, projectRoot);
            const violations = checks.filter(c => c.severity === 'error' || c.severity === 'critical');
            if (violations.length > 0) {
              storeValidationResult(db, filePath, checks, session_id);
            }
          }
        }
      } catch (_validationErr) {
        // Best-effort: never block post-tool-use
      }

      // Auto-security scoring for router/API files
      try {
        if (tool_name === 'Edit' || tool_name === 'Write') {
          const filePath = (tool_input.file_path as string) ?? '';
          if (filePath && (filePath.includes('routers/') || filePath.includes('api/'))) {
            const projectRoot = hookInput.cwd;
            const { riskScore, findings } = scoreFileSecurity(filePath, projectRoot);
            if (findings.length > 0) {
              storeSecurityScore(db, session_id, filePath, riskScore, findings);
            }
          }
        }
      } catch (_securityErr) {
        // Best-effort: never block post-tool-use
      }

      // P-H029 (plan-stage-c-high-batch): wire recordTestResult() into the
      // post-tool-use hook so `feature_health` dashboard reflects real test
      // deltas. Pre-fix: `trackModification` fired but `recordTestResult` was
      // unit-tested yet never called; dashboard showed tests_passing=0 for
      // every feature.
      //
      // Strategy: when a Bash tool call runs a test runner AND the output
      // includes parseable pass/fail counts, call recordTestResult for every
      // feature with `modifications_since_test > 0`. This resets their counter
      // and updates pass/fail tallies based on the run.
      try {
        if (tool_name === 'Bash') {
          const command = (tool_input.command as string) ?? '';
          if (isTestRunnerCommand(command)) {
            const counts = parseTestRunOutput(tool_response ?? '');
            if (counts) {
              // LIMIT 10000 caps active-feature count (P-DG-001) — a healthy
              // project has dozens; 10000 is multiple orders beyond realistic.
              const modifiedFeatures = db
                .prepare(
                  'SELECT feature_key FROM feature_health WHERE modifications_since_test > 0 LIMIT 10000',
                )
                .all() as Array<{ feature_key: string }>;
              for (const row of modifiedFeatures) {
                recordTestResult(db, row.feature_key, counts.passing, counts.failing);
              }
              // Also record a session-level aggregate so the dashboard has at
              // least one row even when no features were modified.
              if (modifiedFeatures.length === 0) {
                recordTestResult(db, '_session_test_run', counts.passing, counts.failing);
              }
            }
          }
        }
      } catch (_testResultErr) {
        // Best-effort: never block post-tool-use
      }

      // MEMORY.md integrity check on write
      try {
        if (tool_name === 'Edit' || tool_name === 'Write') {
          const filePath = (tool_input.file_path as string) ?? '';
          if (filePath && filePath.endsWith('MEMORY.md') && filePath.includes('/memory/')) {
            const issues = checkMemoryFileIntegrity(filePath);
            if (issues.length > 0) {
              addObservation(db, session_id, 'incident_near_miss',
                'MEMORY.md integrity issue detected',
                issues.join('; '),
                { importance: 4 }
              );
            }
          }
        }
      } catch (_memoryErr) {
        // Best-effort: never block post-tool-use
      }

      // Memory file auto-ingest: when Claude writes a memory/*.md file,
      // parse frontmatter and ingest into observations table
      try {
        if (tool_name === 'Edit' || tool_name === 'Write') {
          const filePath = (tool_input.file_path as string) ?? '';
          // A-10 — this trigger has NEVER FIRED ON WINDOWS.
          //
          // It matched the substring '/memory/', so `C:\Users\…\memory\x.md` never
          // matched at all, and it derived the basename with split('/'), so on
          // Windows the "basename" was the entire path. It was also a substring
          // test, so ANY repo file under any `*/memory/*` directory was ingested as
          // if it were a user memory.
          //
          // Resolve the real memory dir and ask whether this file is IN it. Same
          // resolver as everywhere else (A-00) — there is exactly one.
          if (filePath && filePath.endsWith('.md') && pathBasename(filePath) !== 'MEMORY.md') {
            let memoryDir = '';
            try {
              memoryDir = getResolvedPaths().memoryDir;
            } catch {
              memoryDir = '';
            }
            if (memoryDir && pathResolve(pathDirname(filePath)) === pathResolve(memoryDir)) {
              ingestMemoryFile(db, session_id, filePath);
            }
          }
        }
      } catch (_memoryIngestErr) {
        // Best-effort: never block post-tool-use
      }

      // Knowledge index staleness check on knowledge file edits
      try {
        if (tool_name === 'Edit' || tool_name === 'Write') {
          const filePath = (tool_input.file_path as string) ?? '';
          if (filePath && isKnowledgeSourceFile(filePath)) {
            addObservation(db, session_id, 'discovery',
              'Knowledge source file modified - index may be stale',
              `Edited ${filePath.split('/').pop() ?? filePath}. Run knowledge re-index to update.`,
              { importance: 3 }
            );
          }
        }
      } catch (_knowledgeErr) {
        // Best-effort: never block post-tool-use
      }

      // plan-v0.2-interactive-rule-approval P-D-011: CR-53 Layer 2
      // recurrence-count increment. When the pattern-scanner runs and emits
      // a `  FAIL:` line on a file we ALSO touched in the current session,
      // increment `metadata.recurrence_count` on the corresponding
      // `rule_promoted` audit_log row. A non-zero count after 7 days means
      // the auto-learned rule did not prevent the recurrence — the CR-53
      // drift-guard test FAILs CI on that condition.
      try {
        if (tool_name === 'Bash') {
          const command = (tool_input.command as string) ?? '';
          if (/massu-pattern-scanner\.sh/.test(command)) {
            const stdout = tool_response ?? '';
            incrementRecurrenceCountsForScannerFailures(db, session_id, stdout);
          }
        }
      } catch (err) {
        // P-D-011 contract: silent in-hook failure but surface via the
        // .cr53-increment-failures.jsonl observability channel so the
        // CR-53 drift-guard catches non-empty failure log within 7 days.
        try {
          const projectRoot = process.cwd();
          const dir = join(projectRoot, '.massu', 'rule-candidates');
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const logPath = join(dir, '.cr53-increment-failures.jsonl');
          const pre = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
          const sep = pre && !pre.endsWith('\n') ? '\n' : '';
          writeFileSync(logPath, pre + sep + JSON.stringify({
            session_id,
            scanner_output_excerpt: (tool_response ?? '').slice(0, 200),
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }) + '\n', 'utf-8');
        } catch { /* truly best-effort */ }
      }
    } finally {
      db.close();
    }
  } catch (err) {
    // G-2: was `catch (_e) { /* Best-effort */ }` — a comment where a signal belonged.
    // THIS EMPTY BLOCK IS WHY MASSU NEVER LEARNED ANYTHING. It swallowed a TypeError
    // on 96% of tool calls for months, silently, while every gate stayed green.
    //
    // We still exit 0 — a Massu bug must never block the user's session — but the
    // failure now leaves a trace in three places (file, stderr, hook_health), so
    // "broken" can never again be byte-identical to "quiet day".
    recordHookFailure('post-tool-use', err);
  }
  process.exit(0);
}

function updatePlanProgress(db: import('better-sqlite3').Database, sessionId: string, progress: Array<{ planItem: string; status: string }>): void {
  // Get or create latest summary's plan_progress
  const existing = db.prepare(
    'SELECT id, plan_progress FROM session_summaries WHERE session_id = ? ORDER BY created_at_epoch DESC LIMIT 1'
  ).get(sessionId) as { id: number; plan_progress: string } | undefined;

  if (existing) {
    try {
      const currentProgress = JSON.parse(existing.plan_progress) as Record<string, string>;
      for (const p of progress) {
        currentProgress[p.planItem] = p.status;
      }
      db.prepare('UPDATE session_summaries SET plan_progress = ? WHERE id = ?')
        .run(JSON.stringify(currentProgress), existing.id);
    } catch (_e) {
      // Skip if JSON parse fails
    }
  } else {
    // Create a minimal summary with plan progress
    const progressMap: Record<string, string> = {};
    for (const p of progress) {
      progressMap[p.planItem] = p.status;
    }
    addSummary(db, sessionId, { planProgress: progressMap });
  }
}

/**
 * P-H029: Detect test-runner commands. Conservative match — only commands that
 * START with a recognized test runner so a build script invoking `npm run test`
 * is included but a script that merely mentions "test" in a filename is not.
 */
function isTestRunnerCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  // Strip leading `cd <dir> && ` or `(cd <dir> && ...)` prefix so we match
  // the actual test command.
  const stripped = trimmed
    .replace(/^cd\s+\S+\s*(&&|;)\s*/, '')
    .replace(/^\(\s*cd\s+\S+\s*(&&|;)\s*/, '');
  const testRunnerPrefixes = [
    'npm test', 'npm run test', 'npx vitest', 'npx jest', 'vitest', 'jest',
    'pnpm test', 'pnpm run test', 'yarn test', 'pytest', 'go test', 'cargo test',
  ];
  return testRunnerPrefixes.some((prefix) => stripped.startsWith(prefix));
}

/**
 * P-H029: Parse test-run output for pass/fail counts. Supports vitest
 * (`Tests  N passed (N)`, `Tests  X failed | Y passed (Z)`), jest
 * (`Tests: X failed, Y passed, Z total`), and pytest (`X passed, Y failed`).
 * Returns null if no parseable summary line found.
 */
function parseTestRunOutput(output: string): { passing: number; failing: number } | null {
  // vitest: " Tests  439 passed (439)" or " Tests  3 failed | 436 passed (439)"
  const vitestSplit = output.match(/Tests?\s+(?:(\d+)\s+failed\s+\|\s+)?(\d+)\s+passed/);
  if (vitestSplit) {
    return {
      passing: parseInt(vitestSplit[2], 10),
      failing: vitestSplit[1] ? parseInt(vitestSplit[1], 10) : 0,
    };
  }
  // jest: "Tests:       1 failed, 5 passed, 6 total"
  const jest = output.match(/Tests?:\s+(?:(\d+)\s+failed,\s+)?(\d+)\s+passed/);
  if (jest) {
    return {
      passing: parseInt(jest[2], 10),
      failing: jest[1] ? parseInt(jest[1], 10) : 0,
    };
  }
  // pytest: "5 passed, 2 failed in 1.23s" or "5 passed in 1.23s"
  const pytestPassed = output.match(/(\d+)\s+passed/);
  const pytestFailed = output.match(/(\d+)\s+failed/);
  if (pytestPassed) {
    return {
      passing: parseInt(pytestPassed[1], 10),
      failing: pytestFailed ? parseInt(pytestFailed[1], 10) : 0,
    };
  }
  return null;
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

type Conventions = { knowledgeSourceFiles: string[]; claudeDirName: string };

// Module-scope cache for readConventions (P-M-002 plan-stage-d-medium-sweep).
// Re-parse YAML only when config-file mtime changes within a hook lifetime.
// Each PostToolUse invocation re-imports this module fresh (esbuild bundle starts
// per-spawn), so the cache lifetime is per-hook-call NOT per-process — but within
// that call, redundant readConventions() invocations short-circuit.
let _cachedConventions: Conventions | null = null;
let _cachedConventionsPath: string | null = null;
let _cachedConventionsMtimeMs = 0;

const _conventionDefaults: Conventions = {
  knowledgeSourceFiles: ['CLAUDE.md', 'MEMORY.md', 'corrections.md'],
  claudeDirName: '.claude',
};

/**
 * Read the conventions section from massu.config.yaml directly.
 * Hooks are compiled with esbuild and cannot use getConfig() from config.ts.
 * Falls back to sensible defaults if the config file is not found.
 * Cached per (path, mtime) within a hook invocation — see _cachedConventions above.
 */
function readConventions(cwd?: string): Conventions {
  try {
    const projectRoot = cwd ?? process.cwd();
    const configPath = join(projectRoot, 'massu.config.yaml');
    if (!existsSync(configPath)) return _conventionDefaults;
    const mtimeMs = statSync(configPath).mtimeMs;
    if (
      _cachedConventions !== null &&
      _cachedConventionsPath === configPath &&
      _cachedConventionsMtimeMs === mtimeMs
    ) {
      return _cachedConventions;
    }
    const content = readFileSync(configPath, 'utf-8');
    // pattern-scanner-allow: yaml-parse — reason: compiled standalone hook (esbuild bundle). Per P2-023a, hooks cannot import getConfig() — they run in the Claude Code subprocess context with no module resolution path back to packages/core. Direct YAML parse is the only available access pattern.
    const parsed = parseYaml(content) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return _conventionDefaults;
    const conventions = parsed.conventions as Record<string, unknown> | undefined;
    if (!conventions || typeof conventions !== 'object') return _conventionDefaults;
    const resolved: Conventions = {
      knowledgeSourceFiles: Array.isArray(conventions.knowledgeSourceFiles)
        ? conventions.knowledgeSourceFiles as string[]
        : _conventionDefaults.knowledgeSourceFiles,
      claudeDirName: typeof conventions.claudeDirName === 'string'
        ? conventions.claudeDirName
        : _conventionDefaults.claudeDirName,
    };
    _cachedConventions = resolved;
    _cachedConventionsPath = configPath;
    _cachedConventionsMtimeMs = mtimeMs;
    return resolved;
  } catch {
    return _conventionDefaults;
  }
}

/**
 * Check if a file path is a knowledge source file (CLAUDE.md, corrections.md,
 * memory files, or knowledge system source files).
 * When these are edited, the knowledge index may become stale.
 */
function isKnowledgeSourceFile(filePath: string): boolean {
  const basename = filePath.split('/').pop() ?? '';
  const conventions = readConventions();
  const knowledgeSourcePatterns = [
    ...conventions.knowledgeSourceFiles,
    'file-index.md',
    'knowledge-db.ts',
    'knowledge-indexer.ts',
    'knowledge-tools.ts',
  ];
  return knowledgeSourcePatterns.some(p => basename === p) ||
    filePath.includes('/memory/') ||
    filePath.includes(conventions.claudeDirName + '/');
}

/**
 * Check MEMORY.md file integrity after a write.
 * Verifies: file exists, has expected structure, and is under line limit.
 * Returns array of issue descriptions (empty = all good).
 */
function checkMemoryFileIntegrity(filePath: string): string[] {
  const issues: string[] = [];

  try {
    if (!existsSync(filePath)) {
      issues.push('MEMORY.md file does not exist after write');
      return issues;
    }

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Check line count (CLAUDE.md truncates after ~200 lines)
    const MAX_LINES = 200;
    if (lines.length > MAX_LINES) {
      issues.push(`MEMORY.md exceeds ${MAX_LINES} lines (currently ${lines.length}). Consider archiving old entries.`);
    }

    // P-E-020 (plan-stage-e-low-info-sweep): MEMORY.md integrity check uses
    // structural assertions instead of brittle fixed-heading strings. The
    // canonical format per CLAUDE.md spec is `# Memory Index` followed by
    // `- [title](file.md) — hook` lines. Old per-heading list caused false
    // positives every time the operator reorganized sections.
    if (!/^#\s+Memory(\s+Index)?\s*$/m.test(content)) {
      issues.push('MEMORY.md missing top-level `# Memory Index` heading');
    }
    const linkLineCount = (content.match(/^- \[[^\]]+\]\([^)]+\.md\)/mg) ?? []).length;
    if (linkLineCount === 0) {
      issues.push('MEMORY.md has no `- [Title](file.md) — hook` index lines');
    }
  } catch (_e) {
    // Graceful degradation: don't report issues if we can't check
  }

  return issues;
}

main();
