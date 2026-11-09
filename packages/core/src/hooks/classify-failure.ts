#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// PostToolUse Hook: Failure Classification
// Classifies bug fixes against known failure patterns before
// demanding the full incident loop. Prevents rule bloat by
// recognizing known patterns vs genuinely novel failures.
//
// Part of the Auto-Learning Pipeline:
//   [Fix Detected] → [CLASSIFY] → Incident Report → Rule → Enforcement
//
// Classification:
//   SCORE >= known threshold  → KNOWN   — Reference existing rules, no new deliverables
//   SCORE >= similar threshold → SIMILAR — Check existing rules first
//   SCORE < similar threshold  → NEW     — Full incident loop mandatory
//
// Triggers on: Edit|Write to code files
// Must complete in <1000ms.
// ============================================================

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { getProjectRoot, getConfig } from '../config.ts';
import { getMemoryDb, scoreFailureClasses } from '../memory-db.ts';
import { isTestOrFixturePath } from './fix-detector.ts';
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
  tool_input: {
    file_path?: string;
    old_string?: string;
    new_string?: string;
    content?: string;
  };
}

// Bug fix detection heuristics
const BUG_FIX_INDICATORS = [
  /\b(catch|error|throw|fail|fix|bug|broken|missing|crash|wrong|typo|incorrect)\b/i,
];

const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|swift|rs|go|rb|sh)$/;

function getDedupeMarkerPath(sessionId: string, filePath: string): string {
  // One reminder per file per calendar day
  const day = new Date().toISOString().slice(0, 10);
  const hash = simpleHash(filePath);
  return join(tmpdir(), `massu-classify-${day}-${sessionId.slice(0, 8)}-${hash}`);
}

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function readFailureContextFiles(): string {
  const dir = tmpdir();
  let context = '';
  try {
    const files = readdirSync(dir).filter(f => f.startsWith('massu-failure-context-'));
    for (const file of files) {
      try {
        context += ' ' + readFileSync(join(dir, file), 'utf-8');
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return context.trim();
}

function cleanupFailureContextFiles(): void {
  const dir = tmpdir();
  try {
    const files = readdirSync(dir).filter(f => f.startsWith('massu-failure-context-'));
    for (const file of files) {
      try { unlinkSync(join(dir, file)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const filePath = hookInput.tool_input?.file_path;

    if (!filePath) {
      process.exit(0);
      return;
    }

    const config = getConfig();

    // Check if feature is enabled
    if (config.autoLearning?.enabled === false ||
        config.autoLearning?.failureClassification?.enabled === false) {
      process.exit(0);
      return;
    }

    // Only check code files
    if (!CODE_EXTENSIONS.test(filePath)) {
      process.exit(0);
      return;
    }

    // Skip incident/memory/doc files (those are pipeline output)
    const root = getProjectRoot();
    const incidentDir = config.autoLearning?.incidentDir ?? 'docs/incidents';
    const memoryDir = config.autoLearning?.memoryDir ?? 'memory';
    const relPath = filePath.startsWith(root + '/') ? filePath.slice(root.length + 1) : filePath;
    if (relPath.startsWith(incidentDir) || relPath.includes(memoryDir) || relPath.includes('MEMORY.md')) {
      process.exit(0);
      return;
    }

    // Skip TESTS and FIXTURES — pipeline output too, for exactly the reason above.
    //
    // SECOND SITE of the role-gate landed in `fix-detector.ts` on 2026-08-13 (incident
    // 2026-08-13). These two hooks are the same decision — "does this edit look like a bug
    // fix, and must the author therefore file an incident?" — scored by the same kind of
    // content heuristics over the same `old_string`/`new_string`. The gate was applied to
    // one of them and not the other, so the class stayed live at half its sites (CR-74: a
    // fix is a set of SITES, not an edit).
    //
    // It was still firing: writing the drift-guard for the FIRST site tripped THIS hook on
    // the test file being written, demanding an incident for the artifact that closed the
    // previous incident — the same circular demand, satisfiable only by inventing a defect.
    //
    // Binds to `fix-detector.ts`'s exported patterns rather than re-listing them here; two
    // copies of a path predicate is how the sites drift apart in the first place.
    if (isTestOrFixturePath(relPath) || isTestOrFixturePath(filePath)) {
      process.exit(0);
      return;
    }

    // Detect if this edit looks like a bug fix
    const oldString = hookInput.tool_input?.old_string ?? '';
    const newString = hookInput.tool_input?.new_string ?? '';
    const content = hookInput.tool_input?.content ?? '';
    const matchText = `${oldString} ${newString} ${content}`;

    let isBugFix = false;

    // Check for failure context markers (from UserPromptSubmit)
    const promptContext = readFailureContextFiles();
    if (promptContext) {
      isBugFix = true;
    }

    // Check for bug fix indicators in the edit text
    if (!isBugFix) {
      for (const pattern of BUG_FIX_INDICATORS) {
        if (pattern.test(matchText)) {
          isBugFix = true;
          break;
        }
      }
    }

    // Check for column/key name changes (common fix pattern)
    if (!isBugFix && oldString && newString) {
      const oldKeys = oldString.match(/[a-z_]+:/g)?.sort().join(',');
      const newKeys = newString.match(/[a-z_]+:/g)?.sort().join(',');
      if (oldKeys && newKeys && oldKeys !== newKeys) {
        isBugFix = true;
      }
    }

    if (!isBugFix) {
      process.exit(0);
      return;
    }

    // De-duplicate: skip if already reminded for this file today
    const dedupeMarker = getDedupeMarkerPath(hookInput.session_id, filePath);
    if (existsSync(dedupeMarker)) {
      process.exit(0);
      return;
    }

    // Mark that we've classified this file
    try {
      writeFileSync(dedupeMarker, '1');
    } catch { /* ignore */ }

    // Score against failure taxonomy in database
    const db = getMemoryDb();
    try {
      const scoringConfig = config.autoLearning?.failureClassification?.scoring;
      const thresholds = config.autoLearning?.failureClassification?.thresholds ?? { known: 5, similar: 3 };
      const bestMatch = scoreFailureClasses(db, matchText, filePath, promptContext, scoringConfig);

      if (!bestMatch || bestMatch.score === 0) {
        // No taxonomy entries yet, or no match — full enforcement
        outputNewPattern(basename(filePath), bestMatch);
      } else if (bestMatch.score >= thresholds.known) {
        outputKnownPattern(bestMatch);
      } else if (bestMatch.score >= thresholds.similar) {
        outputSimilarPattern(bestMatch);
      } else {
        outputNewPattern(basename(filePath), bestMatch);
      }
    } finally {
      db.close();
    }

    // Clean up consumed context files to prevent cross-bug contamination
    cleanupFailureContextFiles();
  } catch (err) {
    // G-2: a hook may fail; it may not fail SILENTLY. Exit stays 0 (a Massu
    // bug must never block the user's session) but the failure now leaves a
    // durable trace: .massu/hook-failures.jsonl + stderr + hook_health.
    recordHookFailure('classify-failure', err);
  }
  process.exit(0);
}

function outputKnownPattern(match: FailureClassMatch): void {
  const lines: string[] = [];
  lines.push('');
  lines.push(`[KNOWN PATTERN] ${match.name} (score: ${match.score}, ${match.incidentCount} prior incident(s))`);
  if (match.knownMessage) {
    lines.push(`  ${match.knownMessage}`);
  }
  if (match.rules.length > 0) {
    lines.push(`  Covered by: ${match.rules.join(', ')}`);
  }
  lines.push('  No new rules needed. Reference existing incident if logging.');
  writeHookContext(HOOK_EVENT, lines.join('\n'));
}

function outputSimilarPattern(match: FailureClassMatch): void {
  const lines: string[] = [];
  lines.push('');
  lines.push(`[POSSIBLE MATCH] Resembles ${match.name} (score: ${match.score})`);
  if (match.rules.length > 0) {
    lines.push(`  Check if existing rules cover this case: ${match.rules.join(', ')}`);
  }
  lines.push('  If genuinely new: create incident + prevention rule + enforcement.');
  writeHookContext(HOOK_EVENT, lines.join('\n'));
}

function outputNewPattern(fileName: string, match: FailureClassMatch | null): void {
  const lines: string[] = [];
  lines.push('');
  if (match && match.score > 0) {
    lines.push(`[NEW PATTERN] No known failure class matches this fix in ${fileName} (best: ${match.name}, score: ${match.score}).`);
  } else {
    lines.push(`[NEW PATTERN] Bug fix detected in ${fileName} — no failure classes in taxonomy yet.`);
  }
  lines.push('  Full incident loop required:');
  lines.push('    1. INCIDENT REPORT');
  lines.push('    2. PREVENTION RULE (if new failure pattern)');
  lines.push('    3. ENFORCEMENT (hook or static check)');
  writeHookContext(HOOK_EVENT, lines.join('\n'));
}

interface FailureClassMatch {
  name: string;
  score: number;
  incidentCount: number;
  rules: string[];
  knownMessage: string;
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
