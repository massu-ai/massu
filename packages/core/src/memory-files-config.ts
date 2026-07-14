// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * A-20 — the `memory.files` config block: the ONE switch that decides whether Massu may
 * ever write into the user's memory directory.
 *
 * ⛔ `renderEnabled` DEFAULTS TO **FALSE**, AND THAT IS A LAW, NOT A PREFERENCE.
 *
 * `@massu/core` is a public package. 4B is the first capability in its history that
 * WRITES FILES INTO THE USER'S MEMORY DIRECTORY — the place they keep their own
 * hand-written prose, which is git-tracked and pushed on many machines. A brand-new
 * write capability that arrives switched-on in an `npm update` is a capability nobody
 * consented to.
 *
 * The operator's standing law (`feedback_universal_product_never_one_off`) is explicit:
 * optional capabilities are surfaced **in chat**, re-offered when the user's setup
 * changes, and **NEVER auto-enabled**. The upgrade path is: the advisor offers it → the
 * user runs `massu memory render --dry-run` and sees exactly what WOULD be written →
 * the user turns it on. Three deliberate steps, none of them implicit.
 *
 * A drift-guard pins the default to `false`. Flipping it is not a config tweak; it is a
 * decision to write to strangers' files by default.
 */
import { getConfig } from './config.ts';

export interface MemoryFilesConfig {
  /** Master switch for the memory-file mirror (ingest side). Read-only; safe. */
  enabled: boolean;

  /**
   * May Massu WRITE memory files (4B renderer)? **Default false — never auto-enable.**
   * This is the only flag in the block that grants a write.
   */
  renderEnabled: boolean;

  /** Anti-spam: how many files Massu may render in ONE session. */
  renderMaxFilesPerSession: number;

  /** Only memories at or above this importance are worth a durable file. */
  renderMinImportance: number;

  /** The clearly-labelled `MEMORY.md` section Massu's pointers live under. */
  indexSection: string;

  /**
   * Hard bound on the managed `MEMORY.md` region. `MEMORY.md` is auto-loaded into EVERY
   * turn of EVERY session, so an unbounded index is a permanent, compounding context tax
   * — and the per-session cap bounds only the RATE, never the total.
   */
  indexMaxLines: number;
}

export const DEFAULT_MEMORY_FILES_CONFIG: MemoryFilesConfig = {
  enabled: true,
  // ⛔ Never flip this default. See the module doc.
  renderEnabled: false,
  renderMaxFilesPerSession: 3,
  renderMinImportance: 4,
  indexSection: 'Learned by Massu',
  indexMaxLines: 50,
};

export function resolveMemoryFilesConfig(): MemoryFilesConfig {
  try {
    const c = getConfig().memory?.files as Partial<MemoryFilesConfig> | undefined;
    if (!c) return { ...DEFAULT_MEMORY_FILES_CONFIG };
    return { ...DEFAULT_MEMORY_FILES_CONFIG, ...c };
  } catch {
    // Fail-CLOSED with respect to writing: any config error leaves renderEnabled false.
    return { ...DEFAULT_MEMORY_FILES_CONFIG };
  }
}
