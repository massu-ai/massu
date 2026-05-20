// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-D-011 / ARCH-04: extracted from
// `hooks/post-tool-use.ts` to break the test-infra ↔ esbuild-entry
// coupling. The hook imports this module via the static import graph
// rather than re-exporting test internals from a bundled entry.

import type Database from 'better-sqlite3';

const ANSI = /\x1b\[[0-9;]*m/g;
const FAIL_LINE = /^\s+FAIL:\s*(.*)$/;
const FILE_TOKEN = /[\w./-]+\.(?:ts|tsx|js|jsx|sh|md|yaml|yml|json)\b/g;

/**
 * Scan pattern-scanner stdout for `  FAIL:` lines (after ANSI strip),
 * and for each FAILed file that the current session also edited in the
 * last 24h, bump `metadata.recurrence_count` on every `rule_promoted`
 * audit_log row whose `file_path` matches.
 *
 * ARCH-05 fix: previously a greedy 5-line lookahead window could over-bump
 * recurrence_count on FAIL lines that mentioned unrelated paths. The
 * lookahead is removed — files are extracted ONLY from the FAIL line
 * itself (after the `FAIL:` prefix), giving a tight 1-line scope per
 * scanner violation.
 *
 * The 24h window is the natural session granularity for a correction →
 * recurrence causal link. 1h is too short (a single multi-phase loop
 * can exceed 1h); 7d is too long (catches stale unrelated edits).
 */
export function incrementRecurrenceCountsForScannerFailures(
  db: Database.Database,
  sessionId: string,
  scannerStdout: string
): number {
  const stripped = scannerStdout.replace(ANSI, '');
  const lines = stripped.split('\n');
  const failedFiles = new Set<string>();
  for (const line of lines) {
    const m = line.match(FAIL_LINE);
    if (!m) continue;
    const matches = m[1].match(FILE_TOKEN);
    if (matches) {
      for (const f of matches) failedFiles.add(f);
    }
  }
  if (failedFiles.size === 0) return 0;

  const sessionEdits = db.prepare(`
    SELECT DISTINCT file_path FROM audit_log
    WHERE session_id = ?
      AND event_type = 'code_change'
      AND change_type IN ('edit', 'create')
      AND timestamp > datetime('now', '-24 hours')
    LIMIT 10000
  `).all(sessionId) as Array<{ file_path: string | null }>;
  const sessionFiles = new Set(
    sessionEdits.map(r => r.file_path).filter((p): p is string => Boolean(p))
  );
  if (sessionFiles.size === 0) return 0;

  // Intersection — files BOTH failed in this scanner run AND edited in this session.
  const intersection = new Set<string>();
  for (const f of failedFiles) {
    if (sessionFiles.has(f)) {
      intersection.add(f);
    } else {
      // Also match by basename suffix to handle absolute vs relative path
      // discrepancies. Only the SHORTER path is treated as the match key —
      // a session-edited absolute path matched by a relative FAIL token
      // uses the absolute (canonical) path as the bump target.
      for (const sf of sessionFiles) {
        if (sf.endsWith('/' + f) || f.endsWith('/' + sf)) {
          intersection.add(sf);
          break;
        }
      }
    }
  }
  if (intersection.size === 0) return 0;

  const updateStmt = db.prepare(`
    UPDATE audit_log
    SET metadata = json_set(metadata, '$.recurrence_count', COALESCE(json_extract(metadata, '$.recurrence_count'), 0) + 1)
    WHERE event_type = 'rule_promoted'
      AND file_path = ?
      AND timestamp > datetime('now', '-7 days')
  `);
  let updates = 0;
  for (const f of intersection) {
    const r = updateStmt.run(f);
    updates += r.changes;
  }
  return updates;
}
