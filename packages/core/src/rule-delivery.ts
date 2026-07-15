/**
 * Durable, ACK-based delivery for LEARNED RULES (Layer 2).
 *
 * THE BUG THIS EXISTS TO KILL
 * ---------------------------
 * The previous delivery path DELETED a promoted rule from its outbound store at
 * the moment it was READ into a sync payload (`drainRulePromotionEvents` /
 * `drainTeamPromotions`). If the upload then failed, the payload was pushed into
 * `pending_sync`, retried 10 times, and — on the 11th — DISCARDED. The only trace
 * was a `cloud_sync_giveup` counter nobody read.
 *
 * Measured on 2026-07-14 across the 7 local repos: 18 promotion events were ever
 * enqueued; 17 were destroyed; 0 rules have ever reached a server. Not one.
 * `read == delete` is the whole disease: *delivery failure and nothing-to-deliver
 * produced the same end state*, and that state was the quiet one.
 *
 * THE CONTRACT
 * ------------
 *   lease() -> deliver -> ack()   on confirmed receipt  => rows DELETED
 *                      -> nack()  on ANY failure        => rows KEPT, attempts++
 *
 * A row leaves an outbound store on exactly ONE event: the server confirmed it.
 * Nothing else deletes a learned rule — not a retry cap, not a give-up, not a
 * cap-trim, not an exception. If we cannot deliver, we keep it and we get LOUD.
 *
 * RULES vs TELEMETRY (an honest distinction, not a loophole)
 * ---------------------------------------------------------
 *   team_promotion_outbound  / team_revocation_outbound  = LEARNED RULES.
 *       These are the product. They are NEVER dropped, capped, or expired.
 *   rule_promotion_events_outbound                       = funnel TELEMETRY
 *       (proposed/shown/approved/dismissed metadata; the rule itself is not in
 *       here). Bounded by a cap, because unbounded local growth on a seat that
 *       never syncs is a real failure mode and losing a funnel datapoint does not
 *       lose the user's rule. The cap is declared, tested, and LOGGED when it bites.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  TeamPromotionOutbound,
  RulePromotionEventOutbound,
  RulePromotionEventType,
} from './memory-db.ts';

/** Outbound stores that hold LEARNED RULES. Never dropped. */
export const RULE_OUTBOUND_TABLES = [
  'team_promotion_outbound',
  'team_revocation_outbound',
] as const;

/** Outbound store holding funnel TELEMETRY (metadata only; capped). */
export const TELEMETRY_OUTBOUND_TABLE = 'rule_promotion_events_outbound';

/** Every outbound store the lease/ack contract governs. */
export const ALL_OUTBOUND_TABLES = [
  ...RULE_OUTBOUND_TABLES,
  TELEMETRY_OUTBOUND_TABLE,
] as const;

/** Funnel telemetry cap. Rules have NO cap — see the module docstring. */
export const TELEMETRY_OUTBOX_CAP = 20_000;

/** A lease expires so a crashed session cannot strand rows forever. */
export const LEASE_TTL_MS = 15 * 60 * 1000;

/** Bounded claim per session (P-DG-001). A tail beyond this simply waits — never lost. */
export const PROMOTION_LEASE_LIMIT = 1000;
export const TELEMETRY_LEASE_LIMIT = 5000;

/** Attempts before we consider delivery STALLED and start shouting. */
export const STALL_ATTEMPTS = 5;

/** Analytics event names (read by the CLI reader + the Guardian watcher). */
export const EVENT_DELIVERY_STALLED = 'rule_delivery_stalled';
export const EVENT_DELIVERY_CONFIRMED = 'rule_delivery_confirmed';
export const EVENT_TELEMETRY_CAPPED = 'rule_telemetry_capped';

/** The rows leased for one delivery attempt, plus the token that owns them. */
export interface LearningLease {
  token: string;
  promotions: TeamPromotionOutbound[];
  revocations: string[];
  events: RulePromotionEventOutbound[];
}

/** A snapshot of what has NOT been delivered. Drives the stall alarm + watcher. */
export interface UndeliveredSnapshot {
  promotions: number;
  revocations: number;
  events: number;
  /** Highest attempt count across undelivered LEARNED RULES (not telemetry). */
  max_rule_attempts: number;
  /** Oldest undelivered LEARNED RULE, ISO string, or null when none. */
  oldest_rule_created_at: string | null;
  /** True when rules exist that we have repeatedly failed to deliver. */
  stalled: boolean;
}

function tableExists(db: Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { ok: number } | undefined;
  return row !== undefined;
}

/**
 * Stamp a BOUNDED page of claimable rows with this lease token. Two steps on
 * purpose: pick the ids first, then stamp exactly those. Stamping every claimable
 * row and then reading only a page would leave the un-read tail leased and
 * therefore invisible until its TTL expired — a stall that looks like an empty
 * queue, which is the exact failure mode this module exists to abolish.
 */
function claimPage(
  db: Database,
  table: string,
  pk: string,
  orderBy: string,
  limit: number,
  token: string,
  nowMs: number,
): void {
  if (!tableExists(db, table)) return;
  const cutoff = nowMs - LEASE_TTL_MS;
  const ids = db
    .prepare(
      `SELECT ${pk} AS k FROM ${table}
        WHERE lease_token IS NULL OR leased_at_ms IS NULL OR leased_at_ms < ?
        ORDER BY ${orderBy} ASC LIMIT ?`,
    )
    .all(cutoff, limit) as Array<{ k: string | number }>;
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE ${table} SET lease_token = ?, leased_at_ms = ? WHERE ${pk} IN (${placeholders})`,
  ).run(token, nowMs, ...ids.map((r) => r.k));
}

function columns(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Add the lease/ack bookkeeping columns to every outbound store. Idempotent
 * (PRAGMA guard), mirroring `migrateMemoryFilesFor4B`. Safe on a fresh DB and on
 * one carrying rows written by the old destructive-drain build.
 */
export function migrateRuleDelivery(db: Database): void {
  const ADDITIONS: ReadonlyArray<{ name: string; decl: string }> = [
    { name: 'attempts', decl: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'lease_token', decl: 'TEXT' },
    { name: 'leased_at_ms', decl: 'INTEGER' },
    { name: 'last_error', decl: 'TEXT' },
  ];
  for (const table of ALL_OUTBOUND_TABLES) {
    if (!tableExists(db, table)) continue;
    const cols = columns(db, table);
    for (const add of ADDITIONS) {
      if (cols.has(add.name)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${add.name} ${add.decl}`);
    }
  }
}

/**
 * Claim undelivered rows for one delivery attempt. Marks them with a lease token.
 * DOES NOT DELETE ANYTHING — that is the entire point of this module.
 *
 * A row is claimable when it is unleased, or its lease has expired (the owning
 * session died mid-flight). `nowMs` is injectable so the tests can drive expiry
 * deterministically instead of sleeping.
 */
export function leaseLearning(db: Database, nowMs: number = Date.now()): LearningLease {
  migrateRuleDelivery(db);
  const token = randomUUID();

  // Claim a BOUNDED page per store (P-DG-001: every .all() carries a LIMIT). The
  // claim is two steps — pick the ids, then stamp exactly those — because stamping
  // every claimable row while only reading a page would leave the tail leased but
  // unread, stranded until its TTL expired. Rows beyond the page simply stay
  // unleased and go out on the next session. Nothing is dropped either way.
  claimPage(db, 'team_promotion_outbound', 'prompt_hash', 'created_at', PROMOTION_LEASE_LIMIT, token, nowMs);
  claimPage(db, 'team_revocation_outbound', 'prompt_hash', 'created_at', PROMOTION_LEASE_LIMIT, token, nowMs);
  claimPage(db, TELEMETRY_OUTBOUND_TABLE, 'id', 'id', TELEMETRY_LEASE_LIMIT, token, nowMs);

  const promotions: TeamPromotionOutbound[] = tableExists(db, 'team_promotion_outbound')
    ? (
        db
          .prepare(
            `SELECT prompt_hash, destination, draft_text, score, signals_json,
                    content_hash, hardened, review_attestation_json
             FROM team_promotion_outbound WHERE lease_token = ?
             ORDER BY created_at ASC LIMIT ?`,
          )
          .all(token, PROMOTION_LEASE_LIMIT) as Array<{
          prompt_hash: string;
          destination: string;
          draft_text: string;
          score: number | null;
          signals_json: string;
          content_hash: string;
          hardened: number;
          review_attestation_json: string | null;
        }>
      ).map((r) => ({
        prompt_hash: r.prompt_hash,
        destination: r.destination,
        draft_text: r.draft_text,
        ...(r.score !== null ? { score: r.score } : {}),
        signals: safeParseArray(r.signals_json),
        content_hash: r.content_hash,
        ...(r.hardened ? { hardened: true } : {}),
        ...(r.review_attestation_json != null
          ? { review_attestation: safeParseUnknown(r.review_attestation_json) }
          : {}),
      }))
    : [];

  const revocations: string[] = tableExists(db, 'team_revocation_outbound')
    ? (
        db
          .prepare(
            `SELECT prompt_hash FROM team_revocation_outbound
             WHERE lease_token = ? ORDER BY created_at ASC LIMIT ?`,
          )
          .all(token, PROMOTION_LEASE_LIMIT) as Array<{ prompt_hash: string }>
      ).map((r) => r.prompt_hash)
    : [];

  const events: RulePromotionEventOutbound[] = tableExists(db, TELEMETRY_OUTBOUND_TABLE)
    ? (
        db
          .prepare(
            `SELECT prompt_hash, event_type, metadata_json, created_at
             FROM ${TELEMETRY_OUTBOUND_TABLE} WHERE lease_token = ?
             ORDER BY id ASC LIMIT ?`,
          )
          .all(token, TELEMETRY_LEASE_LIMIT) as Array<{
          prompt_hash: string;
          event_type: string;
          metadata_json: string;
          created_at: string;
        }>
      ).map((r) => ({
        prompt_hash: r.prompt_hash,
        event_type: r.event_type as RulePromotionEventType,
        created_at: r.created_at,
        metadata: (safeParseUnknown(r.metadata_json) as Record<string, unknown>) ?? {},
      }))
    : [];

  return { token, promotions, revocations, events };
}

/**
 * The server confirmed receipt. This is the ONLY code path in the codebase that
 * may delete a learned rule. Deletes exactly the leased rows — a row enqueued
 * mid-flight carries no lease token and therefore survives to the next attempt.
 */
export function ackLearning(db: Database, lease: LearningLease): void {
  const delivered = lease.promotions.length + lease.revocations.length + lease.events.length;
  for (const table of ALL_OUTBOUND_TABLES) {
    if (!tableExists(db, table)) continue;
    db.prepare(`DELETE FROM ${table} WHERE lease_token = ?`).run(lease.token);
  }
  if (delivered > 0) {
    recordAnalytics(db, EVENT_DELIVERY_CONFIRMED, {
      promotions: lease.promotions.length,
      revocations: lease.revocations.length,
      events: lease.events.length,
    });
  }
}

/**
 * Delivery failed. Release the lease, count the attempt, remember why — and KEEP
 * EVERY ROW. Then, if learned rules are piling up undelivered, get LOUD: an
 * undelivered rule is the product silently not working, and silence is precisely
 * what let 17 rules die unnoticed.
 */
export function nackLearning(db: Database, lease: LearningLease, error: string): UndeliveredSnapshot {
  for (const table of ALL_OUTBOUND_TABLES) {
    if (!tableExists(db, table)) continue;
    db.prepare(
      `UPDATE ${table}
         SET lease_token = NULL,
             leased_at_ms = NULL,
             attempts = attempts + 1,
             last_error = ?
       WHERE lease_token = ?`,
    ).run(error.slice(0, 500), lease.token);
  }
  const snap = undeliveredSnapshot(db);
  if (snap.stalled) alarmStalled(db, snap, error);
  return snap;
}

/** What is sitting undelivered right now. The denominator the watcher asserts on. */
export function undeliveredSnapshot(db: Database): UndeliveredSnapshot {
  const count = (t: string): number => {
    if (!tableExists(db, t)) return 0;
    const r = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
    return r.n;
  };
  const promotions = count('team_promotion_outbound');
  const revocations = count('team_revocation_outbound');
  const events = count(TELEMETRY_OUTBOUND_TABLE);

  let maxAttempts = 0;
  let oldest: string | null = null;
  for (const t of RULE_OUTBOUND_TABLES) {
    if (!tableExists(db, t)) continue;
    if (!columns(db, t).has('attempts')) continue;
    const r = db
      .prepare(`SELECT MAX(attempts) AS a, MIN(created_at) AS c FROM ${t}`)
      .get() as { a: number | null; c: string | null };
    if (r.a !== null && r.a > maxAttempts) maxAttempts = r.a;
    if (r.c !== null && (oldest === null || r.c < oldest)) oldest = r.c;
  }

  return {
    promotions,
    revocations,
    events,
    max_rule_attempts: maxAttempts,
    oldest_rule_created_at: oldest,
    stalled: promotions + revocations > 0 && maxAttempts >= STALL_ATTEMPTS,
  };
}

/**
 * Failure must never look like emptiness. Write a durable analytics row AND shout
 * on stderr, so a stalled learning pipeline is visible in the terminal and to the
 * Guardian watcher — instead of being a silent zero.
 */
function alarmStalled(db: Database, snap: UndeliveredSnapshot, error: string): void {
  const rules = snap.promotions + snap.revocations;
  process.stderr.write(
    `[massu] WARNING: ${rules} learned rule(s) have NOT reached your team after ` +
      `${snap.max_rule_attempts} delivery attempts. They are SAFE (nothing was deleted) ` +
      `and will retry. Last error: ${error}. Run \`massu rule delivery-status\` for detail.\n`,
  );
  recordAnalytics(db, EVENT_DELIVERY_STALLED, {
    undelivered_promotions: snap.promotions,
    undelivered_revocations: snap.revocations,
    undelivered_events: snap.events,
    max_attempts: snap.max_rule_attempts,
    oldest_created_at: snap.oldest_rule_created_at,
    last_error: error.slice(0, 300),
  });
}

/**
 * Bound funnel TELEMETRY growth (never rules). When the cap bites we RECORD it —
 * a silent trim is how you discover months later that your dashboard was lying.
 */
export function capTelemetry(db: Database, cap: number = TELEMETRY_OUTBOX_CAP): number {
  if (!tableExists(db, TELEMETRY_OUTBOUND_TABLE)) return 0;
  const before = db.prepare(`SELECT COUNT(*) AS n FROM ${TELEMETRY_OUTBOUND_TABLE}`).get() as {
    n: number;
  };
  if (before.n <= cap) return 0;
  const info = db
    .prepare(
      `DELETE FROM ${TELEMETRY_OUTBOUND_TABLE}
        WHERE id NOT IN (SELECT id FROM ${TELEMETRY_OUTBOUND_TABLE} ORDER BY id DESC LIMIT ?)`,
    )
    .run(cap);
  const dropped = info.changes;
  if (dropped > 0) {
    process.stderr.write(
      `[massu] NOTE: dropped ${dropped} oldest promotion-funnel telemetry row(s) at the ` +
        `${cap}-row cap. No learned rules were affected (rules are never dropped).\n`,
    );
    recordAnalytics(db, EVENT_TELEMETRY_CAPPED, { dropped, cap });
  }
  return dropped;
}

/**
 * Learned rules must NEVER travel in `pending_sync` — that queue discards its
 * contents after 10 failed retries, which is exactly how they were being lost.
 * They live in the outbound stores under the lease/ack contract instead. This
 * strips them from any payload about to be handed to the discardable queue.
 */
export function stripLearningFromPayload<T extends object>(payload: T): T {
  const clone = { ...payload } as Record<string, unknown>;
  delete clone.rule_promotions;
  delete clone.rule_revocations;
  delete clone.rule_promotion_events;
  return clone as T;
}

/** True when a legacy `pending_sync` payload still carries learned rules. */
export function payloadCarriesLearning(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
  return (
    nonEmpty(p.rule_promotions) ||
    nonEmpty(p.rule_revocations) ||
    nonEmpty(p.rule_promotion_events)
  );
}

function safeParseArray(raw: string): unknown[] {
  const v = safeParseUnknown(raw);
  return Array.isArray(v) ? v : [];
}

function safeParseUnknown(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // A corrupt metadata blob must not sink the delivery of the rule it decorates.
    return null;
  }
}

/**
 * Durable telemetry sink. Deliberately NOT swallowed into silence: if we cannot
 * even record that delivery is broken, the operator still hears about it on
 * stderr. (A catch that returns nothing here would recreate the exact class of
 * bug this module exists to destroy.)
 */
function recordAnalytics(db: Database, eventType: string, data: Record<string, unknown>): void {
  try {
    db.prepare(
      `INSERT INTO analytics_events (event_type, event_data, created_at)
       VALUES (?, ?, datetime('now'))`,
    ).run(eventType, JSON.stringify(data));
  } catch (err) {
    process.stderr.write(
      `[massu] WARNING: could not record '${eventType}' telemetry: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
