// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { unlinkSync, existsSync, mkdirSync, rmSync } from 'fs';
import { getResolvedPaths } from '../config.ts';
import { initKnowledgeSchema } from '../knowledge-db.ts';
import { indexAllKnowledge } from '../knowledge-indexer.ts';
import { handleKnowledgeToolCall, getKnowledgeToolDefinitions } from '../knowledge-tools.ts';

// P1-007: Knowledge Tools Unit Tests

const TEST_DB_PATH = resolve(__dirname, '../test-knowledge-tools.db');

let db: Database.Database;

function cleanupTestDb(): void {
  try {
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
    if (existsSync(TEST_DB_PATH + '-shm')) unlinkSync(TEST_DB_PATH + '-shm');
    if (existsSync(TEST_DB_PATH + '-wal')) unlinkSync(TEST_DB_PATH + '-wal');
  } catch { /* ignore */ }
}

beforeAll(() => {
  cleanupTestDb();
  db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initKnowledgeSchema(db);
  indexAllKnowledge(db);
});

afterAll(() => {
  db.close();
  cleanupTestDb();
});

describe('getKnowledgeToolDefinitions', () => {
  it('returns 12 tool definitions', () => {
    const tools = getKnowledgeToolDefinitions();
    expect(tools.length).toBe(12);

    const names = tools.map(t => t.name);
    expect(names).toContain('massu_knowledge_search');
    expect(names).toContain('massu_knowledge_rule');
    expect(names).toContain('massu_knowledge_incident');
    expect(names).toContain('massu_knowledge_schema_check');
    expect(names).toContain('massu_knowledge_pattern');
    expect(names).toContain('massu_knowledge_verification');
    expect(names).toContain('massu_knowledge_graph');
    expect(names).toContain('massu_knowledge_command');
    expect(names).toContain('massu_knowledge_correct');
    expect(names).toContain('massu_knowledge_plan');
    expect(names).toContain('massu_knowledge_gaps');
    expect(names).toContain('massu_knowledge_effectiveness');
  });
});

describe('massu_knowledge_search', () => {
  it('finds results for build-related queries', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_search', { query: 'build' }, db);
    const text = result.content[0].text;
    expect(text).toContain('Knowledge Search');
    // Should find something -- build is mentioned extensively
    expect(text).not.toContain('No matches found');
  });

  it('returns error for missing query', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_search', {}, db);
    expect(result.content[0].text).toContain('Error');
  });

  it('respects limit parameter', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_search', { query: 'build', limit: 2 }, db);
    const text = result.content[0].text;
    // Count the number of result headers (### ...)
    const headings = text.match(/^### /gm);
    if (headings) {
      expect(headings.length).toBeLessThanOrEqual(2);
    }
  });
});

describe('massu_knowledge_rule', () => {
  it('looks up CR-1 with verification', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_rule', { rule_id: 'CR-1' }, db);
    const text = result.content[0].text;
    expect(text).toContain('CR-1');
  });

  it('searches rules by keyword', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_rule', { keyword: 'test' }, db);
    const text = result.content[0].text;
    expect(text).toContain('Rules matching');
  });

  it('lists all rules when no params', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_rule', {}, db);
    const text = result.content[0].text;
    expect(text).toContain('All Canonical Rules');
    expect(text).toContain('CR-1');
  });

  it('handles unknown rule gracefully', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_rule', { rule_id: 'CR-999' }, db);
    expect(result.content[0].text).toContain('not found');
  });
});

describe('massu_knowledge_incident', () => {
  it('lists incidents when no filter', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_incident', {}, db);
    const text = result.content[0].text;
    expect(text).toContain('Incidents');
  });

  it('searches incidents by keyword', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_incident', { keyword: 'test' }, db);
    const text = result.content[0].text;
    expect(text).toContain('Incidents');
  });
});

describe('massu_knowledge_schema_check', () => {
  it('returns no mismatches for unknown table', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_schema_check', { table: 'nonexistent_table_xyz' }, db);
    const text = result.content[0].text;
    expect(text).toContain('No known schema mismatches');
  });

  it('lists all mismatches when no params', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_schema_check', {}, db);
    const text = result.content[0].text;
    expect(text).toContain('Schema Mismatches');
  });
});

describe('massu_knowledge_pattern', () => {
  it('returns pattern guidance for a domain keyword', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_pattern', { domain: 'config' }, db);
    const text = result.content[0].text;
    expect(text).toContain('Pattern Guidance');
  });

  it('requires domain parameter', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_pattern', {}, db);
    expect(result.content[0].text).toContain('Error');
  });
});

describe('massu_knowledge_verification', () => {
  it('looks up VR-BUILD', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_verification', { vr_type: 'VR-BUILD' }, db);
    const text = result.content[0].text;
    expect(text).toContain('VR-BUILD');
    expect(text).toContain('npm run build');
  });

  it('searches by situation', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_verification', { situation: 'test' }, db);
    const text = result.content[0].text;
    expect(text).toContain('Verification');
  });

  it('lists all verifications when no params', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_verification', {}, db);
    const text = result.content[0].text;
    expect(text).toContain('All Verification Types');
  });
});

describe('massu_knowledge_graph', () => {
  it('traverses from CR-1', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_graph', { entity_type: 'cr', entity_id: 'CR-1' }, db);
    const text = result.content[0].text;
    expect(text).toContain('Knowledge Graph');
    expect(text).toContain('CR-1');
  });

  it('requires entity_type and entity_id', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_graph', {}, db);
    expect(result.content[0].text).toContain('Error');
  });
});

describe('massu_knowledge_command', () => {
  it('lists all commands when no params', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_command', {}, db);
    const text = result.content[0].text;
    expect(text).toContain('All Commands');
  });

  it('searches commands by keyword', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_command', { keyword: 'audit' }, db);
    const text = result.content[0].text;
    expect(text).toContain('Commands matching');
  });
});

// Tests for additional tools

describe('massu_knowledge_correct', () => {
  // The corrections tool writes to the memory directory which may not exist
  const memoryDir = getResolvedPaths().memoryDir;
  const correctionsPath = resolve(memoryDir, 'corrections.md');
  let createdMemoryDir = false;

  beforeAll(() => {
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
      createdMemoryDir = true;
    }
  });

  afterAll(() => {
    // Clean up corrections.md created by tests
    try { if (existsSync(correctionsPath)) unlinkSync(correctionsPath); } catch { /* ignore */ }
    // Only remove directory if we created it
    if (createdMemoryDir) {
      try { rmSync(memoryDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('requires wrong, correction, and rule', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_correct', { wrong: 'test' }, db);
    expect(result.content[0].text).toContain('Error');
  });

  it('records a correction when all args provided', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_correct', {
      wrong: 'Test wrong behavior',
      correction: 'Test correct behavior',
      rule: 'Test prevention rule',
      cr_rule: 'CR-9',
    }, db);
    const text = result.content[0].text;
    expect(text).toContain('Correction recorded');
    expect(text).toContain('Test wrong behavior');
    expect(text).toContain('corrections.md updated');
  });

  it('inserts correction chunk with is_correction metadata into DB when corrections doc is indexed', () => {
    // First, ensure a corrections.md document exists in the knowledge index
    // so handleCorrect can attach chunks to it
    const existingDoc = db.prepare(
      "SELECT id FROM knowledge_documents WHERE file_path LIKE '%corrections.md'"
    ).get() as { id: number } | undefined;

    if (!existingDoc) {
      // Insert a mock corrections.md document so handleCorrect can attach chunks
      db.prepare(
        'INSERT INTO knowledge_documents (file_path, category, title, content_hash, indexed_at, indexed_at_epoch) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('memory/corrections.md', 'memory', 'User Corrections Log', 'mock', new Date().toISOString(), Date.now());
    }

    handleKnowledgeToolCall('massu_knowledge_correct', {
      wrong: 'DB verify wrong',
      correction: 'DB verify correct',
      rule: 'DB verify rule',
      cr_rule: 'CR-99',
    }, db);
    const chunk = db.prepare(
      "SELECT heading, content, metadata FROM knowledge_chunks WHERE heading LIKE '%DB verify%' AND metadata LIKE '%is_correction%'"
    ).get() as { heading: string; content: string; metadata: string } | undefined;
    expect(chunk).toBeTruthy();
    expect(chunk!.content).toContain('DB verify wrong');
    const meta = JSON.parse(chunk!.metadata);
    expect(meta.is_correction).toBe(true);
    expect(meta.cr_rule).toBe('CR-99');
  });
});

describe('massu_knowledge_plan', () => {
  it('lists all plans when no args', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_plan', {}, db);
    const text = result.content[0].text;
    expect(text).toContain('All Plans');
  });

  it('finds plans by keyword', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_plan', { keyword: 'massu' }, db);
    const text = result.content[0].text;
    expect(text).toContain('Plans matching');
  });
});

describe('massu_knowledge_gaps', () => {
  it('returns gap analysis for features', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_gaps', {}, db);
    const text = result.content[0].text;
    expect(text).toContain('Knowledge Gap Analysis');
  });
});

describe('massu_knowledge_effectiveness', () => {
  it('returns ranked rule list', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_effectiveness', {}, db);
    const text = result.content[0].text;
    expect(text).toContain('Most Violated Rules');
  });

  it('returns detail for a specific rule', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_effectiveness', { rule_id: 'CR-9', mode: 'detail' }, db);
    const text = result.content[0].text;
    expect(text).toContain('Rule Effectiveness');
    expect(text).toContain('CR-9');
  });
});

describe('handleKnowledgeToolCall routing', () => {
  it('handles unknown tool name', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_unknown', {}, db);
    expect(result.content[0].text).toContain('Unknown knowledge tool');
  });
});
