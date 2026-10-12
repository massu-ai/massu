// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Asset RESOLUTION — which bundled file, for which stack.
 *
 * Extracted from `install-commands.ts` so that the installer and every other consumer of a
 * bundled asset answer "which file?" with the SAME code rather than each deriving it.
 *
 * ⛔ WHY THE EXTRACTION, and not a re-export shim. `massu show-template <name>` is documented
 * — by the installer itself, at the local-edit-protection message — as the right-hand side of
 *
 *     diff .claude/commands/<name>.md <(npx massu show-template <name>)
 *
 * It re-derived variant selection from `pickVariant` by hand, including its own copy of the
 * suffix→filename rule. Two derivations of one answer is a divergence waiting for whichever
 * one nobody updates, and the failure is silent because BOTH still produce a file.
 *
 * This module holds the single answer. `asset-render.ts` holds the single answer to "and what
 * bytes does it become". Neither imports the installer, so the cycle `install-commands` ↔
 * `fragments` that P4.3b introduced is gone as well.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Config } from '../config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Directory Resolution
// ============================================================

/**
 * Resolve the path to a bundled asset directory.
 * Handles both npm-installed and local development scenarios.
 */
/**
 * An asset dir is only a HIT if it actually CONTAINS assets.
 *
 * CR-65 — BROKEN AND EMPTY MAY NEVER RENDER IDENTICALLY.
 *
 * `existsSync(dir)` was the entire test, and it is the wrong question. Running from source,
 * `__dirname` is `src/commands/`, so candidate 2 — `resolve(__dirname, '..', 'commands')` —
 * resolves to `src/commands` ITSELF: a directory that exists, contains only `.ts`, and holds
 * ZERO installable assets. The resolver returned it, the installer walked it, found nothing to
 * do, and reported success with `installed: 0`.
 *
 *     "I found no commands to install"   and   "I looked in the wrong directory"
 *
 * were byte-identical. A resolver that CANNOT SEE passed as a resolver that FOUND NOTHING —
 * which is the mechanism behind every bug in this codebase's silent-failure class.
 *
 * So a candidate must prove it holds assets. If none does, we return null and the caller FAILS
 * LOUD rather than quietly installing nothing.
 */
function dirHoldsAssets(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some(
      (e) => e.endsWith('.md') || statSync(resolve(dir, e)).isDirectory(),
    );
  } catch {
    // Unreadable is NOT empty. Refuse it.
    return false;
  }
}

export function resolveAssetDir(assetName: string): string | null {
  const cwd = process.cwd();

  const candidates = [
    // 1. npm-installed: node_modules/@massu/core/{assetName}
    resolve(cwd, 'node_modules/@massu/core', assetName),
    // 2. Relative to compiled dist/cli.js → ../{assetName}
    resolve(__dirname, '..', assetName),
    // 3. Relative to source src/commands/ → ../../{assetName}
    resolve(__dirname, '../..', assetName),
  ];

  for (const c of candidates) {
    if (dirHoldsAssets(c)) return c;
  }

  return null;
}


// ============================================================
// Variant Resolution (Phase 1)
// ============================================================

/** Discriminated-union return shape for `pickVariant`. */
export type PickVariantResult =
  | { kind: 'hit'; suffix: string } // found a variant (suffix may be "")
  | { kind: 'miss' } // no candidate found, caller SKIPS the file
  | { kind: 'fallback'; reason: string }; // misconfig / safe fallback, caller copies UNSUFFIXED default

/** Well-known language keys for the passthrough-fallback step in `pickVariant`. */
const PASSTHROUGH_LANG_KEYS = [
  'typescript',
  'javascript',
  'python',
  'swift',
  'rust',
  'go',
] as const;

/**
 * Choose the variant suffix for a base template name.
 *
 * Two-axis priority (Plan #2 P2-001 extends Plan #1's lang-only axis):
 *   For each language `L` in priority order (primary, languages.*, passthrough.*):
 *     a. If a sub-framework `F` is declared for L, probe `<base>.<L>-<F>.md`.
 *     b. Probe `<base>.<L>.md` (lang-only fallback).
 *   Then probe the unsuffixed `<base>.md`.
 *
 * Priority order for the language list (Plan #1):
 *   1. `framework.primary` (or `framework.type` if primary undefined). With the
 *      sub-framework axis, the candidate framework is the matching
 *      `framework.languages[primary].framework` if present, else `framework.router`
 *      / `framework.orm` / `framework.ui` heuristics, else just lang-only.
 *   2. Each declared `framework.languages.<lang>` entry with a non-empty `framework`,
 *      in YAML declaration order. Sub-framework = `entry.framework`.
 *   3. Passthrough fallback: well-known top-level `framework.<lang>` blocks with a
 *      non-empty `framework` field, in fixed order, excluding entries already covered.
 *      Sub-framework = top-level block's `framework` field.
 *   4. The unsuffixed default ("").
 *
 * The function NEVER throws. It returns a discriminated union so the caller can
 * distinguish "skip this file" from "copy the default" — see plan §"Error semantics".
 */
export function pickVariant(
  baseName: string,
  sourceDir: string,
  framework: Config['framework'],
): PickVariantResult {
  // Build (lang, subFramework) candidate pairs in priority order. Sub-framework
  // can be undefined — in that case only the lang-only axis is probed for that
  // language.
  type Candidate = { lang: string; subFramework?: string };
  const candidates: Candidate[] = [];
  const seenLangs = new Set<string>();

  function pushCandidate(lang: string, sub: string | undefined): void {
    if (seenLangs.has(lang)) return;
    seenLangs.add(lang);
    candidates.push({ lang, subFramework: sub && sub.length > 0 ? sub : undefined });
  }

  // 1. framework.primary (or fall back to framework.type)
  const primary = framework.primary ?? framework.type;
  if (primary && primary !== 'multi') {
    // Best-effort sub-framework detection for the primary lang:
    //   - If `framework.languages[primary]` has a `framework`, use that.
    //   - Else, fall back to top-level passthrough `framework[primary].framework`.
    let primarySub: string | undefined;
    if (framework.languages && framework.languages[primary]?.framework) {
      primarySub = framework.languages[primary].framework;
    } else {
      const passthrough = framework as unknown as Record<string, unknown>;
      const block = passthrough[primary];
      if (block && typeof block === 'object') {
        const fw = (block as { framework?: unknown }).framework;
        if (typeof fw === 'string' && fw.length > 0) primarySub = fw;
      }
    }
    pushCandidate(primary, primarySub);
  }

  // 2. framework.languages declaration order
  if (framework.languages) {
    for (const lang of Object.keys(framework.languages)) {
      const entry = framework.languages[lang];
      if (entry && typeof entry.framework === 'string' && entry.framework.length > 0) {
        pushCandidate(lang, entry.framework);
      }
    }
  }

  // 3. Passthrough fallback — `framework.<lang>` (top-level passthrough block).
  const passthrough = framework as unknown as Record<string, unknown>;
  for (const lang of PASSTHROUGH_LANG_KEYS) {
    if (seenLangs.has(lang)) continue;
    const block = passthrough[lang];
    if (block && typeof block === 'object') {
      const fw = (block as { framework?: unknown }).framework;
      if (typeof fw === 'string' && fw.length > 0) {
        pushCandidate(lang, fw);
      }
    }
  }

  // 4. Probe disk — for each (lang, sub) pair, try lang-sub first, then lang-only.
  for (const cand of candidates) {
    if (cand.subFramework) {
      const subPath = resolve(sourceDir, `${baseName}.${cand.lang}-${cand.subFramework}.md`);
      if (existsSync(subPath)) {
        return { kind: 'hit', suffix: `.${cand.lang}-${cand.subFramework}` };
      }
    }
    const langPath = resolve(sourceDir, `${baseName}.${cand.lang}.md`);
    if (existsSync(langPath)) {
      return { kind: 'hit', suffix: `.${cand.lang}` };
    }
  }
  // Unsuffixed default
  const defaultPath = resolve(sourceDir, `${baseName}.md`);
  if (existsSync(defaultPath)) {
    return { kind: 'hit', suffix: '' };
  }

  // No hit. Risk #7: framework.type=multi without primary → safe fallback.
  if (framework.type === 'multi' && !framework.primary) {
    process.stderr.write(
      'massu: warning - framework.type=multi but framework.primary is undefined; ' +
        'falling back to default templates\n',
    );
    return { kind: 'fallback', reason: 'multi-without-primary' };
  }

  return { kind: 'miss' };
}

/** Returns true if a top-level entry name has the `<base>.<variant>.md` shape. */
export function isVariantFilename(entry: string): boolean {
  // Match exactly one inner dot before `.md`. `_shared-preamble.md` (no inner dot) survives.
  return /^[^.]+\.[^.]+\.md$/.test(entry);
}

/**
 * The source filename a `PickVariantResult` selects, for a given base name.
 *
 * ⛔ THIS EXISTS BECAUSE IT WAS WRITTEN TWICE. `install-commands.ts` and `show-template.ts`
 * each carried their own copy of the same three lines:
 *
 *     const suffix = choice.kind === 'hit' ? choice.suffix : '';
 *     const file = suffix === '' ? `${base}.md` : `${base}${suffix}.md`;
 *
 * Identical today. Nothing would have reported it if they stopped being identical — both
 * still name a file, and a file that exists still installs. The rule is small enough to feel
 * unworthy of a function, which is exactly the size at which duplication survives review.
 *
 * Returns null for a `miss` — the caller has no file to act on.
 */
export function variantFilename(
  baseName: string,
  choice: PickVariantResult,
): string | null {
  if (choice.kind === 'miss') return null;
  // 'hit' uses its suffix (which may be ''); 'fallback' copies the unsuffixed default.
  const suffix = choice.kind === 'hit' ? choice.suffix : '';
  return suffix === '' ? `${baseName}.md` : `${baseName}${suffix}.md`;
}
