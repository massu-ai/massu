#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P3-006: PreCompact State Snapshot Hook
// Captures current session state into DB before compaction destroys context.
// ============================================================

import { getMemoryDb, addSummary, createSession } from '../memory-db.ts';
import type { SessionSummary } from '../memory-db.ts';

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const { session_id } = hookInput;

    const db = getMemoryDb();
    try {
      // Ensure session exists
      createSession(db, session_id);

      // 1. Get all observations for this session
      const observations = db.prepare(
        'SELECT * FROM observations WHERE session_id = ? ORDER BY created_at_epoch ASC'
      ).all(session_id) as Array<Record<string, unknown>>;

      // 2. Get user prompts
      const prompts = db.prepare(
        'SELECT prompt_text FROM user_prompts WHERE session_id = ? ORDER BY prompt_number ASC'
      ).all(session_id) as Array<{ prompt_text: string }>;

      // 3. Generate mid-session summary snapshot
      const summary = buildSnapshotSummary(observations, prompts);

      // 4. Store with pre_compact marker in plan_progress
      addSummary(db, session_id, summary);
    } finally {
      db.close();
    }
  } catch (_e) {
    // Best-effort: never block Claude Code
  }
  process.exit(0);
}

function buildSnapshotSummary(
  observations: Array<Record<string, unknown>>,
  prompts: Array<{ prompt_text: string }>
): SessionSummary {
  const request = prompts[0]?.prompt_text?.slice(0, 500) ?? undefined;

  const completed = observations
    .filter(o => ['feature', 'bugfix', 'refactor'].includes(o.type as string))
    .map(o => `- ${o.title}`)
    .join('\n');

  const failedAttempts = observations
    .filter(o => o.type === 'failed_attempt')
    .map(o => `- ${o.title}`)
    .join('\n');

  const decisions = observations
    .filter(o => o.type === 'decision')
    .map(o => `- ${o.title}`)
    .join('\n');

  // Collect file changes
  const filesCreated: string[] = [];
  const filesModified: string[] = [];
  for (const o of observations) {
    if (o.type !== 'file_change') continue;
    const files = safeParseJson(o.files_involved as string, []) as string[];
    const title = o.title as string;
    if (title.startsWith('Created')) filesCreated.push(...files);
    else if (title.startsWith('Edited')) filesModified.push(...files);
  }

  // Collect plan progress
  const planProgress: Record<string, string> = { snapshot_type: 'pre_compact' };
  for (const o of observations) {
    if (!o.plan_item) continue;
    planProgress[o.plan_item as string] = 'in_progress';
  }

  // Verification results
  const verificationResults: Record<string, string> = {};
  for (const o of observations) {
    if (o.type !== 'vr_check') continue;
    const vrType = o.vr_type as string;
    const passed = (o.title as string).includes('PASS');
    if (vrType) verificationResults[vrType] = passed ? 'PASS' : 'FAIL';
  }

  return {
    request,
    completed: completed || undefined,
    failedAttempts: failedAttempts || undefined,
    decisions: decisions || undefined,
    filesCreated: [...new Set(filesCreated)],
    filesModified: [...new Set(filesModified)],
    verificationResults,
    planProgress,
  };
}

function safeParseJson(json: string, fallback: unknown): unknown {
  try {
    return JSON.parse(json);
  } catch (_e) {
    return fallback;
  }
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

main();
