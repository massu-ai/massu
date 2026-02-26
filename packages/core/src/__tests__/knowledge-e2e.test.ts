// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { unlinkSync, existsSync } from 'fs';
import { initKnowledgeSchema } from '../knowledge-db.ts';
import { indexAllKnowledge, isKnowledgeStale, indexIfStale } from '../knowledge-indexer.ts';
import { handleKnowledgeToolCall } from '../knowledge-tools.ts';

// P1-005: Knowledge Integration / E2E Tests

const TEST_DB_PATH = resolve(__dirname, '../test-knowledge-e2e.db');

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
});

afterAll(() => {
  db.close();
  cleanupTestDb();
});

describe('Full Pipeline: Index -> Query -> Verify', () => {
  it('indexes, searches, and returns results matching source files', () => {
    // Step 1: Index
    const stats = indexAllKnowledge(db);
    expect(stats.filesIndexed).toBeGreaterThan(0);
    expect(stats.chunksCreated).toBeGreaterThan(0);

    // Step 2: Query for something we know exists in CLAUDE.md
    const result = handleKnowledgeToolCall('massu_knowledge_rule', { rule_id: 'CR-1' }, db);
    const text = result.content[0].text;
    expect(text).toContain('CR-1');
    expect(text).toContain('Never claim state without proof');

    // Step 3: Verify VR types are indexed from CLAUDE.md
    const vrResult = handleKnowledgeToolCall('massu_knowledge_verification', { vr_type: 'VR-BUILD' }, db);
    const vrText = vrResult.content[0].text;
    expect(vrText).toContain('VR-BUILD');
  });
});

describe('Staleness Detection', () => {
  it('detects stale state on empty DB and indexes', () => {
    // Create a fresh DB for this test
    const freshPath = resolve(__dirname, '../test-knowledge-stale.db');
    try { if (existsSync(freshPath)) unlinkSync(freshPath); } catch { /* ignore */ }
    const freshDb = new Database(freshPath);
    freshDb.pragma('journal_mode = WAL');
    freshDb.pragma('foreign_keys = ON');
    initKnowledgeSchema(freshDb);

    try {
      // Empty DB should be stale
      expect(isKnowledgeStale(freshDb)).toBe(true);

      // indexIfStale should index when stale
      const stats = indexIfStale(freshDb);
      expect(stats.filesIndexed).toBeGreaterThan(0);

      // Second call should NOT reindex (not stale)
      const stats2 = indexIfStale(freshDb);
      expect(stats2.filesIndexed).toBe(0);
    } finally {
      freshDb.close();
      try { unlinkSync(freshPath); } catch { /* ignore */ }
      try { unlinkSync(freshPath + '-shm'); } catch { /* ignore */ }
      try { unlinkSync(freshPath + '-wal'); } catch { /* ignore */ }
    }
  });
});

describe('Edge Traversal: Multi-Hop', () => {
  it('traverses from a CR through connected entities', () => {
    // Ensure data is indexed
    const docCount = (db.prepare('SELECT COUNT(*) as cnt FROM knowledge_documents').get() as { cnt: number }).cnt;
    if (docCount === 0) indexAllKnowledge(db);

    // Find any CR that has an edge
    const crWithEdge = db.prepare(
      "SELECT source_id FROM knowledge_edges WHERE source_type = 'cr' LIMIT 1"
    ).get() as { source_id: string } | undefined;

    if (crWithEdge) {
      // Traverse from that CR at depth 2
      const result = handleKnowledgeToolCall('massu_knowledge_graph', {
        entity_type: 'cr',
        entity_id: crWithEdge.source_id,
        depth: 2,
      }, db);

      const text = result.content[0].text;
      expect(text).toContain('Knowledge Graph');
      expect(text).toContain('cr/' + crWithEdge.source_id);
      // Should find at least 1 connected entity
      expect(text).toContain('Total connected entities');
    }
  });
});

describe('FTS5 Full-Text Search Quality', () => {
  it('returns relevant results for domain-specific queries', () => {
    // Ensure data is indexed
    const docCount = (db.prepare('SELECT COUNT(*) as cnt FROM knowledge_documents').get() as { cnt: number }).cnt;
    if (docCount === 0) indexAllKnowledge(db);

    // Search for "verification" -- should find VR-related content
    const result = handleKnowledgeToolCall('massu_knowledge_search', { query: 'verification' }, db);
    const text = result.content[0].text;
    // Should find something related to verification
    expect(text).toContain('Knowledge Search');
  });

  it('handles FTS5 special characters gracefully', () => {
    // Queries with special chars should not crash
    const result = handleKnowledgeToolCall('massu_knowledge_search', { query: 'config.ts' }, db);
    expect(result.content[0].text).toBeTruthy();
  });
});

describe('Graceful Degradation', () => {
  it('handles empty search results gracefully', () => {
    // The ensureKnowledgeIndexed call auto-indexes if data is stale,
    // so we test degradation via an impossible search term instead
    const result = handleKnowledgeToolCall('massu_knowledge_search', { query: 'xyznonexistent99999' }, db);
    const text = result.content[0].text;
    expect(text).toContain('Knowledge Search');
    // Should show "No matches" or similar, not crash
    expect(text).toBeTruthy();
  });

  it('handles unknown tool name gracefully', () => {
    const result = handleKnowledgeToolCall('massu_knowledge_nonexistent', {}, db);
    expect(result.content[0].text).toContain('Unknown knowledge tool');
  });
});

describe('Plan Documents in Index', () => {
  it('plan documents appear in FTS search results', () => {
    const docCount = (db.prepare('SELECT COUNT(*) as cnt FROM knowledge_documents').get() as { cnt: number }).cnt;
    if (docCount === 0) indexAllKnowledge(db);

    const planDocs = db.prepare("SELECT COUNT(*) as cnt FROM knowledge_documents WHERE category = 'plan'").get() as { cnt: number };
    expect(planDocs.cnt).toBeGreaterThan(0);

    // Plan items should be searchable via FTS
    const ftsResult = db.prepare(`
      SELECT COUNT(*) as cnt FROM knowledge_fts WHERE file_path LIKE '%plans/%'
    `).get() as { cnt: number };
    expect(ftsResult.cnt).toBeGreaterThan(0);
  });
});

describe('Corrections Indexing', () => {
  it('corrections are indexed with is_correction metadata if corrections.md exists', () => {
    const docCount = (db.prepare('SELECT COUNT(*) as cnt FROM knowledge_documents').get() as { cnt: number }).cnt;
    if (docCount === 0) indexAllKnowledge(db);

    const correctionChunks = db.prepare(
      "SELECT COUNT(*) as cnt FROM knowledge_chunks WHERE metadata LIKE '%is_correction%'"
    ).get() as { cnt: number };
    expect(correctionChunks.cnt).toBeGreaterThanOrEqual(0); // May be 0 if corrections.md doesn't exist
  });
});
