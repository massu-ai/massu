// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P2-002 (plan-2026-06-01-curated-rule-packs): the client PULL half of curated
 * rule packs — the rule-pack analogue of `team-rule-sync.pullTeamPromotions`.
 *
 * Pulls the requester's org's INSTALLED-pack rules from the cloud
 * `/installed-rules` Edge Function, VERIFIES the Ed25519 envelope (server-signed
 * with the SAME promotion signer as `/promoted-rules`), confirms org match, and
 * materializes each pack rule as a LOCAL rule-candidate sidecar — provenance
 * tagged (`origin:'pack'` + `pack_slug` + `pack_version`), surfaced via
 * `/massu-rule` for the receiving operator to review and approve. It NEVER
 * applies anything.
 *
 * ⛔ HARD INVARIANT (materialize-never-apply, enforced by the P2-004 drift-guard +
 * pattern-scanner Check 36): this module imports/references NONE of the applier's
 * promotion-apply or destination-write functions (the four-step apply
 * transaction, the memory-index appender, or any of the four destination
 * writers). The drift-guard greps this file for those identifiers — keep them
 * out of code AND comments. The only write it performs is a candidate sidecar
 * JSON (plus best-effort telemetry). Materialization ≠ application. A pulled pack
 * rule cannot take effect until a human approves it via `/massu-rule`, which
 * routes through the applier's team-origin / hardened apply-gate (tier ≥ Team +
 * verified provenance + shareable/hardened destination).
 *
 * Trust layering mirrors `team-rule-sync`: org isolation is server-enforced; the
 * signature closes MITM/tampered-transit; an executable-destination pack rule
 * (`pattern-scanner` / `custom-destination`) materializes as HARDENED-PENDING
 * (`provenance.hardened === true`) so the operator must `review` (render-only
 * preview + two-operator attestation) before `approve`. The client re-checks the
 * signed `orgId` against its own. NO transition mode — an unsigned / invalid /
 * wrong-org envelope is DROPPED whole with observability.
 */

import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type Database from 'better-sqlite3';
import { getConfig, getProjectRoot } from './config.ts';
import { getCachedTierReadOnly, getCachedOrgId, type ToolTier } from './license.ts';
import { entitledForTeamSharedPromotion } from './auto-learning-entitlement.ts';
import {
  verifyPromotionEnvelope,
  type SignedPromotionEnvelope,
} from './security/promotion-envelope-verifier.ts';
import {
  validateRulePackRule,
  isExecutableDestination,
  type RulePackRule,
} from './rule-pack-schema.ts';
import { recordTelemetry } from './memory-db.ts';

const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * The FLAT signed envelope served by `/installed-rules`. Same signed-key scheme
 * as `/promoted-rules` (see {@link SignedPromotionEnvelope}); the installed packs
 * ride as the `packs_json` STRING so the Ed25519 signature covers every rule
 * body. The verifier accepts ANY FLAT envelope whose load-bearing fields are in
 * the signed-key set; we re-check `orgId` + `packs_json` are signed below.
 */
export interface SignedInstalledRulesEnvelope extends SignedPromotionEnvelope {
  /** Number of installed packs returned (informational; signature-covered). */
  pack_count?: number;
  /** Whether the server filtered to update-available packs only. */
  updates_only?: boolean;
  /** JSON-serialized installed-packs array (string so the signature covers it). */
  packs_json?: string;
}

/** A single installed pack as carried in the verified `packs_json` string. */
interface InstalledPack {
  pack_id: string;
  slug: string;
  name: string;
  installed_version: string;
  current_version: string;
  update_available?: boolean;
  auto_update?: boolean;
  installed_at?: string;
  rules: unknown[];
}

export interface PullInstalledPackRulesResult {
  pulled: number;
  materialized: number;
  skipped: number;
  dropped_unverified: number;
  /**
   * Set when the pull FAILED (HTTP non-OK / network / timeout) — DISTINCT from a
   * legitimately-empty pull. BND-3 (audit 2026-07-14): a sync failure must never
   * be byte-identical to "nothing to sync". Undefined = the request completed.
   */
  sync_error?: string;
}

/**
 * DI seam (mirrors `team-rule-sync.PullOptions`). Production omits all of these —
 * they default to config + the cache-only license readers + global fetch. Tests
 * inject to exercise the gate / verify / org-match / validate / dedup branches
 * without a live cloud or license cache.
 */
export interface PullPackOptions {
  projectRoot?: string;
  fetchImpl?: typeof fetch;
  /** Override the entitlement tier (default: cache-only `getCachedTierReadOnly`). */
  tier?: ToolTier;
  /** Override the org id check (default: cache-only `getCachedOrgId`). */
  orgId?: string | null;
  endpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Pass `?updates_only=1` to the endpoint when true. */
  updatesOnly?: boolean;
}

const ZERO: PullInstalledPackRulesResult = {
  pulled: 0,
  materialized: 0,
  skipped: 0,
  dropped_unverified: 0,
};

/**
 * Pull, verify, and materialize the org's INSTALLED rule-pack rules. Best-effort:
 * any network / parse error returns zero counts. Designed to run from the
 * `/massu-rule packs` CLI subcommand (and is safe to invoke from a session hook
 * within the bounded request budget).
 */
export async function pullInstalledPackRules(
  db: Database.Database,
  opts: PullPackOptions = {},
): Promise<PullInstalledPackRulesResult> {
  const config = getConfig();
  const cloud = config.cloud;
  const projectRoot = opts.projectRoot ?? getProjectRoot();

  // (1) Tier gate — Free/Pro never pull (cache-only, no network). Pack
  // enforcement is a Team+ shared feature, gated like team-shared promotion.
  const tier = opts.tier ?? getCachedTierReadOnly(db);
  if (!entitledForTeamSharedPromotion(tier)) return { ...ZERO };

  const endpoint = opts.endpoint ?? cloud?.endpoint;
  const apiKey = opts.apiKey ?? cloud?.apiKey;
  if (!endpoint || !apiKey) return { ...ZERO };

  const ownOrgId = opts.orgId !== undefined ? opts.orgId : getCachedOrgId(db);

  // (2) Bounded fetch of the installed-pack rules.
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs =
    opts.timeoutMs ??
    (cloud as { requestTimeoutMs?: number } | undefined)?.requestTimeoutMs ??
    DEFAULT_TIMEOUT_MS;
  const url = `${endpoint}/installed-rules${opts.updatesOnly ? '?updates_only=1' : ''}`;
  let envelope: SignedInstalledRulesEnvelope;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return failSync(db, `http_${res.status}`);
    envelope = (await res.json()) as SignedInstalledRulesEnvelope;
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network';
    return failSync(db, reason);
  }

  // (3) Verify the Ed25519 envelope — NO transition mode. Drop the WHOLE
  // response on anything other than `valid` (observability counter).
  const verdict = verifyPromotionEnvelope(envelope);
  if (verdict.kind !== 'valid') {
    emitDropTelemetry(db, 'pack_rules_envelope_dropped', { reason: verdict.kind });
    return { ...ZERO, dropped_unverified: countUntrusted(envelope) };
  }

  // (3.5) Defense-in-depth: the signature covers ONLY the keys named in
  // `_signature_payload_keys`. Before trusting `orgId` / `packs_json`, confirm
  // both are IN that signed set — otherwise a tampered (but otherwise-valid)
  // envelope could carry an UNSIGNED orgId/packs_json the signature does not
  // actually cover. Drop the whole response if either load-bearing field is
  // unsigned.
  const signedKeys = Array.isArray(envelope._signature_payload_keys)
    ? (envelope._signature_payload_keys as readonly string[])
    : [];
  if (!signedKeys.includes('orgId') || !signedKeys.includes('packs_json')) {
    emitDropTelemetry(db, 'pack_rules_unsigned_field', {
      orgId_signed: signedKeys.includes('orgId'),
      packs_json_signed: signedKeys.includes('packs_json'),
    });
    return { ...ZERO, dropped_unverified: countUntrusted(envelope) };
  }

  // (4) Confirm the signed orgId matches this seat's own org (T3). A null/own
  // mismatch is a trust failure → drop the whole response.
  const signedOrgId = typeof envelope.orgId === 'string' ? envelope.orgId : null;
  if (!signedOrgId || !ownOrgId || signedOrgId !== ownOrgId) {
    emitDropTelemetry(db, 'pack_rules_org_mismatch', {
      signed_org_present: !!signedOrgId,
      own_org_present: !!ownOrgId,
    });
    return { ...ZERO, dropped_unverified: countUntrusted(envelope) };
  }

  // (5) Parse the now-trusted packs and process each rule.
  const packs = parsePacks(envelope.packs_json);
  const result: PullInstalledPackRulesResult = { ...ZERO };
  const nowIso = new Date().toISOString();

  for (const pack of packs) {
    if (!isValidInstalledPack(pack)) continue;
    for (const rawRule of pack.rules) {
      // (5a) Validate against the pack-rule schema; skip invalid rules.
      const validation = validateRulePackRule(rawRule);
      if (!validation.valid) {
        result.skipped += 1;
        continue;
      }
      const rule = rawRule as RulePackRule;
      result.pulled += 1;

      const promptHash = packRulePromptHash(pack.slug, rule);
      const candidatePath = sidecarPath(projectRoot, promptHash);

      // (5b) Idempotency: already pending (sidecar) or already applied (audit).
      if (existsSync(candidatePath) || alreadyApplied(db, promptHash)) {
        result.skipped += 1;
        continue;
      }

      // (5c) Materialize a provenance-tagged candidate. An executable
      // destination → hardened-PENDING (operator must `review` before `approve`).
      materializeCandidate(projectRoot, candidatePath, promptHash, rule, pack, signedOrgId, nowIso);
      result.materialized += 1;
    }
  }

  return result;
}

// ============================================================
// Helpers
// ============================================================

function parsePacks(json: unknown): InstalledPack[] {
  if (typeof json !== 'string') return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as InstalledPack[]) : [];
  } catch {
    return [];
  }
}

/** Count rules in an UNTRUSTED body for telemetry only (never materialized). */
function countUntrusted(envelope: SignedInstalledRulesEnvelope): number {
  const packs = parsePacks(envelope.packs_json);
  let n = 0;
  for (const p of packs) {
    if (p && Array.isArray((p as InstalledPack).rules)) n += (p as InstalledPack).rules.length;
  }
  return n > 0 ? n : 1;
}

function isValidInstalledPack(p: unknown): p is InstalledPack {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return typeof r.slug === 'string' && r.slug.length > 0 && Array.isArray(r.rules);
}

/**
 * Deterministic 16-hex identity for a pack rule, derived from the pack slug + the
 * rule's enforcement body. Matches the `prompt_hash` shape the applier and the
 * `list`/`approve` protocol key on (`/^[a-f0-9]{16}$/`). Stable across pulls so
 * dedup (T4) works: re-pulling the same pack rule resolves to the same sidecar.
 */
function packRulePromptHash(slug: string, rule: RulePackRule): string {
  // Lazy import keeps `crypto` off the module's import-cost path for the common
  // no-op (Free/Pro) exit; createHash is the same primitive the applier uses.
  // pattern-scanner-allow: require
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('crypto');
  const body = `${slug}\u0000${rule.destination}\u0000${rule.title}\u0000${
    rule.pattern ?? rule.check ?? rule.description
  }`;
  return createHash('sha256').update(body, 'utf-8').digest('hex').slice(0, 16);
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

function materializeCandidate(
  projectRoot: string,
  candidatePath: string,
  promptHash: string,
  rule: RulePackRule,
  pack: InstalledPack,
  orgId: string,
  nowIso: string,
): void {
  const promptText =
    `${rule.title}: ${rule.description}`.replace(/\n+/g, ' ').slice(0, 200) ||
    `pack rule ${promptHash}`;
  const draftText = rule.pattern ?? rule.check ?? rule.description;
  // An executable destination must ride the hardened path (review-before-apply).
  const hardened = isExecutableDestination(rule.destination);

  const sidecar = {
    // Standard RuleCandidatePayload fields (so `/massu-rule approve` → readCandidate
    // → validateCandidatePayload passes), synthesized from the pack rule.
    prompt: promptText,
    prompt_hash: promptHash,
    score: 0,
    signals: [] as Array<{ name: string; baseWeight: number; applied: number; evidence?: string }>,
    prior_turn_files: [] as string[],
    timestamp: nowIso,
    session_id: `pack:${pack.slug}`,
    // Provenance (P2-002/P2-003): the applier's team-origin / hardened apply-gate
    // keys on this. `origin:'pack'` rides the SAME gate as a team origin
    // (tier≥Team + signature_verified + shareable/hardened destination). A
    // hardened (executable-destination) materialization sets `hardened:true` so
    // the operator's `/massu-rule review` (render-only preview + a distinct
    // second-operator attestation) is required before `approve`.
    provenance: {
      origin: 'pack' as const,
      org_id: orgId,
      promoted_by: `pack:${pack.slug}`,
      promoted_at: nowIso,
      signature_verified: true,
      pack_slug: pack.slug,
      pack_version: pack.current_version,
      ...(hardened ? { hardened: true } : {}),
    },
    // Extra fields the `/massu-rule approve` flow reads to drive the apply (the
    // pack author already decided destination + body). validateCandidatePayload
    // ignores unknown keys.
    destination: rule.destination,
    draft_text: draftText,
  };

  const dir = dirname(candidatePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(candidatePath, JSON.stringify(sidecar, null, 2), 'utf-8');
}

function emitDropTelemetry(
  db: Database.Database,
  eventType: string,
  data: Record<string, unknown>,
): void {
  recordTelemetry(db, eventType, data);
  process.stderr.write(
    `[massu] installed-pack rules pull: dropped envelope (${eventType}). ` +
      `A signed/org-matched response is required — see massu.ai for details.\n`,
  );
}

/**
 * BND-3 (audit 2026-07-14): a failed pull (HTTP non-OK / network / timeout) is a
 * FAILURE, not an empty result. Record telemetry + a loud stderr line + carry a
 * distinct `sync_error` so callers and outcome-watchers can tell "the cloud was
 * unreachable" from "there was nothing to sync" (previously byte-identical).
 */
function failSync(db: Database.Database, reason: string): PullInstalledPackRulesResult {
  recordTelemetry(db, 'installed_pack_rules_sync_failed', { reason });
  process.stderr.write(
    `[massu] installed-pack rules pull FAILED (${reason}). This is NOT "nothing to sync" — ` +
      `the cloud was unreachable or rejected the request; installed-pack rules were NOT refreshed this run.\n`,
  );
  return { ...ZERO, sync_error: reason };
}
