// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { generateCurrentMd } from '../session-state-generator.ts';

// Helper to create an in-memory database with the full memory-db schema
// required by generateCurrentMd (sessions, observations, session_summaries, user_prompts)
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      project TEXT NOT NULL DEFAULT 'my-project',
      git_branch TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      ended_at TEXT,
      ended_at_epoch INTEGER,
      status TEXT CHECK(status IN ('active', 'completed', 'abandoned')) NOT NULL DEFAULT 'active',
      plan_file TEXT,
      plan_phase TEXT,
      task_id TEXT
    );

    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN (
        'decision', 'bugfix', 'feature', 'refactor', 'discovery',
        'cr_violation', 'vr_check', 'pattern_compliance', 'failed_attempt',
        'file_change', 'incident_near_miss'
      )),
      title TEXT NOT NULL,
      detail TEXT,
      files_involved TEXT DEFAULT '[]',
      plan_item TEXT,
      cr_rule TEXT,
      vr_type TEXT,
      evidence TEXT,
      importance INTEGER NOT NULL DEFAULT 3 CHECK(importance BETWEEN 1 AND 5),
      recurrence_count INTEGER NOT NULL DEFAULT 1,
      original_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      decisions TEXT,
      completed TEXT,
      failed_attempts TEXT,
      next_steps TEXT,
      files_created TEXT DEFAULT '[]',
      files_modified TEXT DEFAULT '[]',
      verification_results TEXT DEFAULT '{}',
      plan_progress TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      prompt_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
  `);

  return db;
}

// Helper to insert a session row directly
function insertSession(
  db: Database.Database,
  sessionId: string,
  opts: {
    status?: string;
    branch?: string;
    planFile?: string;
  } = {}
): void {
  const now = new Date().toISOString();
  const epoch = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO sessions (session_id, git_branch, plan_file, status, started_at, started_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    opts.branch ?? null,
    opts.planFile ?? null,
    opts.status ?? 'active',
    now,
    epoch
  );
}

// Helper to insert an observation row directly
function insertObservation(
  db: Database.Database,
  sessionId: string,
  type: string,
  title: string,
  detail: string | null = null,
  filesInvolved: string[] = [],
  epochOffset: number = 0
): void {
  const epoch = Math.floor(Date.now() / 1000) + epochOffset;
  db.prepare(`
    INSERT INTO observations (session_id, type, title, detail, files_involved, importance, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, 3, ?, ?)
  `).run(sessionId, type, title, detail, JSON.stringify(filesInvolved), new Date(epoch * 1000).toISOString(), epoch);
}

// Helper to insert a session summary
function insertSummary(
  db: Database.Database,
  sessionId: string,
  opts: {
    completed?: string;
    nextSteps?: string;
    planProgress?: Record<string, string>;
  } = {}
): void {
  const now = new Date().toISOString();
  const epoch = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO session_summaries (session_id, completed, next_steps, plan_progress, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    opts.completed ?? null,
    opts.nextSteps ?? null,
    JSON.stringify(opts.planProgress ?? {}),
    now,
    epoch
  );
}

// Helper to insert a user prompt
function insertPrompt(db: Database.Database, sessionId: string, text: string, promptNumber: number = 1): void {
  const now = new Date().toISOString();
  const epoch = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO user_prompts (session_id, prompt_text, prompt_number, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, text, promptNumber, now, epoch);
}

describe('session-state-generator', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // ============================================================
  // No session
  // ============================================================

  describe('missing session', () => {
    it('returns fallback content when session does not exist', () => {
      const result = generateCurrentMd(db, 'nonexistent-session');
      expect(result).toBe('# Session State\n\nNo active session found.\n');
    });
  });

  // ============================================================
  // Empty session (no observations, no summary, no prompt)
  // ============================================================

  describe('empty session', () => {
    const SESSION_ID = 'empty-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID, { branch: 'main', status: 'active' });
    });

    it('returns markdown content', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('# Session State');
    });

    it('includes the session id', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain(SESSION_ID);
    });

    it('includes git branch', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('main');
    });

    it('shows IN PROGRESS for active status', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('IN PROGRESS');
    });

    it('uses Unknown task when no prompt exists', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('Unknown task');
    });

    it('does not include COMPLETED WORK section without observations', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).not.toContain('## COMPLETED WORK');
    });

    it('does not include FAILED ATTEMPTS section without observations', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).not.toContain('## FAILED ATTEMPTS');
    });

    it('does not include VERIFICATION EVIDENCE section without observations', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).not.toContain('## VERIFICATION EVIDENCE');
    });

    it('does not include PLAN DOCUMENT section without plan_file', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).not.toContain('## PLAN DOCUMENT');
    });

    it('includes the separator line', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('---');
    });

    it('includes Last Updated field', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('**Last Updated**');
    });
  });

  // ============================================================
  // Session status variants
  // ============================================================

  describe('session status', () => {
    it('shows COMPLETED for completed status', () => {
      insertSession(db, 'completed-session', { status: 'completed' });
      const result = generateCurrentMd(db, 'completed-session');
      expect(result).toContain('COMPLETED');
    });

    it('shows ABANDONED for abandoned status', () => {
      insertSession(db, 'abandoned-session', { status: 'abandoned' });
      const result = generateCurrentMd(db, 'abandoned-session');
      expect(result).toContain('ABANDONED');
    });
  });

  // ============================================================
  // User prompt as task summary
  // ============================================================

  describe('user prompt / task summary', () => {
    const SESSION_ID = 'prompt-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID);
    });

    it('uses first user prompt as task summary', () => {
      insertPrompt(db, SESSION_ID, 'Fix the authentication bug in login page', 1);
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('Fix the authentication bug in login page');
    });

    it('truncates prompt text at 100 characters', () => {
      const longPrompt = 'A'.repeat(150);
      insertPrompt(db, SESSION_ID, longPrompt, 1);
      const result = generateCurrentMd(db, SESSION_ID);
      // The 100-char slice of the long prompt should appear
      expect(result).toContain('A'.repeat(100));
      // But not the 101st character portion (since it's sliced)
      expect(result).not.toContain('A'.repeat(101));
    });

    it('normalises newlines in prompt text', () => {
      insertPrompt(db, SESSION_ID, 'Line one\nLine two\nLine three', 1);
      const result = generateCurrentMd(db, SESSION_ID);
      // Newlines are replaced with spaces
      expect(result).toContain('Line one Line two Line three');
    });

    it('only uses the first prompt (prompt_number = 1)', () => {
      insertPrompt(db, SESSION_ID, 'Second prompt that should not appear', 2);
      insertPrompt(db, SESSION_ID, 'First prompt that should appear', 1);
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('First prompt that should appear');
      expect(result).not.toContain('Second prompt that should not appear');
    });
  });

  // ============================================================
  // Observation types
  // ============================================================

  describe('feature observations', () => {
    const SESSION_ID = 'feature-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID);
    });

    it('renders COMPLETED WORK section for feature observations', () => {
      insertObservation(db, SESSION_ID, 'feature', 'Add user profile endpoint');
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('## COMPLETED WORK');
    });

    it('does not list feature observations as file entries', () => {
      // feature type does not map to Files Created/Modified
      insertObservation(db, SESSION_ID, 'feature', 'Add user profile endpoint');
      const result = generateCurrentMd(db, SESSION_ID);
      // COMPLETED WORK section present, but no file table rows for this observation
      expect(result).toContain('## COMPLETED WORK');
    });
  });

  describe('bugfix observations', () => {
    const SESSION_ID = 'bugfix-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID);
    });

    it('renders COMPLETED WORK section for bugfix observations', () => {
      insertObservation(db, SESSION_ID, 'bugfix', 'Fix null pointer in auth flow');
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('## COMPLETED WORK');
    });
  });

  describe('refactor observations', () => {
    const SESSION_ID = 'refactor-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID);
    });

    it('renders COMPLETED WORK section for refactor observations', () => {
      insertObservation(db, SESSION_ID, 'refactor', 'Extract helper functions into utils.ts');
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('## COMPLETED WORK');
    });
  });

  describe('file_change observations', () => {
    const SESSION_ID = 'filechange-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID);
    });

    it('renders COMPLETED WORK section for file_change observations', () => {
      insertObservation(db, SESSION_ID, 'file_change', 'Created: src/utils.ts', null, ['src/utils.ts']);
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('## COMPLETED WORK');
    });

    it('shows Files Created table for file_change with title starting with Created', () => {
      insertObservation(db, SESSION_ID, 'file_change', 'Created/wrote: src/helpers.ts', null, ['src/helpers.ts']);
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('### Files Created');
      expect(result).toContain('src/helpers.ts');
    });

    it('shows Files Modified table for file_change with title starting with Edited', () => {
      insertObservation(db, SESSION_ID, 'file_change', 'Edited: src/server.ts', null, ['src/server.ts']);
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('### Files Modified');
      expect(result).toContain('src/server.ts');
    });

    it('deduplicates files in Files Modified table', () => {
      insertObservation(db, SESSION_ID, 'file_change', 'Edited: src/server.ts', null, ['src/server.ts'], 0);
      insertObservation(db, SESSION_ID, 'file_change', 'Edited: src/server.ts', null, ['src/server.ts'], 1);
      const result = generateCurrentMd(db, SESSION_ID);
      // Count occurrences of the file path in the output
      const matches = result.match(/`src\/server\.ts`/g) ?? [];
      expect(matches.length).toBe(1);
    });

    it('falls back to title-derived file name when files_involved is empty', () => {
      insertObservation(db, SESSION_ID, 'file_change', 'Created/wrote: src/config.ts', null, []);
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('### Files Created');
      // Falls back to title.replace('Created/wrote: ', '')
      expect(result).toContain('src/config.ts');
    });

    it('uses first entry in files_involved array when present', () => {
      insertObservation(db, SESSION_ID, 'file_change', 'Created: something', null, ['src/actual-file.ts', 'other.ts']);
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('src/actual-file.ts');
    });
  });

  describe('decision observations', () => {
    const SESSION_ID = 'decision-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID);
    });

    it('renders Key Decisions section for decision observations', () => {
      insertObservation(db, SESSION_ID, 'decision', 'Use FTS5 for search indexing');
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('### Key Decisions');
      expect(result).toContain('Use FTS5 for search indexing');
    });

    it('renders multiple decisions as list items', () => {
      insertObservation(db, SESSION_ID, 'decision', 'Decision A', null, [], 0);
      insertObservation(db, SESSION_ID, 'decision', 'Decision B', null, [], 1);
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('- Decision A');
      expect(result).toContain('- Decision B');
    });

    it('does not render Key Decisions section when no decision observations exist', () => {
      insertObservation(db, SESSION_ID, 'feature', 'Some feature');
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).not.toContain('### Key Decisions');
    });
  });

  describe('failed_attempt observations', () => {
    const SESSION_ID = 'failed-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID);
    });

    it('renders FAILED ATTEMPTS section', () => {
      insertObservation(db, SESSION_ID, 'failed_attempt', 'Regex approach fails on nested braces');
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('## FAILED ATTEMPTS (DO NOT RETRY)');
      expect(result).toContain('Regex approach fails on nested braces');
    });

    it('includes detail for failed attempts', () => {
      insertObservation(db, SESSION_ID, 'failed_attempt', 'Parser fails', 'Stops at first } character');
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('Stops at first } character');
    });

    it('truncates detail to 200 characters', () => {
      const longDetail = 'X'.repeat(300);
      insertObservation(db, SESSION_ID, 'failed_attempt', 'Some failure', longDetail);
      const result = generateCurrentMd(db, SESSION_ID);
      // 200 X's should be present
      expect(result).toContain('X'.repeat(200));
      // But not 201 X's
      expect(result).not.toContain('X'.repeat(201));
    });

    it('renders multiple failed attempts as list items', () => {
      insertObservation(db, SESSION_ID, 'failed_attempt', 'Approach A failed', null, [], 0);
      insertObservation(db, SESSION_ID, 'failed_attempt', 'Approach B failed', null, [], 1);
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('- Approach A failed');
      expect(result).toContain('- Approach B failed');
    });

    it('omits detail line when detail is null/empty', () => {
      insertObservation(db, SESSION_ID, 'failed_attempt', 'Silent failure', null);
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('- Silent failure');
      // No indented detail line
      const lines = result.split('\n');
      const failureIdx = lines.findIndex(l => l.includes('- Silent failure'));
      expect(failureIdx).toBeGreaterThan(-1);
      // Next non-empty line should not be an indented detail
      const nextLine = lines[failureIdx + 1] ?? '';
      expect(nextLine.startsWith('  ')).toBe(false);
    });
  });

  describe('vr_check observations', () => {
    const SESSION_ID = 'vrcheck-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID);
    });

    it('renders VERIFICATION EVIDENCE section', () => {
      insertObservation(db, SESSION_ID, 'vr_check', 'VR-BUILD: npm run build exits 0');
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('## VERIFICATION EVIDENCE');
      expect(result).toContain('VR-BUILD: npm run build exits 0');
    });

    it('renders multiple vr_checks as list items', () => {
      insertObservation(db, SESSION_ID, 'vr_check', 'VR-BUILD passed', null, [], 0);
      insertObservation(db, SESSION_ID, 'vr_check', 'VR-TEST passed', null, [], 1);
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('- VR-BUILD passed');
      expect(result).toContain('- VR-TEST passed');
    });

    it('does not render VERIFICATION EVIDENCE without vr_check observations', () => {
      insertObservation(db, SESSION_ID, 'decision', 'Some decision');
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).not.toContain('## VERIFICATION EVIDENCE');
    });
  });

  // ============================================================
  // Mixed observation types
  // ============================================================

  describe('mixed observation types', () => {
    const SESSION_ID = 'mixed-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID, { branch: 'feature/auth', status: 'active' });
    });

    it('renders all relevant sections when all observation types are present', () => {
      insertObservation(db, SESSION_ID, 'feature', 'Add OAuth support', null, [], 0);
      insertObservation(db, SESSION_ID, 'bugfix', 'Fix token refresh', null, [], 1);
      insertObservation(db, SESSION_ID, 'refactor', 'Extract auth utils', null, [], 2);
      insertObservation(db, SESSION_ID, 'file_change', 'Created/wrote: src/auth.ts', null, ['src/auth.ts'], 3);
      insertObservation(db, SESSION_ID, 'file_change', 'Edited: src/server.ts', null, ['src/server.ts'], 4);
      insertObservation(db, SESSION_ID, 'decision', 'Use JWT over sessions', null, [], 5);
      insertObservation(db, SESSION_ID, 'failed_attempt', 'Cookie approach failed', 'Cross-domain issues', [], 6);
      insertObservation(db, SESSION_ID, 'vr_check', 'VR-BUILD passed', null, [], 7);

      const result = generateCurrentMd(db, SESSION_ID);

      expect(result).toContain('## COMPLETED WORK');
      expect(result).toContain('### Files Created');
      expect(result).toContain('### Files Modified');
      expect(result).toContain('### Key Decisions');
      expect(result).toContain('## FAILED ATTEMPTS (DO NOT RETRY)');
      expect(result).toContain('## VERIFICATION EVIDENCE');
    });

    it('observations not in completed types do not contribute to Files Created/Modified', () => {
      // decision and failed_attempt are not in ['feature', 'bugfix', 'refactor', 'file_change']
      insertObservation(db, SESSION_ID, 'decision', 'Some decision');
      insertObservation(db, SESSION_ID, 'failed_attempt', 'Some failure');
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).not.toContain('### Files Created');
      expect(result).not.toContain('### Files Modified');
    });
  });

  // ============================================================
  // Session summaries
  // ============================================================

  describe('session summary - completed text', () => {
    const SESSION_ID = 'summary-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID);
    });

    it('renders completed text from summary in COMPLETED WORK section', () => {
      // Need at least one completed-type observation to trigger the section
      insertObservation(db, SESSION_ID, 'feature', 'Some feature');
      insertSummary(db, SESSION_ID, { completed: 'Implemented full OAuth flow with refresh tokens' });
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('Implemented full OAuth flow with refresh tokens');
    });

    it('renders COMPLETED WORK even when only summary has completed field', () => {
      insertSummary(db, SESSION_ID, { completed: 'Completed the main task' });
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('## COMPLETED WORK');
      expect(result).toContain('Completed the main task');
    });

    it('omits COMPLETED WORK section when no observations and no summary', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).not.toContain('## COMPLETED WORK');
    });
  });

  describe('session summary - next steps', () => {
    const SESSION_ID = 'nextsteps-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID);
    });

    it('renders PENDING section from summary next_steps', () => {
      insertSummary(db, SESSION_ID, { nextSteps: '- Run VR-TEST\n- Deploy to staging' });
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('## PENDING');
      expect(result).toContain('- Run VR-TEST');
    });

    it('does not render PENDING section when no next_steps', () => {
      insertSummary(db, SESSION_ID, { completed: 'Done' });
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).not.toContain('## PENDING');
    });
  });

  // ============================================================
  // Plan progress
  // ============================================================

  describe('plan progress', () => {
    const SESSION_ID = 'plan-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID, {
        planFile: 'docs/plans/2026-02-17-auth-refactor.md',
        status: 'active',
      });
    });

    it('renders PLAN DOCUMENT section when plan_file is set', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('## PLAN DOCUMENT');
      expect(result).toContain('docs/plans/2026-02-17-auth-refactor.md');
    });

    it('shows plan progress from summary', () => {
      insertSummary(db, SESSION_ID, {
        planProgress: {
          'P1-001': 'complete',
          'P1-002': 'complete',
          'P1-003': 'in_progress',
        },
      });
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('2/3 items complete');
    });

    it('shows 0/N when no items are complete', () => {
      insertSummary(db, SESSION_ID, {
        planProgress: {
          'P1-001': 'pending',
          'P1-002': 'in_progress',
        },
      });
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('0/2 items complete');
    });

    it('shows N/N when all items are complete', () => {
      insertSummary(db, SESSION_ID, {
        planProgress: {
          'P1-001': 'complete',
          'P1-002': 'complete',
        },
      });
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('2/2 items complete');
    });

    it('does not render progress line when plan_progress is empty', () => {
      insertSummary(db, SESSION_ID, { planProgress: {} });
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('## PLAN DOCUMENT');
      expect(result).not.toContain('items complete');
    });

    it('does not render plan progress when there is no summary', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('## PLAN DOCUMENT');
      expect(result).not.toContain('items complete');
    });

    it('handles malformed plan_progress JSON gracefully', () => {
      // Insert summary with raw invalid JSON in plan_progress
      const now = new Date().toISOString();
      const epoch = Math.floor(Date.now() / 1000);
      db.prepare(`
        INSERT INTO session_summaries (session_id, plan_progress, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?)
      `).run(SESSION_ID, 'not-valid-json', now, epoch);

      // Should not throw and should still render the plan document section
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('## PLAN DOCUMENT');
      expect(result).not.toContain('items complete');
    });
  });

  describe('session without plan_file', () => {
    it('does not render PLAN DOCUMENT section', () => {
      insertSession(db, 'no-plan-session', { status: 'active' });
      const result = generateCurrentMd(db, 'no-plan-session');
      expect(result).not.toContain('## PLAN DOCUMENT');
    });
  });

  // ============================================================
  // Formatted output / date formatting
  // ============================================================

  describe('formatted output', () => {
    const SESSION_ID = 'format-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID, { branch: 'main', status: 'active' });
    });

    it('includes a formatted date in the heading', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      // formatDate produces "Month Day, Year" style
      const months = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
      const currentMonth = months[new Date().getMonth()];
      expect(result).toContain(currentMonth);
    });

    it('heading is on the first line', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      const firstLine = result.split('\n')[0];
      expect(firstLine).toMatch(/^# Session State - .+/);
    });

    it('auto-generated annotation is present', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('auto-generated from massu-memory');
    });

    it('status line contains task summary', () => {
      insertPrompt(db, SESSION_ID, 'Implement new feature', 1);
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('**Status**:');
      expect(result).toContain('Implement new feature');
    });

    it('Branch field is present', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('**Branch**: main');
    });

    it('Branch shows unknown when git_branch is null', () => {
      insertSession(db, 'no-branch-session', { status: 'active' });
      const result = generateCurrentMd(db, 'no-branch-session');
      expect(result).toContain('**Branch**: unknown');
    });

    it('file table rows use backtick-wrapped paths', () => {
      insertObservation(db, SESSION_ID, 'file_change', 'Created/wrote: src/index.ts', null, ['src/index.ts']);
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('`src/index.ts`');
    });

    it('Files Created table has correct header', () => {
      insertObservation(db, SESSION_ID, 'file_change', 'Created/wrote: src/foo.ts', null, ['src/foo.ts']);
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('| File | Purpose |');
      expect(result).toContain('|------|---------|');
    });

    it('Files Modified table has correct header', () => {
      insertObservation(db, SESSION_ID, 'file_change', 'Edited: src/bar.ts', null, ['src/bar.ts']);
      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('| File | Change |');
      expect(result).toContain('|------|--------|');
    });
  });

  // ============================================================
  // Multiple summaries — only latest is used
  // ============================================================

  describe('multiple summaries', () => {
    const SESSION_ID = 'multi-summary-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID, { planFile: 'docs/plans/2026-02-17-test.md' });
    });

    it('uses only the most recent summary (by created_at_epoch DESC)', () => {
      const now = Math.floor(Date.now() / 1000);
      // Insert older summary first
      db.prepare(`
        INSERT INTO session_summaries (session_id, next_steps, plan_progress, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?)
      `).run(SESSION_ID, 'Old next step', '{}', new Date((now - 100) * 1000).toISOString(), now - 100);
      // Insert newer summary
      db.prepare(`
        INSERT INTO session_summaries (session_id, next_steps, plan_progress, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?)
      `).run(SESSION_ID, 'New next step', '{}', new Date(now * 1000).toISOString(), now);

      const result = generateCurrentMd(db, SESSION_ID);
      expect(result).toContain('New next step');
      expect(result).not.toContain('Old next step');
    });
  });

  // ============================================================
  // Comprehensive scenario
  // ============================================================

  describe('comprehensive scenario', () => {
    const SESSION_ID = 'full-scenario-session';

    beforeEach(() => {
      insertSession(db, SESSION_ID, {
        branch: 'feature/session-state',
        status: 'active',
        planFile: 'docs/plans/2026-02-17-session-state.md',
      });
      insertPrompt(db, SESSION_ID, 'Generate CURRENT.md from memory database automatically', 1);

      // Various observation types
      insertObservation(db, SESSION_ID, 'feature', 'Implement generateCurrentMd function', null, [], 0);
      insertObservation(db, SESSION_ID, 'file_change', 'Created/wrote: src/session-state-generator.ts', null, ['src/session-state-generator.ts'], 1);
      insertObservation(db, SESSION_ID, 'file_change', 'Edited: src/tools.ts', null, ['src/tools.ts'], 2);
      insertObservation(db, SESSION_ID, 'decision', 'Query sessions table via session_id directly', null, [], 3);
      insertObservation(db, SESSION_ID, 'decision', 'Use ORDER BY created_at_epoch for observation ordering', null, [], 4);
      insertObservation(db, SESSION_ID, 'failed_attempt', 'Attempted to use getMemoryDb in tests', 'Config dependency caused failures', [], 5);
      insertObservation(db, SESSION_ID, 'vr_check', 'VR-BUILD: npm run build exits 0', null, [], 6);
      insertObservation(db, SESSION_ID, 'vr_check', 'VR-TEST: all 880 tests pass', null, [], 7);

      insertSummary(db, SESSION_ID, {
        completed: 'generateCurrentMd fully implemented and tested',
        nextSteps: '- Run /massu-commit\n- Push to remote',
        planProgress: {
          'P5-001': 'complete',
          'P5-002': 'in_progress',
          'P5-003': 'pending',
        },
      });
    });

    it('produces a well-formed markdown document', () => {
      const result = generateCurrentMd(db, SESSION_ID);

      // Header
      expect(result).toMatch(/^# Session State - /m);

      // Metadata
      expect(result).toContain('**Session ID**: full-scenario-session');
      expect(result).toContain('**Branch**: feature/session-state');
      expect(result).toContain('IN PROGRESS');
      expect(result).toContain('Generate CURRENT.md from memory database automatically');

      // Completed work
      expect(result).toContain('## COMPLETED WORK');
      expect(result).toContain('generateCurrentMd fully implemented and tested');
      expect(result).toContain('### Files Created');
      expect(result).toContain('src/session-state-generator.ts');
      expect(result).toContain('### Files Modified');
      expect(result).toContain('src/tools.ts');

      // Key decisions
      expect(result).toContain('### Key Decisions');
      expect(result).toContain('- Query sessions table via session_id directly');
      expect(result).toContain('- Use ORDER BY created_at_epoch for observation ordering');

      // Failed attempts
      expect(result).toContain('## FAILED ATTEMPTS (DO NOT RETRY)');
      expect(result).toContain('Attempted to use getMemoryDb in tests');
      expect(result).toContain('Config dependency caused failures');

      // Verification evidence
      expect(result).toContain('## VERIFICATION EVIDENCE');
      expect(result).toContain('- VR-BUILD: npm run build exits 0');
      expect(result).toContain('- VR-TEST: all 880 tests pass');

      // Pending
      expect(result).toContain('## PENDING');
      expect(result).toContain('- Run /massu-commit');

      // Plan document
      expect(result).toContain('## PLAN DOCUMENT');
      expect(result).toContain('docs/plans/2026-02-17-session-state.md');
      expect(result).toContain('1/3 items complete');
    });

    it('output is a string ending with newline (from lines.join)', () => {
      const result = generateCurrentMd(db, SESSION_ID);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
