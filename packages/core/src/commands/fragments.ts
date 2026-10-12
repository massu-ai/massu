// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P4.3b — fragment resolution for the `{{> name}}` directive.
 *
 * Extracted from `install-commands.ts` rather than left inline: that file crossed the
 * pattern scanner's 1000-LOC cap the moment this landed, and a resolver is a distinct
 * concern from a directory sync in any case. Same reasoning that moved the shipped-template
 * schema out of `config.ts`.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { Config } from '../config.ts';
import { pickVariant, resolveAssetDir } from './asset-resolution.ts';

/**
 * P4.3b-2 — resolve a `{{> name}}` fragment for the customer's declared stack.
 *
 * Delegates to `pickVariant`, which already implements the specific→generic→default chain
 * (`<lang>-<framework>` → `<lang>` → unsuffixed) in the declared-language priority order.
 * That chain has a name in the wider world — RFC 4647 lookup semantics, the same rule i18n
 * libraries use to fall back `fr-CA` → `fr` → default — and this repo arrived at it
 * independently. Reusing it rather than writing a second resolver is the whole point:
 * a fragment and a file variant must agree about which stack a customer is.
 *
 * VERIFIED BY ENUMERATION before relying on it (CLAIM LEDGER row P4.3b-D2): every
 * filesystem call inside `pickVariant` is `resolve(sourceDir, …)` or `existsSync`, and it
 * references no asset-tree symbol, so pointing it at `fragments/` is sound.
 *
 * ⛔ RETURNS null RATHER THAN THROWING when nothing resolves. The engine turns that into a
 * visible diagnostic and the asset still installs (D5). Throwing would reach
 * `install-commands.ts`'s catch, become `stats.skipped++` and exit 0 — a silently absent
 * asset, the exact failure this plan exists to end.
 */
export interface FragmentStats {
  /** A stack-specific variant was found. */
  resolved: number;
  /** No variant; the shared default was used. */
  defaulted: number;
  /** Neither — the asset rendered a diagnostic in its place. */
  missing: number;
}

export function makeFragmentResolver(
  framework: Config['framework'],
  stats: FragmentStats,
): (name: string) => string | null {
  const fragmentsDir = resolveAssetDir('fragments');
  return (name: string): string | null => {
    if (!fragmentsDir) {
      stats.missing++;
      return null;
    }
    const choice = pickVariant(name, fragmentsDir, framework);
    if (choice.kind !== 'hit') {
      stats.missing++;
      return null;
    }
    const file = resolve(fragmentsDir, `${name}${choice.suffix}.md`);
    if (!existsSync(file)) {
      // pickVariant said hit, so this is a race or a broken tree — an ERROR state, not an
      // empty one. Counted as missing so the denominator still reports it (M2).
      stats.missing++;
      return null;
    }
    if (choice.suffix === '') stats.defaulted++;
    else stats.resolved++;
    return readFileSync(file, 'utf-8');
  };
}
