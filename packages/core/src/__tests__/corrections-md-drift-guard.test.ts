// A-09 — corrections.md: ONE format, ONE parser, and every writer's output is readable.
//
// THE BUG: THREE writers in three formats, and a reader that parsed a FOURTH.
//   reader   hooks/session-start.ts        -> a 4-column markdown TABLE
//   writer 1 knowledge-tools.ts            -> `### date - title` + bullets
//   writer 2 rule-candidate-applier.ts     -> `## date: slug` + bullets
// The reader therefore found NOTHING either writer produced. Every prevention rule ever
// written to corrections.md was invisible to the session-start injection whose entire
// purpose is to surface them. A silently-dropped prevention rule is a memory-loss bug.
//
// (A-00 also showed the reader was looking in a directory that DOES NOT EXIST — so
// fixing only the format would have left it dead anyway. Both halves are fixed.)
//
// THE GUARD: a writer's output MUST be parseable by the reader. That is the invariant a
// format agreement actually means, and it is the one nobody was testing.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, basename } from 'path';

import {
  formatCorrectionEntry,
  parseCorrectionRules,
} from '../lib/corrections-md.ts';

const SRC = join(__dirname, '..');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      walk(full, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('corrections.md — one format (A-09 drift-guard)', () => {
  it('ROUND-TRIP: what a writer writes, the reader reads', () => {
    const entry = formatCorrectionEntry({
      date: '2026-07-12',
      title: 'Never guess a referent',
      wrong: 'picked the most recent ADR without asking',
      correction: 'enumerate the candidates and ask',
      rule: 'when more than one candidate exists, ASK — never pick silently',
    });
    expect(parseCorrectionRules(entry)).toEqual([
      'when more than one candidate exists, ASK — never pick silently',
    ]);
  });

  it("the APPLIER's shape (a rule + provenance bullets) round-trips", () => {
    const entry = formatCorrectionEntry({
      date: '2026-07-12',
      title: 'never_guess',
      rule: 'Cite evidence or ask. Never pick a candidate silently.',
      extra: { prompt_hash: 'abc123', score: 9, audit_log_id: 42 },
    });
    expect(parseCorrectionRules(entry)).toEqual([
      'Cite evidence or ask. Never pick a candidate silently.',
    ]);
    expect(entry).toContain('- prompt_hash: abc123'); // provenance preserved
  });

  it('a rule containing a PIPE survives — the old table format shredded its own content', () => {
    // Corrections are exactly where regex alternations, shell pipelines and SQL show up.
    // A markdown table splits on `|`, so the old format was hostile to its own content.
    const rule = 'grep -rE "a|b" src/ | grep -v test — enumerate, do not spot-check';
    const entry = formatCorrectionEntry({ date: '2026-07-12', title: 't', rule });
    expect(parseCorrectionRules(entry)).toEqual([rule]);
  });

  it('a multi-line value is collapsed, not allowed to break the one-bullet-per-fact contract', () => {
    const entry = formatCorrectionEntry({
      date: '2026-07-12',
      title: 't',
      rule: 'line one\nline two\n\nline three',
    });
    expect(parseCorrectionRules(entry)).toEqual(['line one line two line three']);
  });

  it('LEGACY: an old 4-column table file is still read (history is not discarded)', () => {
    const legacy =
      '| Date | Wrong | Correction | Prevention |\n' +
      '|---|---|---|---|\n' +
      '| 2026-01-01 | guessed | asked | ALWAYS ask when ambiguous |\n';
    expect(parseCorrectionRules(legacy)).toEqual(['ALWAYS ask when ambiguous']);
  });

  it('many entries accumulate', () => {
    const a = formatCorrectionEntry({ date: '2026-07-01', title: 'a', rule: 'rule A' });
    const b = formatCorrectionEntry({ date: '2026-07-02', title: 'b', rule: 'rule B' });
    expect(parseCorrectionRules('# Corrections\n' + a + b)).toEqual(['rule A', 'rule B']);
  });

  it('STRUCTURAL: every corrections.md writer goes through the shared formatter', () => {
    // A fourth format is how this broke in the first place.
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      if (basename(f) === 'corrections-md.ts') continue;
      const code = readFileSync(f, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (!/corrections\.md|correctionsMd|correctionsPath/.test(code)) continue;

      const writesEntry = /correctionsEntry|const entry =/.test(code);
      if (writesEntry && !/formatCorrectionEntry/.test(code)) offenders.push(relative(SRC, f));
    }
    expect(
      offenders,
      'A corrections.md writer that does NOT use formatCorrectionEntry — its rules will be ' +
        'invisible to the reader, exactly as before. Offenders',
    ).toEqual([]);
  });

  it('STRUCTURAL: the reader uses the shared parser, not a hand-rolled table scan', () => {
    const hook = readFileSync(join(SRC, 'hooks', 'session-start.ts'), 'utf-8');
    expect(/parseCorrectionRules/.test(hook), 'session-start must use the shared parser').toBe(true);
    expect(
      /cells\[3\]/.test(hook),
      'the hand-rolled 4-column table scan must be gone',
    ).toBe(false);
  });
});
