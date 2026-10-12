/**
 * The auto-learning summary must count the noun it is about to list.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The header read `${sessionFixes.length} bug fix(es) detected:` and then printed one line
 * per DISTINCT FILE. Two different nouns. On 2026-08-19 it reported **"2 bug fix(es)"** and
 * listed **1 file** — the same file edited twice — and its only reader (me) concluded that a
 * finding had been counted and not named, i.e. that a check had aborted, and reported that
 * to the operator as a defect. It was not one.
 *
 * The misreading is the point. This machine's blind-gate law states the corollary directly:
 * *"a counted-but-unprinted finding is a dead check. If a summary says 3 violations and
 * prints 1, two checks aborted. Totals and details that disagree must FAIL LOUDLY."* A
 * header whose arithmetic cannot be reconciled against its own body therefore reads as a
 * broken gate — and a check people learn to distrust is the CR-83 failure, arrived at
 * through presentation rather than logic.
 *
 * `formatFixSummary` was extracted from `main()` for this file. It had NO test and was
 * unreachable from one, which is how a header that contradicts its own body shipped.
 */
import { describe, it, expect } from 'vitest';
import { formatFixSummary } from '../hooks/auto-learning-pipeline.ts';

const header = (lines: string[]): string => lines.find((l) => l.includes('detected')) ?? '';
const bullets = (lines: string[]): string[] => lines.filter((l) => l.trimStart().startsWith('- '));

describe('the header reconciles against its own list', () => {
  it('THE 2026-08-19 REGRESSION: two signals in ONE file says 2 signals across 1 file', () => {
    const lines = formatFixSummary([
      { file: 'packages/core/src/hooks/security-gate.ts', signals: ['method_name_correction'] },
      { file: 'packages/core/src/hooks/security-gate.ts', signals: ['removed_broken_code'] },
    ]);
    expect(header(lines)).toBe('  2 fix signal(s) across 1 file(s) detected during this session:');
    // The bullet count must equal the FILE count in the header — that is the property.
    expect(bullets(lines)).toHaveLength(1);
  });

  it('the file count in the header always equals the number of bullets', () => {
    // Property, not anecdote: several shapes, one invariant.
    const shapes: Array<Array<{ file: string; signals: string[] }>> = [
      [{ file: 'a.ts', signals: ['x'] }],
      [
        { file: 'a.ts', signals: ['x'] },
        { file: 'b.ts', signals: ['y'] },
      ],
      [
        { file: 'a.ts', signals: ['x'] },
        { file: 'a.ts', signals: ['y'] },
        { file: 'b.ts', signals: ['z'] },
      ],
    ];
    for (const fixes of shapes) {
      const lines = formatFixSummary(fixes);
      const declared = /across (\d+) file\(s\)/.exec(header(lines));
      expect(declared, `no file count in header: ${header(lines)}`).not.toBeNull();
      expect(Number(declared?.[1])).toBe(bullets(lines).length);
    }
  });

  it('the signal count in the header equals the number of input signals', () => {
    const lines = formatFixSummary([
      { file: 'a.ts', signals: ['x'] },
      { file: 'a.ts', signals: ['y'] },
      { file: 'b.ts', signals: ['z'] },
    ]);
    expect(header(lines)).toContain('3 fix signal(s)');
  });

  it('signals are de-duplicated within a file but the file still appears once', () => {
    const lines = formatFixSummary([
      { file: 'a.ts', signals: ['x'] },
      { file: 'a.ts', signals: ['x'] },
    ]);
    expect(bullets(lines)).toEqual(['    - a.ts (x)']);
    expect(header(lines)).toContain('across 1 file(s)');
  });

  it('empty input produces NO block at all — not a header with nothing under it', () => {
    // A header over an empty list is the same defect in its purest form.
    expect(formatFixSummary([])).toEqual([]);
  });
});

describe('the old shape is gone', () => {
  it('never emits a bare "N bug fix(es) detected" header', () => {
    // ⛔ MUST-STAY-SILENT. The old wording is what made the count and the list look like the
    // same noun; if it returns, so does the misreading.
    const lines = formatFixSummary([
      { file: 'a.ts', signals: ['x'] },
      { file: 'a.ts', signals: ['y'] },
    ]);
    expect(lines.join('\n')).not.toMatch(/\d+ bug fix\(es\) detected/);
  });
});
