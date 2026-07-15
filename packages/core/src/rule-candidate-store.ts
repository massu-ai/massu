// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * THE RULE-CANDIDATE STORE (D-11, Layer 2).
 *
 * Until now a rule candidate — the raw material of the entire auto-learning
 * product — existed ONLY as a loose JSON file in `.massu/rule-candidates/`. There
 * was no table. Measured 2026-07-14: 16 candidates across 6 repos, 0 rows in 0
 * databases. That means the product could not answer its own basic questions:
 * how many candidates has this repo produced? how many were ever promoted? is the
 * funnel moving at all? A directory of files cannot be queried, cannot be joined
 * to the promotion audit log, and cannot tell you that NOTHING has been promoted
 * in three months — it looks exactly the same as a healthy one.
 *
 * This module makes the DB the source of truth and keeps the JSON sidecar as a
 * COMPATIBILITY PROJECTION (the `/massu-rule` markdown protocol is assistant-driven
 * and reads files, not SQLite). Three writers previously each hand-rolled their own
 * `writeFileSync` — they now all route through `upsertCandidate`, so there is one
 * definition of what "a candidate exists" means.
 *
 * The lifecycle is a state machine, and every transition is RECORDED:
 *   proposed → shown → promoted | dismissed
 * `status` is what lets an outcome-watcher ask the only question that matters:
 * "candidates exist, but has a single one ever been promoted?"
 */

import type { Database } from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type CandidateStatus = 'proposed' | 'shown' | 'promoted' | 'dismissed';
export type CandidateOrigin = 'local' | 'team' | 'pack';

export interface RuleCandidateRow {
  prompt_hash: string;
  status: CandidateStatus;
  origin: CandidateOrigin;
  score: number | null;
  destination: string | null;
  created_at: string;
  updated_at: string;
  /** The full sidecar payload, verbatim. The sidecar is a projection OF this. */
  payload: Record<string, unknown>;
}

/** Idempotent (CR-56). Safe on a fresh DB and on one that predates the table. */
export function ensureRuleCandidatesTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rule_candidates (
      prompt_hash  TEXT PRIMARY KEY,
      status       TEXT NOT NULL DEFAULT 'proposed'
                     CHECK (status IN ('proposed','shown','promoted','dismissed')),
      origin       TEXT NOT NULL DEFAULT 'local'
                     CHECK (origin IN ('local','team','pack')),
      score        REAL,
      destination  TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rule_candidates_status ON rule_candidates(status);
    CREATE INDEX IF NOT EXISTS idx_rule_candidates_created ON rule_candidates(created_at);
  `);
}

function sidecarPath(projectRoot: string, promptHash: string): string {
  return join(projectRoot, '.massu', 'rule-candidates', `${promptHash}.json`);
}

/**
 * Record a candidate. DB row is the source of truth; the sidecar is written as a
 * projection so the file-reading `/massu-rule` protocol keeps working unchanged.
 *
 * Idempotent on prompt_hash — re-proposing an existing candidate refreshes its
 * payload without resetting a status it has already advanced past (a candidate you
 * already promoted must not silently revert to 'proposed').
 */
export function upsertCandidate(
  db: Database,
  projectRoot: string,
  candidate: Record<string, unknown> & { prompt_hash: string },
  opts: { origin?: CandidateOrigin; score?: number | null } = {},
): void {
  ensureRuleCandidatesTable(db);
  const origin = opts.origin ?? 'local';
  const score = opts.score ?? (typeof candidate.score === 'number' ? candidate.score : null);

  db.prepare(`
    INSERT INTO rule_candidates (prompt_hash, status, origin, score, payload_json, created_at, updated_at)
    VALUES (?, 'proposed', ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(prompt_hash) DO UPDATE SET
      payload_json = excluded.payload_json,
      score        = excluded.score,
      origin       = excluded.origin,
      updated_at   = datetime('now')
  `).run(candidate.prompt_hash, origin, score, JSON.stringify(candidate));

  // The sidecar projection. Sha-keyed → idempotent on retry.
  const dir = join(projectRoot, '.massu', 'rule-candidates');
  mkdirSync(dir, { recursive: true });
  const path = sidecarPath(projectRoot, candidate.prompt_hash);
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(candidate, null, 2), 'utf-8');
  }
}

/** Advance the lifecycle. Unknown candidate ⇒ no-op (nothing to advance). */
export function setCandidateStatus(
  db: Database,
  promptHash: string,
  status: CandidateStatus,
  destination?: string,
): void {
  ensureRuleCandidatesTable(db);
  db.prepare(`
    UPDATE rule_candidates
       SET status = ?, destination = COALESCE(?, destination), updated_at = datetime('now')
     WHERE prompt_hash = ?
  `).run(status, destination ?? null, promptHash);
}

export function getCandidate(db: Database, promptHash: string): RuleCandidateRow | null {
  ensureRuleCandidatesTable(db);
  const r = db
    .prepare('SELECT * FROM rule_candidates WHERE prompt_hash = ?')
    .get(promptHash) as
    | (Omit<RuleCandidateRow, 'payload'> & { payload_json: string })
    | undefined;
  if (!r) return null;
  return { ...r, payload: safeParse(r.payload_json) };
}

export function listCandidates(db: Database, status?: CandidateStatus): RuleCandidateRow[] {
  ensureRuleCandidatesTable(db);
  const rows = (
    status
      ? db
          .prepare('SELECT * FROM rule_candidates WHERE status = ? ORDER BY created_at ASC LIMIT 1000')
          .all(status)
      : db.prepare('SELECT * FROM rule_candidates ORDER BY created_at ASC LIMIT 1000').all()
  ) as Array<Omit<RuleCandidateRow, 'payload'> & { payload_json: string }>;
  return rows.map((r) => ({ ...r, payload: safeParse(r.payload_json) }));
}

/** The funnel, as numbers. This is what an outcome-watcher alarms on. */
export function candidateFunnel(db: Database): Record<CandidateStatus | 'total', number> {
  ensureRuleCandidatesTable(db);
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM rule_candidates GROUP BY status')
    .all() as Array<{ status: CandidateStatus; n: number }>;
  const out = { proposed: 0, shown: 0, promoted: 0, dismissed: 0, total: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}

/**
 * Adopt any loose sidecar that has no DB row (the 16 candidates that were stranded
 * on disk before this table existed, plus anything written by an older build).
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION: it only ever INSERTs. The JSON files are left
 * exactly where they are. Nothing is migrated-then-deleted, so a bug here cannot
 * cost anyone a candidate — prove-before-destroy, with nothing to destroy.
 *
 * Returns the number adopted. A caller that gets 0 back on a directory full of
 * files knows the import did not silently no-op — the count is the denominator.
 */
export function importOrphanSidecars(db: Database, projectRoot: string): number {
  ensureRuleCandidatesTable(db);
  const dir = join(projectRoot, '.massu', 'rule-candidates');
  if (!existsSync(dir)) return 0;

  let adopted = 0;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry.startsWith('.')) continue;
    const promptHash = entry.slice(0, -'.json'.length);
    if (getCandidate(db, promptHash) !== null) continue; // already tracked

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(readFileSync(join(dir, entry), 'utf-8')) as Record<string, unknown>;
    } catch {
      // A corrupt sidecar is not a reason to abort the whole import — but it is
      // also not something to pass over in silence.
      process.stderr.write(`[massu] WARNING: unreadable rule candidate sidecar: ${entry}\n`);
      continue;
    }
    const origin = readOrigin(payload);
    db.prepare(`
      INSERT INTO rule_candidates (prompt_hash, status, origin, score, payload_json, created_at, updated_at)
      VALUES (?, 'proposed', ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))
    `).run(
      promptHash,
      origin,
      typeof payload.score === 'number' ? payload.score : null,
      JSON.stringify(payload),
      typeof payload.timestamp === 'string' ? payload.timestamp : null,
    );
    adopted++;
  }
  return adopted;
}

function readOrigin(payload: Record<string, unknown>): CandidateOrigin {
  const prov = payload.provenance;
  if (typeof prov === 'object' && prov !== null) {
    const o = (prov as Record<string, unknown>).origin;
    if (o === 'team' || o === 'pack') return o;
  }
  return 'local';
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
