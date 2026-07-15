// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PB-003 (plan-2026-05-28-team-shared-rule-promotion): the client PULL half of
 * team-shared rule promotion.
 *
 * Pulls the requester's org's promoted rules from the cloud /promoted-rules
 * differential-pull endpoint, VERIFIES the Ed25519 envelope, confirms org match,
 * and materializes each promotion as a LOCAL rule-candidate sidecar — provenance
 * tagged, surfaced via `/massu-rule` for the receiving operator to review and
 * approve. It NEVER applies anything.
 *
 * ⛔ HARD INVARIANT (approval-before-apply, enforced by the PB-007 drift-guard +
 * pattern-scanner Check 32): this module imports/calls NONE of the applier's
 * promotion-apply or destination-write functions (the four-step apply
 * transaction, the memory-index appender, or any of the four destination
 * writers). The drift-guard greps this file for those identifiers — keep them
 * out of code AND comments. The only writes it performs are (a) a candidate
 * sidecar JSON, (b) a `shared_observations` row, (c) the cursor in `memory_meta`,
 * (d) best-effort telemetry. Materialization ≠ application. A pulled rule cannot
 * take effect until a human approves it via `/massu-rule`, which routes through
 * the applier's team-origin gate (tier ≥ Team + verified provenance + shareable
 * destination).
 *
 * Trust layering: org isolation is server-enforced (org-scoped query + RLS); the
 * signature closes MITM/tampered-transit (T2); the H1 destination allowlist makes
 * executable bash / arbitrary file-writes structurally unable to cross seats; the
 * client re-checks signed `orgId` against its own (T3). No transition mode — an
 * unsigned / invalid / wrong-org envelope is DROPPED with observability (H5).
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type Database from 'better-sqlite3';
import { getConfig, getProjectRoot } from './config.ts';
import { getCachedTierReadOnly, getCachedOrgId, type ToolTier } from './license.ts';
import { entitledForTeamSharedPromotion } from './auto-learning-entitlement.ts';
import {
  verifyPromotionEnvelope,
  type SignedPromotionEnvelope,
} from './security/promotion-envelope-verifier.ts';
// Only the H1 allowlist constant + predicate are imported from the applier —
// NOT any apply/write function (see HARD INVARIANT above; PB-007 enforces).
import { isTeamShareableDestination } from './rule-candidate-applier.ts';
import { isHardenedShareableDestination } from './rule-candidate-hardened.ts';
import { shareObservation } from './team-knowledge.ts';
import { getMemoryMeta, setMemoryMeta, recordTelemetry } from './memory-db.ts';

const CURSOR_KEY = 'team_promotions_cursor';
const DEFAULT_TIMEOUT_MS = 2_000;
const PROMPT_HASH_RE = /^[0-9a-f]{16}$/;

/** A single promotion as carried in the verified `promotions_json` string. */
interface WirePromotion {
  prompt_hash: string;
  destination: string;
  draft_text: string;
  score?: number;
  signals?: unknown[];
  promoted_by: string;
  promoted_at: string;
  seq: number;
  revoked_at?: string | null;
  /** PA3-005: true for a hardened (executable-destination) promotion. */
  hardened?: boolean;
  /** PA3-005: the publisher's review attestation (carried for display/audit; the
   *  RECEIVER's two-operator + render-only ack is recorded separately on apply). */
  review_attestation?: unknown;
}

export interface PullTeamPromotionsResult {
  pulled: number;
  materialized: number;
  skipped: number;
  dropped_unverified: number;
  dropped_nonshareable: number;
  revoked_handled: number;
  /**
   * Set when the pull FAILED (HTTP non-OK / network / timeout) — DISTINCT from a
   * legitimately-empty pull. BND-3 (audit 2026-07-14): a sync failure must never
   * be byte-identical to "nothing to sync". Undefined = the request completed.
   */
  sync_error?: string;
}

/**
 * DI seam (mirrors the server's `PromotedRulesDeps`). Production omits all of
 * these — they default to config + the cache-only license readers + global
 * fetch. Tests inject to exercise the gate / verify / org-match / H1 / H3
 * branches without a live cloud or license cache.
 */
export interface PullOptions {
  projectRoot?: string;
  fetchImpl?: typeof fetch;
  /** Override the entitlement tier (default: cache-only `getCachedTierReadOnly`). */
  tier?: ToolTier;
  /** Override the org id check (default: cache-only `getCachedOrgId`). */
  orgId?: string | null;
  endpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
}

const ZERO: PullTeamPromotionsResult = {
  pulled: 0,
  materialized: 0,
  skipped: 0,
  dropped_unverified: 0,
  dropped_nonshareable: 0,
  revoked_handled: 0,
};

/**
 * Pull, verify, and materialize the org's team-shared promotions. Best-effort:
 * any network / parse error returns zero counts without advancing the cursor
 * (so the next session retries). Designed to run inside the session-end hook's
 * existing non-blocking try/catch within the bounded request budget.
 */
export async function pullTeamPromotions(
  db: Database.Database,
  opts: PullOptions = {},
): Promise<PullTeamPromotionsResult> {
  const config = getConfig();
  const cloud = config.cloud;
  const projectRoot = opts.projectRoot ?? getProjectRoot();

  // (1) Tier gate — Free/Pro never pull (cache-only, no network).
  const tier = opts.tier ?? getCachedTierReadOnly(db);
  if (!entitledForTeamSharedPromotion(tier)) return { ...ZERO };

  const endpoint = opts.endpoint ?? cloud?.endpoint;
  const apiKey = opts.apiKey ?? cloud?.apiKey;
  if (!endpoint || !apiKey) return { ...ZERO };

  const ownOrgId = opts.orgId !== undefined ? opts.orgId : getCachedOrgId(db);

  // (2) Cursor — monotonic seq watermark (H2). Default 0.
  const since = parseCursor(getMemoryMeta(db, CURSOR_KEY));

  // (3) Bounded differential fetch.
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? (cloud as { requestTimeoutMs?: number } | undefined)?.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  let envelope: SignedPromotionEnvelope;
  try {
    const res = await fetchImpl(`${endpoint}/promoted-rules?since=${since}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return failSync(db, `http_${res.status}`);
    envelope = (await res.json()) as SignedPromotionEnvelope;
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network';
    return failSync(db, reason);
  }

  // (4) Verify the Ed25519 envelope — NO transition mode. Drop the WHOLE
  // response on anything other than `valid` (H5 observability).
  const verdict = verifyPromotionEnvelope(envelope);
  if (verdict.kind !== 'valid') {
    const result = { ...ZERO, dropped_unverified: countUntrusted(envelope) };
    emitDropTelemetry(db, 'team_promotion_envelope_dropped', { reason: verdict.kind });
    return result;
  }

  // (4.5) Defense-in-depth (PA3 security review LOW): the signature covers ONLY
  // the keys named in `_signature_payload_keys`. Before trusting `orgId` /
  // `promotions_json`, confirm they are IN that signed set — otherwise a tampered
  // (but otherwise-valid) envelope could carry an UNSIGNED orgId/promotions_json
  // that the signature does not actually cover. Drop the whole response if either
  // load-bearing field was not signed.
  const signedKeys = Array.isArray(envelope._signature_payload_keys)
    ? (envelope._signature_payload_keys as readonly string[])
    : [];
  if (!signedKeys.includes('orgId') || !signedKeys.includes('promotions_json')) {
    const result = { ...ZERO, dropped_unverified: countUntrusted(envelope) };
    emitDropTelemetry(db, 'team_promotion_unsigned_field', {
      orgId_signed: signedKeys.includes('orgId'),
      promotions_json_signed: signedKeys.includes('promotions_json'),
    });
    return result;
  }

  // (5) Confirm the signed orgId matches this seat's own org (T3). A null/own
  // mismatch is a trust failure → drop the whole response.
  const signedOrgId = typeof envelope.orgId === 'string' ? envelope.orgId : null;
  if (!signedOrgId || !ownOrgId || signedOrgId !== ownOrgId) {
    const result = { ...ZERO, dropped_unverified: countUntrusted(envelope) };
    emitDropTelemetry(db, 'team_promotion_org_mismatch', {
      signed_org_present: !!signedOrgId,
      own_org_present: !!ownOrgId,
    });
    return result;
  }

  // (6) Parse the now-trusted promotions and process each.
  const promotions = parsePromotions(envelope.promotions_json);
  const result: PullTeamPromotionsResult = { ...ZERO };
  let maxSeq = since;

  for (const p of promotions) {
    if (!isValidWirePromotion(p)) continue;
    result.pulled += 1;
    if (typeof p.seq === 'number' && p.seq > maxSeq) maxSeq = p.seq;

    // (6 H1) Destination gate. Non-hardened: only the two non-executing
    // destinations materialize (Phase-2 guarantee). Hardened (PA3-005): an
    // executable destination materializes into a hardened-PENDING sidecar ONLY if
    // the wire promotion is flagged `hardened` (the server only stores hardened
    // rows with hardened=true + a publisher review_attestation; migration 045
    // CHECK). It NEVER auto-applies — the receiver's `/massu-rule review`
    // (render-only preview + a second-operator attestation) gates the apply.
    // Defense-in-depth: a compromised broker (T9) emitting a hardened flag on an
    // unopted-in org is still blocked at the applier gate (verified provenance +
    // two-operator + render-only ack) and server-side (org opt-in).
    const hardenedMaterialize =
      isHardenedShareableDestination(p.destination) && p.hardened === true;
    if (!isTeamShareableDestination(p.destination) && !hardenedMaterialize) {
      result.dropped_nonshareable += 1;
      continue;
    }

    const candidatePath = sidecarPath(projectRoot, p.prompt_hash);

    // (6 H3) Revocation tombstone.
    if (p.revoked_at) {
      handleRevocation(db, projectRoot, candidatePath, p.prompt_hash);
      result.revoked_handled += 1;
      continue;
    }

    // (6 T4) Idempotency: already pending (sidecar) or already applied (audit).
    if (existsSync(candidatePath) || alreadyApplied(db, p.prompt_hash)) {
      result.skipped += 1;
      continue;
    }

    // Materialize as a provenance-tagged candidate + a shared_observations row.
    materializeCandidate(db, projectRoot, candidatePath, p, signedOrgId);
    result.materialized += 1;
  }

  // (7) Advance the cursor monotonically (H2) — prefer the server's computed
  // cursor, but never regress below what we observed.
  const serverCursor = typeof envelope.cursor === 'number' ? envelope.cursor : 0;
  const nextCursor = Math.max(since, maxSeq, serverCursor);
  if (nextCursor > since) setMemoryMeta(db, CURSOR_KEY, String(nextCursor));

  return result;
}

// ============================================================
// Helpers
// ============================================================

function parseCursor(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function parsePromotions(json: unknown): WirePromotion[] {
  if (typeof json !== 'string') return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as WirePromotion[]) : [];
  } catch {
    return [];
  }
}

/** Count promotions in an UNTRUSTED body for telemetry only (never materialized). */
function countUntrusted(envelope: SignedPromotionEnvelope): number {
  const arr = parsePromotions(envelope.promotions_json);
  return arr.length > 0 ? arr.length : 1;
}

function isValidWirePromotion(p: unknown): p is WirePromotion {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return (
    typeof r.prompt_hash === 'string' &&
    PROMPT_HASH_RE.test(r.prompt_hash) &&
    typeof r.destination === 'string' &&
    typeof r.draft_text === 'string' &&
    typeof r.promoted_by === 'string' &&
    typeof r.promoted_at === 'string'
  );
}

function sidecarPath(projectRoot: string, promptHash: string): string {
  return join(projectRoot, '.massu', 'rule-candidates', `${promptHash}.json`);
}

/** T4: has this prompt_hash already been promoted locally (audit_log)? */
function alreadyApplied(db: Database.Database, promptHash: string): boolean {
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM audit_log WHERE event_type = 'rule_promoted'
           AND json_extract(metadata, '$.prompt_hash') = ? LIMIT 1`,
      )
      .get(promptHash);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * H3 revocation receive side. A pending (not-yet-approved) candidate is deleted
 * outright. An already-applied rule is NOT auto-reverted (symmetric with
 * approval-before-apply) — instead a one-shot stderr notice invites the operator
 * to consider reverting.
 */
function handleRevocation(
  db: Database.Database,
  projectRoot: string,
  candidatePath: string,
  promptHash: string,
): void {
  if (existsSync(candidatePath)) {
    try { unlinkSync(candidatePath); } catch { /* best-effort */ }
    return;
  }
  if (alreadyApplied(db, promptHash)) {
    process.stderr.write(
      `[massu] team rule ${promptHash} was revoked by your org — consider reverting it.\n`,
    );
  }
}

function materializeCandidate(
  db: Database.Database,
  projectRoot: string,
  candidatePath: string,
  p: WirePromotion,
  orgId: string,
): void {
  const promptText = p.draft_text.replace(/\n+/g, ' ').slice(0, 200) || `team rule ${p.prompt_hash}`;
  const sidecar = {
    // Standard RuleCandidatePayload fields (so `/massu-rule approve` → readCandidate
    // → validateCandidatePayload passes), synthesized from the promotion.
    prompt: promptText,
    prompt_hash: p.prompt_hash,
    score: clampScore(p.score),
    signals: sanitizeSignals(p.signals),
    prior_turn_files: [] as string[],
    timestamp: p.promoted_at,
    session_id: `team:${p.promoted_by}`,
    // Provenance (PB-004): the applier's team-origin gate keys on this. PA3-005:
    // a hardened materialization sets `hardened: true` so the applier's hardened
    // apply-gate (PA3-004) engages. `review_attestation` is intentionally NOT
    // copied from the publisher here — the RECEIVER's `/massu-rule review` records
    // ITS OWN two-operator + render-only ack into provenance.review_attestation
    // before apply; until then the gate refuses (hardened-PENDING).
    provenance: {
      origin: 'team' as const,
      org_id: orgId,
      promoted_by: p.promoted_by,
      promoted_at: p.promoted_at,
      signature_verified: true,
      ...(p.hardened === true ? { hardened: true } : {}),
    },
    // Extra fields the `/massu-rule approve` flow reads to drive the apply (the
    // publisher already decided destination + body). validateCandidatePayload
    // ignores unknown keys. `publisher_review_attestation` is retained for the
    // receiver's review UI (display only — never the apply-gate authority).
    destination: p.destination,
    draft_text: p.draft_text,
    ...(p.review_attestation !== undefined
      ? { publisher_review_attestation: p.review_attestation }
      : {}),
  };

  const dir = dirname(candidatePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(candidatePath, JSON.stringify(sidecar, null, 2), 'utf-8');

  // Team visibility: record a shared_observations row (best-effort).
  try {
    shareObservation(db, p.promoted_by, getProjectName(), 'rule_promotion', promptText, {
      filePath: undefined,
      module: p.destination,
    });
  } catch {
    // best-effort — the candidate is already written
  }
}

function clampScore(score: unknown): number {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0;
  return Math.max(-200, Math.min(200, score));
}

function sanitizeSignals(
  signals: unknown,
): Array<{ name: string; baseWeight: number; applied: number; evidence?: string }> {
  if (!Array.isArray(signals)) return [];
  const out: Array<{ name: string; baseWeight: number; applied: number; evidence?: string }> = [];
  for (const s of signals) {
    if (!s || typeof s !== 'object') continue;
    const sig = s as Record<string, unknown>;
    out.push({
      name: typeof sig.name === 'string' ? sig.name : 'unknown',
      baseWeight: typeof sig.baseWeight === 'number' ? sig.baseWeight : 0,
      applied: typeof sig.applied === 'number' ? sig.applied : 0,
      ...(typeof sig.evidence === 'string' ? { evidence: sig.evidence } : {}),
    });
  }
  return out;
}

function getProjectName(): string {
  try {
    return getConfig().project?.name ?? 'massu';
  } catch {
    return 'massu';
  }
}

function emitDropTelemetry(
  db: Database.Database,
  eventType: string,
  data: Record<string, unknown>,
): void {
  recordTelemetry(db, eventType, data);
  process.stderr.write(
    `[massu] team-shared promotion pull: dropped envelope (${eventType}). ` +
      `A signed/org-matched response is required — see massu.ai for details.\n`,
  );
}

/**
 * BND-3 (audit 2026-07-14): a failed pull (HTTP non-OK / network / timeout) is a
 * FAILURE, not an empty result. Record telemetry + a loud stderr line + carry a
 * distinct `sync_error` so callers and outcome-watchers can tell "the cloud was
 * unreachable" from "there was nothing to sync" (previously byte-identical).
 */
function failSync(db: Database.Database, reason: string): PullTeamPromotionsResult {
  recordTelemetry(db, 'team_promotion_sync_failed', { reason });
  process.stderr.write(
    `[massu] team-shared promotion pull FAILED (${reason}). This is NOT "nothing to sync" — ` +
      `the cloud was unreachable or rejected the request; promotions were NOT refreshed this run.\n`,
  );
  return { ...ZERO, sync_error: reason };
}
