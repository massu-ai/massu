/**
 * Two detectors that could not see what they were judging.
 *
 * 1. `method_name_correction` claimed to detect a method rename. It compared the FIRST
 *    removed `.method(` against the FIRST added `.method(` anywhere in the diff — two lines
 *    with no relationship — so it fired on nearly any diff touching code. Measured over 250
 *    commits repo-wide: **29 firings (12%)**, while a predicate requiring the two lines to
 *    be identical but for the method name fires **0** times. Eleven read by hand: not one
 *    was a rename. RETIRED rather than repaired, because a correct version fires zero times
 *    here — repairing it buys a branch that never runs.
 *
 * 2. `hasPreventionSection` required `##` IMMEDIATELY followed by "Prevention", so
 *    `## 6. Prevention Rules` — the house style in this corpus — could not match, and the
 *    hook demanded a section from documents that already had one.
 *
 * Both put noise on the RETRO PIPELINE, which is the one banner that must not cry wolf: a
 * gate that fires on compliant work gets disabled, and then nothing is enforced (CR-72/CR-83).
 */
import { describe, it, expect } from 'vitest';
import { FIX_HEURISTICS } from '../hooks/fix-detector.ts';
import { hasPreventionSection } from '../hooks/incident-pipeline.ts';
import { AutoLearningConfigSchema } from '../config.ts';

describe('method_name_correction is retired', () => {
  it('is gone from the heuristic table', () => {
    expect(FIX_HEURISTICS.map((h) => h.name)).not.toContain('method_name_correction');
  });

  it('the diffs it used to fire on now produce NO signal from it', () => {
    // Real pairs it matched, taken from the 250-commit measurement.
    const diffs = [
      '-  lines.push(x)\n+  if (a.includes(b)) {}\n',
      '-  const x = p.trim()\n+  const y = JSON.stringify(z)\n',
      '-  await Promise.all(t)\n+  const r = process.cwd()\n',
    ];
    for (const d of diffs) {
      const fired = FIX_HEURISTICS.filter((h) => h.test(d)).map((h) => h.name);
      expect(fired).not.toContain('method_name_correction');
    }
  });

  it('the OTHER heuristics are untouched — a retirement must not be a purge', () => {
    // ⛔ NEGATIVE CONTROL. Deleting the whole table would satisfy every assertion above.
    const names = FIX_HEURISTICS.map((h) => h.name);
    for (const kept of [
      'removed_broken_code',
      'added_error_handling',
      'auth_fix',
      'nil_handling_fix',
      'concurrency_fix',
    ]) {
      expect(names).toContain(kept);
    }
    expect(names).toHaveLength(5);
  });
});

describe('async_pattern_fix and added_missing_import are retired', () => {
  // Retired 2026-08-20 on the same measurement that retired `method_name_correction`:
  // ZERO firings across 250 commits (0/87 on commits touching non-test source). Their tokens
  // are largely foreign to a TypeScript monorepo — `@MainActor` is Swift, `async with` is
  // Python — and `added_missing_import` additionally requires added imports with NO removed
  // import anywhere in the diff, which any edit touching an import block violates.
  it('are gone from the heuristic table', () => {
    const names = FIX_HEURISTICS.map((h) => h.name);
    expect(names).not.toContain('async_pattern_fix');
    expect(names).not.toContain('added_missing_import');
  });

  it('a diff of the shape they targeted now produces NO signal from them', () => {
    const asyncDiff = '-  old()\n+  async with session.get(url) as r:\n';
    const importDiff = '+import { readFileSync } from "node:fs";\n+const x = 1;\n';
    for (const d of [asyncDiff, importDiff]) {
      const fired = FIX_HEURISTICS.filter((h) => h.test(d)).map((h) => h.name);
      expect(fired).not.toContain('async_pattern_fix');
      expect(fired).not.toContain('added_missing_import');
    }
  });
});

describe('every heuristic alternative is word-bounded', () => {
  // 2026-08-20. SECOND occurrence of the detector-precision class; the first was
  // `method_name_correction` (retired above, 0/29 precision). The first occurrence shipped a
  // measurement and a retirement; a recurrence is what obligates a MECHANISM, and this is it.
  //
  // The alternatives were unanchored substrings, so they matched inside ordinary English words
  // in a codebase whose comments discuss its own machinery constantly. Real matched lines,
  // taken from the 250-commit measurement — every one a comment, none of them code.
  const fire = (d: string) => FIX_HEURISTICS.filter((h) => h.test(d)).map((h) => h.name);

  it('auth_fix does not fire on "author", "authoring" or GIT_AUTHOR_DATE', () => {
    for (const line of [
      '+ // — was unreachable, and the duplicate was the only thing in effect. Two authoring',
      '+# 2026-08-04, a commit titled "base" authored by `t <t@t>` in a private repository',
      '+# GIT_AUTHOR_DATE / GIT_COMMITTER_DATE set commit METADATA, not the target repository.',
      '+ * the authority for this value lives in the config, not the caller',
    ]) {
      expect(fire(line), line).not.toContain('auth_fix');
    }
  });

  it('concurrency_fix does not fire on "block", "clock" or "corporate_limits"', () => {
    for (const line of [
      '+ * skip an ACTION REQUIRED block, which is the one block that must stay un-skippable',
      '+/** Upper plausibility slack: an index may be stamped slightly ahead by clock skew. */',
      '+# Comment syntax by extension. Only line comments are stripped: a literal inside a block',
      '+  const corporate_limits = readLimits();',
    ]) {
      expect(fire(line), line).not.toContain('concurrency_fix');
    }
  });

  it('⛔ NEGATIVE CONTROL — the real signals STILL fire', () => {
    // Without this, deleting the predicates outright would pass every assertion above. A
    // boundary fix must narrow what matches, never blind the detector.
    expect(fire('+  const token = await getToken();')).toContain('auth_fix');
    expect(fire('+  headers.set("Authorization", `Bearer ${t}`);')).toContain('auth_fix');
    expect(fire('+  await mutex.acquire();')).toContain('concurrency_fix');
    expect(fire('+  const timeout = 3000;')).toContain('concurrency_fix');
    expect(fire('+  rate-limit: 100\n')).toContain('concurrency_fix');
    expect(fire('+  rate_limit = 100\n')).toContain('concurrency_fix');
  });

  it('plurals survive the boundary — "tokens" and "credentials" are still auth', () => {
    // `\b(token|…)s?\b` — a naive `\b…\b` would have dropped these, which is a silent
    // narrowing wearing a precision fix's clothes.
    expect(fire('+  const tokens = parseTokens(x);')).toContain('auth_fix');
    expect(fire('+  const credentials = load();')).toContain('auth_fix');
  });

  it('added_error_handling no longer double-counts a nil check', () => {
    // `if.*nil` / `if.*None` were dropped because `nil_handling_fix` already matches that
    // shape. The nil diff must still be SEEN — by the heuristic that owns it.
    const nilDiff = '-  old()\n+  if x is not None:\n+    y = 1\n+  if z is None:\n+    w = 2\n';
    expect(fire(nilDiff)).toContain('nil_handling_fix');
    expect(fire(nilDiff)).not.toContain('added_error_handling');
  });

  it('the >2 threshold on added_error_handling is unchanged', () => {
    const two = '+  try:\n+    catch\n';
    const three = '+  try {\n+  } catch (e) {\n+    throw e;\n';
    expect(fire(two)).not.toContain('added_error_handling');
    expect(fire(three)).toContain('added_error_handling');
  });
});

describe('the enabled-signal list has ONE authoring site', () => {
  it('the config schema supplies NO default list, so the heuristics define themselves', () => {
    // The schema carried a hand-typed copy of all eight names while fix-detector.ts already
    // read `config…signals ?? FIX_HEURISTICS.map(h => h.name)`. Because zod ALWAYS
    // materialised the default, that correct fallback was unreachable — and retiring a
    // heuristic at one site left a dead entry in the other, silently (CR-74).
    const parsed = AutoLearningConfigSchema.parse({});
    expect(parsed.fixDetection?.signals).toBeUndefined();
  });

  it('an explicit list still overrides — the override was the only configured behaviour', () => {
    const parsed = AutoLearningConfigSchema.parse({ fixDetection: { signals: ['auth_fix'] } });
    expect(parsed.fixDetection?.signals).toEqual(['auth_fix']);
  });
});

describe('a numbered heading is still a heading', () => {
  it('accepts the corpus house style', () => {
    for (const h of ['## 6. Prevention Rules', '## 1) Prevention', '## 12. Rules']) {
      expect(hasPreventionSection(`# T\n\n${h}\n\n1. do the thing\n`), h).toBe(true);
    }
  });

  it('still accepts the unnumbered forms it always did — the fix must not narrow', () => {
    for (const h of ['## Prevention Rules', '## Prevention', '## rules']) {
      expect(hasPreventionSection(`# T\n\n${h}\n\n1. do the thing\n`), h).toBe(true);
    }
  });

  it('a document with no such section is still reported', () => {
    expect(hasPreventionSection('# T\n\n## What happened\n\nprose\n')).toBe(false);
  });

  it('does not match a lookalike heading', () => {
    // `\b` — `## Rulesets` is a different section.
    expect(hasPreventionSection('# T\n\n## Rulesets\n\nprose\n')).toBe(false);
  });

  it('does not match mid-line prose or a fenced example', () => {
    // `^` with `m`. Without the anchor, prose QUOTING the heading satisfies the check —
    // which is the same read-discussion-as-the-thing defect one layer up.
    expect(hasPreventionSection('# T\n\nsee the ## Prevention Rules section elsewhere\n')).toBe(false);
    expect(hasPreventionSection('# T\n\ntext `## Prevention Rules` inline\n')).toBe(false);
  });
});
