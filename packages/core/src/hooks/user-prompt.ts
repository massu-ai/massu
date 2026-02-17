#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P3-004: UserPromptSubmit Hook
// Captures user prompts for search and context.
// ============================================================

import { getMemoryDb, createSession, addUserPrompt, linkSessionToTask, autoDetectTaskId } from '../memory-db.ts';

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  prompt: string;
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const { session_id, prompt } = hookInput;

    if (!prompt || !prompt.trim()) {
      process.exit(0);
      return;
    }

    const db = getMemoryDb();
    try {
      // 1. Create session if not exists
      const gitBranch = await getGitBranch();
      createSession(db, session_id, { branch: gitBranch });

      // 2. Scan prompt for plan file references
      const planFileMatch = prompt.match(/([^\s]+docs\/plans\/[^\s]+\.md)/);
      if (planFileMatch) {
        const planFile = planFileMatch[1];
        db.prepare('UPDATE sessions SET plan_file = ? WHERE session_id = ?').run(planFile, session_id);

        // Auto-detect and link task_id
        const taskId = autoDetectTaskId(planFile);
        if (taskId) {
          linkSessionToTask(db, session_id, taskId);
        }
      }

      // 3. Get current prompt count for this session
      const countResult = db.prepare(
        'SELECT COUNT(*) as count FROM user_prompts WHERE session_id = ?'
      ).get(session_id) as { count: number };
      const promptNumber = countResult.count + 1;

      // 4. Insert prompt
      addUserPrompt(db, session_id, prompt.trim(), promptNumber);
    } finally {
      db.close();
    }
  } catch (_e) {
    // Best-effort: never block Claude Code
  }
  process.exit(0);
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
    setTimeout(() => resolve(data), 3000);
  });
}

main();
