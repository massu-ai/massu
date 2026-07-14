// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * THE GOLDEN PATH'S QUALITY SUBSYSTEMS MUST EXIST *AND* BE INVOKED.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * Commit `8fff05d` — message: "CR-45 zero-tolerance mandate — fix ALL issues at ALL severity
 * levels", listing only ADDITIONS — silently DELETED three quality subsystems from the golden
 * path: the sprint contracts (2A.5), the QA evaluator (2C), and VR-VISUAL's weighted scoring.
 * The spec files kept shipping to every user. Nothing invoked them. Every golden-path run since
 * has implemented against no agreed definition of done and accepted its own work with no
 * adversarial check.
 *
 * A fourth, `phase-5.5-production-verify.md`, was NEVER wired at all — shipped in v0.6.0 and
 * linked by nothing, ever (`git log -S` over massu-golden-path.md finds no commit that added it).
 * Its own first line reads: *"A feature is NOT complete until it is verified working in production
 * with real data. 'Deployed' and 'working' are two completely different things."* The phase that
 * would have caught "we shipped it but never checked it worked" was itself shipped and never
 * checked.
 *
 * WHY THE ORPHAN GUARD IS NOT ENOUGH — and this is the whole point
 * ---------------------------------------------------------------
 * `no_orphaned_reference.py` asks "does every reference file have a link?". Delete the four spec
 * files and it goes GREEN — proven by execution:
 *
 *     $ rm commands/massu-golden-path/references/{qa-evaluator-spec,sprint-contract-protocol,\
 *           vr-visual-calibration,phase-5.5-production-verify}.md
 *     $ no_orphaned_reference.py --root .
 *     no-orphaned-reference: OK — all 25 reference file(s) are linked.   exit=0
 *
 * DESTROYING THE ARTIFACT REMOVES THE DRIFT. That is the same defect as the v4 plan's VR-P6, which
 * would have gone green on the destruction of 336 lines of work. A check a deletion can satisfy is
 * not a check.
 *
 * So this test asserts the conjunction that deletion CANNOT satisfy:
 *   (1) the spec file EXISTS and is non-trivial, AND
 *   (2) the golden path LINKS it, AND
 *   (3) the golden path INVOKES it — the phase that uses it is present by name.
 *
 * Delete the file  -> (1) fails.
 * Delete the link  -> (2) fails.
 * Delete the phase -> (3) fails.
 * There is no move that makes this green while the subsystem is dead.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const CORE = resolve(__dirname, '../..');
const GOLDEN_PATH = resolve(CORE, 'commands/massu-golden-path.md');
const REFS = resolve(CORE, 'commands/massu-golden-path/references');

/**
 * Each subsystem: its spec file, the link the golden path must carry, and the PHASE that must
 * invoke it. The phase marker is what makes deletion insufficient — a link in a table is not an
 * invocation.
 */
const SUBSYSTEMS = [
  {
    name: 'Sprint contracts (2A.5) — agree definition-of-done BEFORE implementing',
    spec: 'sprint-contract-protocol.md',
    link: 'references/sprint-contract-protocol.md',
    invokedBy: /\*\*2A\.5\*\*/,
    invocationDesc: 'Phase 2A.5 in the sub-phase list',
    killedBy: '8fff05d (silent deletion)',
  },
  {
    name: 'QA evaluator (2C) — adversarial acceptance testing against the sprint contracts',
    spec: 'qa-evaluator-spec.md',
    link: 'references/qa-evaluator-spec.md',
    invokedBy: /\*\*QA evaluator\*\*/,
    invocationDesc: 'the QA evaluator named in Phase 2C',
    killedBy: '8fff05d (silent deletion)',
  },
  {
    name: 'VR-VISUAL weighted scoring — 4 dimensions, threshold >= 3.0',
    spec: 'vr-visual-calibration.md',
    link: 'references/vr-visual-calibration.md',
    invokedBy: /VR-VISUAL uses weighted 4-dimension scoring/,
    invocationDesc: 'VR-VISUAL weighted scoring stated in Phase 2.5',
    killedBy: '8fff05d (silent deletion)',
  },
  {
    name: 'Production verification (5.5) — "deployed" and "working" are different things',
    spec: 'phase-5.5-production-verify.md',
    link: 'references/phase-5.5-production-verify.md',
    invokedBy: /##\s*PHASE 5\.5:\s*PRODUCTION VERIFICATION/i,
    invocationDesc: 'the PHASE 5.5 heading',
    killedBy: 'never wired — shipped in v0.6.0, linked by nothing, ever',
  },
  {
    name: 'Deep security audit (3.5) — adversarial red-team loop, NEVER skipped',
    spec: 'phase-3.5-security-audit.md',
    link: 'references/phase-3.5-security-audit.md',
    invokedBy: /##\s*PHASE 3\.5:\s*DEEP SECURITY AUDIT/i,
    invocationDesc: 'the PHASE 3.5 heading',
    // The worst of the lot. It SHIPPED in v0.6.1, was GONE by v1.0.0, and exists in NO commit in
    // this repository's history. Every version from 1.0.0 to 1.15.5 ran the golden path with no
    // security audit phase at all. The only surviving copy on the machine was in a consumer repo
    // that had committed its installed commands in April.
    //
    // THE REASON IT SURVIVED UNDETECTED: the reference-link guard asks "does every reference file
    // have a link?" — and a file DELETED OUTRIGHT has no link to be missing. A check that only
    // sees BROKEN things is structurally blind to ABSENT ones. That is the same defect as a
    // scanner reporting CLEAN because it scanned zero files, and it is why assertion (1) of this
    // suite — the file must EXIST — is not redundant with the link check. It is the whole point.
    killedBy: 'DELETED ENTIRELY between v0.6.1 and v1.0.0 — in no commit, in no changelog',
  },
] as const;

describe('golden path: the quality subsystems must EXIST and be INVOKED (not merely present)', () => {
  it('the golden path itself exists and is substantial (anti-vacuity: a scan of nothing is not a pass)', () => {
    expect(existsSync(GOLDEN_PATH)).toBe(true);
    const body = readFileSync(GOLDEN_PATH, 'utf-8');
    expect(body.length).toBeGreaterThan(2000);
  });

  for (const s of SUBSYSTEMS) {
    describe(s.name, () => {
      it(`(1) the spec file SHIPS — ${s.spec}`, () => {
        const p = resolve(REFS, s.spec);
        expect(existsSync(p), `${s.spec} is GONE. Killed by: ${s.killedBy}`).toBe(true);
        // Non-trivial: an empty file passes an existence check and protects nothing.
        expect(readFileSync(p, 'utf-8').trim().length).toBeGreaterThan(200);
      });

      it(`(2) the golden path LINKS it — ${s.link}`, () => {
        const body = readFileSync(GOLDEN_PATH, 'utf-8');
        expect(
          body.includes(s.link),
          `massu-golden-path.md does not link ${s.link}. The spec ships to every user and ` +
            'nothing points at it — it is dead weight in the package.',
        ).toBe(true);
      });

      it(`(3) the golden path INVOKES it — ${s.invocationDesc}`, () => {
        const body = readFileSync(GOLDEN_PATH, 'utf-8');
        expect(
          s.invokedBy.test(body),
          `The link exists but the subsystem is NOT INVOKED: ${s.invocationDesc} is missing from ` +
            'massu-golden-path.md. A row in a reference table is not an invocation. This is ' +
            'exactly how the subsystem died the first time — the file stayed, the phase left.',
        ).toBe(true);
      });
    });
  }

  it('the gap analyzer covers sprint-contract compliance (its 7th category — deleted with the contracts)', () => {
    // 8fff05d cut the loop from 7 categories to 6, dropping "sprint contract compliance". Without
    // it the loop can report ZERO gaps while the work misses the definition of done it was built
    // against — a green light from a check that stopped looking at the thing that matters.
    const body = readFileSync(GOLDEN_PATH, 'utf-8');
    expect(body).toMatch(/7 categories/i);
    expect(body.toLowerCase()).toContain('sprint-contract compliance');
  });

  it('ANTI-VACUITY: this suite cannot be satisfied by DELETING the subsystems', () => {
    // The orphan guard CAN be. Proven: rm the four spec files, and `no_orphaned_reference.py`
    // reports "OK — all 25 reference file(s) are linked", exit 0. Destroying the artifact removes
    // the drift.
    //
    // This suite cannot, because assertion (1) requires the file to EXIST. The three assertions
    // are a conjunction over independent failure modes:
    //     delete the file  -> (1) red
    //     delete the link  -> (2) red
    //     delete the phase -> (3) red
    // There is no deletion that turns this green while the subsystem is dead. That property is
    // the entire reason this file exists, so it is asserted rather than assumed.
    for (const s of SUBSYSTEMS) {
      expect(existsSync(resolve(REFS, s.spec))).toBe(true);   // (1)
    }
    const body = readFileSync(GOLDEN_PATH, 'utf-8');
    for (const s of SUBSYSTEMS) {
      expect(body.includes(s.link)).toBe(true);               // (2)
      expect(s.invokedBy.test(body)).toBe(true);              // (3)
    }
  });
});
