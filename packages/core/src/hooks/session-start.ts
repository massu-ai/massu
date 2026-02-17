#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P3-001: Enhanced SessionStart Hook
// Injects context from previous sessions into new sessions.
// Output: plain text to stdout (auto-injected by Claude Code)
// ============================================================

import { getMemoryDb, getSessionSummaries, getRecentObservations, getFailedAttempts, getCrossTaskProgress, autoDetectTaskId, linkSessionToTask, createSession } from '../memory-db.ts';
import { getConfig } from '../config.ts';
import type Database from 'better-sqlite3';

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

      // Build context
      const context = buildContext(db, session_id, source ?? 'startup', tokenBudget, session?.task_id ?? null);

      if (context.trim()) {
        process.stdout.write(context);
      }
    } finally {
      db.close();
    }
  } catch (_e) {
    // Best-effort: never block Claude Code
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

function buildContext(db: Database.Database, sessionId: string, source: string, tokenBudget: number, taskId: string | null): string {
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

  // 5. Recent observations sorted by importance
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
  const headerTokens = estimateTokens('=== CS MEMORY: Previous Session Context ===\n\n=== END CS MEMORY ===\n');
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

  return `=== CS MEMORY: Previous Session Context ===\n\n${includedSections.join('\n')}\n=== END CS MEMORY ===\n`;
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

function safeParseJson(json: string): Record<string, string> | null {
  try {
    return JSON.parse(json);
  } catch (_e) {
    return null;
  }
}

main();
