/**
 * Drift-guard for CORE_BUNDLED_IDS (Plan 3c Phase 5 — Rule 0 drift-prevention).
 *
 * A new first-party adapter file added to detect/adapters/ without updating
 * detect/adapters/index.ts:CORE_BUNDLED_IDS makes the loader silently fail
 * to classify it as core-bundled. This test fails on filesystem-vs-set drift
 * so the divergence is impossible to merge.
 *
 * To fix a failing run:
 *  1. If you ADDED a new adapter file (e.g. detect/adapters/foo.ts), append
 *     'foo' to CORE_BUNDLED_IDS in detect/adapters/index.ts.
 *  2. If you renamed a support file, append it to ADAPTER_SUPPORT_FILES in
 *     detect/adapters/index.ts so it's excluded from the comparison.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CORE_BUNDLED_IDS,
  ADAPTER_SUPPORT_FILES,
} from '../detect/adapters/index.js';

describe('CORE_BUNDLED_IDS drift-guard', () => {
  it('matches filesystem state of detect/adapters/*.ts', () => {
    const dir = resolve(__dirname, '../detect/adapters');
    const filesystemIds = new Set<string>();
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.ts')) continue;
      if (ADAPTER_SUPPORT_FILES.has(entry)) continue;
      // Adapter file naming convention: <id>.ts. Strip the extension.
      filesystemIds.add(entry.slice(0, -'.ts'.length));
    }

    const declared = new Set(CORE_BUNDLED_IDS);

    const missingFromDeclared = [...filesystemIds].filter((id) => !declared.has(id));
    const missingFromFilesystem = [...declared].filter((id) => !filesystemIds.has(id));

    expect(missingFromDeclared, 'adapters added to filesystem but not declared in CORE_BUNDLED_IDS').toEqual([]);
    expect(missingFromFilesystem, 'ids declared in CORE_BUNDLED_IDS but not present on filesystem').toEqual([]);
  });
});
