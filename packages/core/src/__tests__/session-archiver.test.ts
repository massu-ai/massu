// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ============================================================
// Mocks — must be declared before module imports
// ============================================================

// Mock fs so we never touch the real filesystem
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

// Mock config so we get a stable, deterministic project root
vi.mock('../config.ts', () => ({
  getProjectRoot: vi.fn(() => '/test/project'),
  getConfig: vi.fn(() => ({
    toolPrefix: 'massu',
    project: { name: 'test-project', root: '/test/project' },
    framework: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' },
    paths: { source: 'src', aliases: {} },
    domains: [],
    rules: [],
  })),
  getResolvedPaths: vi.fn(() => ({
    sessionStatePath: '/test/project/.claude/session-state/CURRENT.md',
    sessionArchivePath: '/test/project/.claude/session-state/archive',
    claudeDir: '/test/project/.claude',
  })),
  resetConfig: vi.fn(),
}));

// Mock session-state-generator so we control what generateCurrentMd returns
vi.mock('../session-state-generator.ts', () => ({
  generateCurrentMd: vi.fn(() => '# Session State - February 17, 2026\n\n**Task**: test task\n'),
}));

// ============================================================
// Imports — after mocks are declared
// ============================================================

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from 'fs';
import { archiveAndRegenerate } from '../session-archiver.ts';
import { generateCurrentMd } from '../session-state-generator.ts';

// ============================================================
// Typed mock helpers
// ============================================================

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockWriteFileSync = writeFileSync as ReturnType<typeof vi.fn>;
const mockMkdirSync = mkdirSync as ReturnType<typeof vi.fn>;
const mockRenameSync = renameSync as ReturnType<typeof vi.fn>;
const mockGenerateCurrentMd = generateCurrentMd as ReturnType<typeof vi.fn>;

// ============================================================
// Test DB factory — minimal schema needed by generateCurrentMd
// (even though we mock that function, the db arg must be valid)
// ============================================================

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      project TEXT NOT NULL DEFAULT 'my-project',
      git_branch TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      ended_at TEXT,
      ended_at_epoch INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      plan_file TEXT,
      plan_phase TEXT,
      task_id TEXT
    );
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      files_involved TEXT DEFAULT '[]',
      plan_item TEXT,
      cr_rule TEXT,
      vr_type TEXT,
      evidence TEXT,
      importance INTEGER NOT NULL DEFAULT 3,
      recurrence_count INTEGER NOT NULL DEFAULT 1,
      original_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      request TEXT, investigated TEXT, decisions TEXT, completed TEXT,
      failed_attempts TEXT, next_steps TEXT,
      files_created TEXT DEFAULT '[]', files_modified TEXT DEFAULT '[]',
      verification_results TEXT DEFAULT '{}', plan_progress TEXT DEFAULT '{}',
      created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      prompt_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

// ============================================================
// Tests
// ============================================================

describe('session-archiver', () => {
  let db: Database.Database;

  // These paths are derived from the mocked getProjectRoot() = '/test/project'
  const CURRENT_MD = '/test/project/.claude/session-state/CURRENT.md';
  const ARCHIVE_DIR = '/test/project/.claude/session-state/archive';
  const NEW_CONTENT = '# Session State - February 17, 2026\n\n**Task**: test task\n';

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
    // Default: generateCurrentMd returns deterministic content
    mockGenerateCurrentMd.mockReturnValue(NEW_CONTENT);
  });

  afterEach(() => {
    db.close();
  });

  // ============================================================
  // archiveAndRegenerate — CURRENT.md does not exist
  // ============================================================

  describe('archiveAndRegenerate — CURRENT.md does not exist', () => {
    beforeEach(() => {
      // CURRENT.md does not exist; the parent dir also does not exist
      mockExistsSync.mockImplementation((p: string) => {
        // Neither the file nor the parent dir exist initially
        return false;
      });
    });

    it('does not archive when CURRENT.md is missing', () => {
      const result = archiveAndRegenerate(db, 'session-1');

      expect(result.archived).toBe(false);
      expect(result.archivePath).toBeUndefined();
    });

    it('calls generateCurrentMd with the db and sessionId', () => {
      archiveAndRegenerate(db, 'session-1');

      expect(mockGenerateCurrentMd).toHaveBeenCalledOnce();
      expect(mockGenerateCurrentMd).toHaveBeenCalledWith(db, 'session-1');
    });

    it('creates the parent directory when it does not exist', () => {
      archiveAndRegenerate(db, 'session-1');

      // mkdirSync should be called for the parent dir of CURRENT.md
      expect(mockMkdirSync).toHaveBeenCalledWith(
        '/test/project/.claude/session-state',
        { recursive: true }
      );
    });

    it('writes the new CURRENT.md', () => {
      archiveAndRegenerate(db, 'session-1');

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        CURRENT_MD,
        NEW_CONTENT,
        'utf-8'
      );
    });

    it('returns the new content', () => {
      const result = archiveAndRegenerate(db, 'session-1');

      expect(result.newContent).toBe(NEW_CONTENT);
    });
  });

  // ============================================================
  // archiveAndRegenerate — CURRENT.md exists but is nearly empty
  // ============================================================

  describe('archiveAndRegenerate — CURRENT.md exists but is too short to archive', () => {
    beforeEach(() => {
      mockExistsSync.mockImplementation((_p: string) => true);
      // Fewer than 10 non-whitespace characters — should not archive
      mockReadFileSync.mockReturnValue('hi\n');
    });

    it('does not archive trivially short content', () => {
      const result = archiveAndRegenerate(db, 'session-1');

      expect(result.archived).toBe(false);
      expect(result.archivePath).toBeUndefined();
      expect(mockRenameSync).not.toHaveBeenCalled();
    });

    it('still writes a new CURRENT.md', () => {
      archiveAndRegenerate(db, 'session-1');

      expect(mockWriteFileSync).toHaveBeenCalledWith(CURRENT_MD, NEW_CONTENT, 'utf-8');
    });
  });

  // ============================================================
  // archiveAndRegenerate — CURRENT.md exists with real content
  // ============================================================

  describe('archiveAndRegenerate — CURRENT.md exists with archivable content', () => {
    const EXISTING_CONTENT = [
      '# Session State - January 30, 2026',
      '',
      '**Last Updated**: 2026-01-30 10:00:00 (auto-generated from massu-memory)',
      '**Status**: IN PROGRESS - implement auth module',
      '**Task**: implement the authentication module',
      '**Session ID**: old-session',
      '**Branch**: main',
    ].join('\n');

    beforeEach(() => {
      mockExistsSync.mockImplementation((_p: string) => true);
      mockReadFileSync.mockReturnValue(EXISTING_CONTENT);
    });

    it('sets archived to true', () => {
      const result = archiveAndRegenerate(db, 'new-session');

      expect(result.archived).toBe(true);
    });

    it('returns an archivePath', () => {
      const result = archiveAndRegenerate(db, 'new-session');

      expect(result.archivePath).toBeDefined();
      expect(result.archivePath).toContain(ARCHIVE_DIR);
      expect(result.archivePath!.endsWith('.md')).toBe(true);
    });

    it('archive filename contains the ISO date from the content', () => {
      const result = archiveAndRegenerate(db, 'new-session');

      // isoMatch in extractArchiveInfo picks the first YYYY-MM-DD in content
      // which is 2026-01-30 (from the **Last Updated** line)
      expect(result.archivePath).toContain('2026-01-30');
    });

    it('archive filename contains a slug derived from the Task field', () => {
      const result = archiveAndRegenerate(db, 'new-session');

      // Task is "implement the authentication module" -> "implement-the-authentication-module"
      expect(result.archivePath).toContain('implement-the-authentication-module');
    });

    it('calls renameSync to atomically move the file', () => {
      const result = archiveAndRegenerate(db, 'new-session');

      expect(mockRenameSync).toHaveBeenCalledOnce();
      expect(mockRenameSync).toHaveBeenCalledWith(CURRENT_MD, result.archivePath);
    });

    it('does not call writeFileSync for the archive (rename is used)', () => {
      archiveAndRegenerate(db, 'new-session');

      // writeFileSync should only be called once — for the new CURRENT.md
      const writeCallArgs = (mockWriteFileSync as ReturnType<typeof vi.fn>).mock.calls;
      expect(writeCallArgs.every(([p]: [string]) => p === CURRENT_MD)).toBe(true);
    });

    it('writes the new CURRENT.md content after archiving', () => {
      archiveAndRegenerate(db, 'new-session');

      expect(mockWriteFileSync).toHaveBeenCalledWith(CURRENT_MD, NEW_CONTENT, 'utf-8');
    });

    it('does not create archive directory when it already exists', () => {
      // existsSync returns true for everything including archive dir
      archiveAndRegenerate(db, 'new-session');

      expect(mockMkdirSync).not.toHaveBeenCalledWith(ARCHIVE_DIR, expect.anything());
    });
  });

  // ============================================================
  // archiveAndRegenerate — archive directory does not exist yet
  // ============================================================

  describe('archiveAndRegenerate — archive directory needs to be created', () => {
    const EXISTING_CONTENT = '# Session State - February 1, 2026\n\n**Task**: add feature\n**Status**: IN PROGRESS - add feature\n';

    beforeEach(() => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === CURRENT_MD) return true;
        if (p === ARCHIVE_DIR) return false;
        // Parent dir of CURRENT.md (/test/project/.claude/session-state) exists
        return true;
      });
      mockReadFileSync.mockReturnValue(EXISTING_CONTENT);
    });

    it('creates the archive directory with recursive flag', () => {
      archiveAndRegenerate(db, 'session-1');

      expect(mockMkdirSync).toHaveBeenCalledWith(ARCHIVE_DIR, { recursive: true });
    });
  });

  // ============================================================
  // archiveAndRegenerate — renameSync fails (cross-device scenario)
  // ============================================================

  describe('archiveAndRegenerate — renameSync throws (cross-device fallback)', () => {
    const EXISTING_CONTENT = '# Session State - February 10, 2026\n\n**Task**: cross device task\n';

    beforeEach(() => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === CURRENT_MD) return true;
        return true;
      });
      mockReadFileSync.mockReturnValue(EXISTING_CONTENT);
      mockRenameSync.mockImplementation(() => {
        throw new Error('EXDEV: cross-device link not permitted');
      });
    });

    it('falls back to writeFileSync when rename throws', () => {
      const result = archiveAndRegenerate(db, 'session-1');

      // archived should still be true because the fallback copy worked
      expect(result.archived).toBe(true);
      // writeFileSync should have been called for the archive copy AND for the new CURRENT.md
      const writeCallPaths = (mockWriteFileSync as ReturnType<typeof vi.fn>).mock.calls.map(
        ([p]: [string]) => p
      );
      // First call should be the archive path (copy fallback)
      expect(writeCallPaths[0]).toBe(result.archivePath);
      // Second call should write the new CURRENT.md
      expect(writeCallPaths[1]).toBe(CURRENT_MD);
    });

    it('writes existing content to the archive path in the fallback', () => {
      const result = archiveAndRegenerate(db, 'session-1');

      expect(mockWriteFileSync).toHaveBeenCalledWith(result.archivePath, EXISTING_CONTENT);
    });
  });

  // ============================================================
  // extractArchiveInfo — tested indirectly via archiveAndRegenerate
  // ============================================================

  describe('extractArchiveInfo — date extraction', () => {
    function runWithContent(content: string) {
      mockExistsSync.mockImplementation((p: string) => (p === CURRENT_MD ? true : true));
      mockReadFileSync.mockReturnValue(content);
      return archiveAndRegenerate(db, 'session-x');
    }

    beforeEach(() => {
      vi.clearAllMocks();
      mockGenerateCurrentMd.mockReturnValue(NEW_CONTENT);
    });

    it('extracts ISO date from **Last Updated** line (iso date wins over header date)', () => {
      const content = [
        '# Session State - January 30, 2026',
        '**Last Updated**: 2026-01-30 (auto-generated)',
        '**Task**: something meaningful enough to parse',
      ].join('\n');
      const result = runWithContent(content);

      expect(result.archivePath).toContain('2026-01-30');
    });

    it('extracts date from "# Session State - Month Day, Year" header when no ISO date present', () => {
      // Content with no ISO date pattern (no YYYY-MM-DD anywhere) but with the header
      const content = [
        '# Session State - March 5, 2026',
        '**Task**: build a thing long enough to matter here',
      ].join('\n');
      const result = runWithContent(content);

      expect(result.archivePath).toContain('2026-03-05');
    });

    it('falls back to today\'s ISO date when no date pattern found', () => {
      const today = new Date().toISOString().split('T')[0];
      const content = 'This content has no date at all and is long enough to be archived by the function logic.';
      const result = runWithContent(content);

      expect(result.archivePath).toContain(today);
    });
  });

  describe('extractArchiveInfo — slug extraction', () => {
    function runWithContent(content: string) {
      mockExistsSync.mockImplementation((_p: string) => true);
      mockReadFileSync.mockReturnValue(content);
      return archiveAndRegenerate(db, 'session-x');
    }

    beforeEach(() => {
      vi.clearAllMocks();
      mockGenerateCurrentMd.mockReturnValue(NEW_CONTENT);
    });

    it('uses Task field for slug when present', () => {
      const content = [
        '# Session State - February 17, 2026',
        '**Task**: Implement the OAuth2 flow',
        '**Status**: IN PROGRESS - something else',
      ].join('\n');
      const result = runWithContent(content);

      expect(result.archivePath).toContain('implement-the-oauth2-flow');
    });

    it('falls back to Status description when Task is absent', () => {
      // Note: the status regex is \w+ (single word) before the dash,
      // so "IN PROGRESS" would not match — use a single-word status like "ACTIVE"
      const content = [
        '# Session State - February 17, 2026',
        '**Status**: ACTIVE - refactor the database layer',
      ].join('\n');
      const result = runWithContent(content);

      expect(result.archivePath).toContain('refactor-the-database-layer');
    });

    it('uses "session" slug when neither Task nor Status description is found', () => {
      const content = [
        '# Session State - February 17, 2026',
        'No task or status fields present in this document at all.',
      ].join('\n');
      const result = runWithContent(content);

      expect(result.archivePath).toContain('-session');
    });

    it('lowercases and hyphenates special characters in slug', () => {
      const content = [
        '# Session State - February 17, 2026',
        '**Task**: Fix the Auth/JWT (token) issue!',
      ].join('\n');
      const result = runWithContent(content);

      // Special chars become hyphens, leading/trailing hyphens removed
      expect(result.archivePath).toContain('fix-the-auth-jwt-token-issue');
    });

    it('truncates slug to 50 characters', () => {
      const longTask = 'A'.repeat(60);
      const content = [
        '# Session State - February 17, 2026',
        `**Task**: ${longTask}`,
      ].join('\n');
      const result = runWithContent(content);

      const filename = result.archivePath!.split('/').pop()!;
      // date (10) + '-' (1) + slug (<=50) + '.md' (3) = <=64 chars
      const slug = filename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
      expect(slug.length).toBeLessThanOrEqual(50);
    });
  });

  // ============================================================
  // Return value contract
  // ============================================================

  describe('return value contract', () => {
    it('always returns { archived, newContent } even when nothing existed', () => {
      mockExistsSync.mockReturnValue(false);

      const result = archiveAndRegenerate(db, 'fresh-session');

      expect(result).toHaveProperty('archived');
      expect(result).toHaveProperty('newContent');
      expect(typeof result.archived).toBe('boolean');
      expect(typeof result.newContent).toBe('string');
    });

    it('newContent always matches what generateCurrentMd returns', () => {
      const customContent = '# Custom Content\n';
      mockGenerateCurrentMd.mockReturnValue(customContent);
      mockExistsSync.mockReturnValue(false);

      const result = archiveAndRegenerate(db, 'any-session');

      expect(result.newContent).toBe(customContent);
    });

    it('archivePath is undefined when archived is false', () => {
      mockExistsSync.mockReturnValue(false);

      const result = archiveAndRegenerate(db, 'any-session');

      expect(result.archived).toBe(false);
      expect(result.archivePath).toBeUndefined();
    });
  });
});
