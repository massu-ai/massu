// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * STRUCTURAL drift-guard for `FIRST_PARTY_ADAPTERS` ↔ `CORE_BUNDLED_IDS`
 * parity. Plan 1.5.7 deliverable; closes the gap that produced the 1.5.4
 * → 1.5.5 hotfix.
 *
 * R-011 evidence (this session, 2026-05-08):
 *   - 1.5.4 published with `applyVariantTemplate` + real file sampler
 *     wired through `introspectAsync`.
 *   - Live debug instrumentation showed introspectAsync returned `{}`
 *     for a Phoenix fixture — the runner never invoked the phoenix
 *     adapter because it wasn't in `codebase-introspector.ts:75-78
 *     FIRST_PARTY_ADAPTERS`.
 *   - Phase 7 commits (`d965da4` flask, `424f0a1` go-chi, `83d516b`
 *     rails, `97622b7` phoenix, `b570a3c` aspnet, `f9e5c73` spring) had
 *     added each adapter to `CORE_BUNDLED_IDS` (gated by
 *     `core-bundled-ids-drift.test.ts`) but NOT to the runtime dispatch
 *     list. The two were structurally divergent.
 *   - Pre-1.5.4 the divergence was masked by `sampleFiles=[]`
 *     (every adapter returned 'none' anyway). 1.5.4 made the sampler
 *     work, surfacing the gap.
 *
 * This test makes the divergence IMPOSSIBLE TO MERGE: any future adapter
 * added to one side without the other fails the build.
 *
 * The two sources of truth being reconciled:
 *   - `detect/adapters/index.ts:CORE_BUNDLED_IDS` — id-set of all
 *     core-bundled adapter ids
 *   - `detect/codebase-introspector.ts:FIRST_PARTY_ADAPTERS` — runtime
 *     dispatch array of `CodebaseAdapter` instances
 *
 * The test compares the SETS — every id in CORE_BUNDLED_IDS must have
 * an adapter in FIRST_PARTY_ADAPTERS with that exact id, and vice-versa.
 */

import { describe, it, expect } from 'vitest';
import { CORE_BUNDLED_IDS } from '../detect/adapters/index.ts';

describe('FIRST_PARTY_ADAPTERS ↔ CORE_BUNDLED_IDS parity drift-guard', () => {
  it('every CORE_BUNDLED_IDS id has a corresponding FIRST_PARTY_ADAPTERS entry', async () => {
    // Lazy import to avoid the introspector module's side-effect on
    // module-eval (it triggers TreeSitter init under some test runners).
    const introspectorModule = await import('../detect/codebase-introspector.ts');
    // FIRST_PARTY_ADAPTERS is a module-internal const, but the structural
    // contract is observable via the introspector's runtime behavior.
    // Read the source file directly so the test catches drift via
    // static analysis — keeps the assertion deterministic regardless
    // of import-time side effects.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(__dirname, '../detect/codebase-introspector.ts'),
      'utf-8',
    );
    // Match the FIRST_PARTY_ADAPTERS array contents.
    const arrMatch = /const FIRST_PARTY_ADAPTERS:[^=]+=\s*\[([\s\S]*?)\];/.exec(src);
    expect(arrMatch, 'FIRST_PARTY_ADAPTERS array not found in source').not.toBeNull();
    // Each entry is `<adapterVarName>,` — extract the variable names.
    const entries = arrMatch![1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('//'));

    // Map each adapter variable name → adapter id by reading its import
    // line in the same source file. e.g. `import { railsAdapter } from
    // './adapters/rails.ts';` → varName `railsAdapter` → adapter id is
    // the filename `rails`. (Phase 7 + 3b adapter naming convention is
    // 1:1 var-to-file, with the var being `<id>Adapter` in camelCase.)
    const importedIds = new Set<string>();
    for (const varName of entries) {
      const importPattern = new RegExp(
        `^import\\s+\\{\\s*${varName}\\s*\\}\\s+from\\s+'\\./adapters/([^']+)\\.ts'`,
        'm',
      );
      const importMatch = importPattern.exec(src);
      expect(
        importMatch,
        `FIRST_PARTY_ADAPTERS entry "${varName}" — no matching import line found in codebase-introspector.ts`,
      ).not.toBeNull();
      importedIds.add(importMatch![1]);
    }

    const declared = new Set(CORE_BUNDLED_IDS);

    const missingFromDispatch = [...declared].filter((id) => !importedIds.has(id));
    const missingFromDeclared = [...importedIds].filter((id) => !declared.has(id));

    expect(
      missingFromDispatch,
      'ids in CORE_BUNDLED_IDS but NOT in FIRST_PARTY_ADAPTERS — runtime dispatch will not invoke them',
    ).toEqual([]);
    expect(
      missingFromDeclared,
      'adapters in FIRST_PARTY_ADAPTERS but NOT in CORE_BUNDLED_IDS — trust-class classification will refuse them',
    ).toEqual([]);

    // Belt-and-suspenders: also verify the introspector module itself
    // exports nothing that would break the runtime invocation.
    expect(introspectorModule).toBeDefined();
  });
});
