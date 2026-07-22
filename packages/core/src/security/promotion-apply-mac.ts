// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * promotion-apply-mac.ts — the install-bound apply credential for team/pack rule
 * candidates (S-6, closing the pre-existing D2 in the shipped CR-55/57 apply gate).
 *
 * THE BUG (D2, pre-existing HIGH): the applier's team-origin gate trusted a stored
 * `provenance.signature_verified: true` boolean — a claim the sidecar makes ABOUT
 * ITSELF (`rule-candidate-applier.ts` ← `team-rule-sync.ts`). The Ed25519 signature
 * is verified at PULL time; at APPLY time only the boolean survives, and Massu ships
 * to arbitrary consumer repos whose `.gitignore` it does not control — so a hostile
 * repo can commit a pre-forged sidecar (`signature_verified: true`) into its tree and
 * have it applied. This is the exact "authorship is claimed, not earned" class Slice 4
 * B-01 exists to kill.
 *
 * THE FIX (mirrors CR-61's keyed-HMAC authorship — operator decision 2026-07-21):
 * when the client materializes a candidate (i.e. AFTER it verified the server
 * envelope) it stamps an HMAC keyed by THIS install's per-install secret
 * (`~/.massu/render-key`, the CR-61 credential) over the candidate's load-bearing
 * fields. At apply, the gate RECOMPUTES that MAC and refuses on any mismatch. A
 * pre-forged sidecar from a repo that does not hold this install's key has NO valid
 * MAC ⇒ refused. The forgeable boolean is no longer authority.
 *
 * Domain separation (TWO-SIDED, via key derivation): CR-61 file-authorship signs a raw
 * body with the per-install render-key directly. This apply MAC uses a DERIVED subkey
 * `HMAC(render-key, DOMAIN)` — never the raw render-key — so an authorship MAC (raw key)
 * can NEVER collide with an apply MAC (derived key), regardless of what body authorship
 * signs. A one-sided message prefix would NOT achieve this (an authorship MAC over a
 * body equal to the prefixed apply input would collide); the independent subkey does.
 *
 * HONEST LIMIT (documented, same as B-05/CR-61): a process running AS the operator
 * can read `~/.massu/render-key` and forge a MAC. A local secret is not a boundary
 * against a compromised local account — it closes the DOWNSTREAM-repo forgery vector
 * (a cloned/hostile repo cannot forge it), which is the actual D2.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { homedir } from 'os';
import { ensureRenderKey, readRenderKey } from '../memory-authorship.ts';

/** HMAC domain-separation label. Bump the version on any field-set change. */
const DOMAIN = 'massu.promotion-apply.v1';

/** The load-bearing fields the apply MAC binds. Field order is FIXED. */
export interface ApplyMacFields {
  origin: string;
  org_id: string;
  prompt_hash: string;
  destination: string;
  draft_text: string;
}

function canonical(f: ApplyMacFields): string {
  return [DOMAIN, f.origin, f.org_id, f.prompt_hash, f.destination, f.draft_text].join('\n');
}

/**
 * The DERIVED apply subkey — HMAC(render-key, DOMAIN). Independent of the raw render-key
 * CR-61 authorship signs with, so the two MAC protocols share a key FILE but not a key.
 * No cross-protocol collision is possible. (This is the whole fix for the one-sided-
 * separation defect: separation lives in the KEY, not merely in the message.)
 */
function deriveApplyKey(renderKey: Buffer): Buffer {
  return createHmac('sha256', renderKey).update(DOMAIN, 'utf8').digest();
}

/**
 * Stamp the apply MAC at materialize time (the client has already verified the server
 * envelope). Returns null if no per-install key can be established — the caller then
 * omits the stamp, and the apply gate will REFUSE (fail-closed).
 */
export function computePromotionApplyMac(fields: ApplyMacFields, home: string = homedir()): string | null {
  try {
    const key = ensureRenderKey(home);
    if (!key) return null;
    return createHmac('sha256', deriveApplyKey(key)).update(canonical(fields), 'utf8').digest('hex');
  } catch {
    return null;
  }
}

/**
 * Verify the apply MAC at apply time. Fail-closed: an absent/empty MAC, no key on this
 * install, a length mismatch, or any exception ⇒ false. Constant-time compare (the MAC
 * is a secret-derived value).
 */
export function verifyPromotionApplyMac(
  claimed: string | undefined,
  fields: ApplyMacFields,
  home: string = homedir(),
): boolean {
  try {
    if (typeof claimed !== 'string' || claimed.length === 0) return false;
    const key = readRenderKey(home);
    if (!key) return false;
    const expected = createHmac('sha256', deriveApplyKey(key)).update(canonical(fields), 'utf8').digest('hex');
    const a = Buffer.from(claimed, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
