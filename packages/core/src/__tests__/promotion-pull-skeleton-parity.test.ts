// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * ARCH-FIX 3 (curated-rule-packs review — duplication vs team-rule-sync):
 * `rule-pack-sync.ts` and `team-rule-sync.ts` share a SECURITY-CRITICAL pull
 * skeleton — verify the Ed25519 envelope → assert the signed-key set includes the
 * expected load-bearing keys → org-match the signed `orgId` against the seat's own
 * → DROP the whole response on any failure (no transition mode). Two near-identical
 * copies risk silent drift: a hardening fix landing in one module but not the
 * other (the exact bug class that makes a forged/wrong-org envelope materialize).
 *
 * DECISION (recorded): a clean extraction of the verify+signed-key-guard+org-match
 * primitive into ONE shared function was REJECTED as higher-risk — it would also
 * remove the literal `verifyPromotionEnvelope` call-site from each module, breaking
 * the EXISTING security drift-guards that pin it there (`team-shared-promotion-
 * drift-guard.test.ts` asserts team-rule-sync `.toContain('verifyPromotionEnvelope')`;
 * `rule-pack-enforcement-bridge.test.ts` asserts the same on rule-pack-sync). Per the
 * fix's lower-risk instruction, we instead pin BOTH modules in lockstep here: each
 * MUST (a) call `verifyPromotionEnvelope`, (b) hard-drop on a non-`valid` verdict,
 * (c) perform the `_signature_payload_keys` signed-key-set guard on `orgId`, and
 * (d) org-match the signed `orgId` against `ownOrgId`. A drift in either module
 * (dropping any of these) fails this test. Behavior is unchanged.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const TEAM_SRC = resolve(REPO_ROOT, 'packages/core/src/team-rule-sync.ts');
const PACK_SRC = resolve(REPO_ROOT, 'packages/core/src/rule-pack-sync.ts');

/**
 * The shared verify → signed-key-guard → org-match skeleton, expressed as the
 * load-bearing source substrings each module's pull path MUST contain. The
 * signed-key checks differ only in the body-carrying field name
 * (`promotions_json` vs `packs_json`), which is asserted per-module below.
 */
const SHARED_SKELETON = [
  // (a) verify the Ed25519 envelope via the consolidated verifier
  'verifyPromotionEnvelope(',
  // (b) hard-drop on anything other than a `valid` verdict (no transition mode)
  "verdict.kind !== 'valid'",
  // (c) the signed-key-set guard — the signature covers ONLY `_signature_payload_keys`
  '_signature_payload_keys',
  "signedKeys.includes('orgId')",
  // (d) org-match the signed orgId against the seat's own
  'signedOrgId !== ownOrgId',
];

describe('promotion pull-skeleton parity (ARCH-FIX 3 — lockstep drift-guard)', () => {
  const team = readFileSync(TEAM_SRC, 'utf-8');
  const pack = readFileSync(PACK_SRC, 'utf-8');

  it('team-rule-sync.ts carries the full verify+signed-key-guard+org-match skeleton', () => {
    for (const frag of SHARED_SKELETON) {
      expect(team, `team-rule-sync.ts pull skeleton must contain: ${frag}`).toContain(frag);
    }
    // its body-carrying signed key
    expect(team).toContain("signedKeys.includes('promotions_json')");
  });

  it('rule-pack-sync.ts carries the IDENTICAL verify+signed-key-guard+org-match skeleton', () => {
    for (const frag of SHARED_SKELETON) {
      expect(pack, `rule-pack-sync.ts pull skeleton must contain: ${frag}`).toContain(frag);
    }
    // its body-carrying signed key
    expect(pack).toContain("signedKeys.includes('packs_json')");
  });

  it('both modules verify BEFORE trusting the signed orgId (verify precedes org-match)', () => {
    for (const [name, src] of [
      ['team-rule-sync.ts', team],
      ['rule-pack-sync.ts', pack],
    ] as const) {
      const verifyIdx = src.indexOf('verifyPromotionEnvelope(');
      const orgMatchIdx = src.indexOf('signedOrgId !== ownOrgId');
      expect(verifyIdx, `${name} must call verifyPromotionEnvelope`).toBeGreaterThan(-1);
      expect(orgMatchIdx, `${name} must org-match`).toBeGreaterThan(-1);
      expect(
        verifyIdx,
        `${name} must verify the envelope BEFORE org-matching the signed orgId`,
      ).toBeLessThan(orgMatchIdx);
    }
  });
});
