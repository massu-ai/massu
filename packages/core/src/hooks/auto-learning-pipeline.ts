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

// P-H002 (plan-stage-c-high-batch): bound git-diff reads so monorepos with
// 10MB+ working trees don't trigger Stop-hook timeout. Short-stat first,
// only read full diff body when estimated bytes <= cap. execFileSync argv
// form is defense-in-depth (P-001 pattern).
// Exported so the DG-2 drift-guard binds to THIS value rather than restating
// it — a second copy of a cap is a cap that drifts.
export const MAX_FULL_DIFF_BYTES = 2 * 1024 * 1024; // 2MB; ~25k lines at 80 bytes/line

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

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const config = getConfig();

    // Check if auto-learning is enabled
    if (config.autoLearning?.enabled === false) {
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
    let uncommittedFix = false;
    try {
      const nameOnly = execFileSync('git', ['diff', '--name-only'], {
        cwd: root,
        timeout: 3000,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      if (nameOnly.trim()) {
        const shortstat = execFileSync('git', ['diff', '--shortstat'], {
          cwd: root,
          timeout: 2000,
          encoding: 'utf-8',
          maxBuffer: 64 * 1024,
        });
        const insertions = parseInt(shortstat.match(/(\d+) insertion/)?.[1] ?? '0', 10);
        const deletions = parseInt(shortstat.match(/(\d+) deletion/)?.[1] ?? '0', 10);
        const estimatedBytes = (insertions + deletions) * 80; // ~80 bytes/line avg
        if (estimatedBytes <= MAX_FULL_DIFF_BYTES) {
          const fullDiff = execFileSync('git', ['diff'], {
            cwd: root,
            timeout: 5000,
            encoding: 'utf-8',
            maxBuffer: MAX_FULL_DIFF_BYTES,
          });
          const fixPatterns = (fullDiff.match(/^\+.*(try|except|catch|guard|throw|raise|assert|validate|if.*null|if.*nil|if.*None|if.*undefined)/gm) || []).length;
          const removedBroken = (fullDiff.match(/^-.*(bug|broken|crash|wrong|incorrect|typo|fail|error|miss|stale)/gm) || []).length;
          if (fixPatterns > 3 || removedBroken > 1) {
            uncommittedFix = true;
          }
        }
        // else: diff exceeds cap — skip pattern scan rather than risk timeout.
        // The fix-detector hook fires on per-Edit/Write and already populates
        // sessionFixes for the realistic case; full-diff fallback is a safety
        // net that we can correctly skip for huge trees.
      }
    } catch { /* git not available or no changes or buffer overflow */ }

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

    lines.push('');
    lines.push('  Complete these steps before this session ends:');
    lines.push('');

    if (autoLearn?.pipeline?.requireIncidentReport !== false) {
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

main();
