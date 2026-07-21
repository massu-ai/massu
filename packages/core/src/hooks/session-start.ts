#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P3-001: Enhanced SessionStart Hook
// Injects context from previous sessions into new sessions.
// Output: plain text to stdout (auto-injected by Claude Code)
// ============================================================

import { getMemoryDb, getSessionSummaries, getRecentObservations, getFailedAttempts, getCrossTaskProgress, autoDetectTaskId, linkSessionToTask, createSession } from '../memory-db.ts';
import { pullTeamPromotions } from '../team-rule-sync.ts';
import { reconcileMemoryFileObservations, backfillMemoryFiles } from '../memory-file-ingest.ts';
import { getConfig, getResolvedPaths } from '../config.ts';
import { parseCorrectionRules } from '../lib/corrections-md.ts';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import type Database from 'better-sqlite3';
import { openDatabase } from '../lib/sqlite-loader.ts';
import { runAdvisors } from '../capability-advisor.ts';
import { localModelAdvisor } from '../advisors/local-model-advisor.ts';
import { resolveConsolidationConfig } from '../consolidation-config.ts';
// P-E-013 (plan-stage-e-low-info-sweep, wave1-hooks:F-HOOK-010): the
// detection layer + fingerprint helpers compose to ~280KB of compiled
// bundle. Most session-start invocations DO NOT need them — the drift
// banner only fires when (a) massu.config.yaml has a stored fingerprint
// AND (b) we're past the trailing-grace window. Defer the load to that
// branch via dynamic `await import()` so cold-start invocations skip
// the cost entirely.
// Compiled bundle size targets: pre-fix 311 KB; post-fix < 100 KB.
type DetectionMod = typeof import('../detect/index.ts');
type DriftMod = typeof import('../detect/drift.ts');
import { isPidAlive } from '../lib/pidLiveness.ts';
import { recordHookFailure } from './lib/hook-failure-signal.ts';

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  source?: 'startup' | 'resume' | 'clear' | 'compact';
}

async function main(): Promise<void> {
  try {
    // Read stdin
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const { session_id, source } = hookInput;

    const db = getMemoryDb();

    try {
      // Create session if not exists
      const gitBranch = await getGitBranch();
      createSession(db, session_id, { branch: gitBranch });

      // Check if session has a plan_file and link task
      const session = db.prepare('SELECT plan_file, task_id FROM sessions WHERE session_id = ?').get(session_id) as { plan_file: string | null; task_id: string | null } | undefined;
      if (session?.plan_file && !session.task_id) {
        const taskId = autoDetectTaskId(session.plan_file);
        if (taskId) linkSessionToTask(db, session_id, taskId);
      }

      // Token budget based on source
      const tokenBudget = getTokenBudget(source ?? 'startup');

      // Check if this is the very first session (no prior sessions)
      const sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
      if (sessionCount.count <= 1 && (source === 'startup' || !source)) {
        process.stdout.write(
          '=== MASSU AI: Active ===\n' +
          'Session memory, code intelligence, and governance are now active.\n' +
          `11 hooks monitoring this session. Type "${getConfig().toolPrefix ?? 'massu'}_sync" to index your codebase.\n` +
          '=== END MASSU ===\n\n'
        );
      }

      // S-2 (plan-silent-failure-remediation) — THE MEMORY CORPUS HAD NO INGEST PATH.
      //
      // Measured 2026-07-13: 77 memory files on disk, 0 rows in `memory_files`. So
      // auto-recall (Slice 1) was searching an EMPTY TABLE and finding nothing — the
      // entire living-memory system was dead on this machine, silently, and looked
      // exactly like "you have no relevant memories".
      //
      // WHY: `backfillMemoryFiles()` — the only bulk file->DB path — was called from
      // exactly two places: the `massu_memory_backfill` MCP tool (manual) and `init`
      // (once, at install). NOTHING called it at session start. The only automatic
      // ingest lived inside `post-tool-use`, which was 100% dead (S-1). So a file
      // written after install never reached the DB, and Slice 4A's sweep wiped the
      // init-time rows anyway.
      //
      // The reconcile below is NOT a fallback: it only EXPIRES rows whose file is gone.
      // It cannot ingest. Retiring without ingesting is a one-way ratchet to zero.
      //
      // Ingest FIRST, then reconcile. Order matters: reconciling before ingest would
      // consider every not-yet-ingested file "orphaned".
      // Idempotent (hash/mtime-gated: inserted/updated/skipped) and fail-open.
      try {
        const memoryDir = getMemoryDir();
        if (memoryDir) backfillMemoryFiles(db, memoryDir, session_id);
      } catch (err) {
        // G-2: fail-open (never block session start) but NEVER silent — a memory
        // system that cannot ingest must not look like a user with no memories.
        recordHookFailure('session-start:memory-ingest', err);
      }

      // P4-002 (plan-living-memory-slice-1): GC orphaned [memory-file]
      // observations whose backing memory/*.md file was deleted. Runs before
      // context build so stale entries don't surface. Fail-open by design.
      try {
        const memoryDir = getMemoryDir();
        if (memoryDir) reconcileMemoryFileObservations(db, memoryDir);
      } catch (err) {
        // G-2: was `catch (_reconcileErr) {}` — silent.
        recordHookFailure('session-start:reconcile', err);
      }

      // 4B (plan-living-memory-slice-4, B-08/B-12) — THE RENDERER'S ONE PRODUCTION CALLER.
      //
      // ⛔ THIS CALL IS THE FEATURE. Without it the entire renderer is dead code: every
      // gate, guard and test would pass, `renderEnabled: true` would do NOTHING, and the
      // capability would be "built and never switched on" — the exact silent-failure class
      // this workstream exists to kill. It was caught by asking "who CALLS this?" (the
      // renderer had exactly one caller: the CLI's --dry-run path), not by any test.
      //
      // Everything dangerous is INSIDE renderMemoryFiles():
      //   - renderEnabled defaults FALSE and is its FIRST statement (zero side effects on
      //     refusal), so this call is a no-op for every user who has not opted in;
      //   - no memory dir ⇒ inert; lock busy ⇒ skip after 2s, write 0 bytes;
      //   - it NEVER throws — and this try/catch is the belt to that braces, because
      //     session start's contract is FAIL-OPEN everywhere.
      try {
        const memoryDir = getMemoryDir();
        if (memoryDir) {
          const { renderMemoryFiles } = await import('../memory-renderer.ts');
          const { loadRenderCandidates } = await import('../memory-render-candidates.ts');
          renderMemoryFiles(db, loadRenderCandidates(db), { memoryDir });
        }
      } catch (_renderErr) {
        // Non-blocking, always. A renderer failure must never block session start.
      }

      // Build context
      const context = await buildContext(db, session_id, source ?? 'startup', tokenBudget, session?.task_id ?? null);

      if (context.trim()) {
        process.stdout.write(context);
      }

      // P5-001: drift banner (runs after memory context, independent of it).
      // Plan 3a Phase 6: when a live watcher daemon exists, the drift banner
      // is suppressed in favor of a compact watcher banner.
      const driftBanner = await buildDriftBanner();
      if (driftBanner) {
        process.stdout.write(driftBanner);
      } else {
        const watcherBanner = buildWatcherBanner();
        if (watcherBanner) process.stdout.write(watcherBanner);
      }

      // Capability advisor (P6-004/005, plan-living-memory-slice-3).
      //
      // Surfaces an optional upgrade the user is not using — e.g. "you have a
      // local model; Massu could write your session lessons as prose instead of
      // clipped notes" — with the full explanation, the honest downsides, and
      // the exact steps. This is IN CHAT and unprompted, on purpose: most people
      // never run `massu doctor`, and a capability nobody can find does not
      // exist.
      //
      // It is quiet by design: silent when nothing is detected, when the user
      // already configured it, or when they dismissed it — and it re-offers only
      // if their machine CHANGES (they install a model later) or after a long
      // interval. Its state is USER-level, so a 10-repo operator hears it once,
      // not ten times. Fail-open + budgeted: never delays or breaks session start.
      try {
        const consolidationCfg = resolveConsolidationConfig();
        const advisorBlock = await runAdvisors([localModelAdvisor], {
          enabled: consolidationCfg.enabled && consolidationCfg.suggestUpgrades,
          suggestIntervalDays: consolidationCfg.suggestIntervalDays,
        });
        if (advisorBlock) process.stdout.write(`\n${advisorBlock}\n`);
      } catch {
        // A suggestion is a nicety; it must never cost the user a session.
      }

      // PB3-002: cache-gated team-promotion PULL at session START (in addition to
      // session-end), so a new session materializes pending org promotions promptly
      // instead of waiting a full session for the session-end pull. Runs AFTER all
      // context/banner stdout is flushed so it never delays the visible context.
      // Self-gating + bounded: pullTeamPromotions no-ops for Free/Pro / no-cloud
      // (a single cache read, no network) and caps its fetch at the 2s request
      // budget (AbortSignal.timeout). Materializes reviewable candidates — NEVER
      // applies. Best-effort: a pull failure never blocks session start.
      try {
        await pullTeamPromotions(db);
      } catch (_pullErr) {
        // Non-blocking: pull failure never blocks session start.
      }
    } finally {
      db.close();
    }
  } catch (err) {
    // S-5 + G-2: THE MOST DECEPTIVE FAILURE IN THE PRODUCT.
    //
    // This used to swallow and exit 0 with ZERO bytes written. The visible effect of a
    // completely broken Massu was that the "MASSU AI: Active" banner simply DID NOT
    // APPEAR — which a user reads as "it isn't installed", not "it is broken". Massu
    // went quiet at exactly the moment it most needed to speak. Verified 2026-07-13:
    // fired against a destroyed DB, this hook emitted 0 bytes on stdout AND stderr.
    //
    // Now the failure is ANNOUNCED, in the same place the healthy banner would go, so
    // "broken" and "absent" can never again render identically (this is CR-65).
    recordHookFailure('session-start', err);
    try {
      process.stdout.write(
        '⚠️  MASSU AI: DEGRADED — Massu is installed but failed to start.\n' +
          '   This is a Massu bug, not a problem with your project.\n' +
          '   Details: .massu/hook-failures.jsonl · Run `massu doctor` to diagnose.\n',
      );
    } catch {
      // SWALLOW-OK: stdout is closed; the JSONL + stderr channels in
      // recordHookFailure have already fired, so the failure is not silent.
    }
    process.exit(0);
  }
}

function getTokenBudget(source: string): number {
  switch (source) {
    case 'compact': return 4000;
    case 'startup': return 2000;
    case 'resume': return 1000;
    case 'clear': return 2000;
    default: return 2000;
  }
}

async function buildContext(db: Database.Database, sessionId: string, source: string, tokenBudget: number, taskId: string | null): Promise<string> {
  const sections: Array<{ text: string; importance: number }> = [];

  // 1. Failed attempts (highest priority - DON'T RETRY warnings)
  const failures = getFailedAttempts(db, undefined, 10);
  if (failures.length > 0) {
    let failText = '### Failed Attempts (DO NOT RETRY)\n';
    for (const f of failures) {
      const recurrence = f.recurrence_count > 1 ? ` (${f.recurrence_count}x)` : '';
      failText += `- ${f.title}${recurrence}\n`;
    }
    sections.push({ text: failText, importance: 10 });
  }

  // 2. For compact: include current session's own observations
  if (source === 'compact') {
    const currentObs = getRecentObservations(db, 30, sessionId);
    if (currentObs.length > 0) {
      let currentText = '### Current Session Observations (restored after compaction)\n';
      for (const obs of currentObs) {
        currentText += `- [${obs.type}] ${obs.title}\n`;
      }
      sections.push({ text: currentText, importance: 9 });
    }
  }

  // 3. Recent session summaries
  const summaryCount = source === 'compact' ? 5 : 3;
  const summaries = getSessionSummaries(db, summaryCount);
  if (summaries.length > 0) {
    for (const s of summaries) {
      let sumText = `### Session (${s.created_at.split('T')[0]})\n`;
      if (s.request) sumText += `**Task**: ${s.request.slice(0, 200)}\n`;
      if (s.completed) sumText += `**Completed**: ${s.completed.slice(0, 300)}\n`;
      if (s.failed_attempts) sumText += `**Failed**: ${s.failed_attempts.slice(0, 200)}\n`;

      const progress = safeParseJson(s.plan_progress);
      if (progress && Object.keys(progress).length > 0) {
        const total = Object.keys(progress).length;
        const complete = Object.values(progress).filter(v => v === 'complete').length;
        sumText += `**Plan**: ${complete}/${total} complete\n`;
      }
      sections.push({ text: sumText, importance: 7 });
    }
  }

  // 4. Cross-task progress if task_id exists
  if (taskId) {
    const progress = getCrossTaskProgress(db, taskId);
    if (Object.keys(progress).length > 0) {
      const total = Object.keys(progress).length;
      const complete = Object.values(progress).filter(v => v === 'complete').length;
      let progressText = `### Cross-Session Task Progress (${taskId})\n`;
      progressText += `${complete}/${total} items complete\n`;
      sections.push({ text: progressText, importance: 8 });
    }
  }

  // 5. Prevention rules from corrections.md
  const preventionRules = loadCorrectionsPreventionRules();
  if (preventionRules.length > 0) {
    let rulesText = '### Active Prevention Rules (from corrections.md)\n';
    for (const rule of preventionRules) {
      rulesText += `- ${rule}\n`;
    }
    sections.push({ text: rulesText, importance: 9 });
  }

  // 6. Knowledge index status (warm-up check)
  try {
    const knowledgeDbPath = getResolvedPaths().knowledgeDbPath;
    if (existsSync(knowledgeDbPath)) {
      const kdb = openDatabase(knowledgeDbPath, { readonly: true, selfHeal: false });
      try {
        const stats = kdb.prepare(
          'SELECT COUNT(*) as doc_count, MAX(indexed_at) as last_indexed FROM knowledge_documents'
        ).get() as { doc_count: number; last_indexed: string | null };
        if (stats.doc_count > 0 && stats.last_indexed) {
          const ageMs = Date.now() - new Date(stats.last_indexed).getTime();
          const ageHours = Math.round(ageMs / 3600000);
          if (ageHours > 24) {
            sections.push({
              text: `### Knowledge Index Status\nIndex has ${stats.doc_count} documents, last indexed ${ageHours}h ago. Consider re-indexing.\n`,
              importance: 3,
            });
          }
        } else if (stats.doc_count === 0) {
          sections.push({
            text: '### Knowledge Index Status\nKnowledge index is empty. Run knowledge indexing to populate it.\n',
            importance: 2,
          });
        }
      } finally {
        kdb.close();
      }
    }
  } catch (_knowledgeErr) {
    // Best-effort: never block session start
  }

  // 7. Recent observations sorted by importance
  const recentObs = getRecentObservations(db, 20);
  if (recentObs.length > 0) {
    let obsText = '### Recent Observations\n';
    const sorted = [...recentObs].sort((a, b) => b.importance - a.importance);
    for (const obs of sorted) {
      obsText += `- [${obs.type}|imp:${obs.importance}] ${obs.title} (${obs.created_at.split('T')[0]})\n`;
    }
    sections.push({ text: obsText, importance: 5 });
  }

  // Fill token budget from high-importance to low-importance
  sections.sort((a, b) => b.importance - a.importance);

  let usedTokens = 0;
  const headerTokens = estimateTokens('=== Massu Memory: Previous Session Context ===\n\n=== END Massu Memory ===\n');
  usedTokens += headerTokens;

  const includedSections: string[] = [];
  for (const section of sections) {
    const sectionTokens = estimateTokens(section.text);
    if (usedTokens + sectionTokens <= tokenBudget) {
      includedSections.push(section.text);
      usedTokens += sectionTokens;
    }
  }

  if (includedSections.length === 0) return '';

  return `=== Massu Memory: Previous Session Context ===\n\n${includedSections.join('\n')}\n=== END Massu Memory ===\n`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function getGitBranch(): Promise<string | undefined> {
  try {
    const { spawnSync } = await import('child_process');
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result.status !== 0 || result.error) return undefined;
    return result.stdout.trim();
  } catch (_e) {
    return undefined;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // Timeout after 3s
    setTimeout(() => resolve(data), 3000);
  });
}

/**
 * P5-001: compare the fingerprint stored in massu.config.yaml (detection.fingerprint,
 * stamped by init/refresh/upgrade) against a freshly-computed fingerprint. If they
 * disagree, return a plain-text banner. Returns '' on any error or when the
 * config has no fingerprint (back-compat with v1 configs).
 */
async function buildDriftBanner(): Promise<string> {
  try {
    // Plan #2 P4-004: explicit opt-out for users in deliberate mid-migration windows.
    // Stays at the top so MASSU_DRIFT_QUIET=1 remains the strongest signal
    // (iter-1 G8: env-var override beats watcher-state suppression).
    if (process.env.MASSU_DRIFT_QUIET === '1') return '';

    // Plan 3a Phase 6: if a live watcher daemon refreshed within the last 24h,
    // suppress this banner — the watcher already keeps the config current.
    if (watcherIsLiveAndFresh()) return '';

    const configPath = resolve(process.cwd(), 'massu.config.yaml');
    if (!existsSync(configPath)) return '';
    const content = readFileSync(configPath, 'utf-8');
    // pattern-scanner-allow: yaml-parse — reason: compiled standalone hook (esbuild bundle). Per P2-023a, hooks cannot import getConfig() — they run in the Claude Code subprocess context with no module resolution path back to packages/core. Direct YAML parse is the only available access pattern.
    const parsed = parseYaml(content) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return '';
    const det = parsed.detection as Record<string, unknown> | undefined;
    const storedFp = typeof det?.fingerprint === 'string' ? (det.fingerprint as string) : null;
    if (!storedFp) return '';
    // Plan #2 P4-006: skip the codebase introspector pass — the drift banner
    // only needs the fingerprint, not the introspected detail. Saves up to 2s
    // wall-clock from the hook's 5-second budget.
    //
    // P-E-013: dynamic-import the detection + drift modules ONLY here (inside
    // the branch that needs them) so cold-start invocations that don't fire
    // the banner skip the ~280 KB of compiled bundle.
    const [{ runDetection }, { computeFingerprint }]: [DetectionMod, DriftMod] = await Promise.all([
      import('../detect/index.ts'),
      import('../detect/drift.ts'),
    ]);
    const detection = await runDetection(process.cwd(), undefined, { skipIntrospect: true });
    const currentFp = computeFingerprint(detection);
    if (currentFp === storedFp) return '';
    return (
      '=== Massu Config Drift ===\n' +
      'Detected stack has changed since last config refresh.\n' +
      `Fingerprint:  ${storedFp.slice(0, 16)}  ->  ${currentFp.slice(0, 16)}\n` +
      'Run: npx massu config refresh\n' +
      '(this will update massu.config.yaml AND any commands that need\n' +
      ' re-templating for your new stack)\n' +
      'Tip: set MASSU_DRIFT_QUIET=1 to suppress this banner during mid-migration.\n' +
      '=== END ===\n'
    );
  } catch (_e) {
    // Never block session start on drift-check failure.
    return '';
  }
}

function safeParseJson(json: string): Record<string, string> | null {
  try {
    return JSON.parse(json);
  } catch (_e) {
    return null;
  }
}

/**
 * Load prevention rules from corrections.md in the memory directory.
 * Parses the markdown table format: | Date | Wrong Behavior | Correction | Prevention Rule |
 * Returns only the prevention rule column values.
 * Graceful degradation: returns empty array if file doesn't exist or can't be parsed.
 */
/**
 * Resolve the memory directory for the current project, following Claude's
 * project-directory convention (mirrors loadCorrectionsPreventionRules).
 * Returns '' if it cannot be resolved.
 */
/**
 * A-00 — THE memory dir. One resolver, repo-wide.
 *
 * This function used to build the path itself:
 *     cwd.replace(/[/\\]/g, '-').replace(/^-/, '')
 * Two independent bugs in one line.
 *
 *   1. `.replace(/^-/, '')` STRIPPED THE LEADING DASH. An absolute path starts
 *      with '/', so the encoded name always starts with exactly one '-'. The
 *      canonical encoder says so in as many words (`lib/memory-path.ts:18-21`:
 *      "the result always starts with `-` exactly once"). This function deleted
 *      it, so it resolved to `~/.claude/projects/Users-…/memory` — A DIRECTORY
 *      THAT DOES NOT EXIST — while the real corpus sat in `-Users-…/memory`.
 *   2. It keyed off `process.cwd()` rather than the project root, so running
 *      from a subdirectory resolved somewhere else again.
 *
 * The damage was not cosmetic. `reconcileMemoryFileObservations` is called with
 * this path at every session start. A nonexistent directory yielded an empty
 * live-file set, which (before A-01) took the unbounded branch:
 *     DELETE FROM observations WHERE title LIKE '[memory-file] %'
 * Meanwhile `massu init` and the backfill tool populate those very rows using the
 * CORRECT resolver (`config.ts:965`, `commands/init.ts:1789`). So the two halves
 * formed a death loop: backfill inserts 69 rows -> the next session start deletes
 * all 69. Forever. The live store showed exactly that: 0 `[memory-file]` rows
 * against 69 files on disk.
 *
 * `lib/memory-path.ts` already exists precisely to be the single source of truth
 * here — its own header records that it was written to close this SAME bug class
 * once before (a writer that mangled the dash and "orphaned MEMORY.md in a
 * directory the reader could never find"). This hook was never migrated onto it.
 * It is now. There is ONE resolver, and a drift-guard keeps it that way.
 */
function getMemoryDir(): string {
  try {
    return getResolvedPaths().memoryDir;
  } catch (err) {
    // G-2: returning '' here is how the memory directory becomes a PHANTOM — every
    // caller then resolves against cwd, finds nothing, and reports "no memories"
    // instead of "I could not find the memory directory". That is A-00 all over
    // again. The empty return is preserved (callers depend on it) but it now SAYS SO.
    recordHookFailure('session-start:getMemoryDir', err);
    return '';
  }
}

function loadCorrectionsPreventionRules(): string[] {
  try {
    // A-00 — the SAME phantom-directory bug lived here (a second hand-rolled copy
    // of the encoder, with the same dash-stripping `.replace(/^-/, '')`). So this
    // reader has been looking in a directory that does not exist, and would have
    // found nothing even if corrections.md had been written in the format it
    // parses. The "dead corrections read" (D2) was diagnosed as a FORMAT mismatch;
    // it was ALSO a path bug. Fixing only the format would have left it dead.
    const correctionsPath = join(getResolvedPaths().memoryDir, 'corrections.md');

    if (!existsSync(correctionsPath)) return [];

    // A-09 — ONE parser, shared with both writers (`lib/corrections-md.ts`).
    //
    // This used to hand-roll a 4-column TABLE parser while the two writers emitted
    // heading+bullet formats — so the reader found NOTHING either writer produced, and
    // every prevention rule ever written was invisible to the injection that exists to
    // surface them. (A-00 also showed it was looking in a directory that does not
    // exist; fixing only the format would have left it dead.)
    return parseCorrectionRules(readFileSync(correctionsPath, 'utf-8'));
  } catch (_e) {
    // Graceful degradation: never block session start
    return [];
  }
}

// ============================================================
// Plan 3a Phase 6: watcher-aware banner support
// ============================================================

interface WatchStateShape {
  schema_version?: number;
  daemonPid?: number | null;
  lastRefreshAt?: string | null;
  startedAt?: string | null;
}

function readWatchStateRaw(cwd: string): WatchStateShape | null {
  try {
    const path = resolve(cwd, '.massu', 'watch-state.json');
    if (!existsSync(path)) return null;
    const obj = JSON.parse(readFileSync(path, 'utf-8'));
    if (!obj || typeof obj !== 'object') return null;
    return obj as WatchStateShape;
  } catch {
    return null;
  }
}

function watcherIsLiveAndFresh(): boolean {
  // MASSU_DRIFT_QUIET takes precedence (caller already short-circuited).
  // Fresh = last refresh within 24h AND daemonPid is alive.
  const state = readWatchStateRaw(process.cwd());
  if (!state) return false;
  if (typeof state.daemonPid !== 'number' || state.daemonPid <= 0) return false;
  if (!isPidAlive(state.daemonPid)) return false;
  if (typeof state.lastRefreshAt !== 'string') return false;
  const last = Date.parse(state.lastRefreshAt);
  if (!Number.isFinite(last)) return false;
  const ageMs = Date.now() - last;
  return ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000;
}

function buildWatcherBanner(): string {
  // P4-004 ordering: MASSU_DRIFT_QUIET wins everywhere.
  if (process.env.MASSU_DRIFT_QUIET === '1') return '';
  const state = readWatchStateRaw(process.cwd());
  if (!state) return '';
  if (typeof state.daemonPid !== 'number' || state.daemonPid <= 0) return '';
  if (!isPidAlive(state.daemonPid)) return '';
  if (typeof state.lastRefreshAt !== 'string') return '';
  const last = Date.parse(state.lastRefreshAt);
  if (!Number.isFinite(last)) return '';
  const ageMs = Date.now() - last;
  if (ageMs < 0 || ageMs >= 24 * 60 * 60 * 1000) return '';

  const ageStr = formatAge(ageMs);
  return (
    '=== Massu Watcher ===\n' +
    `[massu] watcher running, last refresh: ${ageStr} ago (pid ${state.daemonPid})\n` +
    '=== END ===\n'
  );
}

function formatAge(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  return `${hr}h`;
}

main();
