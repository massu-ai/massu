// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getPromptToolDefinitions,
  isPromptTool,
  categorizePrompt,
  hashPrompt,
  detectOutcome,
  analyzeSessionPrompts,
  handlePromptToolCall,
} from '../prompt-analyzer.ts';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL
    );

    CREATE TABLE user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      prompt_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );

    CREATE TABLE prompt_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      prompt_category TEXT NOT NULL DEFAULT 'feature',
      word_count INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL DEFAULT 'success' CHECK(outcome IN ('success', 'partial', 'failure', 'abandoned')),
      corrections_needed INTEGER NOT NULL DEFAULT 0,
      follow_up_prompts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

describe('prompt-analyzer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('getPromptToolDefinitions', () => {
    it('should return tool definitions for prompt tools', () => {
      const defs = getPromptToolDefinitions();
      expect(defs.length).toBe(2);

      const names = defs.map(d => d.name);
      expect(names.some(n => n.includes('prompt_effectiveness'))).toBe(true);
      expect(names.some(n => n.includes('prompt_suggestions'))).toBe(true);

      for (const def of defs) {
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.inputSchema).toBeTruthy();
        expect(def.inputSchema.type).toBe('object');
      }
    });
  });

  describe('isPromptTool', () => {
    it('should return true for prompt tools', () => {
      expect(isPromptTool('massu_prompt_effectiveness')).toBe(true);
      expect(isPromptTool('massu_prompt_suggestions')).toBe(true);
    });

    it('should return false for non-prompt tools', () => {
      expect(isPromptTool('massu_cost_session')).toBe(false);
      expect(isPromptTool('massu_quality_score')).toBe(false);
      expect(isPromptTool('random_tool')).toBe(false);
    });

    it('should handle base names without prefix', () => {
      expect(isPromptTool('prompt_effectiveness')).toBe(true);
      expect(isPromptTool('prompt_suggestions')).toBe(true);
    });
  });

  describe('categorizePrompt', () => {
    it('should categorize bugfix prompts', () => {
      expect(categorizePrompt('Fix the bug in auth.ts')).toBe('bugfix');
      expect(categorizePrompt('There is an error in the validation')).toBe('bugfix');
      expect(categorizePrompt('The app crash on submit')).toBe('bugfix');
    });

    it('should categorize refactor prompts', () => {
      expect(categorizePrompt('Refactor the user module')).toBe('refactor');
      expect(categorizePrompt('Rename the function to be more clear')).toBe('refactor');
      expect(categorizePrompt('Extract this into a separate component')).toBe('refactor');
    });

    it('should categorize question prompts', () => {
      expect(categorizePrompt('What does this function do?')).toBe('question');
      expect(categorizePrompt('How do I implement authentication?')).toBe('question');
      expect(categorizePrompt('Explain the database schema')).toBe('question');
    });

    it('should categorize command prompts', () => {
      expect(categorizePrompt('/commit')).toBe('command');
      expect(categorizePrompt('/massu-loop')).toBe('command');
    });

    it('should categorize feature prompts', () => {
      expect(categorizePrompt('Add a new user registration form')).toBe('feature');
      expect(categorizePrompt('Create a dashboard component')).toBe('feature');
      expect(categorizePrompt('Implement password reset')).toBe('feature');
    });

    it('should default to feature for ambiguous prompts', () => {
      expect(categorizePrompt('Update the styles')).toBe('feature');
      expect(categorizePrompt('Make it better')).toBe('feature');
    });
  });

  describe('hashPrompt', () => {
    it('should generate consistent hashes for same prompt', () => {
      const hash1 = hashPrompt('Fix the bug in auth.ts');
      const hash2 = hashPrompt('Fix the bug in auth.ts');
      expect(hash1).toBe(hash2);
    });

    it('should normalize whitespace', () => {
      const hash1 = hashPrompt('Fix   the    bug');
      const hash2 = hashPrompt('Fix the bug');
      expect(hash1).toBe(hash2);
    });

    it('should be case-insensitive', () => {
      const hash1 = hashPrompt('Fix The Bug');
      const hash2 = hashPrompt('fix the bug');
      expect(hash1).toBe(hash2);
    });

    it('should return different hashes for different prompts', () => {
      const hash1 = hashPrompt('Fix the bug');
      const hash2 = hashPrompt('Add a feature');
      expect(hash1).not.toBe(hash2);
    });

    it('should return 16-character hash', () => {
      const hash = hashPrompt('Test prompt');
      expect(hash.length).toBe(16);
    });
  });

  describe('detectOutcome', () => {
    it('should detect success outcome', () => {
      const followUps = ['Great, that works!', 'Perfect, thanks'];
      const responses = ['Done.'];
      const result = detectOutcome(followUps, responses);
      expect(result.outcome).toBe('success');
      expect(result.correctionsNeeded).toBe(0);
    });

    it('should detect partial outcome with corrections', () => {
      const followUps = ['No, that\'s wrong', 'Fix this issue', 'Try again'];
      const responses = ['Updated.'];
      const result = detectOutcome(followUps, responses);
      expect(result.outcome).toBe('partial');
      expect(result.correctionsNeeded).toBeGreaterThan(0);
    });

    it('should detect abandoned outcome', () => {
      const followUps = ['Nevermind, skip this', 'Let\'s move on'];
      const responses = ['OK.'];
      const result = detectOutcome(followUps, responses);
      expect(result.outcome).toBe('abandoned');
    });

    it('should detect failure from assistant responses', () => {
      const followUps: string[] = [];
      const responses = ['Error: cannot complete', 'Failed to process'];
      const result = detectOutcome(followUps, responses);
      expect(result.outcome).toBe('failure');
    });

    it('should count follow-up prompts', () => {
      const followUps = ['One', 'Two', 'Three'];
      const responses: string[] = [];
      const result = detectOutcome(followUps, responses);
      expect(result.followUpCount).toBe(3);
    });
  });

  describe('analyzeSessionPrompts', () => {
    it('should analyze prompts from a session', () => {
      const sessionId = 'test-session-1';

      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      const prompts = [
        'Fix the bug in auth',
        'Add validation',
        'Refactor the code',
      ];

      for (let i = 0; i < prompts.length; i++) {
        db.prepare('INSERT INTO user_prompts (session_id, prompt_text, prompt_number, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?)').run(
          sessionId,
          prompts[i],
          i + 1,
          new Date().toISOString(),
          Math.floor(Date.now() / 1000)
        );
      }

      const stored = analyzeSessionPrompts(db, sessionId);
      expect(stored).toBe(3);

      const outcomes = db.prepare('SELECT * FROM prompt_outcomes WHERE session_id = ?').all(sessionId) as Array<Record<string, unknown>>;
      expect(outcomes.length).toBe(3);

      for (const outcome of outcomes) {
        expect(outcome.prompt_category).toBeTruthy();
        expect(outcome.prompt_hash).toBeTruthy();
        expect(outcome.word_count).toBeGreaterThan(0);
      }
    });

    it('should skip duplicate prompts', () => {
      const sessionId = 'test-session-2';

      db.prepare('INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES (?, ?, ?)').run(
        sessionId,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      db.prepare('INSERT INTO user_prompts (session_id, prompt_text, prompt_number, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?)').run(
        sessionId,
        'Fix the bug',
        1,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );

      analyzeSessionPrompts(db, sessionId);
      const first = analyzeSessionPrompts(db, sessionId);

      expect(first).toBe(0); // No new prompts stored
    });
  });

  describe('handlePromptToolCall', () => {
    it('should handle prompt_suggestions tool call', () => {
      const result = handlePromptToolCall('massu_prompt_suggestions', { prompt: 'Fix the bug' }, db);

      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;
      expect(text).toContain('Prompt Analysis');
      expect(text).toContain('Category');
    });

    it('should return error for missing prompt', () => {
      const result = handlePromptToolCall('massu_prompt_suggestions', {}, db);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Usage');
    });

    it('should handle unknown tool name', () => {
      const result = handlePromptToolCall('massu_unknown_prompt_tool', {}, db);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Unknown prompt tool');
    });
  });
});
