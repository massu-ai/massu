/**
 * Phase D — memory.db timestamp normalisation (plan-2026-08-01).
 *
 * The measured defect, from the real fleet DBs:
 *
 *     sessions.started_at           25 rows      2026-08-01T05:18:21.877Z
 *     user_prompts.created_at      443 rows      (same ISO form)
 *     tool_cost_events.created_at 7733 rows      2026-08-01 04:57:05
 *     quality_events            1037 rows        (same space form)
 *     tool_call_details       147556 rows        (same space form)
 *     conversation_turns        2968 rows        (same space form)
 *
 * `' '` is 0x20 and `'T'` is 0x54, so the space form ALWAYS sorts before the ISO form on the
 * same date. A cross-format `>=` silently under-counts; on the real data one such query
 * returned 0 where the truth was 6052.
 */
import { describe, it, expect } from 'vitest';
import {
  nowIso,
  SQL_ISO_NOW,
  toComparableIso,
  compareTimestamps,
  isAtOrAfter,
} from '../lib/timestamps.ts';

describe('Phase D — timestamp normalisation', () => {
  it('REPRODUCES the raw defect: naive string compare is wrong across formats', () => {
    const space = '2026-08-01 05:18:21'; // SQLite datetime('now')
    const iso = '2026-08-01T05:18:21.000Z'; // JS toISOString, SAME INSTANT
    // The bug, stated as an assertion so it cannot quietly stop being true:
    expect(space < iso).toBe(true); // 0x20 < 0x54 — space sorts first
    // …and the fix:
    expect(compareTimestamps(space, iso)).toBe(0);
  });

  it('normalises both stored formats to one comparable string', () => {
    expect(toComparableIso('2026-08-01 04:57:05')).toBe('2026-08-01T04:57:05.000Z');
    expect(toComparableIso('2026-08-01T05:18:21.877Z')).toBe('2026-08-01T05:18:21.877Z');
  });

  it('pads a short/absent fractional part, or Z outsorts a millisecond', () => {
    // 'Z' is 0x5A and '.' is 0x2E, so '…:21Z' > '…:21.877Z' naively — a SECOND ordering trap
    // hiding inside the ISO format itself, independent of the space/T one.
    expect('2026-08-01T05:18:21Z' > '2026-08-01T05:18:21.877Z').toBe(true);
    expect(compareTimestamps('2026-08-01T05:18:21Z', '2026-08-01T05:18:21.877Z')).toBe(-1);
    expect(toComparableIso('2026-08-01T05:18:21Z')).toBe('2026-08-01T05:18:21.000Z');
    expect(toComparableIso('2026-08-01T05:18:21.5Z')).toBe('2026-08-01T05:18:21.500Z');
  });

  it('FAILS CLOSED on anything unrecognised (M2)', () => {
    for (const bad of ['', '   ', 'not-a-date', '2026-08-01', '1754006301', null, undefined, 42 as unknown as string]) {
      expect(toComparableIso(bad as string), `should not parse: ${String(bad)}`).toBeNull();
    }
    // "cannot compare" must be distinguishable from "equal"
    expect(compareTimestamps('garbage', '2026-08-01T00:00:00.000Z')).toBeNull();
    expect(compareTimestamps('2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')).toBe(0);
  });

  it('isAtOrAfter treats uncomparable as NOT after — never optimistic', () => {
    expect(isAtOrAfter('2026-08-01 06:00:00', '2026-08-01T05:00:00.000Z')).toBe(true);
    expect(isAtOrAfter('2026-08-01 04:00:00', '2026-08-01T05:00:00.000Z')).toBe(false);
    expect(isAtOrAfter('garbage', '2026-08-01T05:00:00.000Z')).toBe(false);
    expect(isAtOrAfter(null, '2026-08-01T05:00:00.000Z')).toBe(false);
  });

  it('nowIso() emits the canonical form and round-trips through the normaliser', () => {
    const t = nowIso();
    expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(toComparableIso(t)).toBe(t);
  });

  it('SQL_ISO_NOW is the expression that matches nowIso() — shape asserted, not assumed', () => {
    // Verified against sqlite3 2026-08-01:
    //   strftime('%Y-%m-%dT%H:%M:%fZ','now') -> 2026-08-02T00:09:02.309Z
    expect(SQL_ISO_NOW).toBe("strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    // A value of that shape must normalise to itself, i.e. it IS the canonical form.
    expect(toComparableIso('2026-08-02T00:09:02.309Z')).toBe('2026-08-02T00:09:02.309Z');
  });

  it('ordering over a MIXED set is correct — the property that was actually broken', () => {
    const mixed = [
      '2026-08-01T05:18:21.877Z',
      '2026-08-01 04:57:05',
      '2026-08-01T04:00:00.000Z',
      '2026-08-01 06:30:00',
    ];
    const sorted = [...mixed].sort((a, b) => compareTimestamps(a, b) ?? 0);
    expect(sorted).toEqual([
      '2026-08-01T04:00:00.000Z',
      '2026-08-01 04:57:05',
      '2026-08-01T05:18:21.877Z',
      '2026-08-01 06:30:00',
    ]);
    // A naive sort gets this WRONG — proving the test is not vacuous.
    const naive = [...mixed].sort();
    expect(naive).not.toEqual(sorted);
  });
});
