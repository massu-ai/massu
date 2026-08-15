// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * THE LEDGER PARSER MIS-MAPPED EVERY COLUMN OF A 5-COLUMN TABLE (2026-08-11).
 *
 * `parseLedger` destructured POSITIONALLY behind a length FLOOR:
 *
 *     if (cells.length < 4) continue;
 *     const [claim, command, output, verdict] = cells;
 *
 * A table with an extra leading column (`#`, `Type`) shifted every field one place, so
 * `verdict` read the OUTPUT cell and `command` read the header text. The header row was no
 * longer skipped either, because the header check tested cell[0] — now `#`, not `Claim`.
 *
 * MEASURED before the fix, across 666 tracked markdown files / 25 with a CLAIM LEDGER:
 *   99 of 490 parsed rows were mis-mapped, in 5 tracked plans.
 *   docs/plans/2026-07-22-windows-node-bootstrap-layer2.md scored 0 of 22 rows
 *   substantive — a full ledger of evidenced claims validating NOTHING while looking
 *   complete. Its coverage was restored to 14.
 *
 * The parser now binds columns BY HEADER NAME (the table declares its schema; the parser
 * asks), with a positional fallback for canonical 4-cell rows so the change can only ever
 * ADD correctly-mapped rows. Proven per-file against the pre-fix parser: 4 files improved,
 * 21 unchanged, 0 regressions.
 *
 * CR-72: these attack the parser rather than read it. A header-only first draft silently
 * dropped 47 rows from two plans whose header says "Verbatim output" — caught by
 * re-measuring, not by reading the diff (G10).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { join } from 'path';

const require = createRequire(import.meta.url);
const REPO = join(__dirname, '..', '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const detect = require(join(REPO, 'scripts/lib/claim-ledger-detect.mjs')) as {
  parseLedger: (t: string) => Array<{ claim: string; command: string; output: string; verdict: string }>;
  rowIsSubstantive: (r: { claim: string; command: string; output: string; verdict: string }) => boolean;
};

const ledger = (body: string) => `## CLAIM LEDGER\n\n${body}\n`;

describe('claim-ledger column binding', () => {
  it('maps a canonical 4-column table', () => {
    const rows = detect.parseLedger(
      ledger(
        '| Claim | Command | Output | Verdict |\n' +
          '|---|---|---|---|\n' +
          '| X is the only Y | `ls x` | `x` | **CONFIRMED** |',
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toBe('`ls x`');
    expect(rows[0].verdict).toBe('**CONFIRMED**');
    expect(detect.rowIsSubstantive(rows[0])).toBe(true);
  });

  it('maps a 5-column table with a leading index column — the shipped defect', () => {
    // RED before the fix: verdict read '`x`' (the OUTPUT) and command read the Type cell,
    // so rowIsSubstantive() was false and a standing REFUTED was invisible.
    const rows = detect.parseLedger(
      ledger(
        '| # | Claim (verbatim) | Verification command | Pasted output | Verdict |\n' +
          '|---|---|---|---|---|\n' +
          '| C-1 | X is the only Y | `ls x` | `x` | **CONFIRMED** |',
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toBe('`ls x`');
    expect(rows[0].output).toBe('`x`');
    expect(rows[0].verdict).toBe('**CONFIRMED**');
    expect(detect.rowIsSubstantive(rows[0])).toBe(true);
  });

  it('accepts the "Verbatim output" header shape used by tracked plans', () => {
    // A prefix-anchored matcher missed this and silently returned 0 rows for two plans.
    const rows = detect.parseLedger(
      ledger(
        '| Claim (verbatim) | Verification command | Verbatim output | Verdict |\n' +
          '|---|---|---|---|\n' +
          '| X is the only Y | `ls x` | `x` | **CONFIRMED** |',
      ),
    );
    expect(rows).toHaveLength(1);
    expect(detect.rowIsSubstantive(rows[0])).toBe(true);
  });

  it('never emits the header or separator as a data row', () => {
    const rows = detect.parseLedger(
      ledger(
        '| # | Claim | Command | Output | Verdict |\n' +
          '|---|---|---|---|---|\n' +
          '| C-1 | a | `c` | `o` | **CONFIRMED** |',
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows.some((r) => /^claim/i.test(r.claim) || r.claim === '#')).toBe(false);
  });

  it('surfaces a standing REFUTED in a 5-column table (it was invisible before)', () => {
    const rows = detect.parseLedger(
      ledger(
        '| # | Claim | Command | Output | Verdict |\n' +
          '|---|---|---|---|---|\n' +
          '| C-1 | a | `c` | `o` | **REFUTED** |',
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toMatch(/REFUTED/);
    expect(detect.rowIsSubstantive(rows[0])).toBe(true);
  });

  it('falls back to positional for a headerless canonical table (no regression)', () => {
    const rows = detect.parseLedger(
      ledger('| X is the only Y | `ls x` | `x` | **CONFIRMED** |'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('**CONFIRMED**');
  });

  it('does not invent rows from a table with fewer than four cells', () => {
    expect(detect.parseLedger(ledger('| a | b | c |'))).toHaveLength(0);
  });
});
