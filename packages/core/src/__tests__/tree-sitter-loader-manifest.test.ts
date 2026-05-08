// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c Phase 7 grammar-infrastructure drift-guards.
 *
 * GRAMMAR_MANIFEST is the security-critical pinned-source-of-truth for
 * Tree-sitter WASM downloads (tree-sitter-loader.ts:143). Every entry
 * pairs an HTTPS URL with a hardcoded SHA-256; runtime mismatch throws
 * GrammarSHAMismatchError (per Phase 3.5 finding #3).
 *
 * Adding a grammar to the manifest is a high-stakes edit because the SHA
 * must match what unpkg actually serves at the pinned version, AND the
 * URL must be HTTPS, AND the version must match the rest of the manifest
 * (we pin one tree-sitter-wasms version across all grammars to keep the
 * dependency surface single-source). This test makes structural mistakes
 * impossible to merge:
 *
 *   1. EXPECTED_PHASE7_GRAMMARS asserts the closed-set of language
 *      identifiers Phase 7 ships first-party adapters for. A regression
 *      that removes an entry (or a typo that adds the wrong key) fails
 *      this test — not at runtime when an adapter calls loadGrammar().
 *
 *   2. PINNED_TREE_SITTER_WASMS_VERSION asserts every entry uses the
 *      same upstream version. Mixing versions is a bug class in itself:
 *      different versions of tree-sitter-wasms ship grammars built
 *      against different web-tree-sitter ABIs.
 *
 *   3. Each entry's URL must be https:// (defense-in-depth — the loader
 *      ALSO rejects http:// at load time per
 *      GrammarUrlNotHttpsError, but a static test catches the mistake
 *      pre-merge instead of at first-use).
 *
 *   4. Each SHA must be exactly 64 lowercase hex chars (the format
 *      `crypto.createHash('sha256').digest('hex')` produces). A typo,
 *      truncation, or accidentally-pasted SHA-1 value fails here.
 *
 *   5. Each entry's URL must reference the SAME pinned version as the
 *      `version` field — preventing the failure mode where someone
 *      bumps the URL version but forgets to update the version string
 *      (or vice versa), letting drift accumulate silently.
 */

import { describe, it, expect } from 'vitest';
import { GRAMMAR_MANIFEST } from '../detect/adapters/tree-sitter-loader.ts';
import type { TreeSitterLanguage } from '../detect/adapters/types.ts';

/**
 * Closed-set of grammars that MUST be in GRAMMAR_MANIFEST after Plan 3c
 * Phase 7 grammar-infra commit. Any future Phase 7 grammar additions
 * extend this set in lockstep with the manifest entry.
 */
const EXPECTED_PHASE7_GRAMMARS: ReadonlySet<TreeSitterLanguage> = new Set([
  // v1 (Plan 3b Phase 1)
  'python',
  'typescript',
  'javascript',
  'swift',
  // Plan 3c Phase 7 expansion (2026-05-07)
  'go',       // go-chi (registry-verified) + bundled net/http, gin, echo, fiber
  'ruby',     // rails (registry-verified) + sinatra (bundled)
  'csharp',   // aspnet (registry-verified)
  'java',     // spring (registry-verified)
  'kotlin',   // ktor (bundled) + spring-boot-kotlin variant
  'elixir',   // phoenix (registry-verified)
]);

/**
 * The single pinned upstream version. Mixing versions is a bug class
 * (different versions of tree-sitter-wasms ship grammars built against
 * different web-tree-sitter ABIs). One version, one truth.
 */
const PINNED_TREE_SITTER_WASMS_VERSION = '0.1.13';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const HTTPS_RE = /^https:\/\//;

describe('GRAMMAR_MANIFEST: required-grammars drift-guard (Plan 3c Phase 7)', () => {
  it('contains an entry for every Phase 7 expected grammar', () => {
    const present = new Set(Object.keys(GRAMMAR_MANIFEST) as TreeSitterLanguage[]);
    const missing = [...EXPECTED_PHASE7_GRAMMARS].filter((g) => !present.has(g));
    expect(missing, 'grammars expected by Phase 7 adapters but missing from GRAMMAR_MANIFEST').toEqual([]);
  });

  it('does NOT contain entries for grammars not yet adapter-supported', () => {
    // Inverse drift-guard: catches accidental additions. If a future
    // phase needs `rust`/`php`/etc., add them BOTH to this expected set
    // AND to the manifest in the same commit.
    const present = new Set(Object.keys(GRAMMAR_MANIFEST) as TreeSitterLanguage[]);
    const unexpected = [...present].filter((g) => !EXPECTED_PHASE7_GRAMMARS.has(g));
    expect(unexpected, 'grammars present in manifest but not declared in EXPECTED_PHASE7_GRAMMARS').toEqual([]);
  });
});

describe('GRAMMAR_MANIFEST: per-entry shape invariants', () => {
  for (const [language, entry] of Object.entries(GRAMMAR_MANIFEST)) {
    if (!entry) continue;
    describe(`entry: ${language}`, () => {
      it('uses an HTTPS URL', () => {
        expect(entry.url, `${language}.url must be https://`).toMatch(HTTPS_RE);
      });

      it('SHA-256 is exactly 64 lowercase hex chars', () => {
        expect(entry.sha256, `${language}.sha256 must be 64 lowercase hex chars`).toMatch(SHA256_HEX_RE);
      });

      it(`pinned version equals ${PINNED_TREE_SITTER_WASMS_VERSION}`, () => {
        expect(entry.version).toBe(PINNED_TREE_SITTER_WASMS_VERSION);
      });

      it('URL embeds the same pinned version as the version field', () => {
        // Detects the failure mode where the URL version and the version
        // string are bumped independently, letting drift accumulate.
        expect(entry.url).toContain(`tree-sitter-wasms@${entry.version}/`);
      });

      it('URL points to the tree-sitter-wasms unpkg out/ directory', () => {
        // Defense-in-depth: every Phase 7 grammar comes from the SAME
        // upstream (tree-sitter-wasms package on unpkg). Catches anyone
        // sneaking in a one-off URL from a different registry.
        expect(entry.url).toMatch(
          /^https:\/\/unpkg\.com\/tree-sitter-wasms@\d+\.\d+\.\d+\/out\/tree-sitter-[a-z0-9_]+\.wasm$/,
        );
      });
    });
  }
});

describe('GRAMMAR_MANIFEST: SHA uniqueness invariant', () => {
  it('every grammar has a distinct SHA-256 (no copy-paste duplication)', () => {
    // Cheap structural check: two manifest entries with the SAME SHA
    // means a copy-paste error during a manifest extension. Tree-sitter
    // grammars are independently-built WASM binaries; collision
    // probability is effectively zero.
    const seen = new Map<string, string>();
    const duplicates: Array<{ sha: string; languages: string[] }> = [];
    for (const [language, entry] of Object.entries(GRAMMAR_MANIFEST)) {
      if (!entry) continue;
      const prior = seen.get(entry.sha256);
      if (prior) {
        duplicates.push({ sha: entry.sha256, languages: [prior, language] });
      } else {
        seen.set(entry.sha256, language);
      }
    }
    expect(duplicates, 'duplicate SHA-256 across manifest entries — copy-paste error').toEqual([]);
  });
});
