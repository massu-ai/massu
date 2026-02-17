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

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: string;
}

// In-memory dedup for Read calls within this session
const seenReads = new Set<string>();
let currentSessionId: string | null = null;

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const { session_id, tool_name, tool_input, tool_response } = hookInput;

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

      // Auto-detect plan progress
      if (tool_response) {
        const progress = detectPlanProgress(tool_response);
        if (progress.length > 0) {
          // Update plan_progress in session summary
          updatePlanProgress(db, session_id, progress);
        }
      }
    } finally {
      db.close();
    }
  } catch (_e) {
    // Best-effort: never block Claude Code
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
