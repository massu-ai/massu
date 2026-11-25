// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Memory-store retention: the ONE retention pass, and handing freed pages back to the filesystem.
 *
 * Nothing here deletes memory or corpus content. `runMemoryRetention` is the retention pass massu already
 * shipped (conversation turns > 7 days, tool-cost events > 90 days, low-value observations EXPIRED, never
 * deleted), moved out of the MCP server's startup so the session-end hook can run it too: before this, retention
 * happened only when the MCP server restarted. `releaseFreePages` returns pages SQLite has ALREADY freed.
 */

import type Database from 'better-sqlite3';
import {
  armUsageCounter,
  pruneOldConversationTurns,
  pruneOldObservations,
  pruneToolCostEvents,
} from './memory-db.ts';
import { resolveConsolidationConfig } from './consolidation-config.ts';

/** Days of conversation turns and tool-call detail kept. Unchanged from the startup pass that shipped. */
export const CONVERSATION_RETENTION_DAYS = 7;

export interface RetentionCounts {
  turnsDeleted: number;
  detailsDeleted: number;
  /** Observations EXPIRED (superseded, kept on disk), not deleted. */
  observationsExpired: number;
  costEventsDeleted: number;
  retentionDays: number;
}

/**
 * The retention pass. Callers: the MCP server at startup (`server.ts`) and the session-end hook. A caller test
 * (`memory-retention.test.ts`) asserts exactly those two, so neither can silently stop calling it.
 */
export function runMemoryRetention(db: Database.Database): RetentionCounts {
  // Arm the retrieval counter on first ever boot. Expiry stays DISARMED until it has observed usage for
  // usageWarmupDays, otherwise the first run after an upgrade would see a store in which nothing has ever been
  // retrieved and expire nearly all of it. See armUsageCounter() in memory-db.ts.
  armUsageCounter(db);

  const turns = pruneOldConversationTurns(db, CONVERSATION_RETENTION_DAYS);

  // Supersede-EXPIRE, read from the SAME config the consolidation pass reads, so the two never retire rows on two
  // different policies.
  const cfg = resolveConsolidationConfig();
  const observationsExpired = pruneOldObservations(db, {
    retentionDays: cfg.retentionDays,
    importanceFloor: cfg.importanceFloor,
    protectedTypes: cfg.protectedTypes,
    usageWarmupDays: cfg.usageWarmupDays,
    reweightIntervalDays: cfg.reweightIntervalDays,
  });

  const costEventsDeleted = pruneToolCostEvents(db);

  return {
    turnsDeleted: turns.turnsDeleted,
    detailsDeleted: turns.detailsDeleted,
    observationsExpired,
    costEventsDeleted,
    retentionDays: cfg.retentionDays,
  };
}

/** One human-readable line for a retention result; empty when nothing was retired. */
export function describeRetention(c: RetentionCounts, when: string): string {
  const total = c.turnsDeleted + c.detailsDeleted + c.observationsExpired + c.costEventsDeleted;
  if (total === 0) return '';
  return (
    `massu: Maintained memory DB ${when} — ` +
    `${c.turnsDeleted} conversation turns, ` +
    `${c.detailsDeleted} tool call details (>${CONVERSATION_RETENTION_DAYS}d), ` +
    `${c.observationsExpired} observations expired (not deleted; >${c.retentionDays}d, unused, unprotected), ` +
    `${c.costEventsDeleted} tool-cost events (>90d)\n`
  );
}

/**
 * Pages freed per `PRAGMA incremental_vacuum(N)` call.
 *
 * MEASURED, not chosen (CR-68): `scripts/ops/measure-incremental-vacuum.sh --like .massu/memory.db`, 2026-11-21
 * PST, node 26.0.0 / SQLite 3.53.1, 4096-byte pages, 117k scattered free pages, the hook's default cache_size.
 * Three runs picked 512: 32-38 pages/ms (the best throughput measured), p95 26-37 ms per batch + checkpoint, and
 * 415 WAL frames per batch. 1024 was SLOWER per page and wrote 957 frames, 4% under SQLite's 1000-frame
 * autocheckpoint; 2048 wrote 1991. Re-run the script before changing this.
 */
export const INCREMENTAL_VACUUM_BATCH_PAGES = 512;

export type FreePagesResult =
  | { status: 'skipped'; reason: string; autoVacuum: number; freePages: number }
  | {
      status: 'ran';
      freeBefore: number;
      freeAfter: number;
      batches: number;
      /** Why the loop ended: nothing left, out of time, or a batch freed nothing (never spins). */
      stoppedBy: 'empty' | 'deadline' | 'no-progress';
    };

const pragmaNumber = (db: Database.Database, name: string): number =>
  Number(db.pragma(name, { simple: true }));

/**
 * Hand pages SQLite has already freed back to the filesystem, in bounded batches, until `deadlineAt`.
 *
 * Only in `auto_vacuum=INCREMENTAL` (mode 2). In mode 0 or 1 it does nothing and SAYS so (`status: 'skipped'`),
 * because a run that freed nothing and a run that could not free anything must not look alike. Each batch is
 * followed by a PASSIVE checkpoint, so the WAL is reset between batches instead of accumulating every relocated
 * page (sqlite.org/forum/forumpost/bca9f3906a); PASSIVE never waits on a reader.
 */
export function releaseFreePages(
  db: Database.Database,
  opts: { deadlineAt: number; batchPages?: number; now?: () => number },
): FreePagesResult {
  const batchPages = opts.batchPages ?? INCREMENTAL_VACUUM_BATCH_PAGES;
  if (!Number.isInteger(batchPages) || batchPages <= 0) {
    throw new Error(`releaseFreePages: batchPages must be a positive integer, got ${batchPages}`);
  }
  const now = opts.now ?? Date.now;
  const autoVacuum = pragmaNumber(db, 'auto_vacuum');
  const freeBefore = pragmaNumber(db, 'freelist_count');
  if (autoVacuum !== 2) {
    return { status: 'skipped', reason: `auto_vacuum=${autoVacuum}`, autoVacuum, freePages: freeBefore };
  }

  let free = freeBefore;
  let batches = 0;
  let stoppedBy: 'empty' | 'deadline' | 'no-progress' = 'empty';
  while (free > 0) {
    if (now() >= opts.deadlineAt) { stoppedBy = 'deadline'; break; }
    db.exec(`PRAGMA incremental_vacuum(${batchPages})`);
    db.pragma('wal_checkpoint(PASSIVE)');
    batches++;
    const next = pragmaNumber(db, 'freelist_count');
    if (next >= free) { stoppedBy = 'no-progress'; free = next; break; }
    free = next;
  }
  return { status: 'ran', freeBefore, freeAfter: free, batches, stoppedBy };
}

/** One line for a free-pages result, always non-empty: a skip is reported, never silent. */
export function describeFreePages(r: FreePagesResult): string {
  if (r.status === 'skipped') {
    return `[massu] session-end: release free pages skipped: ${r.reason} (${r.freePages} free pages stay in the file ` +
      `until it is converted once: PRAGMA auto_vacuum=INCREMENTAL; VACUUM; with no massu process holding it)\n`;
  }
  return `[massu] session-end: released ${r.freeBefore - r.freeAfter} free pages in ${r.batches} batch(es) ` +
    `(${r.freeBefore} -> ${r.freeAfter}, stopped: ${r.stoppedBy})\n`;
}
