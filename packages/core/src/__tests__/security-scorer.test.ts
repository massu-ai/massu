// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  getSecurityToolDefinitions,
  isSecurityTool,
  scoreFileSecurity,
  storeSecurityScore,
  handleSecurityToolCall,
} from '../security-scorer.ts';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE security_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      risk_score INTEGER NOT NULL DEFAULT 0,
      findings TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      status TEXT,
      started_at_epoch INTEGER
    );
  `);
  return db;
}

describe('security-scorer', () => {
  let db: Database.Database;
  const testDir = '/tmp/security-scorer-test';

  beforeEach(() => {
    db = createTestDb();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe('getSecurityToolDefinitions', () => {
    it('returns 3 tool definitions', () => {
      const tools = getSecurityToolDefinitions();
      expect(tools).toHaveLength(3);
      expect(tools.map(t => t.name.split('_').slice(-2).join('_'))).toEqual([
        'security_score',
        'security_heatmap',
        'security_trend',
      ]);
    });

    it('has required fields in tool definitions', () => {
      const tools = getSecurityToolDefinitions();
      tools.forEach(tool => {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
      });
    });
  });

  describe('isSecurityTool', () => {
    it('returns true for security tool names', () => {
      expect(isSecurityTool('massu_security_score')).toBe(true);
      expect(isSecurityTool('massu_security_heatmap')).toBe(true);
      expect(isSecurityTool('massu_security_trend')).toBe(true);
    });

    it('returns false for non-security tool names', () => {
      expect(isSecurityTool('massu_adr_list')).toBe(false);
      expect(isSecurityTool('massu_unknown')).toBe(false);
    });
  });

  describe('scoreFileSecurity', () => {
    it('returns 0 for non-existent file', () => {
      const result = scoreFileSecurity('nonexistent.ts', testDir);
      expect(result.riskScore).toBe(0);
      expect(result.findings).toEqual([]);
    });

    it('detects hardcoded credentials', () => {
      const filePath = join(testDir, 'test.ts');
      writeFileSync(filePath, `const api_key = "sk-1234567890abcdef";\n`);

      const result = scoreFileSecurity(filePath, testDir);
      expect(result.riskScore).toBeGreaterThan(0);
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings[0].severity).toBe('critical');
      expect(result.findings[0].description).toContain('credential');
    });

    it('detects publicProcedure.mutation vulnerability', () => {
      const filePath = join(testDir, 'router.ts');
      writeFileSync(filePath, `export const router = publicProcedure.mutation(async () => {});\n`);

      const result = scoreFileSecurity(filePath, testDir);
      expect(result.riskScore).toBeGreaterThan(0);
      const mutation = result.findings.find(f => f.description.includes('Mutation without authentication'));
      expect(mutation).toBeDefined();
      expect(mutation?.severity).toBe('critical');
    });

    it('detects eval usage', () => {
      const filePath = join(testDir, 'dangerous.ts');
      writeFileSync(filePath, `const result = eval(userInput);\n`);

      const result = scoreFileSecurity(filePath, testDir);
      expect(result.riskScore).toBeGreaterThan(0);
      const evalFinding = result.findings.find(f => f.description.includes('eval()'));
      expect(evalFinding).toBeDefined();
      expect(evalFinding?.severity).toBe('high');
    });

    it('detects dangerouslySetInnerHTML in tsx files', () => {
      const filePath = join(testDir, 'component.tsx');
      writeFileSync(filePath, `<div dangerouslySetInnerHTML={{ __html: html }} />\n`);

      const result = scoreFileSecurity(filePath, testDir);
      expect(result.riskScore).toBeGreaterThan(0);
      const xss = result.findings.find(f => f.description.includes('XSS risk'));
      expect(xss).toBeDefined();
      expect(xss?.severity).toBe('high');
    });

    it('returns 0 for clean file', () => {
      const filePath = join(testDir, 'clean.ts');
      writeFileSync(filePath, `export function add(a: number, b: number) { return a + b; }\n`);

      const result = scoreFileSecurity(filePath, testDir);
      expect(result.riskScore).toBe(0);
      expect(result.findings).toEqual([]);
    });

    it('caps risk score at 100', () => {
      const filePath = join(testDir, 'critical.ts');
      writeFileSync(filePath, `
        const password = "hardcoded-secret-12345";
        const token = "sk-1234567890abcdef";
        const apiKey = "another-secret-key-abc";
        publicProcedure.mutation(async () => {});
        eval(userInput);
        exec(\`rm -rf \${dir}\`);
      `);

      const result = scoreFileSecurity(filePath, testDir);
      expect(result.riskScore).toBeLessThanOrEqual(100);
    });

    it('blocks path traversal attacks', () => {
      const result = scoreFileSecurity('../../../etc/passwd', testDir);
      expect(result.riskScore).toBe(100);
      expect(result.findings[0].severity).toBe('critical');
      expect(result.findings[0].description).toContain('Path traversal blocked');
    });
  });

  describe('storeSecurityScore', () => {
    it('stores security score in database', () => {
      storeSecurityScore(db, 'session-123', 'src/test.ts', 42, [
        { pattern: 'test', severity: 'high', line: 10, description: 'Test finding' },
      ]);

      const row = db.prepare('SELECT * FROM security_scores WHERE session_id = ?').get('session-123') as Record<string, unknown>;
      expect(row.file_path).toBe('src/test.ts');
      expect(row.risk_score).toBe(42);

      const findings = JSON.parse(row.findings as string) as Array<Record<string, unknown>>;
      expect(findings).toHaveLength(1);
      expect(findings[0].description).toBe('Test finding');
    });
  });

  describe('handleSecurityToolCall', () => {
    it('handles security_score for file', () => {
      const filePath = join(testDir, 'test.ts');
      writeFileSync(filePath, `export const x = 1;\n`);

      // Create active session
      db.prepare(`INSERT INTO sessions (session_id, status, started_at_epoch) VALUES (?, ?, ?)`).run(
        'test-session',
        'active',
        Math.floor(Date.now() / 1000)
      );

      const result = handleSecurityToolCall('massu_security_score', { file_path: filePath }, db);
      const text = result.content[0].text;
      expect(text).toContain('Security Score');
      expect(text).toContain(filePath);
    });

    it('handles security_heatmap with no data', () => {
      const result = handleSecurityToolCall('massu_security_heatmap', {}, db);
      const text = result.content[0].text;
      expect(text).toContain('No files with risk score');
    });

    it('handles security_heatmap with threshold', () => {
      storeSecurityScore(db, 'session-1', 'file1.ts', 50, []);
      storeSecurityScore(db, 'session-1', 'file2.ts', 80, []);
      storeSecurityScore(db, 'session-1', 'file3.ts', 20, []);

      const result = handleSecurityToolCall('massu_security_heatmap', { threshold: 30 }, db);
      const text = result.content[0].text;
      expect(text).toContain('Security Heat Map');
      expect(text).toContain('file1.ts');
      expect(text).toContain('file2.ts');
      expect(text).not.toContain('file3.ts');
    });

    it('handles security_trend with no data', () => {
      const result = handleSecurityToolCall('massu_security_trend', {}, db);
      const text = result.content[0].text;
      expect(text).toContain('No security scan data');
    });

    it('handles unknown tool name', () => {
      const result = handleSecurityToolCall('massu_security_unknown', {}, db);
      const text = result.content[0].text;
      expect(text).toContain('Unknown security tool');
    });
  });
});
