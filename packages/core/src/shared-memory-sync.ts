// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * shared-memory-sync.ts — the verify → PENDING → accept half of cross-repo
 * surfacing (Living Memory Slice 5, B-04 / B-05 / B-07). This is the
 * TRUST-CRITICAL core: it is where a foreign trust domain's bytes are (or are
 * NOT) admitted into this repo.
 *
 * ⛔ HARD INVARIANT (transport-agnostic — enforced by the B-03 drift-guard +
 * pattern-scanner Check 44): this module imports NO concrete transport class and NO
 * network client. The transport is a PARAMETER; the local (zero-network) path and
 * the future cloud path run this exact verify/accept code, so the local path can
 * never rot into a weaker parallel mechanism. Keep any concrete filesystem/cloud
 * transport class, any global network-call, and any CommonJS loader out of this file
 * — in code AND in comments (the drift-guard greps both).
 *
 * The two laws this module makes structural:
 *   1. IMPORT MATERIALIZES ONLY A PENDING ROW. A verified record lands in
 *      `shared_memory_pending` and NOWHERE else — not in `observations`, not in
 *      FTS, not embedded, not on disk. Recall cannot reach it (C-01 adds a
 *      deliberately inert pointer path). Its verbatim signed bytes are retained.
 *   2. ACCEPT RE-VERIFIES (D2). A stored `signature_verified: true` boolean would
 *      be the self-certifying-flag bug Slice 4 B-01 exists to kill, so no such
 *      column exists — accept RE-RUNS the full verifier over the retained envelope
 *      bytes, and every refusal precedes any mutation (0 rows / 0 bytes on refusal).
 */

import type Database from 'better-sqlite3';
import { homedir } from 'os';
import { getConfig } from './config.ts';
import { getCachedTierReadOnly } from './license.ts';
import { entitledForCrossRepoSurfacing } from './auto-learning-entitlement.ts';
import {
  getRepoId,
  getSharedPin,
  tofuPinSharedFingerprint,
  deriveRepoLabel,
} from './memory-repo-identity.ts';
import { findRepoByLabel } from './memory-repos-registry.ts';
import { verifyLocalShareEnvelope } from './security/local-share-verifier.ts';
import {
  hashSharedMemoryRecord,
  type SharedMemoryEnvelope,
  type SharedMemoryRecord,
} from './shared-memory-envelope.ts';
import { sanitizeCrossRepoBody, sanitizeCrossRepoTitle } from './shared-memory-sanitize.ts';
import { getMemoryMeta, setMemoryMeta, recordTelemetry, createSession } from './memory-db.ts';
import { writeSharedAudit } from './shared-memory-audit.ts';
import type { SharedMemoryTransport } from './shared-memory-transport.ts';

/** A `repo_id` may become a path/lookup key only if it is UUID-shaped (B-09/H5). */
const REPO_ID_RE = /^[0-9a-f-]{36}$/;
/** `memory_meta` cursor key prefix: `shared_cursor:<origin_repo_id>` (monotonic, H2). */
const SHARED_CURSOR_PREFIX = 'shared_cursor:';
/** Session that owns accepted cross-repo observations (ensured idempotently). */
const SHARED_ACCEPT_SESSION = 'shared-memory';

/**
 * The `observations.type` CHECK vocabulary (memory-db.ts:363). Accept re-validates an
 * imported record's `type` against this and REFUSES an unknown one (never coerces) —
 * an unknown value would otherwise throw the CHECK mid-transaction (M3). A drift-guard
 * asserts this set equals the DB CHECK so the two cannot drift apart.
 */
export const ACCEPTED_OBSERVATION_TYPES: ReadonlySet<string> = new Set([
  'decision', 'bugfix', 'feature', 'refactor', 'discovery',
  'cr_violation', 'vr_check', 'pattern_compliance', 'failed_attempt',
  'file_change', 'incident_near_miss',
]);

export interface ImportResult {
  imported: number; // materialized as PENDING
  dropped: number; // verify/consistency failures (whole-envelope or per-record)
  revoked: number; // revocations applied
  skipped: number; // idempotent (already pending/accepted)
}
const ZERO_IMPORT: ImportResult = { imported: 0, dropped: 0, revoked: 0, skipped: 0 };

interface SyncOpts {
  home?: string;
  nowEpoch?: number;
  tier?: Parameters<typeof entitledForCrossRepoSurfacing>[0];
  /** Opt-in #2 override; defaults to `config.memory.share.subscribe` (team-rule-sync idiom). */
  subscribe?: string[];
}

// ============================================================================
// B-04 — import: verify → PENDING (and B-07 revocation)
// ============================================================================

/**
 * Pull, verify, and materialize as PENDING the memories this repo subscribes to.
 * Best-effort: a transport error for one origin skips it (retried next sweep)
 * without advancing its cursor. Runs in the session-end sweep (B-08), NEVER the
 * recall hot path. Anything but `{ kind: 'valid' }` drops the WHOLE envelope.
 */
export async function importSharedMemories(
  db: Database.Database,
  transport: SharedMemoryTransport,
  opts: SyncOpts = {},
): Promise<ImportResult> {
  const home = opts.home ?? homedir();
  const nowEpoch = opts.nowEpoch ?? Math.floor(Date.now() / 1000);
  const config = getConfig();

  // (1) Entitlement (Free passes) + opt-in #2 non-empty. Dormant ⇒ nothing.
  const tier = opts.tier ?? getCachedTierReadOnly(db);
  if (!entitledForCrossRepoSurfacing(tier)) return { ...ZERO_IMPORT };
  const subscribe = opts.subscribe ?? config.memory?.share?.subscribe ?? [];
  if (!Array.isArray(subscribe) || subscribe.length === 0) return { ...ZERO_IMPORT };

  const ownRepoId = getRepoId(db); // may be null on an import-only repo
  const result: ImportResult = { ...ZERO_IMPORT };

  for (const subscribedLabel of subscribe) {
    // Resolve the subscribed LABEL to a registered repo (repo_id + trust anchor).
    const entry = findRepoByLabel(home, subscribedLabel);
    if (!entry || !REPO_ID_RE.test(entry.repo_id)) continue; // unregistered ⇒ un-importable
    const originRepoId = entry.repo_id;
    if (ownRepoId && originRepoId === ownRepoId) continue; // self-import loop

    // TOFU pin (A-07): first import pins the registry's fingerprint — a DIFFERENT
    // artifact than the key file (anti-vacuity). Later imports use the stored pin.
    const pinned = getSharedPin(db, originRepoId) ?? tofuPinSharedFingerprint(db, originRepoId, entry.pubkey_fingerprint);

    const cursorKey = SHARED_CURSOR_PREFIX + originRepoId;
    const since = parseCursor(getMemoryMeta(db, cursorKey));

    let envelopes: SharedMemoryEnvelope[];
    try {
      envelopes = await transport.fetchSince(originRepoId, since);
    } catch {
      continue; // transport error ⇒ skip this origin, retry next sweep (cursor unmoved)
    }

    let maxSeq = since;
    // A drop whose cause a re-pin/next-session CANNOT fix is PERMANENT: advance the
    // cursor past it so a bad envelope holding the highest seq is not re-fetched and
    // re-dropped every sweep. A `{kind:'error'}` verdict (unknown_pubkey after a key
    // swap, or key-unavailable) is TRANSIENT/re-pinnable → do NOT advance (retry later).
    const advancePast = (env: SharedMemoryEnvelope): void => {
      if (typeof env.seq === 'number' && env.seq > maxSeq) maxSeq = env.seq;
    };
    for (const env of envelopes) {
      // (a) VERIFY — no transition mode. Anything but valid drops the whole envelope.
      const verdict = verifyLocalShareEnvelope(env, pinned, home);
      if (verdict.kind !== 'valid') {
        result.dropped += 1;
        drop(db, 'bad_signature', { kind: verdict.kind, origin: originRepoId });
        if (verdict.kind === 'bad_signature') advancePast(env); // permanent tamper; 'error' is re-pinnable
        continue;
      }

      // (b) Signed-key-set check: the three load-bearing fields MUST be signed.
      if (!hasSignedLoadBearingKeys(env)) {
        result.dropped += 1;
        drop(db, 'unsigned_field', { origin: originRepoId });
        advancePast(env); // structurally permanent
        continue;
      }

      // (c) Origin match: the signed origin must be the repo we fetched from, be
      //     subscribed (it is — we resolved it from `subscribe`), and not be self.
      if (env.origin_repo_id !== originRepoId) {
        result.dropped += 1;
        drop(db, 'origin_mismatch', { expected: originRepoId, got: env.origin_repo_id });
        advancePast(env); // permanent (wrong repo)
        continue;
      }
      if (ownRepoId && env.origin_repo_id === ownRepoId) {
        result.dropped += 1;
        advancePast(env); // our own echo — permanent, never re-import
        continue;
      }

      advancePast(env);

      // (d) Revocations first (B-07): expire pending / expire accepted, never delete.
      for (const revokedHash of parseStringArray(env.revokes_json)) {
        if (applyRevocation(db, revokedHash, nowEpoch)) result.revoked += 1;
      }

      // (e) Records → PENDING. The re-slugged label is the OPERATOR's, never the wire's.
      const originLabel = deriveRepoLabel(entry.label);
      for (const rec of parseRecords(env.records_json)) {
        if (!isWellFormedRecord(rec)) {
          result.dropped += 1;
          drop(db, 'malformed_record', { origin: originRepoId });
          continue;
        }
        // Integrity: the record content MUST hash to its claimed record_hash.
        const computed = hashSharedMemoryRecord(stripHash(rec));
        if (computed !== rec.record_hash) {
          result.dropped += 1;
          drop(db, 'record_hash_mismatch', { origin: originRepoId });
          continue;
        }
        // Idempotency: a pending row (any state) already exists for this hash.
        if (pendingExists(db, rec.record_hash)) {
          result.skipped += 1;
          continue;
        }
        insertPending(db, rec, env, originRepoId, originLabel, nowEpoch);
        result.imported += 1;
        writeSharedAudit(db, 'shared_memory_imported', `pending from ${originLabel}`, {
          record_hash: rec.record_hash,
          origin_repo_id: originRepoId,
        });
      }
    }

    // Advance the cursor monotonically (H2).
    if (maxSeq > since) setMemoryMeta(db, cursorKey, String(maxSeq));
  }

  return result;
}

// ============================================================================
// B-05 (D2) — accept: RE-VERIFY the retained bytes. A claim is never authority.
// ============================================================================

export interface AcceptResult {
  ok: boolean;
  /** Present on refusal — a reason, never the offending content. */
  reason?: string;
  /** The inserted observations.id on success. */
  observationId?: number;
  /** True when the record was already accepted (idempotent no-op). */
  alreadyAccepted?: boolean;
}

interface PendingRow {
  id: number;
  record_hash: string;
  origin_repo_id: string;
  origin_repo_label: string;
  envelope_raw: string;
  record_json: string;
  accepted_at_epoch: number | null;
  refused_at_epoch: number | null;
  expired_at_epoch: number | null;
}

/**
 * Accept a pending cross-repo record: RE-VERIFY the retained envelope bytes, confirm
 * the record is a signed member, re-validate its type, then in ONE transaction insert
 * an `observations` row with `origin='repo:<id>'`, sanitized, `shareable=0`. Every
 * refusal PRECEDES any mutation — zero rows, zero bytes on refusal (the
 * rule-candidate-applier discipline). Idempotent.
 */
export function acceptSharedMemory(
  db: Database.Database,
  recordHash: string,
  opts: SyncOpts = {},
): AcceptResult {
  const home = opts.home ?? homedir();
  const nowEpoch = opts.nowEpoch ?? Math.floor(Date.now() / 1000);

  const row = loadPending(db, recordHash);
  if (!row) return refuse(db, recordHash, 'not_found');
  if (row.accepted_at_epoch !== null) return { ok: true, alreadyAccepted: true };
  if (row.refused_at_epoch !== null) return { ok: false, reason: 'already_refused' };
  if (row.expired_at_epoch !== null) return { ok: false, reason: 'revoked' };

  // --- all refusals below precede any mutation ---

  // (1) Re-parse and RE-VERIFY the retained envelope bytes (D2).
  let env: SharedMemoryEnvelope;
  try {
    env = JSON.parse(row.envelope_raw) as SharedMemoryEnvelope;
  } catch {
    return refuse(db, recordHash, 'envelope_unparseable');
  }
  const pinned = getSharedPin(db, row.origin_repo_id);
  if (!pinned) return refuse(db, recordHash, 'no_pin');
  const verdict = verifyLocalShareEnvelope(env, pinned, home);
  if (verdict.kind !== 'valid') return refuse(db, recordHash, `reverify_${verdict.kind}`);
  // Re-assert the signed-key-set too — accept must not verify weaker than import did
  // (a load-bearing field left out of `_signature_payload_keys` is UNSIGNED).
  if (!hasSignedLoadBearingKeys(env)) return refuse(db, recordHash, 'unsigned_field');

  // (2) The record MUST be a member of the SIGNED records, and its content must hash
  //     to record_hash (a stored record_json is never trusted over the signed bytes).
  const signed = parseRecords(env.records_json).find((r) => r.record_hash === recordHash);
  if (!signed) return refuse(db, recordHash, 'not_in_signed_records');
  if (hashSharedMemoryRecord(stripHash(signed)) !== recordHash) {
    return refuse(db, recordHash, 'record_hash_mismatch');
  }

  // (3) Type re-validated against the CHECK vocabulary — refuse, never coerce (M3).
  if (!ACCEPTED_OBSERVATION_TYPES.has(signed.type)) {
    return refuse(db, recordHash, 'unknown_type');
  }

  // (4) Materialize — one transaction. origin='repo:<id>', sanitized, shareable=0.
  const originLabel = deriveRepoLabel(row.origin_repo_label);
  const title = sanitizeCrossRepoTitle(signed.title);
  const detail = sanitizeCrossRepoBody(signed.detail);
  const iso = new Date(nowEpoch * 1000).toISOString();
  const evidence = JSON.stringify({
    cross_repo: true,
    origin_repo_id: row.origin_repo_id,
    origin_repo_label: originLabel,
    accepted_at_epoch: nowEpoch,
    original_created_at_epoch: signed.created_at_epoch,
    record_hash: recordHash,
  });

  const insertAndMark = db.transaction((): number => {
    createSession(db, SHARED_ACCEPT_SESSION);
    const res = db
      .prepare(
        `INSERT INTO observations
           (session_id, type, title, detail, files_involved, evidence, importance, origin, shareable,
            original_tokens, created_at, created_at_epoch, valid_from, ingested_at, valid_from_epoch, ingested_at_epoch)
         VALUES (?, ?, ?, ?, '[]', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        SHARED_ACCEPT_SESSION,
        signed.type,
        title,
        detail,
        evidence,
        clampImportance(signed.importance),
        `repo:${row.origin_repo_id}`,
        iso,
        nowEpoch,
        iso,
        iso,
        nowEpoch,
        nowEpoch,
      );
    db.prepare(`UPDATE shared_memory_pending SET accepted_at_epoch = ? WHERE record_hash = ?`).run(nowEpoch, recordHash);
    return Number(res.lastInsertRowid);
  });

  const observationId = insertAndMark();
  writeSharedAudit(
    db,
    'shared_memory_accepted',
    `accepted from ${originLabel}`,
    { record_hash: recordHash, origin_repo_id: row.origin_repo_id, observation_id: observationId },
    'human', // accept is a CLI-only human act
  );
  recordTelemetry(db, 'shared_memory_accepted', { origin: row.origin_repo_id });
  return { ok: true, observationId };
}

/**
 * S-5 (rollback) — `massu memory purge --shared`: EXPIRE every cross-repo row, never
 * DELETE (the no-hard-delete law, S-3). Both the un-resolved pending rows AND the
 * accepted cross-repo observations are stamped expired; they leave recall but stay
 * asOf-queryable and on the books. Returns the counts expired. Disabling sharing
 * (config) stops new crossings; purge retires what already crossed.
 */
export function purgeSharedMemories(db: Database.Database, opts: SyncOpts = {}): { pending: number; accepted: number } {
  const nowEpoch = opts.nowEpoch ?? Math.floor(Date.now() / 1000);
  const iso = new Date(nowEpoch * 1000).toISOString();
  const pending = db
    .prepare(
      `UPDATE shared_memory_pending SET expired_at_epoch = ?
        WHERE expired_at_epoch IS NULL AND accepted_at_epoch IS NULL AND refused_at_epoch IS NULL`,
    )
    .run(nowEpoch).changes;
  const accepted = db
    .prepare(
      `UPDATE observations
          SET valid_to = ?, expired_at = ?, valid_to_epoch = ?, expired_at_epoch = ?
        WHERE origin LIKE 'repo:%' AND expired_at IS NULL`,
    )
    .run(iso, iso, nowEpoch, nowEpoch).changes;
  if (pending + accepted > 0) {
    writeSharedAudit(db, 'shared_memory_revoked', 'purge --shared', { pending, accepted, purge: true }, 'human');
  }
  return { pending, accepted };
}

/** B-06 — refuse a pending record (CLI). Idempotent; expires nothing already accepted. */
export function refuseSharedMemory(db: Database.Database, recordHash: string, opts: SyncOpts = {}): AcceptResult {
  const nowEpoch = opts.nowEpoch ?? Math.floor(Date.now() / 1000);
  const row = loadPending(db, recordHash);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.accepted_at_epoch !== null) return { ok: false, reason: 'already_accepted' };
  db.prepare(`UPDATE shared_memory_pending SET refused_at_epoch = ? WHERE record_hash = ? AND refused_at_epoch IS NULL`).run(
    nowEpoch,
    recordHash,
  );
  writeSharedAudit(db, 'shared_memory_refused', `refused ${recordHash}`, { record_hash: recordHash }, 'human');
  return { ok: true };
}

// ============================================================================
// B-06 — review surface (read-only)
// ============================================================================

export interface PendingView {
  record_hash: string;
  origin_repo_label: string;
  received_at_epoch: number;
  type: string;
  title: string; // sanitized
  detail: string; // sanitized
  signature_valid: boolean; // recomputed LIVE, never read from a stored claim
}

/** List pending (un-accepted, un-refused, un-expired) records, sanitized + live-verified. */
export function listPendingSharedMemories(db: Database.Database, opts: SyncOpts = {}): PendingView[] {
  const home = opts.home ?? homedir();
  const rows = db
    .prepare(
      `SELECT record_hash, origin_repo_id, origin_repo_label, envelope_raw, record_json, received_at_epoch
         FROM shared_memory_pending
        WHERE accepted_at_epoch IS NULL AND refused_at_epoch IS NULL AND expired_at_epoch IS NULL
        ORDER BY received_at_epoch DESC
        LIMIT 500`,
    )
    .all() as Array<{
      record_hash: string;
      origin_repo_id: string;
      origin_repo_label: string;
      envelope_raw: string;
      record_json: string;
      received_at_epoch: number;
    }>;

  const out: PendingView[] = [];
  for (const r of rows) {
    let rec: SharedMemoryRecord | null = null;
    let valid = false;
    try {
      rec = JSON.parse(r.record_json) as SharedMemoryRecord;
      const env = JSON.parse(r.envelope_raw) as SharedMemoryEnvelope;
      const pinned = getSharedPin(db, r.origin_repo_id);
      valid = !!pinned && verifyLocalShareEnvelope(env, pinned, home).kind === 'valid';
    } catch {
      /* leave valid=false / rec=null */
    }
    out.push({
      record_hash: r.record_hash,
      origin_repo_label: deriveRepoLabel(r.origin_repo_label),
      received_at_epoch: r.received_at_epoch,
      type: rec?.type ?? 'unknown',
      title: sanitizeCrossRepoTitle(rec?.title ?? ''),
      detail: sanitizeCrossRepoBody(rec?.detail ?? ''),
      signature_valid: valid,
    });
  }
  return out;
}

// ============================================================================
// Helpers
// ============================================================================

/** The three load-bearing fields that MUST be in the envelope's signed key-set. */
const SIGNED_LOAD_BEARING_KEYS = ['origin_repo_id', 'records_json', 'revokes_json'] as const;

/**
 * True iff every load-bearing field is actually covered by the signature. The verifier
 * core reconstructs the payload from whatever keys the envelope CLAIMS in
 * `_signature_payload_keys`, so an otherwise-valid envelope could omit a load-bearing
 * key from the signed set and carry it UNSIGNED. Import AND accept both enforce this
 * (shared here so accept cannot drift weaker than import — SEC review).
 */
function hasSignedLoadBearingKeys(env: SharedMemoryEnvelope): boolean {
  const signed = Array.isArray(env._signature_payload_keys) ? env._signature_payload_keys : [];
  return SIGNED_LOAD_BEARING_KEYS.every((k) => signed.includes(k));
}

function parseCursor(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function parseStringArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseRecords(json: string): SharedMemoryRecord[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as SharedMemoryRecord[]) : [];
  } catch {
    return [];
  }
}

function isWellFormedRecord(r: unknown): r is SharedMemoryRecord {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.record_hash === 'string' &&
    typeof o.type === 'string' &&
    typeof o.title === 'string' &&
    typeof o.detail === 'string' &&
    typeof o.importance === 'number' &&
    typeof o.created_at_epoch === 'number' &&
    (o.superseded_by_hash === null || typeof o.superseded_by_hash === 'string')
  );
}

function stripHash(r: SharedMemoryRecord): Omit<SharedMemoryRecord, 'record_hash'> {
  return {
    type: r.type,
    title: r.title,
    detail: r.detail,
    importance: r.importance,
    created_at_epoch: r.created_at_epoch,
    superseded_by_hash: r.superseded_by_hash,
  };
}

function clampImportance(n: number): number {
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function pendingExists(db: Database.Database, recordHash: string): boolean {
  return !!db.prepare(`SELECT 1 FROM shared_memory_pending WHERE record_hash = ? LIMIT 1`).get(recordHash);
}

function loadPending(db: Database.Database, recordHash: string): PendingRow | null {
  return (
    (db
      .prepare(
        `SELECT id, record_hash, origin_repo_id, origin_repo_label, envelope_raw, record_json,
                accepted_at_epoch, refused_at_epoch, expired_at_epoch
           FROM shared_memory_pending WHERE record_hash = ? LIMIT 1`,
      )
      .get(recordHash) as PendingRow | undefined) ?? null
  );
}

function insertPending(
  db: Database.Database,
  rec: SharedMemoryRecord,
  env: SharedMemoryEnvelope,
  originRepoId: string,
  originLabel: string,
  nowEpoch: number,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO shared_memory_pending
       (record_hash, origin_repo_id, origin_repo_label, envelope_raw, record_json, received_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(rec.record_hash, originRepoId, originLabel, JSON.stringify(env), JSON.stringify(rec), nowEpoch);
}

/**
 * B-07 revocation: a revoked record_hash EXPIRES — pending ⇒ mark the pending row
 * expired; accepted ⇒ expire the accepted observation (still asOf-queryable). NEVER a
 * DELETE, NEVER an auto-revert. Returns true iff something was expired.
 */
function applyRevocation(db: Database.Database, recordHash: string, nowEpoch: number): boolean {
  const row = loadPending(db, recordHash);
  if (!row) return false;
  let changed = false;

  if (row.accepted_at_epoch !== null) {
    // Expire the accepted observation (origin='repo:<id>', matched by record_hash in
    // its evidence provenance). Expire = set valid_to/expired_at; excluded from recall,
    // still asOf-queryable. Never delete, never auto-revert.
    const iso = new Date(nowEpoch * 1000).toISOString();
    const res = db
      .prepare(
        `UPDATE observations
            SET valid_to = ?, expired_at = ?, valid_to_epoch = ?, expired_at_epoch = ?
          WHERE origin = ?
            AND expired_at IS NULL
            AND json_extract(evidence, '$.record_hash') = ?`,
      )
      .run(iso, iso, nowEpoch, nowEpoch, `repo:${row.origin_repo_id}`, recordHash);
    changed = res.changes > 0;
  }

  // Also stamp the pending row expired (covers the un-accepted case, and records the
  // revocation on the accepted case's pending row). Never DELETE (S-3).
  const p = db
    .prepare(`UPDATE shared_memory_pending SET expired_at_epoch = ? WHERE record_hash = ? AND expired_at_epoch IS NULL`)
    .run(nowEpoch, recordHash);
  changed = changed || p.changes > 0;

  if (changed) writeSharedAudit(db, 'shared_memory_revoked', `revoked ${recordHash}`, { record_hash: recordHash });
  return changed;
}

function drop(db: Database.Database, reason: string, meta: Record<string, unknown>): void {
  recordTelemetry(db, 'shared_memory_dropped', { reason, ...meta });
  writeSharedAudit(db, 'shared_memory_dropped', `dropped: ${reason}`, { reason, ...meta });
}

function refuse(db: Database.Database, recordHash: string, reason: string): AcceptResult {
  recordTelemetry(db, 'shared_memory_dropped', { reason, phase: 'accept', record_hash: recordHash });
  return { ok: false, reason };
}
