// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';

// ============================================================
// P5-001: CURRENT.md Generator
// ============================================================

/**
 * Generate CURRENT.md content from memory database.
 * Replaces manual session state maintenance.
 */
export function generateCurrentMd(db: Database.Database, sessionId: string): string {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
  if (!session) return '# Session State\n\nNo active session found.\n';

  const observations = db.prepare(
    'SELECT * FROM observations WHERE session_id = ? ORDER BY created_at_epoch ASC'
  ).all(sessionId) as Array<Record<string, unknown>>;

  const summary = db.prepare(
    'SELECT * FROM session_summaries WHERE session_id = ? ORDER BY created_at_epoch DESC LIMIT 1'
  ).get(sessionId) as Record<string, unknown> | undefined;

  const prompts = db.prepare(
    'SELECT prompt_text FROM user_prompts WHERE session_id = ? ORDER BY prompt_number ASC LIMIT 1'
  ).all(sessionId) as Array<{ prompt_text: string }>;

  const date = new Date().toISOString().split('T')[0];
  const firstPrompt = prompts[0]?.prompt_text ?? 'Unknown task';
  const taskSummary = firstPrompt.slice(0, 100).replace(/\n/g, ' ');

  const lines: string[] = [];
  lines.push(`# Session State - ${formatDate(date)}`);
  lines.push('');
  lines.push(`**Last Updated**: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} (auto-generated from massu-memory)`);
  lines.push(`**Status**: ${session.status === 'active' ? 'IN PROGRESS' : (session.status as string).toUpperCase()} - ${taskSummary}`);
  lines.push(`**Task**: ${taskSummary}`);
  lines.push(`**Session ID**: ${sessionId}`);
  lines.push(`**Branch**: ${session.git_branch ?? 'unknown'}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Completed work
  const completedObs = observations.filter(o =>
    ['feature', 'bugfix', 'refactor', 'file_change'].includes(o.type as string)
  );
  if (completedObs.length > 0 || summary) {
    lines.push('## COMPLETED WORK');
    lines.push('');

    if (summary?.completed) {
      lines.push(summary.completed as string);
      lines.push('');
    }

    // Files created
    const filesCreated = observations
      .filter(o => o.type === 'file_change' && (o.title as string).startsWith('Created'))
      .map(o => {
        const files = safeParseJson(o.files_involved as string, []) as string[];
        return files[0] ?? (o.title as string).replace('Created/wrote: ', '');
      });

    if (filesCreated.length > 0) {
      lines.push('### Files Created');
      lines.push('');
      lines.push('| File | Purpose |');
      lines.push('|------|---------|');
      for (const f of filesCreated) {
        lines.push(`| \`${f}\` | |`);
      }
      lines.push('');
    }

    // Files modified
    const filesModified = observations
      .filter(o => o.type === 'file_change' && (o.title as string).startsWith('Edited'))
      .map(o => {
        const files = safeParseJson(o.files_involved as string, []) as string[];
        return files[0] ?? (o.title as string).replace('Edited: ', '');
      });

    if (filesModified.length > 0) {
      lines.push('### Files Modified');
      lines.push('');
      lines.push('| File | Change |');
      lines.push('|------|--------|');
      for (const f of [...new Set(filesModified)]) {
        lines.push(`| \`${f}\` | |`);
      }
      lines.push('');
    }
  }

  // Key decisions
  const decisions = observations.filter(o => o.type === 'decision');
  if (decisions.length > 0) {
    lines.push('### Key Decisions');
    lines.push('');
    for (const d of decisions) {
      lines.push(`- ${d.title}`);
    }
    lines.push('');
  }

  // Failed attempts
  const failures = observations.filter(o => o.type === 'failed_attempt');
  if (failures.length > 0) {
    lines.push('## FAILED ATTEMPTS (DO NOT RETRY)');
    lines.push('');
    for (const f of failures) {
      lines.push(`- ${f.title}`);
      if (f.detail) lines.push(`  ${(f.detail as string).slice(0, 200)}`);
    }
    lines.push('');
  }

  // Verification evidence
  const vrChecks = observations.filter(o => o.type === 'vr_check');
  if (vrChecks.length > 0) {
    lines.push('## VERIFICATION EVIDENCE');
    lines.push('');
    for (const v of vrChecks) {
      lines.push(`- ${v.title}`);
    }
    lines.push('');
  }

  // Pending / next steps
  if (summary?.next_steps) {
    lines.push('## PENDING');
    lines.push('');
    lines.push(summary.next_steps as string);
    lines.push('');
  }

  // Plan document
  if (session.plan_file) {
    lines.push('## PLAN DOCUMENT');
    lines.push('');
    lines.push(`\`${session.plan_file}\``);

    // Show plan progress if available
    if (summary?.plan_progress) {
      const progress = safeParseJson(summary.plan_progress as string, {}) as Record<string, string>;
      const total = Object.keys(progress).length;
      const complete = Object.values(progress).filter(v => v === 'complete').length;
      if (total > 0) {
        lines.push(`- Progress: ${complete}/${total} items complete`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatDate(dateStr: string): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${months[month - 1]} ${day}, ${year}`;
}

function safeParseJson(json: string, fallback: unknown): unknown {
  try {
    return JSON.parse(json);
  } catch (_e) {
    return fallback;
  }
}
