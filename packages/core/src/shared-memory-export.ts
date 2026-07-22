// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * shared-memory-export.ts — the FAIL-CLOSED export half of cross-repo surfacing
 * (Living Memory Slice 5, B-02 + B-09 + B-12).
 *
 * Export is the trust boundary where a decision LEAVES this repo. It is
 * fail-closed by construction:
 *   • It only ever runs when the operator set `memory.share.enabled: true`
 *     (opt-in #1) — a dormant install exports NOTHING and mints NOTHING.
 *   • A record whose title/detail matches `SECRET_PATTERNS` (the write-boundary
 *     DETECTOR, not `redactSecrets`) or embeds an absolute `$HOME` path is
 *     REFUSED — never redacted, never truncated. A memory silently rewritten
 *     before it crosses is a memory that lies about what you decided.
 *   • A row that is not local (isLocalOrigin is false) is REFUSED — you may not
 *     re-export what you imported (no echo loops, no provenance laundering).
 *   • Over any cap ⇒ refuse the export, never ship a silent subset.
 *   • Before the FIRST export, the store is snapshotted (B-12); an unwritable
 *     backup path REFUSES the export and writes nothing.
 *
 * The envelope is signed (A-06) and handed to the injected transport (B-03) —
 * export knows nothing about WHERE it goes, so the local and cloud paths share it.
 */

import type Database from 'better-sqlite3';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { mkdirSync, chmodSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'fs';
import { getConfig, getProjectRoot } from './config.ts';
import { getCachedTierReadOnly } from './license.ts';
import { entitledForCrossRepoSurfacing } from './auto-learning-entitlement.ts';
import { isLocalOrigin } from './memory-origin.ts';
import { getRepoId, mintRepoId, getRepoLabel } from './memory-repo-identity.ts';
import { upsertRepoRegistration } from './memory-repos-registry.ts';
import {
  ensureLocalShareKeypair,
  localSharePubkeyFingerprint,
  signSharedMemoryEnvelope,
} from './security/local-share-signer.ts';
import {
  hashSharedMemoryRecord,
  SHARED_MEMORY_KIND,
  type SharedMemoryRecord,
  type UnsignedSharedMemoryEnvelope,
} from './shared-memory-envelope.ts';
import { containsSecret } from './memory-llm.ts';
import { getMemoryMeta, setMemoryMeta, recordTelemetry } from './memory-db.ts';
import { writeSharedAudit } from './shared-memory-audit.ts';
import type { SharedMemoryTransport } from './shared-memory-transport.ts';

/** Per-export caps. Generous — the point is to REFUSE, not to shape normal use. */
export interface ExportCaps {
  maxRecords: number;
  maxBytesPerRecord: number;
  maxTotalBytes: number;
}
export const DEFAULT_EXPORT_CAPS: ExportCaps = {
  maxRecords: 200,
  maxBytesPerRecord: 16_384,
  maxTotalBytes: 512_000,
};

/** `memory_meta` key holding the last-used export seq for this repo. */
const EXPORT_SEQ_KEY = 'shared_export_seq';
/** `memory_meta` key stamped once the pre-share backup exists (B-12). */
const BACKUP_DONE_KEY = 'shared_backup_at';

export interface ExportRefusal {
  observation_id: number | null;
  /** A REASON, never the offending content (a refusal must not re-record a secret). */
  reason: string;
}
export interface ExportResult {
  enabled: boolean;
  published: boolean;
  exported: number;
  refused: number;
  refusals: ExportRefusal[];
  seq: number | null;
}

interface ExportOpts {
  home?: string;
  nowEpoch?: number;
  tier?: Parameters<typeof entitledForCrossRepoSurfacing>[0];
  caps?: ExportCaps;
  /** Opt-in #1 override; defaults to `config.memory.share.enabled` (team-rule-sync idiom). */
  shareEnabled?: boolean;
  /** Backup destination dir override (tests); default `~/.massu/shared/backups/<repo_id>`. */
  backupDir?: string;
}

function zero(enabled: boolean): ExportResult {
  return { enabled, published: false, exported: 0, refused: 0, refusals: [], seq: null };
}

/** Snapshot the store before the first cross-repo write (B-12). Throws on failure. */
export function ensureSharingBackup(
  db: Database.Database,
  repoId: string,
  home: string,
  nowEpoch: number,
  backupDirOverride?: string,
): void {
  if (getMemoryMeta(db, BACKUP_DONE_KEY)) return; // already backed up once
  const backupDir = backupDirOverride ?? join(home, '.massu', 'shared', 'backups', repoId);
  const dest = join(backupDir, `memory-${nowEpoch}.db`);
  // db.serialize() gives a consistent snapshot of BOTH file-backed and in-memory
  // stores — one code path, no dependence on the store's on-disk location.
  const snapshot = (db as unknown as { serialize: () => Buffer }).serialize();
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  // Atomic binary write (atomicWriteFileSync is UTF-8 text, so a binary-aware sibling):
  // temp + fsync + rename, matching the transport's durability discipline — a crash can
  // never leave a half-written backup. An unwritable dir throws → export refuses (B-12).
  const tmp = `${dest}.tmp-${process.pid}`;
  writeFileSync(tmp, snapshot, { mode: 0o600 });
  const fd = openSync(tmp, 'r+');
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, dest);
  chmodSync(dest, 0o600);
  setMemoryMeta(db, BACKUP_DONE_KEY, String(nowEpoch));
}

interface ShareableRow {
  id: number;
  type: string;
  title: string;
  detail: string | null;
  importance: number;
  created_at_epoch: number;
  origin: string;
}

/**
 * Export this repo's shareable, local, not-yet-exported decisions as ONE signed
 * envelope, published via the injected transport. Fail-closed at every gate;
 * returns a structured result (never throws for a policy refusal — a caller can
 * surface counts). A hard failure (backup unwritable) refuses the whole export.
 */
export async function exportSharedMemories(
  db: Database.Database,
  transport: SharedMemoryTransport,
  opts: ExportOpts = {},
): Promise<ExportResult> {
  const home = opts.home ?? homedir();
  const nowEpoch = opts.nowEpoch ?? Math.floor(Date.now() / 1000);
  const caps = opts.caps ?? DEFAULT_EXPORT_CAPS;
  const config = getConfig();

  // (1) Opt-in #1. Dormant install ⇒ nothing exists, nothing exports.
  const shareEnabled = opts.shareEnabled ?? config.memory?.share?.enabled ?? false;
  if (!shareEnabled) return zero(false);

  // (2) Entitlement chokepoint (the SoT — Free passes; never a parallel scheme).
  const tier = opts.tier ?? getCachedTierReadOnly(db);
  if (!entitledForCrossRepoSurfacing(tier)) return zero(true);

  // (3) Identity: this is the first-share-enable materialization point. Mint the
  //     repo_id + key lazily, register self. Idempotent.
  const repoId = getRepoId(db) ?? mintRepoId(db);
  const label = getRepoLabel();
  ensureLocalShareKeypair(home);
  const fingerprint = localSharePubkeyFingerprint(home);
  upsertRepoRegistration(
    {
      repo_id: repoId,
      label,
      pubkey_fingerprint: fingerprint,
      last_seen_path: getProjectRoot(),
      share_enabled: true,
    },
    home,
  );

  // (4) B-12 — backup before the first cross-repo write. Unwritable ⇒ refuse all.
  try {
    ensureSharingBackup(db, repoId, home, nowEpoch, opts.backupDir);
  } catch (err) {
    recordTelemetry(db, 'shared_memory_export_refused', {
      reason: 'backup_failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    auditExportRefused(db, null, 'backup_failed');
    return { ...zero(true), refused: 1, refusals: [{ observation_id: null, reason: 'backup_failed' }] };
  }

  // (5) Gather shareable, local decisions. record_hash is content-derived, so the
  //     "not-yet-exported" filter is a per-candidate existence probe (bounded LIMIT 1)
  //     against shared_memory_outbound. The scan is bounded to maxRecords+1: hitting
  //     that ceiling means there are more shareable rows than an envelope may carry, so
  //     we REFUSE the whole export (never ship a silent subset — Slice 4 A-18's rule).
  const rows = db
    .prepare(
      `SELECT id, type, title, detail, importance, created_at_epoch, origin
         FROM observations
        WHERE shareable = 1
        ORDER BY id
        LIMIT ?`,
    )
    .all(caps.maxRecords + 1) as ShareableRow[];

  if (rows.length > caps.maxRecords) {
    recordTelemetry(db, 'shared_memory_export_refused', { reason: 'too_many_records', count: rows.length });
    auditExportRefused(db, null, 'too_many_records');
    return { ...zero(true), refused: 1, refusals: [{ observation_id: null, reason: 'too_many_records' }] };
  }

  const wasExported = db.prepare(`SELECT 1 FROM shared_memory_outbound WHERE record_hash = ? LIMIT 1`);

  const refusals: ExportRefusal[] = [];
  const records: SharedMemoryRecord[] = [];
  const outboundInserts: Array<{ hash: string; id: number }> = [];

  for (const r of rows) {
    // (5a) No re-export of imports (B-02.2) — no echo loops / provenance laundering.
    if (!isLocalOrigin(r.origin)) {
      refusals.push({ observation_id: r.id, reason: 'non_local_origin' });
      auditExportRefused(db, r.id, 'non_local_origin');
      continue;
    }

    const title = r.title ?? '';
    const detail = r.detail ?? '';

    // (5b) Secret DETECTOR — refuse, never redact (memory-llm.ts:containsSecret).
    const sTitle = containsSecret(title);
    const sDetail = containsSecret(detail);
    if (sTitle.matched || sDetail.matched) {
      const reason = `secret:${sTitle.patternName ?? sDetail.patternName}`;
      refusals.push({ observation_id: r.id, reason });
      auditExportRefused(db, r.id, reason);
      continue;
    }

    // (5c) Absolute $HOME path refusal — machine-specific, client-identifying.
    if ((home && (title.includes(home) || detail.includes(home)))) {
      refusals.push({ observation_id: r.id, reason: 'home_path' });
      auditExportRefused(db, r.id, 'home_path');
      continue;
    }

    const base: Omit<SharedMemoryRecord, 'record_hash'> = {
      type: r.type,
      title,
      detail,
      importance: r.importance,
      created_at_epoch: r.created_at_epoch,
      superseded_by_hash: null,
    };
    const record_hash = hashSharedMemoryRecord(base);
    if (wasExported.get(record_hash)) continue; // idempotent by record_hash (bounded probe)

    // (5d) Per-record byte cap — refuse the record, never truncate it.
    const recordBytes = Buffer.byteLength(JSON.stringify({ ...base, record_hash }), 'utf-8');
    if (recordBytes > caps.maxBytesPerRecord) {
      refusals.push({ observation_id: r.id, reason: 'record_too_large' });
      auditExportRefused(db, r.id, 'record_too_large');
      continue;
    }

    records.push({ ...base, record_hash });
    outboundInserts.push({ hash: record_hash, id: r.id });
  }

  // (6) B-07 export side — a previously-exported decision that has since been
  //     superseded/expired (obs.expired_at set) crosses the boundary as a REVOCATION.
  //     Bounded scan; outbound rows are marked revoked after a successful publish.
  const revokeRows = db
    .prepare(
      `SELECT o.record_hash AS h
         FROM shared_memory_outbound o
         JOIN observations obs ON obs.id = o.observation_id
        WHERE o.revoked_at_epoch IS NULL
          AND obs.expired_at IS NOT NULL
        LIMIT ?`,
    )
    .all(caps.maxRecords) as Array<{ h: string }>;
  const revokedHashes = revokeRows.map((r) => r.h);

  // Nothing new AND nothing to revoke ⇒ stop. Refusals are already audited.
  if (records.length === 0 && revokedHashes.length === 0) {
    return { ...zero(true), refused: refusals.length, refusals };
  }

  // (6a) Total-bytes cap — refuse the export, never ship a silent subset. (The
  //      record-count ceiling was already enforced on the bounded scan at step 5.)
  const recordsJson = JSON.stringify(records);
  if (Buffer.byteLength(recordsJson, 'utf-8') > caps.maxTotalBytes) {
    recordTelemetry(db, 'shared_memory_export_refused', { reason: 'envelope_too_large' });
    auditExportRefused(db, null, 'envelope_too_large');
    return { ...zero(true), refused: refusals.length + 1, refusals: [...refusals, { observation_id: null, reason: 'envelope_too_large' }] };
  }

  // (7) Monotonic seq, sign, publish.
  const seq = nextSeq(db);
  const body: UnsignedSharedMemoryEnvelope = {
    kind: SHARED_MEMORY_KIND,
    origin_repo_id: repoId,
    origin_repo_label: label,
    seq,
    issued_at: new Date(nowEpoch * 1000).toISOString(),
    records_json: recordsJson,
    revokes_json: JSON.stringify(revokedHashes),
  };
  const envelope = signSharedMemoryEnvelope(body, home);
  await transport.publish(envelope);

  // (8) Record outbound bookkeeping, mark revoked rows, advance the seq cursor — one txn.
  const insertOutbound = db.prepare(
    `INSERT OR IGNORE INTO shared_memory_outbound (record_hash, observation_id, origin_repo_id, seq, exported_at_epoch)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const markRevoked = db.prepare(
    `UPDATE shared_memory_outbound SET revoked_at_epoch = ? WHERE record_hash = ? AND revoked_at_epoch IS NULL`,
  );
  const commit = db.transaction(() => {
    for (const o of outboundInserts) insertOutbound.run(o.hash, o.id, repoId, seq, nowEpoch);
    for (const h of revokedHashes) markRevoked.run(nowEpoch, h);
    setMemoryMeta(db, EXPORT_SEQ_KEY, String(seq));
  });
  commit();

  recordTelemetry(db, 'shared_memory_exported', { count: records.length, revoked: revokedHashes.length, seq });
  auditExported(db, records.length, seq);

  return { enabled: true, published: true, exported: records.length, refused: refusals.length, refusals, seq };
}

function nextSeq(db: Database.Database): number {
  const raw = getMemoryMeta(db, EXPORT_SEQ_KEY);
  const last = raw !== null && Number.isInteger(Number(raw)) ? Number(raw) : 0;
  return last + 1;
}

// --- audit_log writers (B-10) — via the shared session-resolving writer. ---

function auditExported(db: Database.Database, count: number, seq: number): void {
  writeSharedAudit(db, 'shared_memory_exported', `exported ${count} record(s) at seq ${seq}`, { count, seq });
}

function auditExportRefused(db: Database.Database, obsId: number | null, reason: string): void {
  writeSharedAudit(db, 'shared_memory_export_refused', `export refused: ${reason}`, { observation_id: obsId, reason });
}
