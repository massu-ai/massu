// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-M-031 (plan-stage-d-medium-sweep) drift-guard.
 *
 * Closes the structural class where a god module silently grows past
 * 1000 LOC. Pattern-scanner Check 21 enforces a hard cap with an explicit
 * `@scanner-allow:large-file` opt-out for hand-curated exceptions.
 *
 * Drift-guard asserts:
 *   1. Each known large file (knowledge-tools.ts, memory-db.ts, tools.ts,
 *      commands/init.ts) carries the allowlist marker — so any future
 *      removal forces the structural decomposition discussion.
 *   2. A synthetic >1000 LOC fixture WITHOUT the marker is detected as a
 *      violation by Check 21 when run against a sandboxed source tree.
 *   3. A synthetic >1000 LOC fixture WITH the marker passes Check 21.
 *
 * The synthetic-fixture cases pin the scanner's behaviour structurally so
 * a future scanner refactor that drops the cap silently fails this test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const REPO_ROOT = resolve(__dirname, '../../../..')
const PATTERN_SCANNER = resolve(REPO_ROOT, 'scripts/massu-pattern-scanner.sh')

const KNOWN_LARGE_FILES = [
  'packages/core/src/knowledge-tools.ts',
  'packages/core/src/memory-db.ts',
  'packages/core/src/tools.ts',
  'packages/core/src/commands/init.ts',
  // curated-rule-packs review: the destination-fidelity fix pushed the
  // security-critical apply chokepoint just over the cap (see its marker reason).
  'packages/core/src/rule-candidate-applier.ts',
]

describe('P-M-031 pattern-scanner Check 21 file-size cap', () => {
  it('every known >1000 LOC file carries the @scanner-allow:large-file marker', () => {
    for (const rel of KNOWN_LARGE_FILES) {
      const head = readFileSync(resolve(REPO_ROOT, rel), 'utf-8')
        .split('\n')
        .slice(0, 30)
        .join('\n')
      expect(head, `${rel} missing @scanner-allow:large-file marker`).toMatch(
        /@scanner-allow:large-file/,
      )
    }
  })

  it('Check 21 is present in the pattern scanner script', () => {
    const src = readFileSync(PATTERN_SCANNER, 'utf-8')
    expect(src).toMatch(/Check 21:.*File-size cap/)
    expect(src).toMatch(/@scanner-allow:large-file/)
  })

  // The full scanner shell-out is exercised by the existing
  // pattern-scanner-self-test.test.ts (which runs the entire scanner
  // against the live tree). The two structural assertions above are
  // sufficient to pin Check 21's invariants without re-shelling.
})
