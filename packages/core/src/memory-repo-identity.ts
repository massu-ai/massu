// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * memory-repo-identity.ts — a repo's cross-repo IDENTITY (Living Memory Slice 5,
 * A-02) and the TOFU trust pins that back the verifier (A-07).
 *
 * A repo is identified by a `repo_id`: a v4 UUID minted ONCE, into that repo's own
 * `memory_meta`, on the FIRST session in which the operator enables sharing —
 * never on a plain session start. A dormant install (sharing never enabled) mints
 * NOTHING.
 *
 * Why a UUID and not the obvious alternatives:
 *   - NOT the path: paths move; two clones of one repo would be one identity.
 *   - NOT the git remote: a private repo may have none, and a client's remote URL
 *     is itself sensitive data to copy into `~/.massu`.
 *   - NOT project.name: not unique across a machine, and attacker-influenceable.
 *
 * The human-readable label is DERIVED (`deriveSlug(project.name)`), re-derived on
 * every read, and NEVER trusted from the wire — a raw name can carry `/`, newlines,
 * or ANSI (Slice 4 found real memories with `/` in their name).
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { getConfig } from './config.ts';
import { getMemoryMeta, setMemoryMeta } from './memory-db.ts';
import { deriveSlug, SLUG_ALLOWED } from './lib/safe-write.ts';

/** `memory_meta` key holding this repo's minted `repo_id`. */
export const REPO_ID_META_KEY = 'repo_id';
/** `memory_meta` key prefix for a TOFU trust pin: `shared_pin:<origin_repo_id>`. */
export const SHARED_PIN_META_PREFIX = 'shared_pin:';

/** A well-formed v4-shaped UUID (what `randomUUID()` produces, lowercase hex). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Read this repo's `repo_id`, or `null` if it has never been minted (sharing
 * never enabled). Read-only — a dormant install stays dormant. Returns `null`
 * rather than a malformed value if the stored id is somehow corrupt (fail-closed).
 */
export function getRepoId(db: Database.Database): string | null {
  const v = getMemoryMeta(db, REPO_ID_META_KEY);
  return v && UUID_RE.test(v) ? v : null;
}

/**
 * Mint this repo's `repo_id` if absent, returning it (idempotent — a second call
 * returns the same id, mints nothing new). Call ONLY from the share-enable path;
 * never from plain session start. A minted id is the operator's deliberate act of
 * turning this repo into a shareable identity.
 */
export function mintRepoId(db: Database.Database): string {
  const existing = getRepoId(db);
  if (existing) return existing;
  const id = randomUUID();
  setMemoryMeta(db, REPO_ID_META_KEY, id);
  return id;
}

/**
 * The display label for a repo: `deriveSlug(project.name)`, `[a-z0-9_]` only,
 * capped. Display-only; re-derived on read; never trusted from the wire. Falls
 * back to `'repo'` if the name slugs to empty, so the label always matches
 * {@link SLUG_ALLOWED}.
 */
export function deriveRepoLabel(projectName: string): string {
  // Handle the empty/whitespace name here rather than delegating: the shared
  // slugger's own fallback is 'rule_candidate' (domain-specific to rule files),
  // a misleading label for a REPO. A repo with no name is simply 'repo'.
  if (!projectName || !projectName.trim()) return 'repo';
  const slug = deriveSlug(projectName);
  return slug && SLUG_ALLOWED.test(slug) ? slug : 'repo';
}

/** Convenience: this repo's label from the loaded config's `project.name`. */
export function getRepoLabel(): string {
  return deriveRepoLabel(getConfig().project.name);
}

// ---------------------------------------------------------------------------
// TOFU trust pins (A-07 backing store). The pin is stored in `memory_meta` — a
// DIFFERENT artifact than the key file — so a key swap alone cannot move it.
// ---------------------------------------------------------------------------

/** The pinned pubkey fingerprint for an origin repo, or `null` if never pinned. */
export function getSharedPin(db: Database.Database, originRepoId: string): string | null {
  return getMemoryMeta(db, SHARED_PIN_META_PREFIX + originRepoId);
}

/**
 * TRUST-ON-FIRST-USE: pin `fingerprint` for `originRepoId` ONLY if no pin exists
 * yet. Returns the effective pin (the pre-existing one if already pinned — a
 * second call NEVER silently overwrites, which is the whole point of TOFU). An
 * existing pin is only ever changed by an explicit human re-pin
 * ({@link repinSharedFingerprint}).
 */
export function tofuPinSharedFingerprint(
  db: Database.Database,
  originRepoId: string,
  fingerprint: string,
): string {
  const existing = getSharedPin(db, originRepoId);
  if (existing) return existing;
  setMemoryMeta(db, SHARED_PIN_META_PREFIX + originRepoId, fingerprint);
  return fingerprint;
}

/**
 * Explicit human re-pin (the `massu memory trust <repo> --fingerprint <hex>` path,
 * A-07): overwrite the pin for `originRepoId`. This is the ONLY way a pin changes
 * after first use — a key swap can never trigger it (it drops instead, until the
 * human runs this deliberately).
 */
export function repinSharedFingerprint(
  db: Database.Database,
  originRepoId: string,
  fingerprint: string,
): void {
  setMemoryMeta(db, SHARED_PIN_META_PREFIX + originRepoId, fingerprint);
}
