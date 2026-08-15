/**
 * CR-72 guard for the 2026-08-11 "prose read as code" defect in the auto-learning Stop hook.
 *
 * TWO failures shipped together and this pins BOTH:
 *   1. The keyword lists were matched as SUBSTRINGS, so `try` fired inside `retry`/`entry`
 *      and `throw` inside "the throw". A documentation-only diff scored 8 "fix patterns"
 *      with ZERO code files changed.
 *   2. Documentation was scanned at all. A `.md` plan is not a code fix.
 *
 * Both directions are asserted: prose must NOT fire, and a real fix MUST still fire — a
 * guard that only proves silence would pass just as well if the regex matched nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  FIX_PATTERN_RE,
  REMOVED_BROKEN_RE,
  CODE_ONLY_PATHSPEC,
} from '../hooks/auto-learning-pipeline.ts';

/** `String.match` with a /g/ regex is stateful via lastIndex; count on a fresh copy. */
function count(re: RegExp, text: string): number {
  return (text.match(new RegExp(re.source, re.flags)) || []).length;
}

// Verbatim from the real 2026-08-11 diff that mis-fired (docs/plans/*.md prose).
const REAL_PROSE_DIFF = [
  '+trace, and **drops the payload**. No spool, no retry, no dead-letter.',
  '+  never on "we read it", never on a retry cap (CR-66/CR-67).',
  '+  because a failed attempt burns a retry credit toward the shredder.',
  '+`packages/core/src/hooks/lib/hook-failure-signal.ts:154` `runHookSafely` catch',
  '+peaking **79.0%** on 2026-07-29. P1 reduced the FREQUENCY of the throw.',
  '+the entry point was missing and the country code was stale.',
].join('\n');

const REAL_CODE_FIX_DIFF = [
  '+  try {',
  '+    const v = JSON.parse(raw);',
  '+  } catch (err) {',
  '+    throw new Error(`bad payload: ${err}`);',
  '+  }',
  '+  if (v === null) return;',
].join('\n');

describe('auto-learning fix-pattern detection: prose is not code', () => {
  it('drops the SUBSTRING false matches that caused the mis-fire', () => {
    // Measured: the unbounded regex scored 8 on the FULL working-tree diff and 6 on this
    // 6-line excerpt of it; the word-boundaried form scores 2. Word-boundarying kills every
    // substring hit (retry/entry/country/poultry...). Attacked per CR-72: restoring the old
    // pattern yields 6 here, failing the `<= 2` assertion below — the guard goes red for its
    // own declared reason.
    //
    // It does NOT reach 0, and that is the honest result rather than a weakened assertion:
    // two lines use `catch` and `throw` as ORDINARY ENGLISH WORDS ("runHookSafely catch",
    // "the throw"). No regex over English can separate those from code, which is precisely
    // why the second half of the fix — excluding documentation from the diff scope
    // entirely (CODE_ONLY_PATHSPEC) — is the load-bearing one. The regex narrows; the
    // pathspec is what actually makes a .md diff unscannable.
    const n = count(FIX_PATTERN_RE, REAL_PROSE_DIFF);
    expect(n).toBeLessThanOrEqual(2);
    expect(n).toBeLessThan(8); // strictly better than the shipped behaviour
  });

  it('scores ZERO on prose that does not name a code construct', () => {
    const prose = [
      '+the retry budget was stale and the entry count wrong in every country',
      '+peaking **79.0%** on 2026-07-29, then falling to zero for eleven days',
      '+the payload is dropped, so the observation never reaches the pipeline',
    ].join('\n');
    expect(count(FIX_PATTERN_RE, prose)).toBe(0);
  });

  it('STILL fires on a genuine code fix — the guard is not merely silent', () => {
    // Positive control. Without this, a regex matching nothing at all would pass above.
    expect(count(FIX_PATTERN_RE, REAL_CODE_FIX_DIFF)).toBeGreaterThan(3);
  });

  it('does not match a keyword embedded in a longer word', () => {
    for (const word of ['retry', 'entry', 'country', 'industry', 'poultry']) {
      expect(count(FIX_PATTERN_RE, `+  const ${word} = 1;`)).toBe(0);
    }
    // ...but the bare keyword still matches.
    expect(count(FIX_PATTERN_RE, '+  try {')).toBe(1);
  });

  it('REMOVED_BROKEN_RE is word-boundaried too', () => {
    expect(count(REMOVED_BROKEN_RE, '-  const dismissal = compute();')).toBe(0); // "miss"
    expect(count(REMOVED_BROKEN_RE, '-  const errorless = 1;')).toBe(0); // "error"
    expect(count(REMOVED_BROKEN_RE, '-  // fix the bug here')).toBe(1);
  });

  it('only matches ADDED lines for fixes and REMOVED lines for breakage', () => {
    expect(count(FIX_PATTERN_RE, '-  try {')).toBe(0);
    expect(count(REMOVED_BROKEN_RE, '+  // fix the bug here')).toBe(0);
  });
});

describe('auto-learning diff scope: documentation is excluded', () => {
  it('excludes markdown and docs/ via git pathspec magic', () => {
    const spec = [...CODE_ONLY_PATHSPEC];
    expect(spec[0]).toBe('--');
    for (const pat of [
      '*.md', '*.markdown', '*.mdx', '*.rst', '*.adoc', '*.txt', 'docs/**', '.massu/**',
    ]) {
      expect(spec).toContain(`:(exclude)${pat}`);
    }
  });

  it('uses pathspec magic rather than an interpolated file list (no argv ceiling)', () => {
    // A filtered file list would grow with the tree and eventually exceed argv limits;
    // pathspec magic is constant-size. Pin the property, not the implementation detail.
    expect(CODE_ONLY_PATHSPEC.length).toBeLessThan(20);
    expect(CODE_ONLY_PATHSPEC.every((s) => typeof s === 'string')).toBe(true);
  });
});
