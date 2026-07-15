// CR-64 drift-guard — a PUBLISHED version number is immutable.
// Anti-vacuity: feeds the EXACT defect shape that shipped on 2026-07-14 (version published,
// no tag) and asserts the pure decision core returns a FAILURE. A gate that stayed green on
// this input would be dead. Also asserts the fail-closed (unfetchable npm) and pass paths.
// Real-tree attack lives in scripts/tests/test-release-integrity-mutation.sh (CR-72).
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs module, no type decls (pure JS gate logic).
import { evaluateReleaseIntegrity } from '../../../../scripts/release-integrity-check.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

describe('CR-64 evaluateReleaseIntegrity (release-integrity gate core)', () => {
  it('DEFECT shape (the 2026-07-14 incident): published version + NO tag → FAIL(1)', () => {
    const r = evaluateReleaseIntegrity({
      version: '1.16.0',
      publishedVersions: ['1.15.3', '1.16.0'],
      tagExists: false,
      headSha: HEAD,
      tagSha: null,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
    expect(r.reason).toMatch(/ALREADY PUBLISHED/);
  });

  it('published version + tag exists but HEAD ahead of tag → FAIL(1)', () => {
    const r = evaluateReleaseIntegrity({
      version: '1.16.0',
      publishedVersions: ['1.16.0'],
      tagExists: true,
      headSha: HEAD,
      tagSha: OTHER,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
    expect(r.reason).toMatch(/HEAD is/);
  });

  it('published version + tag at HEAD → PASS(0)', () => {
    const r = evaluateReleaseIntegrity({
      version: '1.16.0',
      publishedVersions: ['1.16.0'],
      tagExists: true,
      headSha: HEAD,
      tagSha: HEAD,
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
  });

  it('version NOT yet published (in-progress release) → PASS(0), regardless of tag', () => {
    const r = evaluateReleaseIntegrity({
      version: '1.16.1',
      publishedVersions: ['1.15.3', '1.16.0'],
      tagExists: false,
      headSha: HEAD,
      tagSha: null,
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
  });

  it('FAIL-CLOSED: unfetchable published list (null) → code 3, never a silent pass', () => {
    const r = evaluateReleaseIntegrity({
      version: '1.16.1',
      publishedVersions: null,
      tagExists: false,
      headSha: HEAD,
      tagSha: null,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
    expect(r.reason).toMatch(/CANNOT VERIFY/);
  });

  it('FAIL-CLOSED: empty published list ([]) → code 3', () => {
    const r = evaluateReleaseIntegrity({
      version: '1.16.1',
      publishedVersions: [],
      tagExists: false,
      headSha: HEAD,
      tagSha: null,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
  });
});
