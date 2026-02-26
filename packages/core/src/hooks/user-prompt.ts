#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P3-004: UserPromptSubmit Hook
// Captures user prompts for search and context.
// ============================================================

import { getMemoryDb, createSession, addUserPrompt, linkSessionToTask, autoDetectTaskId, addObservation } from '../memory-db.ts';
import { existsSync } from 'fs';
import { getResolvedPaths } from '../config.ts';

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

      // 5. Knowledge-aware prompt enrichment: detect file references and check knowledge index
      try {
        const fileRefs = extractFileReferences(prompt);
        if (fileRefs.length > 0) {
          const knowledgeDbPath = getResolvedPaths().knowledgeDbPath;
          if (knowledgeDbPath && existsSync(knowledgeDbPath)) {
            const Database = (await import('better-sqlite3')).default;
            const kdb = new Database(knowledgeDbPath, { readonly: true });
            try {
              const placeholders = fileRefs.map(() => '?').join(',');
              const matches = kdb.prepare(
                `SELECT DISTINCT file_path FROM knowledge_documents WHERE file_path IN (${placeholders})`
              ).all(...fileRefs) as Array<{ file_path: string }>;
              if (matches.length > 0) {
                addObservation(db, session_id, 'discovery',
                  `Knowledge entries exist for referenced files`,
                  `Files with knowledge context: ${matches.map(m => m.file_path).join(', ')}`,
                  { importance: 2 }
                );
              }
            } finally {
              kdb.close();
            }
          }
        }
      } catch (_knowledgeErr) {
        // Best-effort: never block prompt capture
      }
    } finally {
      db.close();
    }
  } catch (_e) {
    // Best-effort: never block Claude Code
  }
  process.exit(0);
}

/**
 * Extract file path references from user prompt text.
 * Matches patterns like src/foo/bar.ts, packages/core/src/x.ts, etc.
 */
function extractFileReferences(prompt: string): string[] {
  const filePattern = /(?:^|\s)((?:src|packages|lib)\/[\w./-]+\.(?:ts|tsx|js|jsx|md))/g;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(prompt)) !== null) {
    matches.push(match[1]);
  }
  return [...new Set(matches)];
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
