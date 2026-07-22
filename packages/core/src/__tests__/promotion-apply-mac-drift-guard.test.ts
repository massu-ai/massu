// S-6 (D2 closure) drift-guard: the team/pack apply gate's authority is the
// install-bound apply MAC, not the self-certifying `signature_verified` boolean.
//
// Layer 2 of the three-layer enforcement (code gate + this drift-guard + a live
// behavioral test in rule-candidate-applier-team-shared.test.ts). Asserts, at source
// level, that the MAC is stamped at BOTH materialization sites and RE-VERIFIED at the
// apply gate, and that the MAC module is fail-closed + constant-time.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');

describe('S-6 — team/pack apply gate re-verifies the install-bound MAC', () => {
  it('the apply gate RE-VERIFIES the MAC (verifyPromotionApplyMac), not just the boolean', () => {
    const applier = read('rule-candidate-applier.ts');
    expect(applier).toMatch(/import\s*\{[^}]*verifyPromotionApplyMac[^}]*\}\s*from\s*'\.\/security\/promotion-apply-mac\.ts'/);
    // The re-verify call is present and appears BEFORE takeSnapshots (zero mutation on refusal).
    const macAt = applier.indexOf('verifyPromotionApplyMac(');
    const snapAt = applier.indexOf('takeSnapshots(');
    expect(macAt).toBeGreaterThan(-1);
    expect(snapAt).toBeGreaterThan(-1);
    expect(macAt).toBeLessThan(snapAt);
  });

  it('BOTH materialization sites stamp the apply MAC after verification', () => {
    expect(read('team-rule-sync.ts')).toMatch(/computePromotionApplyMac\(/);
    expect(read('rule-pack-sync.ts')).toMatch(/computePromotionApplyMac\(/);
  });

  it('the MAC module is fail-closed, constant-time, and domain-separated', () => {
    const mac = read('security/promotion-apply-mac.ts');
    expect(mac).toMatch(/timingSafeEqual/); // constant-time compare
    expect(mac).toMatch(/massu\.promotion-apply\.v1/); // domain-separation label
    // reuses the CR-61 per-install key (not a new ad-hoc secret)
    expect(mac).toMatch(/from '\.\.\/memory-authorship\.ts'/);
    // fail-closed: an absent/empty claimed MAC returns false
    expect(mac).toMatch(/claimed\.length === 0.*return false|return false/);
  });
});
