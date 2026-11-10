// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Session cost, kept current from the session's own transcript — the ONE writer of a
 * session's cost row, used by the session-end hook (this session, incrementally) and by
 * the repricer (old rows, from scratch).
 *
 * A row priced under an older PRICING_VERSION — including every row written before
 * per-response pricing existed, all of which held 0 tokens — is recomputed from its
 * transcript when the transcript still exists, and marked 'unknown' when it does not
 * (operator decision 2026-11-09). Never $0 for a cost nobody measured.
 */
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import type Database from 'better-sqlite3';
import { getResolvedPaths } from './config.ts';
import { getMemoryMeta, setMemoryMeta, tryAcquireMetaLease, releaseMetaLease } from './memory-db.ts';
import { parseTranscriptFrom } from './transcript-parser.ts';
import { costTranscriptEntries, storeSessionCost, markSessionCostUnknown } from './cost-tracker.ts';
import { PRICING_VERSION } from './model-pricing.ts';

const cursorKey = (sid: string) => `cost_processed_line:${sid}`;
const lastIdKey = (sid: string) => `cost_last_message:${sid}`;
/** Same key the session-end hook holds while it runs, so the two never price one session at once. */
export const sessionLeaseKey = (sid: string) => `session_end_lease:${sid}`;

/**
 * Bring `sessionId`'s cost row up to date from `transcriptPath`.
 *
 * Incremental when the row is already priced under the current PRICING_VERSION: parse only
 * the lines after the cost cursor, skip lines of the last response already counted (one
 * response spans several lines, and a run can end between them), and add. Otherwise —
 * no row, an older pricing version, or no cursor — parse from line 0 and REPLACE.
 */
export async function updateSessionCost(
  db: Database.Database,
  sessionId: string,
  transcriptPath: string,
): Promise<void> {
  const row = db.prepare('SELECT pricing_version FROM session_costs WHERE session_id = ?')
    .get(sessionId) as { pricing_version: number } | undefined;
  const cursor = Number(getMemoryMeta(db, cursorKey(sessionId)) ?? '0') || 0;
  const incremental = row?.pricing_version === PRICING_VERSION && cursor > 0;
  const from = incremental ? cursor : 0;
  const { entries, totalLines } = await parseTranscriptFrom(transcriptPath, from);
  const slice = costTranscriptEntries(entries, {
    skipMessageId: incremental ? getMemoryMeta(db, lastIdKey(sessionId)) : null,
  });
  storeSessionCost(db, sessionId, slice, incremental ? 'add' : 'replace');
  setMemoryMeta(db, cursorKey(sessionId), String(totalLines));
  if (slice.lastMessageId) setMemoryMeta(db, lastIdKey(sessionId), slice.lastMessageId);
}

/** Where Claude Code keeps this project's session transcripts: beside its memory dir. */
export function defaultTranscriptFor(sessionId: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  const path = join(dirname(getResolvedPaths().memoryDir), `${sessionId}.jsonl`);
  return existsSync(path) ? path : null;
}

export interface RepriceResult {
  repriced: number;
  markedUnknown: number;
  /** Sessions skipped because a session-end run held them; they are retried next time. */
  busy: number;
  /** Sessions whose repricing threw; counted, reported, retried next run (never aborts the batch). */
  failed: number;
  /** Rows still on an older pricing version when the run stopped. */
  remaining: number;
}

/**
 * Reprice stored rows that predate the current price list, oldest first, until
 * `deadlineAt`. Resumable: each finished row carries PRICING_VERSION and drops out of the
 * candidate set, so slices across many runs converge to one full pass.
 */
export async function repriceStoredSessions(
  db: Database.Database,
  opts: { deadlineAt?: number; findTranscript?: (sid: string) => string | null; batch?: number } = {},
): Promise<RepriceResult> {
  const deadlineAt = opts.deadlineAt ?? Infinity;
  const find = opts.findTranscript ?? defaultTranscriptFor;
  const out: RepriceResult = { repriced: 0, markedUnknown: 0, busy: 0, failed: 0, remaining: 0 };
  const stale = db.prepare(
    `SELECT session_id FROM session_costs WHERE pricing_version < ? ORDER BY id LIMIT ?`,
  );
  const ttlSec = 120;
  const tried = new Set<string>();
  outer: while (Date.now() < deadlineAt) {
    const ids = (stale.all(PRICING_VERSION, opts.batch ?? 50) as Array<{ session_id: string }>)
      .map((r) => r.session_id)
      .filter((sid) => !tried.has(sid));
    if (ids.length === 0) break;
    for (const sid of ids) {
      if (Date.now() >= deadlineAt) break outer;
      tried.add(sid);
      if (!tryAcquireMetaLease(db, sessionLeaseKey(sid), ttlSec)) {
        out.busy++;
        continue;
      }
      try {
        const path = find(sid);
        if (path) {
          await updateSessionCost(db, sid, path);
          out.repriced++;
        } else {
          markSessionCostUnknown(db, sid);
          out.markedUnknown++;
        }
      } catch (err) {
        // One unreadable transcript says nothing about the others (G26): count it, say so,
        // and keep going. The row keeps its old version, so a later run retries it.
        out.failed++;
        process.stderr.write(`[massu] cost reprice: ${sid}: ${err instanceof Error ? err.message : String(err)}\n`);
      } finally {
        releaseMetaLease(db, sessionLeaseKey(sid));
      }
    }
  }
  out.remaining = (db.prepare('SELECT COUNT(*) n FROM session_costs WHERE pricing_version < ?')
    .get(PRICING_VERSION) as { n: number }).n;
  return out;
}
