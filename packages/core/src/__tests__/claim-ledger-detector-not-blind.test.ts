// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * THE ANTI-BLIND-GATE GATE WAS ITSELF A BLIND GATE (2026-07-14).
 *
 * `claim-ledger-detect.mjs` skipped any line starting with `|` or `>`:
 *
 *     if (t.startsWith('>')) return true;   // blockquote
 *     if (t.startsWith('|')) return true;   // table row
 *
 * So **the gate could not see a claim written in a markdown table or a blockquote.** The
 * same sentence, both ways:
 *
 *     as prose      -> 1 claim detected
 *     as table cell -> 0 claims detected
 *
 * Any plan could therefore pass Check 41 by writing its claims in a table — and one did.
 * A 482-line plan whose entire load-bearing content lived in tables (a findings table, a
 * dead-function table, a tier table) was certified **GREEN** while asserting things that
 * were false. Fixing the detector took the repo from **1 failing plan to 4**: three plans
 * had been passing while making unverified claims, invisibly.
 *
 * It was found by an adversarial auditor who **ran the detector** instead of reading it.
 * Reading it would never have found this: the code looked deliberate, and the comment
 * said `// table row (incl. the ledger itself)` — a correct-sounding reason for a hole
 * that swallowed the whole gate.
 *
 * CR-72: a gate you have not attacked is decoration. These tests attack it.
 */

import { describe, it, expect } from 'vitest';
import { detectClaims } from '../../../../scripts/lib/claim-ledger-detect.mjs';

// A real universal claim — the exact shape the gate exists to catch.
const CLAIM = 'The knowledge graph is the only store that is not per-account.';

describe('the claim-ledger detector is not blind to markdown containers', () => {
  it('sees a claim written as PROSE (the case that always worked)', () => {
    expect(detectClaims(CLAIM).length).toBeGreaterThan(0);
  });

  it('MUTATION: sees a claim hidden in a TABLE CELL (the hole that made the gate decoration)', () => {
    // Before the fix this returned 0 — and a 482-line plan passed the gate on it.
    expect(detectClaims(`| F-X | ${CLAIM} | some fix |`).length).toBeGreaterThan(0);
  });

  it('MUTATION: sees a claim hidden in a BLOCKQUOTE', () => {
    expect(detectClaims(`> ${CLAIM}`).length).toBeGreaterThan(0);
    expect(detectClaims(`> > ${CLAIM}`).length).toBeGreaterThan(0);
  });

  it('still SKIPS the CLAIM LEDGER’s own rows — they are evidence, not claims', () => {
    // The ledger quotes each claim verbatim. If the detector flagged its own rows, the
    // gate would be unpassable — which is as useless as a gate nothing fails.
    const ledger = [
      '## CLAIM LEDGER',
      '| Claim (verbatim) | Verification command | Pasted output | Verdict |',
      '|---|---|---|---|',
      `| ${CLAIM} | ran the enumeration | 6 stores, 5 per-account | CONFIRMED |`,
    ].join('\n');
    expect(detectClaims(ledger)).toHaveLength(0);
  });

  it('a NEW heading ends the ledger section — claims after it are visible again', () => {
    const doc = [
      '## CLAIM LEDGER',
      `| ${CLAIM} | cmd | out | CONFIRMED |`,
      '',
      '## Phase 1',
      CLAIM, // back in prose, outside the ledger — must be seen
    ].join('\n');
    expect(detectClaims(doc).length).toBeGreaterThan(0);
  });

  it('still skips code fences and table separator rows (no false positives)', () => {
    expect(detectClaims(['```', CLAIM, '```'].join('\n'))).toHaveLength(0);
    expect(detectClaims('|---|---|---|')).toHaveLength(0);
  });
});
