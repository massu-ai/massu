/**
 * The ONE place a memory.db timestamp is produced or compared (plan-2026-08-01 Phase D).
 *
 * THE DEFECT THIS CLOSES. `.massu/memory.db` carries timestamps in TWO formats:
 *
 *     sessions.started_at        2026-08-01T05:18:21.877Z   <- JS `new Date().toISOString()`
 *     tool_call_details.created_at  2026-08-01 04:57:05     <- SQLite `DEFAULT (datetime('now'))`
 *
 * They are the same instant and they do not compare. `' '` is 0x20 and `'T'` is 0x54, so a
 * space-format row ALWAYS sorts before an ISO row on the same date. A `WHERE created_at >= ?`
 * that crosses formats silently under-counts — measured on the real fleet: a query returned 0
 * where the truth was 6052.
 *
 * WHY A READ ACCESSOR IS THE LOAD-BEARING HALF, not the write normalisation. History is NOT
 * rewritten (D-5), so 159,294 space-format rows persist for the life of these databases.
 * Normalising the write path stops the divergence GROWING; it does not make a single existing
 * comparison correct. Anything that compares timestamps must go through `toComparableIso`
 * FOREVER, whatever the writers do.
 *
 * The write half (`nowIso`, `SQL_ISO_NOW`) exists so the mixed set stops expanding, and so a
 * database created from today's schema is single-format by construction.
 */

/** The canonical wire format: `2026-08-01T05:18:21.877Z`. */
const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** SQLite's `datetime('now')` output: `2026-08-01 04:57:05` — UTC, space-separated, no zone. */
const SQLITE_SPACE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

/**
 * The ONE producer of a memory.db timestamp. Every insert path passes this explicitly so the
 * column DEFAULT never fires — which is what makes the fix effective on EXISTING databases,
 * where the old `datetime('now')` DEFAULT is already baked into the schema and cannot be
 * changed without recreating a multi-hundred-megabyte table.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The SQLite expression matching `nowIso()` byte-for-byte, for NEW schema DEFAULTs.
 *
 * Verified 2026-08-01: `strftime('%Y-%m-%dT%H:%M:%fZ','now')` -> `2026-08-02T00:09:02.309Z`,
 * the same shape as `new Date().toISOString()` -> `2026-08-02T00:09:02.292Z`.
 *
 * NOTE the limit, deliberately stated rather than implied: `CREATE TABLE IF NOT EXISTS` is a
 * no-op against a database that already has the table, so changing this does NOT migrate the
 * eleven existing fleet databases. It makes a FRESH database single-format; `nowIso()` at the
 * insert sites is what fixes the existing ones.
 */
export const SQL_ISO_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/**
 * Normalise either stored format to a single lexicographically-comparable ISO string.
 *
 * Returns `null` for anything it does not recognise — FAIL CLOSED (M2). A caller that treats
 * an unparseable timestamp as "0" or as "now" would resurrect the exact silent-miscount this
 * module exists to end, so the caller is forced to decide what an unknown value means.
 */
export function toComparableIso(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v === '') return null;

  if (ISO_MS_Z.test(v)) {
    // Pad a missing/short fractional part so `...:21Z` and `...:21.877Z` compare correctly:
    // without this, 'T05:18:21Z' > 'T05:18:21.877Z' because 'Z' (0x5A) > '.' (0x2E).
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(v);
    if (!m) return null;
    return `${m[1]}.${(m[2] ?? '').padEnd(3, '0')}Z`;
  }

  const s = SQLITE_SPACE.exec(v);
  if (s) return `${s[1]}T${s[2]}.000Z`; // SQLite datetime('now') is UTC

  return null;
}

/**
 * Compare two stored timestamps of EITHER format.
 *
 * Returns null when either side is unrecognised, so "cannot compare" is distinguishable from
 * "compared and found equal" — the two must never collapse to the same value.
 */
export function compareTimestamps(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = toComparableIso(a);
  const y = toComparableIso(b);
  if (x === null || y === null) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** True when `value` is at or after `floor`. Null (uncomparable) is NOT "after" — fail closed. */
export function isAtOrAfter(value: string | null | undefined, floor: string | null | undefined): boolean {
  const c = compareTimestamps(value, floor);
  return c !== null && c >= 0;
}
