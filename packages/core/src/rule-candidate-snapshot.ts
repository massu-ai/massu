// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * File snapshot/restore helpers for the rule-candidate applier's atomic-write
 * transaction. Extracted from rule-candidate-applier.ts so that module stays
 * ≤999 LOC (pattern-scanner Check 21; the Phase-3 extraction discipline — a real
 * helper module, not a @scanner-allow marker). Re-exported from the applier so
 * existing import paths are unchanged.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';

/**
 * Snapshot a set of files. `null` value = ABSENT sentinel (file did not
 * exist pre-write). `string` value = pre-write content. Closes the
 * G-015 race class — restoration distinguishes "delete created file"
 * from "rewrite existing file".
 */
export type Snapshot = Map<string, string | null>;

export function takeSnapshots(paths: readonly string[]): Snapshot {
  const out: Snapshot = new Map();
  for (const p of paths) {
    if (existsSync(p)) out.set(p, readFileSync(p, 'utf-8'));
    else out.set(p, null);
  }
  return out;
}

export function restoreSnapshots(snapshot: Snapshot): { errors: string[] } {
  // Tolerate per-file failure so that one un-restorable file (e.g. EACCES
  // on a chmod'd target) doesn't strand the rest of the snapshot. Caller
  // surfaces collected errors via the failure log.
  const errors: string[] = [];
  for (const [path, content] of snapshot) {
    try {
      if (content === null) {
        if (existsSync(path)) unlinkSync(path);
      } else {
        writeFileSync(path, content, 'utf-8');
      }
    } catch (err) {
      errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { errors };
}
