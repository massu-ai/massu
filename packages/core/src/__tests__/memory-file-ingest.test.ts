// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import type Database from 'better-sqlite3';
import { resetConfig } from '../config.ts';
import { getMemoryDb } from '../memory-db.ts';
import { ingestMemoryFile, backfillMemoryFiles } from '../memory-file-ingest.ts';

const TEST_DIR = resolve(__dirname, '../test-memory-file-ingest-tmp');
const MEM_DIR = resolve(TEST_DIR, 'memory');

function write(path: string, content: string) {
  const dir = resolve(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

function getObs(db: Database.Database, title: string) {
  return db
    .prepare('SELECT id, type, title, detail, importance FROM observations WHERE title = ? LIMIT 1')
    .get(title) as
    | { id: number; type: string; title: string; detail: string; importance: number }
    | undefined;
}

describe('memory-file-ingest', () => {
  const originalCwd = process.cwd();
  let db: Database.Database;

  beforeEach(() => {
    resetConfig();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(MEM_DIR, { recursive: true });
    write(resolve(TEST_DIR, 'massu.config.yaml'), 'project:\n  name: app\npaths:\n  source: src\n');
    process.chdir(TEST_DIR);
    db = getMemoryDb();
    // observations.session_id FKs to sessions(session_id). These tests pass
    // ad-hoc session ids (including an auto-generated backfill id), so relax
    // FK enforcement on the test connection rather than pre-seeding every id.
    db.pragma('foreign_keys = OFF');
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    process.chdir(originalCwd);
    resetConfig();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('ingestMemoryFile', () => {
    it('returns skipped for a non-existent file', () => {
      expect(ingestMemoryFile(db, 'sid', resolve(MEM_DIR, 'nope.md'))).toBe('skipped');
    });

    it('inserts an observation from frontmatter and maps feedback -> decision', () => {
      const file = resolve(MEM_DIR, 'feedback_thing.md');
      write(
        file,
        '---\nname: My Feedback\ndescription: A learned correction\ntype: feedback\nconfidence: 0.5\n---\n\nThe body text goes here.\n'
      );
      const result = ingestMemoryFile(db, 'sid-1', file);
      expect(result).toBe('inserted');

      const obs = getObs(db, '[memory-file] My Feedback');
      expect(obs).toBeDefined();
      expect(obs!.type).toBe('decision'); // feedback -> decision
      expect(obs!.detail).toContain('A learned correction');
      expect(obs!.detail).toContain('The body text goes here.');
      // confidence 0.5 -> round(0.5*4 + 1) = 3
      expect(obs!.importance).toBe(3);
    });

    it('updates an existing observation on re-ingest of the same title', () => {
      const file = resolve(MEM_DIR, 'project_x.md');
      write(file, '---\nname: Proj X\ntype: project\n---\n\nfirst body\n');
      expect(ingestMemoryFile(db, 'sid', file)).toBe('inserted');

      // Rewrite the body, same name/title -> update path.
      write(file, '---\nname: Proj X\ntype: project\n---\n\nsecond body updated\n');
      expect(ingestMemoryFile(db, 'sid', file)).toBe('updated');

      const obs = getObs(db, '[memory-file] Proj X');
      expect(obs!.type).toBe('feature'); // project -> feature
      expect(obs!.detail).toContain('second body updated');
      expect(obs!.detail).not.toContain('first body');
    });

    it('falls back to basename and default type when no frontmatter present', () => {
      const file = resolve(MEM_DIR, 'plain-note.md');
      write(file, 'Just a plain markdown body, no frontmatter.\n');
      expect(ingestMemoryFile(db, 'sid', file)).toBe('inserted');

      const obs = getObs(db, '[memory-file] plain-note');
      expect(obs).toBeDefined();
      expect(obs!.type).toBe('discovery'); // default
      // no confidence -> default importance 4
      expect(obs!.importance).toBe(4);
    });

    it('uses defaults when frontmatter YAML is malformed', () => {
      const file = resolve(MEM_DIR, 'broken.md');
      // Unbalanced/garbage YAML inside the fence, but still matches the fence regex.
      write(file, '---\n: : : not valid yaml : [\n---\n\nbody after broken fm\n');
      const result = ingestMemoryFile(db, 'sid', file);
      expect(result).toBe('inserted');
      const obs = getObs(db, '[memory-file] broken');
      expect(obs).toBeDefined();
      expect(obs!.detail).toContain('body after broken fm');
    });

    it('maps reference type to discovery', () => {
      const file = resolve(MEM_DIR, 'reference_doc.md');
      write(file, '---\nname: Ref Doc\ntype: reference\nconfidence: 1\n---\n\nref body\n');
      ingestMemoryFile(db, 'sid', file);
      const obs = getObs(db, '[memory-file] Ref Doc');
      expect(obs!.type).toBe('discovery');
      // confidence 1.0 -> round(1*4+1)=5 (clamped within 1..5)
      expect(obs!.importance).toBe(5);
    });
  });

  describe('backfillMemoryFiles', () => {
    it('returns zeros when the memory dir does not exist', () => {
      const stats = backfillMemoryFiles(db, resolve(TEST_DIR, 'no-such-dir'));
      expect(stats).toEqual({ inserted: 0, updated: 0, skipped: 0, total: 0 });
    });

    it('ingests all .md files except the MEMORY.md index', () => {
      write(resolve(MEM_DIR, 'MEMORY.md'), '# index — must be skipped\n');
      write(resolve(MEM_DIR, 'a.md'), '---\nname: A\ntype: user\n---\n\nbody a\n');
      write(resolve(MEM_DIR, 'b.md'), '---\nname: B\ntype: project\n---\n\nbody b\n');
      write(resolve(MEM_DIR, 'notes.txt'), 'ignored non-md');

      const stats = backfillMemoryFiles(db, MEM_DIR, 'backfill-sid');
      // MEMORY.md excluded, notes.txt excluded -> 2 md files ingested
      expect(stats.total).toBe(2);
      expect(stats.inserted).toBe(2);
      expect(stats.updated).toBe(0);

      expect(getObs(db, '[memory-file] A')!.type).toBe('decision'); // user -> decision
      expect(getObs(db, '[memory-file] B')!.type).toBe('feature');  // project -> feature
      // The index file must NOT have been ingested.
      expect(getObs(db, '[memory-file] MEMORY')).toBeUndefined();
    });

    it('counts updates on a second backfill pass', () => {
      write(resolve(MEM_DIR, 'a.md'), '---\nname: A\n---\n\nbody a\n');
      const first = backfillMemoryFiles(db, MEM_DIR);
      expect(first.inserted).toBe(1);

      const second = backfillMemoryFiles(db, MEM_DIR);
      expect(second.updated).toBe(1);
      expect(second.inserted).toBe(0);
    });

    it('auto-generates a session id when none is provided', () => {
      write(resolve(MEM_DIR, 'a.md'), '---\nname: A\n---\n\nbody\n');
      const stats = backfillMemoryFiles(db, MEM_DIR);
      expect(stats.total).toBe(1);
      expect(stats.inserted).toBe(1);
    });
  });
});
