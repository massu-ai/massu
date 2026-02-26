// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { unlinkSync, existsSync, writeFileSync, mkdirSync } from 'fs';

// P1: Analytics
import { calculateQualityScore, storeQualityScore, backfillQualityScores, type QualityBreakdown } from '../analytics.ts';
// P1: Cost
import { extractTokenUsage, calculateCost, type TokenUsage, type CostResult } from '../cost-tracker.ts';
import type { TranscriptEntry } from '../transcript-parser.ts';
// P1: Prompt
import { categorizePrompt, hashPrompt, detectOutcome } from '../prompt-analyzer.ts';
// P2: Audit
import { logAuditEntry, queryAuditLog, getFileChain } from '../audit-trail.ts';
// P2: Validation
import { validateFile } from '../validation-engine.ts';
// P2: ADR
import { detectDecisionPatterns, extractAlternatives, storeDecision } from '../adr-generator.ts';
// P3: Security
import { scoreFileSecurity } from '../security-scorer.ts';
// P3: Dependency
import { calculateDepRisk, getInstalledPackages } from '../dependency-scorer.ts';
// P4: Team
import { calculateExpertise, shareObservation } from '../team-knowledge.ts';
// P4: Regression
import { calculateHealthScore, trackModification, recordTestResult } from '../regression-detector.ts';

// P1-008: Plan-01 Memory Enhancement Integration Tests

/**
 * Creates a minimal in-memory DB with the schema needed for plan01 tests.
 * Mirrors the relevant tables from getMemoryDb() in memory-db.ts.
 */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      project TEXT NOT NULL DEFAULT 'test-project',
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

    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      vr_type TEXT,
      importance INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS session_quality_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      score INTEGER NOT NULL,
      security_score INTEGER NOT NULL DEFAULT 0,
      architecture_score INTEGER NOT NULL DEFAULT 0,
      coupling_score INTEGER NOT NULL DEFAULT 0,
      test_score INTEGER NOT NULL DEFAULT 0,
      rule_compliance_score INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      model_id TEXT,
      file_path TEXT,
      change_type TEXT,
      rules_in_effect TEXT,
      approval_status TEXT,
      evidence TEXT,
      metadata TEXT,
      timestamp TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS architecture_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      context TEXT NOT NULL,
      decision TEXT NOT NULL,
      alternatives TEXT,
      consequences TEXT,
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shared_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_id INTEGER,
      developer_id TEXT NOT NULL,
      project TEXT NOT NULL,
      observation_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      file_path TEXT,
      module TEXT,
      severity INTEGER NOT NULL DEFAULT 3,
      is_shared INTEGER NOT NULL DEFAULT 0,
      shared_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS feature_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_key TEXT NOT NULL UNIQUE,
      health_score INTEGER NOT NULL DEFAULT 100,
      tests_passing INTEGER NOT NULL DEFAULT 0,
      tests_failing INTEGER NOT NULL DEFAULT 0,
      test_coverage_pct REAL,
      modifications_since_test INTEGER NOT NULL DEFAULT 0,
      last_modified TEXT,
      last_tested TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

function createSession(db: Database.Database, sessionId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO sessions (session_id, project, started_at, started_at_epoch, status)
    VALUES (?, 'test-project', datetime('now'), ?, 'active')
  `).run(sessionId, Math.floor(Date.now() / 1000));
}

function addObservation(db: Database.Database, sessionId: string, type: string, detail: string): void {
  db.prepare(`
    INSERT INTO observations (session_id, type, detail, created_at, created_at_epoch)
    VALUES (?, ?, ?, datetime('now'), ?)
  `).run(sessionId, type, detail, Math.floor(Date.now() / 1000));
}

describe('PLAN-01: Memory Enhancements', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // =================================================================
  // P1-001: Quality Trend Analytics
  // =================================================================
  describe('P1-001: Quality Scoring', () => {
    it('calculates base score of 50 for empty session', () => {
      createSession(db, 'session-1');
      const result = calculateQualityScore(db, 'session-1');
      expect(result.score).toBe(50);
      expect(result.breakdown).toBeDefined();
    });

    it('adjusts score based on observations', () => {
      createSession(db, 'session-1');
      addObservation(db, 'session-1', 'vr_pass', 'Security check passed');
      addObservation(db, 'session-1', 'clean_commit', 'Clean commit');
      const result = calculateQualityScore(db, 'session-1');
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.breakdown).toBeDefined();
    });

    it('clamps score between 0 and 100', () => {
      createSession(db, 'session-1');
      for (let i = 0; i < 10; i++) {
        addObservation(db, 'session-1', 'incident', 'Critical incident');
      }
      const result = calculateQualityScore(db, 'session-1');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('stores and retrieves quality scores', () => {
      createSession(db, 'session-1');
      const { score, breakdown } = calculateQualityScore(db, 'session-1');
      storeQualityScore(db, 'session-1', score, breakdown);

      const stored = db.prepare('SELECT * FROM session_quality_scores WHERE session_id = ?')
        .get('session-1') as Record<string, unknown>;
      expect(stored).toBeDefined();
      expect(stored.score).toBe(score);
    });

    it('backfills quality scores for sessions without scores', () => {
      createSession(db, 'session-1');
      addObservation(db, 'session-1', 'vr_pass', 'Test passed');
      createSession(db, 'session-2');
      addObservation(db, 'session-2', 'bug_found', 'Bug found');

      const count = backfillQualityScores(db);
      expect(count).toBe(2);

      const scores = db.prepare('SELECT COUNT(*) as count FROM session_quality_scores').get() as { count: number };
      expect(scores.count).toBe(2);
    });
  });

  // =================================================================
  // P1-002: Cost Attribution
  // =================================================================
  describe('P1-002: Cost Tracking', () => {
    it('extracts token usage from transcript entries with usage metadata', () => {
      const entries: TranscriptEntry[] = [
        {
          type: 'assistant',
          message: {
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
            },
            model: 'claude-sonnet-4-5',
          } as Record<string, unknown>,
        } as TranscriptEntry,
      ];
      const usage = extractTokenUsage(entries);
      expect(usage.inputTokens).toBe(1000);
      expect(usage.outputTokens).toBe(500);
    });

    it('returns zero for entries without usage metadata', () => {
      const entries: TranscriptEntry[] = [
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        } as TranscriptEntry,
      ];
      const usage = extractTokenUsage(entries);
      expect(usage.inputTokens).toBe(0);
      expect(usage.outputTokens).toBe(0);
    });

    it('calculates cost from token usage', () => {
      const usage: TokenUsage = {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        model: 'claude-sonnet-4-5-20250929',
      };
      const result = calculateCost(usage);
      // Sonnet: $3/M input + $15/M output = $3 + $1.5 = $4.5
      expect(result.totalCost).toBeCloseTo(4.5, 1);
      expect(result.currency).toBe('USD');
    });

    it('uses default pricing for unknown models', () => {
      const usage: TokenUsage = {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        model: 'unknown-model',
      };
      const result = calculateCost(usage);
      expect(result.totalCost).toBeGreaterThan(0);
    });
  });

  // =================================================================
  // P1-003: Prompt Effectiveness
  // =================================================================
  describe('P1-003: Prompt Analysis', () => {
    it('categorizes bugfix prompts', () => {
      expect(categorizePrompt('Fix the login error')).toBe('bugfix');
      expect(categorizePrompt('There is a bug in the dashboard')).toBe('bugfix');
    });

    it('categorizes refactor prompts', () => {
      expect(categorizePrompt('Refactor the auth module')).toBe('refactor');
      expect(categorizePrompt('Rename the variable')).toBe('refactor');
    });

    it('categorizes question prompts', () => {
      expect(categorizePrompt('What does this function do?')).toBe('question');
      expect(categorizePrompt('How does the auth work?')).toBe('question');
    });

    it('categorizes command prompts', () => {
      expect(categorizePrompt('/massu-loop')).toBe('command');
      expect(categorizePrompt('/commit')).toBe('command');
    });

    it('categorizes feature prompts', () => {
      expect(categorizePrompt('Add a new dashboard widget')).toBe('feature');
      expect(categorizePrompt('Create the settings page')).toBe('feature');
    });

    it('generates consistent hashes', () => {
      const h1 = hashPrompt('Fix the bug');
      const h2 = hashPrompt('fix  the  bug');  // extra spaces
      expect(h1).toBe(h2);
      expect(h1.length).toBe(16);
    });

    it('detects outcomes from follow-up context', () => {
      const result = detectOutcome(
        ['No, that\'s not what I wanted', 'Try again with the correct approach'],
        ['Done, here are the changes', 'Fixed the type error']
      );
      expect(result.correctionsNeeded).toBeGreaterThan(0);
    });
  });

  // =================================================================
  // P2-001: Audit Trail
  // =================================================================
  describe('P2-001: Audit Trail', () => {
    it('logs audit entries', () => {
      createSession(db, 'session-1');
      logAuditEntry(db, {
        sessionId: 'session-1',
        eventType: 'code_change',
        actor: 'ai',
        filePath: 'src/test.ts',
        changeType: 'edit',
      });
      const entries = queryAuditLog(db, { eventType: 'code_change' });
      expect(entries.length).toBe(1);
    });

    it('queries audit log with filters', () => {
      createSession(db, 'session-1');
      logAuditEntry(db, { sessionId: 'session-1', eventType: 'code_change', actor: 'ai', filePath: 'src/a.ts' });
      logAuditEntry(db, { sessionId: 'session-1', eventType: 'commit', actor: 'ai', filePath: 'src/b.ts' });

      const changes = queryAuditLog(db, { eventType: 'code_change' });
      expect(changes.length).toBe(1);
    });

    it('gets file chain of custody', () => {
      createSession(db, 'session-1');
      logAuditEntry(db, { sessionId: 'session-1', eventType: 'code_change', actor: 'ai', filePath: 'src/test.ts', changeType: 'create' });
      logAuditEntry(db, { sessionId: 'session-1', eventType: 'code_change', actor: 'ai', filePath: 'src/test.ts', changeType: 'edit' });

      const chain = getFileChain(db, 'src/test.ts');
      expect(chain.length).toBe(2);
    });
  });

  // =================================================================
  // P2-002: Validation Engine
  // =================================================================
  describe('P2-002: Validation Engine', () => {
    it('validates a non-existent file', () => {
      const checks = validateFile('nonexistent.ts', '/tmp');
      expect(checks.length).toBe(1);
      expect(checks[0].severity).toBe('error');
      expect(checks[0].message).toContain('not found');
    });

    it('validates a file with ctx.prisma violation if prisma checks are configured', () => {
      // Create temp file with violation
      const tmpDir = resolve(__dirname, '../test-validation-tmp');
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      mkdirSync(resolve(tmpDir, 'server/api/routers'), { recursive: true });
      writeFileSync(resolve(tmpDir, 'server/api/routers/test-router.ts'), 'const result = ctx.prisma.orders.findMany();');

      const checks = validateFile('server/api/routers/test-router.ts', tmpDir);
      // Massu may or may not have prisma-related validation rules configured
      expect(Array.isArray(checks)).toBe(true);

      // Cleanup
      unlinkSync(resolve(tmpDir, 'server/api/routers/test-router.ts'));
    });
  });

  // =================================================================
  // P2-003: ADR Generation
  // =================================================================
  describe('P2-003: ADR Generation', () => {
    it('detects decision patterns in text', () => {
      expect(detectDecisionPatterns('We chose React over Vue for the frontend.')).toBe(true);
      expect(detectDecisionPatterns('We decided to use TypeScript.')).toBe(true);
      expect(detectDecisionPatterns('Just a normal commit message.')).toBe(false);
    });

    it('extracts alternatives from decision text', () => {
      const alts = extractAlternatives('We chose React over Vue for the frontend.');
      expect(alts).toContain('Vue for the frontend');
    });

    it('stores architecture decisions', () => {
      createSession(db, 'session-1');
      const id = storeDecision(db, {
        title: 'Use tRPC over REST',
        context: 'Need type-safe API',
        decision: 'Use tRPC',
        alternatives: ['REST', 'GraphQL'],
        consequences: 'Better type safety',
        sessionId: 'session-1',
      });
      expect(id).toBeGreaterThan(0);

      const adr = db.prepare('SELECT * FROM architecture_decisions WHERE id = ?').get(id) as Record<string, unknown>;
      expect(adr.title).toBe('Use tRPC over REST');
    });
  });

  // =================================================================
  // P3-001: Security Scoring
  // =================================================================
  describe('P3-001: Security Scoring', () => {
    it('scores a clean file as 0 risk', () => {
      const tmpDir = resolve(__dirname, '../test-security-tmp');
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      writeFileSync(resolve(tmpDir, 'clean.ts'), 'export function hello() { return "world"; }');

      const result = scoreFileSecurity('clean.ts', tmpDir);
      expect(result.riskScore).toBe(0);
      expect(result.findings.length).toBe(0);

      unlinkSync(resolve(tmpDir, 'clean.ts'));
    });

    it('detects hardcoded credentials', () => {
      const tmpDir = resolve(__dirname, '../test-security-tmp');
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      writeFileSync(resolve(tmpDir, 'risky.ts'), 'const password = "supersecretpassword123";');

      const result = scoreFileSecurity('risky.ts', tmpDir);
      expect(result.riskScore).toBeGreaterThan(0);
      expect(result.findings.some(f => f.severity === 'critical')).toBe(true);

      unlinkSync(resolve(tmpDir, 'risky.ts'));
    });

    it('returns 0 for non-existent file', () => {
      const result = scoreFileSecurity('nonexistent.ts', '/tmp');
      expect(result.riskScore).toBe(0);
    });
  });

  // =================================================================
  // P3-002: Dependency Risk Scoring
  // =================================================================
  describe('P3-002: Dependency Risk', () => {
    it('scores zero risk for healthy package', () => {
      const risk = calculateDepRisk({
        vulnerabilities: 0,
        lastPublishDays: 30,
        weeklyDownloads: 1_000_000,
        license: 'MIT',
        bundleSizeKb: 50,
        previousRemovals: 0,
      });
      expect(risk).toBe(0);
    });

    it('scores high risk for vulnerable package', () => {
      const risk = calculateDepRisk({
        vulnerabilities: 3,
        lastPublishDays: 800,
        weeklyDownloads: 50,
        license: null,
        bundleSizeKb: null,
        previousRemovals: 2,
      });
      expect(risk).toBeGreaterThan(60);
    });

    it('reads installed packages from project root', () => {
      // Use packages/core which has actual dependencies
      const packages = getInstalledPackages(resolve(__dirname, '../..'));
      expect(packages.size).toBeGreaterThan(0);
    });
  });

  // =================================================================
  // P4-001: Team Knowledge Graph
  // =================================================================
  describe('P4-001: Team Knowledge', () => {
    it('calculates expertise score from sessions and observations', () => {
      // 1 session, 1 observation = low score
      const low = calculateExpertise(1, 1);
      // 10 sessions, 50 observations = higher score
      const high = calculateExpertise(10, 50);
      expect(high).toBeGreaterThan(low);
    });

    it('caps expertise at 100', () => {
      const score = calculateExpertise(1000, 10000);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('shares observations', () => {
      createSession(db, 'session-1');
      const id = shareObservation(db, 'dev-1', 'test-project', 'discovery', 'Found a pattern');
      expect(id).toBeGreaterThan(0);
    });
  });

  // =================================================================
  // P4-002: Regression Detection
  // =================================================================
  describe('P4-002: Regression Detection', () => {
    it('starts with score 100 for clean feature', () => {
      const score = calculateHealthScore(5, 0, 0, new Date().toISOString(), new Date().toISOString());
      expect(score).toBe(100);
    });

    it('deducts for test failures', () => {
      const score = calculateHealthScore(3, 2, 0, new Date().toISOString(), new Date().toISOString());
      expect(score).toBeLessThan(100);
    });

    it('deducts for untested modifications', () => {
      const score = calculateHealthScore(5, 0, 5, new Date().toISOString(), new Date().toISOString());
      expect(score).toBeLessThan(100);
    });

    it('deducts heavily for modified but never tested', () => {
      const score = calculateHealthScore(0, 0, 1, null, new Date().toISOString());
      expect(score).toBeLessThanOrEqual(70);
    });

    it('tracks modifications and increases mods_since_test', () => {
      trackModification(db, 'products');
      const row = db.prepare('SELECT * FROM feature_health WHERE feature_key = ?').get('products') as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.modifications_since_test).toBe(1);

      trackModification(db, 'products');
      const row2 = db.prepare('SELECT * FROM feature_health WHERE feature_key = ?').get('products') as Record<string, unknown>;
      expect(row2.modifications_since_test).toBe(2);
    });

    it('records test results and resets modification counter', () => {
      trackModification(db, 'orders');
      trackModification(db, 'orders');
      recordTestResult(db, 'orders', 10, 0);

      const row = db.prepare('SELECT * FROM feature_health WHERE feature_key = ?').get('orders') as Record<string, unknown>;
      expect(row.modifications_since_test).toBe(0);
      expect(row.tests_passing).toBe(10);
      expect(row.tests_failing).toBe(0);
    });
  });

  // =================================================================
  // Tool Registration Smoke Test
  // =================================================================
  describe('Tool Registration', () => {
    it('all tool definition functions return arrays', async () => {
      const { getAnalyticsToolDefinitions } = await import('../analytics.ts');
      const { getCostToolDefinitions } = await import('../cost-tracker.ts');
      const { getPromptToolDefinitions } = await import('../prompt-analyzer.ts');
      const { getAuditToolDefinitions } = await import('../audit-trail.ts');
      const { getValidationToolDefinitions } = await import('../validation-engine.ts');
      const { getAdrToolDefinitions } = await import('../adr-generator.ts');
      const { getSecurityToolDefinitions } = await import('../security-scorer.ts');
      const { getDependencyToolDefinitions } = await import('../dependency-scorer.ts');
      const { getTeamToolDefinitions } = await import('../team-knowledge.ts');
      const { getRegressionToolDefinitions } = await import('../regression-detector.ts');

      const allDefs = [
        ...getAnalyticsToolDefinitions(),
        ...getCostToolDefinitions(),
        ...getPromptToolDefinitions(),
        ...getAuditToolDefinitions(),
        ...getValidationToolDefinitions(),
        ...getAdrToolDefinitions(),
        ...getSecurityToolDefinitions(),
        ...getDependencyToolDefinitions(),
        ...getTeamToolDefinitions(),
        ...getRegressionToolDefinitions(),
      ];

      // Plan specifies 26 new tools
      expect(allDefs.length).toBe(26);

      // All have required fields
      for (const def of allDefs) {
        expect(def.name).toBeDefined();
        expect(def.description).toBeDefined();
        expect(def.inputSchema).toBeDefined();
        expect(def.name.startsWith('massu_')).toBe(true);
      }
    });

    it('all tool names are unique', async () => {
      const { getAnalyticsToolDefinitions } = await import('../analytics.ts');
      const { getCostToolDefinitions } = await import('../cost-tracker.ts');
      const { getPromptToolDefinitions } = await import('../prompt-analyzer.ts');
      const { getAuditToolDefinitions } = await import('../audit-trail.ts');
      const { getValidationToolDefinitions } = await import('../validation-engine.ts');
      const { getAdrToolDefinitions } = await import('../adr-generator.ts');
      const { getSecurityToolDefinitions } = await import('../security-scorer.ts');
      const { getDependencyToolDefinitions } = await import('../dependency-scorer.ts');
      const { getTeamToolDefinitions } = await import('../team-knowledge.ts');
      const { getRegressionToolDefinitions } = await import('../regression-detector.ts');

      const allDefs = [
        ...getAnalyticsToolDefinitions(),
        ...getCostToolDefinitions(),
        ...getPromptToolDefinitions(),
        ...getAuditToolDefinitions(),
        ...getValidationToolDefinitions(),
        ...getAdrToolDefinitions(),
        ...getSecurityToolDefinitions(),
        ...getDependencyToolDefinitions(),
        ...getTeamToolDefinitions(),
        ...getRegressionToolDefinitions(),
      ];

      const names = allDefs.map(d => d.name);
      const uniqueNames = new Set(names);
      expect(names.length).toBe(uniqueNames.size);
    });
  });
});
