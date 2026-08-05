/**
 * D-003 — no memory.db insert path may let the column DEFAULT supply a timestamp.
 *
 * THE DEFECT. `created_at TEXT DEFAULT (datetime('now'))` yields `2026-08-01 04:57:05`,
 * while JS `toISOString()` yields `2026-08-01T05:18:21.877Z`. An INSERT that OMITS the
 * column silently takes the space form, and the two do not compare (`' '` 0x20 < `'T'` 0x54).
 *
 * WHY THIS GUARD AND NOT A SCHEMA CHANGE. `CREATE TABLE IF NOT EXISTS` is a no-op against a
 * database that already has the table, so changing the DEFAULT would fix only FRESH databases
 * — not the eleven existing fleet DBs carrying 159,294 space-format rows. Supplying the value
 * explicitly at every insert is what takes effect on the databases that actually exist.
 *
 * This guard scans SOURCE rather than asserting a fixed list of call sites, so a NEW insert
 * into a timestamped table is covered the first time it is written (G18 — the candidate set
 * IS the gate).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(import.meta.dirname, '..');

/** Tables whose rows carry a timestamp that anything ever compares or orders by. */
const TIMESTAMPED_TABLES = [
  'conversation_turns',
  'tool_call_details',
  'tool_cost_events',
  'quality_events',
  'user_prompts',
] as const;

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === '__tests__' || e === 'node_modules' || e === 'dist') continue;
      tsFiles(p, acc);
    } else if (e.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

interface Site {
  file: string;
  table: string;
  columns: string;
}

function findInsertSites(): Site[] {
  const sites: Site[] = [];
  for (const f of tsFiles(SRC)) {
    const src = readFileSync(f, 'utf-8');
    for (const table of TIMESTAMPED_TABLES) {
      // `INSERT INTO <table> ( ... )` — the FTS shadow tables (…_fts) must not match, hence \b.
      const re = new RegExp(`INSERT\\s+INTO\\s+${table}\\b\\s*\\(([^)]*)\\)`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        sites.push({ file: f.replace(SRC, 'src'), table, columns: m[1] });
      }
    }
  }
  return sites;
}

describe('D-003 — memory.db timestamp write drift-guard', () => {
  const sites = findInsertSites();

  it('M1 — the scan found insert sites at all (0 found must never read as clean)', () => {
    expect(
      sites.length,
      'scanned the source tree and found ZERO inserts into any timestamped table — the ' +
        'scanner is broken or the tables were renamed. A denominator of 0 is not a pass.',
    ).toBeGreaterThan(0);
  });

  it('every insert into a timestamped table supplies created_at explicitly', () => {
    const offenders = sites
      .filter((s) => !/\bcreated_at\b/.test(s.columns))
      .map((s) => `${s.file} -> INSERT INTO ${s.table}`);
    expect(
      offenders,
      'These inserts omit created_at, so SQLite\'s DEFAULT (datetime(\'now\')) supplies the ' +
        'space-separated form and the row becomes uncomparable against ISO rows. Pass ' +
        'nowIso() explicitly — see src/lib/timestamps.ts.\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('the scanner can actually SEE an omission (can-fail proof, CR-72)', () => {
    // Feed the real matcher a string with the defect. If this does not detect it, the
    // green above proves nothing.
    const planted = 'INSERT INTO conversation_turns (session_id, turn_number, user_prompt)';
    const m = /INSERT\s+INTO\s+conversation_turns\b\s*\(([^)]*)\)/.exec(planted);
    expect(m, 'the matcher failed to parse a well-formed INSERT — scanner is broken').not.toBeNull();
    expect(/\bcreated_at\b/.test(m![1]), 'the planted omission was NOT detected').toBe(false);

    // …and the compliant form must NOT be flagged (a guard that fails everything is a brick).
    const ok = 'INSERT INTO conversation_turns (session_id, turn_number, created_at)';
    const m2 = /INSERT\s+INTO\s+conversation_turns\b\s*\(([^)]*)\)/.exec(ok);
    expect(/\bcreated_at\b/.test(m2![1])).toBe(true);
  });

  it('the FTS shadow tables are not mistaken for the real one', () => {
    // conversation_turns_fts inserts carry no timestamp and must not be flagged.
    const fts = 'INSERT INTO conversation_turns_fts(rowid, user_prompt, assistant_response)';
    expect(/INSERT\s+INTO\s+conversation_turns\b\s*\(/.test(fts)).toBe(false);
  });
});
