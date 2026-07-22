// S-6 — the install-bound apply MAC (D2 closure) unit behavior.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { computePromotionApplyMac, verifyPromotionApplyMac, type ApplyMacFields } from '../security/promotion-apply-mac.ts';
import { mintAuthorship } from '../memory-authorship.ts';

const F: ApplyMacFields = { origin: 'team', org_id: 'org-1', prompt_hash: 'abc123def4567890', destination: 'corrections-md', draft_text: 'body' };

describe('S-6 promotion apply MAC', () => {
  let home: string;
  beforeEach(() => (home = mkdtempSync(join(tmpdir(), 'massu-mac-'))));
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('roundtrips: a MAC minted with this install verifies here', () => {
    const mac = computePromotionApplyMac(F, home)!;
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPromotionApplyMac(mac, F, home)).toBe(true);
  });

  it('any field change breaks verification (the MAC binds the load-bearing fields)', () => {
    const mac = computePromotionApplyMac(F, home)!;
    for (const k of ['origin', 'org_id', 'prompt_hash', 'destination', 'draft_text'] as const) {
      expect(verifyPromotionApplyMac(mac, { ...F, [k]: 'x' }, home)).toBe(false);
    }
  });

  it('a DIFFERENT install key does not verify (bound to THIS install)', () => {
    const other = mkdtempSync(join(tmpdir(), 'massu-mac-other-'));
    try {
      const mac = computePromotionApplyMac(F, other)!;
      expect(verifyPromotionApplyMac(mac, F, home)).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('SEC-review: NO cross-protocol collision with the CR-61 authorship MAC (shared key file, separate keys)', () => {
    // The security review PROVED the pre-fix collision: an authorship MAC (raw render-key
    // over a body) equalled an apply MAC (raw render-key over the domain-prefixed body).
    // The fix derives an INDEPENDENT apply subkey, so an authorship MAC over ANY body —
    // including the exact apply canonical string — can no longer verify as an apply MAC.
    const applyCanonical = ['massu.promotion-apply.v1', F.origin, F.org_id, F.prompt_hash, F.destination, F.draft_text].join('\n');
    const authorshipMac = mintAuthorship(applyCanonical, home);
    expect(authorshipMac).not.toBeNull();
    expect(verifyPromotionApplyMac(authorshipMac!, F, home)).toBe(false); // NO collision
    // and the apply MAC is not, itself, a valid authorship MAC for that body
    const applyMac = computePromotionApplyMac(F, home)!;
    expect(applyMac).not.toBe(authorshipMac);
  });

  it('fail-closed: absent/empty claimed MAC ⇒ false', () => {
    computePromotionApplyMac(F, home); // ensure a key exists
    expect(verifyPromotionApplyMac(undefined, F, home)).toBe(false);
    expect(verifyPromotionApplyMac('', F, home)).toBe(false);
    expect(verifyPromotionApplyMac('deadbeef', F, home)).toBe(false);
  });
});
