// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * DF-2 (audit 2026-07-14): `massu rule effectiveness` — the real, reachable
 * entry point that finally runs the CR-53 effectiveness check against the LIVE
 * audit_log. `evaluateCr53Effectiveness` had zero runtime callers (only a
 * synthetic :memory: test), so CR-53's promise — flag a promoted rule that
 * recurs — never actually executed. This drives the CLI handler against a real
 * seeded audit_log and asserts the invariant is now enforced at runtime.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initMemorySchema } from '../memory-db.ts';
import { logAuditEntry } from '../audit-trail.ts';

let ROOT: string;
let sharedDb: Database.Database;

vi.mock('../config.ts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getProjectRoot: () => ROOT };
});

vi.mock('../memory-db.ts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getMemoryDb: () => sharedDb };
});

import { handleRuleSubcommand } from '../commands/rule.ts';

function seedRecurringPromotion(db: Database.Database): void {
  db.prepare(
    `INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('s', datetime('now'), 0)`,
  ).run();
  logAuditEntry(db, {
    eventType: 'rule_promoted',
    actor: 'human',
    sessionId: 's',
    filePath: 'packages/core/src/foo.ts',
    metadata: { prompt_hash: 'h-bad', recurrence_count: 2 },
  });
  const id = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  db.prepare(`UPDATE audit_log SET timestamp = datetime('now', '-8 days') WHERE id = ?`).run(id);
}

let out = '';
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'massu-cr53-cli-'));
  sharedDb = new Database(':memory:');
  initMemorySchema(sharedDb);
  out = '';
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out += String(s);
    return true;
  });
});

afterEach(() => {
  writeSpy.mockRestore();
  // sharedDb is closed by the handler's finally; guard double-close.
  try { sharedDb.close(); } catch { /* already closed */ }
  rmSync(ROOT, { recursive: true, force: true });
});

describe('massu rule effectiveness (DF-2)', () => {
  it('exits 0 on a clean audit_log (no recurring promoted rules)', async () => {
    const res = await handleRuleSubcommand(['effectiveness']);
    expect(res.exitCode).toBe(0);
    expect(out).toContain('CR-53 effectiveness: OK');
  });

  it('exits 1 and reports a recurring promoted rule from the LIVE audit_log', async () => {
    seedRecurringPromotion(sharedDb);
    const res = await handleRuleSubcommand(['effectiveness']);
    expect(res.exitCode).toBe(1);
    expect(out).toContain('CR-53 effectiveness: PROBLEM');
    expect(out).toContain('rule h-bad recurred 2x');
  });

  it('a documented limitation (MASSU_KNOWN_RULE_LIMITATIONS) allowlists the recurrence', async () => {
    seedRecurringPromotion(sharedDb);
    const prev = process.env.MASSU_KNOWN_RULE_LIMITATIONS;
    process.env.MASSU_KNOWN_RULE_LIMITATIONS = JSON.stringify([
      { promptHash: 'h-bad', reason: 'documented limitation' },
    ]);
    try {
      const res = await handleRuleSubcommand(['effectiveness']);
      expect(res.exitCode).toBe(0);
      expect(out).toContain('CR-53 effectiveness: OK');
    } finally {
      if (prev === undefined) delete process.env.MASSU_KNOWN_RULE_LIMITATIONS;
      else process.env.MASSU_KNOWN_RULE_LIMITATIONS = prev;
    }
  });
});
