// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * shared-memory-audit.ts — the observability writer for cross-repo surfacing
 * (Living Memory Slice 5, B-10). One place writes the seven `audit_log` events so
 * export and import/accept stay consistent.
 *
 * `audit_log.session_id` is NOT NULL with an FK to `sessions`; a bad/absent session
 * throws. We resolve the latest real session and wrap the INSERT in try/catch —
 * exactly as `memory-file-ingest.ts` does — because the audit trail must NEVER break
 * the operation it is auditing. Both writers run where a session exists (the
 * session-end sweep for import; an interactive session for the CLI).
 */

import type Database from 'better-sqlite3';

/** The seven cross-repo events (B-10). Each is in the audit_log CHECK vocabulary. */
export type SharedMemoryAuditEvent =
  | 'shared_memory_exported'
  | 'shared_memory_export_refused'
  | 'shared_memory_imported'
  | 'shared_memory_dropped'
  | 'shared_memory_accepted'
  | 'shared_memory_refused'
  | 'shared_memory_revoked';

/** The most recent session id, or null if the store has none yet. */
export function latestSessionId(db: Database.Database): string | null {
  try {
    const row = db
      .prepare(`SELECT session_id FROM sessions ORDER BY started_at_epoch DESC LIMIT 1`)
      .get() as { session_id: string } | undefined;
    return row?.session_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Write one cross-repo audit_log row. Never throws — a bad session is swallowed.
 *
 * `actor` is provenance, not decoration: the export/import events fire from the
 * automated session-end SWEEP (no human present) and MUST be `'hook'`; the CLI-driven
 * events (accept/refuse/purge) are `'human'`. Corrupting this corrupts the exact
 * question B-10 exists to answer. Defaults to `'hook'` (the automated common case).
 */
export function writeSharedAudit(
  db: Database.Database,
  eventType: SharedMemoryAuditEvent,
  evidence: string,
  metadata: Record<string, unknown>,
  actor: 'hook' | 'human' = 'hook',
): void {
  const sessionId = latestSessionId(db);
  if (!sessionId) return;
  try {
    db.prepare(
      `INSERT INTO audit_log (session_id, event_type, actor, evidence, metadata)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(sessionId, eventType, actor, evidence, JSON.stringify(metadata));
  } catch {
    // Never let the audit trail break the thing it audits.
  }
}
