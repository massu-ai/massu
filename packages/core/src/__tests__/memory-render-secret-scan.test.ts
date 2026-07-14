/**
 * B-06 / N-01 — the secret scan at the write boundary is FAIL-CLOSED, and the refusal
 * is VISIBLE.
 *
 * The memory dir is git-tracked and PUSHED. MEMORY.md is auto-loaded as trusted context
 * in every future session. Slice 3 ALREADY wrote a live API-key fragment into durable
 * memory once — this is not hypothetical.
 *
 * `redactSecrets` is the WRONG TOOL here: redact-and-write silently ships a mangled
 * memory into a pushed repo and tells nobody. The renderer must REFUSE and SAY SO.
 */
import { describe, it, expect } from 'vitest';
import { containsSecret, redactSecrets } from '../memory-llm.ts';

describe('B-06 — containsSecret DETECTS rather than redacts', () => {
  const CASES: Array<[string, string]> = [
    ['a massu live key', 'The key is ms_live_abc123def456ghi789 and it works.'],
    ['an openai-style key', 'export OPENAI=sk-abcdefghijklmnop0123456789'],
    ['a github token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['a supabase token', 'sbp_0123456789abcdefghijklmnop'],
    ['an aws access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['a jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'],
  ];

  for (const [label, text] of CASES) {
    it(`refuses ${label}`, () => {
      const r = containsSecret(text);
      expect(r.matched).toBe(true);
      expect(r.patternName).toBeTruthy();
    });
  }

  it('names the PATTERN and never echoes the matched text', () => {
    const secret = 'ms_live_supersecretvalue123456';
    const r = containsSecret(`my key is ${secret}`);

    expect(r.matched).toBe(true);
    expect(r.patternName).toBe('MASSU_LIVE_KEY');

    // The refusal is surfaced to the operator, printed by --dry-run, AND written to
    // audit_log. None of those may become a NEW place the secret is recorded.
    expect(JSON.stringify(r)).not.toContain('supersecretvalue');
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('passes ordinary prose — the operator writes about credentials constantly', () => {
    // His corpus is FULL of memories ABOUT credential incidents. They must still render.
    const prose =
      'Never commit secrets. The 2026-07-05 incident: a key was set but doctor still ' +
      'reported Free because there was no default endpoint to validate against.';
    expect(containsSecret(prose).matched).toBe(false);
  });

  it('⛔ is STATELESS across calls — the /g lastIndex trap', () => {
    // SECRET_PATTERNS carry the /g flag, and `RegExp.prototype.test` on a /g regex
    // ADVANCES lastIndex. These are module-level SHARED regex objects, so a naive
    // detector returns true, then false, then true... — meaning a secret detected in
    // one file would be MISSED in the next. That is a silent leak into a pushed repo.
    const text = 'ms_live_abc123def456ghi789';
    for (let i = 0; i < 10; i++) {
      expect(containsSecret(text).matched, `call ${i + 1}`).toBe(true);
    }
  });

  it('does not disturb redactSecrets (re-expressed, not replaced)', () => {
    const out = redactSecrets('key ms_live_abc123def456ghi789 here');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('abc123def456ghi789');
    // ...and the detector still works after the redactor ran (shared regex state again).
    expect(containsSecret('ms_live_abc123def456ghi789').matched).toBe(true);
  });
});
