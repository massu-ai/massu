// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// Memory File Auto-Ingest
// Shared module for parsing memory/*.md files and ingesting
// their YAML frontmatter + content into the observations table.
// Used by: post-tool-use.ts, memory-tools.ts, init.ts
// ============================================================

import type Database from 'better-sqlite3';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { addObservation } from './memory-db.ts';

export type IngestResult = 'inserted' | 'updated' | 'skipped';

/**
 * Parse a memory/*.md file's YAML frontmatter and ingest it into the
 * observations table. Deduplicates by title prefix `[memory-file] {name}`.
 *
 * @returns 'inserted' | 'updated' | 'skipped'
 */
export function ingestMemoryFile(
  db: Database.Database,
  sessionId: string,
  filePath: string,
): IngestResult {
  if (!existsSync(filePath)) return 'skipped';

  const content = readFileSync(filePath, 'utf-8');
  const basename = (filePath.split('/').pop() ?? '').replace('.md', '');

  // Parse YAML frontmatter (between first --- and second ---)
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

  let name = basename;
  let description = '';
  let type = 'discovery';
  let confidence: number | undefined;

  if (frontmatterMatch) {
    try {
      const fm = parseYaml(frontmatterMatch[1]) as Record<string, unknown>;
      name = (fm.name as string) ?? basename;
      description = (fm.description as string) ?? '';
      type = (fm.type as string) ?? 'discovery';
      confidence = fm.confidence != null ? Number(fm.confidence) : undefined;
    } catch {
      // Use defaults if YAML parsing fails
    }
  }

  // Map memory types to observation types
  const obsType = mapMemoryTypeToObservationType(type);

  // Calculate importance from confidence (0.0-1.0 -> 1-5)
  const importance = confidence != null
    ? Math.max(1, Math.min(5, Math.round(confidence * 4 + 1)))
    : 4;

  // Extract body (after second ---)
  const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
  const body = bodyMatch ? bodyMatch[1].trim().slice(0, 500) : '';

  const title = `[memory-file] ${name}`;
  const detail = description ? `${description}\n\n${body}` : body;

  // Deduplicate: check if this exact title exists
  const existing = db.prepare(
    'SELECT id FROM observations WHERE title = ? LIMIT 1'
  ).get(title) as { id: number } | undefined;

  if (existing) {
    db.prepare('UPDATE observations SET detail = ?, importance = ? WHERE id = ?')
      .run(detail, importance, existing.id);
    return 'updated';
  } else {
    addObservation(db, sessionId, obsType, title, detail, { importance });
    return 'inserted';
  }
}

/**
 * Bulk-ingest all memory/*.md files from a directory.
 * Skips MEMORY.md (the index file).
 *
 * @returns { inserted, updated, skipped, total }
 */
export function backfillMemoryFiles(
  db: Database.Database,
  memoryDir: string,
  sessionId?: string,
): { inserted: number; updated: number; skipped: number; total: number } {
  const stats = { inserted: 0, updated: 0, skipped: 0, total: 0 };

  if (!existsSync(memoryDir)) return stats;

  const files = readdirSync(memoryDir).filter(
    f => f.endsWith('.md') && f !== 'MEMORY.md'
  );
  stats.total = files.length;

  const sid = sessionId ?? `backfill-${Date.now()}`;

  for (const file of files) {
    const result = ingestMemoryFile(db, sid, join(memoryDir, file));
    stats[result]++;
  }

  return stats;
}

function mapMemoryTypeToObservationType(memoryType: string): string {
  switch (memoryType) {
    case 'user':
    case 'feedback':
      return 'decision';
    case 'project':
      return 'feature';
    case 'reference':
      return 'discovery';
    default:
      return 'discovery';
  }
}
