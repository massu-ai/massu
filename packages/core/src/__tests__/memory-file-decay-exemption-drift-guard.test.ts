// Drift-guard: a memory FILE on disk may never be retired by value-decay.
//
// THE BUG THIS LOCKS OUT (live in shipped code before this guard):
// `ingestMemoryFile` gives every memory file `type='discovery'` (NOT in
// `protectedTypes`) and `importance=4` (the corpus carries no `confidence`
// key), and a file nobody happens to retrieve accrues zero usage hits. After
// `retentionDays` (90) stage E demoted it 4→3→2, and `expireOldLowValueObservations`
// then expired it at the importance floor. `hybridSearch` excludes expired rows,
// and ingest never cleared `expired_at` — so re-saving the file could not revive
// it. Net effect: ~93 days after ingest, a memory file the operator wrote but
// never happened to retrieve went PERMANENTLY invisible to recall while sitting
// untouched on disk. Silent, irreversible, and aimed exactly at the memories
// consulted least.
//
// THE INVARIANT: for a file-backed row, THE FILE decides reachability — not the
// hit counter. Decay may not retire what the human never withdrew. A row is
// retired only when its file is gone (reconcile) or the human tombstones it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';

import {
  initMemorySchema,
  createSession,
  setMemoryMeta,
  USAGE_COUNTER_ARMED_KEY,
  MEMORY_FILE_TITLE_PREFIX,
} from '../memory-db.ts';
import { runConsolidation } from '../memory-consolidate.ts';
import { ingestMemoryFile } from '../memory-file-ingest.ts';
import { DEFAULT_CONSOLIDATION_CONFIG, type ConsolidationConfig } from '../consolidation-config.ts';

const DAY = 86400;
const SRC = join(__dirname, '..');

function cfg(over: Partial<ConsolidationConfig> = {}): ConsolidationConfig {
  return { ...DEFAULT_CONSOLIDATION_CONFIG, ...over };
}

/** Seed an observation at an arbitrary age, with no usage hits. */
function seedObs(
  db: Database.Database,
  title: string,
  ageDays: number,
  importance: number,
  now: number,
): number {
  const epoch = now - ageDays * DAY;
  const r = db
    .prepare(
      `INSERT INTO observations (session_id, type, title, detail, importance, created_at, created_at_epoch)
       VALUES (?, 'discovery', ?, 'body', ?, ?, ?)`,
    )
    .run('S1', title, importance, new Date(epoch * 1000).toISOString(), epoch);
  return Number(r.lastInsertRowid);
}

function row(db: Database.Database, id: number) {
  return db
    .prepare('SELECT importance, expired_at FROM observations WHERE id = ?')
    .get(id) as { importance: number; expired_at: string | null };
}

describe('memory-file decay exemption (drift-guard)', () => {
  let db: Database.Database;
  let dir: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'massu-memfile-decay-'));
    db = new Database(join(dir, 'mem.db'));
    initMemorySchema(db);
    createSession(db, 'S1');
    now = Math.floor(Date.now() / 1000);
    // Usage counter armed long ago => the cold-start guard is DISARMED, i.e.
    // expiry is fully live. This is the state the operator's store reaches.
    setMemoryMeta(db, USAGE_COUNTER_ARMED_KEY, String(now - 31 * DAY));
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('a file-backed memory survives long past retention with ZERO retrievals — while an identical non-file row expires', async () => {
    // Identical in every decay-relevant respect (type, age, importance, zero
    // hits). The ONLY difference is the [memory-file] title. The control row is
    // what proves this guard did not simply switch expiry off.
    const fileBacked = seedObs(db, `${MEMORY_FILE_TITLE_PREFIX}feedback_enterprise_grade_always`, 200, 4, now);
    const control = seedObs(db, 'An ordinary unread observation', 200, 4, now);

    // Six consecutive days of session-end consolidation.
    for (let d = 0; d < 6; d++) {
      await runConsolidation(db, { config: cfg(), projectRoot: dir, nowEpochSec: now + d * DAY });
    }

    const f = row(db, fileBacked);
    const c = row(db, control);

    // The memory file: untouched. Not demoted, not expired, still reachable.
    expect(f.expired_at, 'a memory file on disk must NEVER be expired by value-decay').toBeNull();
    expect(f.importance, 'a memory file must not be demoted toward the expiry floor').toBe(4);

    // The control: decayed and retired, exactly as designed.
    expect(c.importance, 'control row should have been demoted').toBeLessThan(4);
    expect(c.expired_at, 'control row should have expired — expiry must still work').not.toBeNull();
  });

  it('RESURRECT-ON-CONTACT: re-ingesting the file revives a row a prior version already expired', () => {
    const id = seedObs(db, `${MEMORY_FILE_TITLE_PREFIX}feedback_never_guess_anything`, 200, 2, now);
    // Simulate the damage done by a pre-fix release.
    db.prepare(
      `UPDATE observations SET expired_at = ?, expired_at_epoch = ?, valid_to = ?, valid_to_epoch = ? WHERE id = ?`,
    ).run(new Date(now * 1000).toISOString(), now, new Date(now * 1000).toISOString(), now, id);
    expect(row(db, id).expired_at, 'precondition: the row is expired').not.toBeNull();

    const file = join(dir, 'feedback_never_guess_anything.md');
    writeFileSync(
      file,
      `---\nname: feedback_never_guess_anything\ndescription: Never guess\nmetadata:\n  type: feedback\n---\n\nVerify or ask.\n`,
      'utf-8',
    );

    expect(ingestMemoryFile(db, 'S1', file)).toBe('updated');
    expect(
      row(db, id).expired_at,
      'the file is on disk, so the memory is live — ingest must clear the retirement',
    ).toBeNull();
  });

  it('STRUCTURAL: both decay queries still carry the file-backed exemption', () => {
    // Behaviour tests can be deleted; this asserts the exemption is present in
    // the two SQL predicates that can retire a memory, so removing it fails here.
    const expiry = readFileSync(join(SRC, 'memory-db.ts'), 'utf-8');
    const demote = readFileSync(join(SRC, 'memory-consolidate.ts'), 'utf-8');

    expect(
      /title NOT LIKE \?/.test(expiry),
      'expireOldLowValueObservations must exclude file-backed rows (title NOT LIKE ?)',
    ).toBe(true);
    expect(
      /MEMORY_FILE_TITLE_LIKE/.test(expiry),
      'memory-db.ts must bind MEMORY_FILE_TITLE_LIKE into the expiry predicate',
    ).toBe(true);
    expect(
      /o\.title NOT LIKE \?/.test(demote),
      "stageReweight's DEMOTE must exclude file-backed rows (o.title NOT LIKE ?)",
    ).toBe(true);
    expect(
      /MEMORY_FILE_TITLE_LIKE/.test(demote),
      'memory-consolidate.ts must bind MEMORY_FILE_TITLE_LIKE into the demote predicate',
    ).toBe(true);
  });
});
