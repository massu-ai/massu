// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * THE ONE COMMENT STRIPPER for source-text drift-guards.
 *
 * THE DEFECT CLASS
 * ----------------
 * A drift-guard that reads a source file and asserts a literal appears in its RAW text is
 * satisfied by ANY mention — including the comment that EXPLAINS why the code exists, which
 * is the last thing anyone deletes. The guard then goes green over the exact edit it exists
 * to catch, and reports the same silence as a healthy one.
 *
 *     const src = readFileSync(join(SRC, 'massu-reality-gate.sh'), 'utf8');
 *     expect(src, 'the log seam is gone').toContain('MASSU_HOOK_FAILURE_LOG');
 *
 * `massu-reality-gate.sh` mentions that literal four times: in code at :218 and :225, and in
 * COMMENTS at :207 and :211. Delete the two code occurrences and the assertion still holds.
 *
 * WHY A SHARED HELPER RATHER THAN TWELVE EDITS
 * --------------------------------------------
 * Measured 2026-08-13: EIGHT hand-written comment strippers already existed in this repo,
 * written independently, and no two of them agreed —
 *
 *   memory-render-accounting-drift-guard.test.ts:62  codeOnly()
 *   security/command-exec.test.ts:103                (an inline chain bound to a local
 *                                                    variable of this same name — which is
 *                                                    why P3 must RENAME it, not just import)
 *   anti-vacuity-plant-payload-safety.test.ts:80     stripComments()
 *   hooks-stdout-convention.test.ts:27               stripCommentsAndStrings()
 *   memory-dir-single-resolver-drift-guard.test.ts:36 stripComments()
 *   no-hard-delete-memory-drift-guard.test.ts:68     stripComments()
 *   node-bootstrap-exec-safety.test.ts:24            stripComments()
 *   website/src/__tests__/edge-async-bcrypt-compare-drift.test.ts:69  stripComments()
 *
 * Four of them do not strip a trailing `//` at all, two truncate any URL at `://`, one blanks
 * string literals and seven do not — and NOT ONE of the eight handles `#`, while TEN of the
 * twelve latent assertions guard SHELL files. Fixing the twelve by hand means authoring a
 * NINTH stripper and leaves the thirteenth assertion, written next month, free to repeat it.
 *
 * THE CONTRACT
 * ------------
 * - Language-aware by EXTENSION, seeded from the Python probe's `LINE_COMMENT` map
 *   (`scripts/ops/probe-comment-satisfiable-assertions.py:109`) so the two cannot drift.
 * - FAIL CLOSED: an unknown extension THROWS naming it. It must never hand the input back
 *   unchanged, because that silently restores the exact defect this helper closes (M2).
 * - A THIRD OUTCOME for an extension with no comment syntax (`.json`): `null`. It is neither
 *   an error nor a strip — there is no comment syntax, so an assertion over that file is
 *   ALREADY comment-proof. The return type is `string | null` so, under this package's
 *   `"strict": true`, a caller that ignores the `null` cannot compile: the type system is a
 *   mechanism, whereas a companion predicate the caller may simply never consult is only
 *   discipline (G21 — prefer IMPOSSIBLE over detectable).
 *
 * WHAT IS AND IS NOT A COMMENT HERE
 * ---------------------------------
 * A `#!` shebang on line 1 is NOT a comment: it is executable configuration, and a guard
 * asserting over an interpreter line is asserting over code. It is preserved verbatim. The
 * Python probe DROPS it (`stripped.startswith(marker)` is true of it), which is one of the
 * three documented, deliberate parity exclusions — see `code-only-parity.test.ts`.
 *
 * BYTE-LEVEL DISPOSITIONS, PINNED TO THE PROBE
 * --------------------------------------------
 * These do not change what any `toContain` assertion detects; they decide whether a
 * cross-language parity test can exist at all, so they are pinned rather than chosen:
 *   - a full-line comment's LINE IS REMOVED, not blanked (probe `:129-130` `continue`;
 *     the repo's precedent stripper substituted a space and kept the line, a one-newline
 *     difference on the single most common input);
 *   - a trailing comment is TRUNCATED at the marker with preceding whitespace intact
 *     (probe `:136` `line = line[:idx]` — no `trimEnd`);
 *   - no trailing newline is appended (probe `:138` `'\n'.join(kept)`);
 *   - line splitting follows Python's `str.splitlines()`, which drops the empty final
 *     element produced by a trailing newline. A bare `split('\n')` does NOT, and every real
 *     source file ends in a newline — so this single line is the difference between a parity
 *     test that can go green and one that cannot.
 */

/** Line-comment marker by file extension. `null` = the language has no line comments. */
export const LINE_COMMENT: Readonly<Record<string, '//' | '#' | null>> = {
  '.sh': '#',
  '.bash': '#',
  '.py': '#',
  '.yml': '#',
  '.yaml': '#',
  '.ts': '//',
  '.tsx': '//',
  '.js': '//',
  '.mjs': '//',
  '.cjs': '//',
  '.json': null,
};

/** Extensions whose block-comment syntax is `/* … *\/`. Shell/Python/YAML have none. */
const BLOCK_COMMENT_MARKERS = new Set<'//' | '#'>(['//']);

export interface CodeOnlyOptions {
  /**
   * Blank `"…"` and `'…'` string literals as well (template literals are left alone).
   *
   * OPT-IN, DEFAULT FALSE. Exactly one of the eight strippers this helper replaces did
   * this — `hooks-stdout-convention.test.ts`, which needs it to match identifier-level
   * shapes like `console.log(`. Imposing it on the other seven would change what they
   * detect, at every call site that is not that one.
   */
  stripStringLiterals?: boolean;
}

function normalizeExt(ext: string): string {
  const e = ext.trim().toLowerCase();
  return e.startsWith('.') ? e : `.${e}`;
}

/**
 * The line-comment marker for `ext`, or `null` when the language has none.
 * THROWS on an unknown extension — never guesses, never returns a default.
 */
function markerFor(ext: string): '//' | '#' | null {
  const key = normalizeExt(ext);
  if (!Object.prototype.hasOwnProperty.call(LINE_COMMENT, key)) {
    throw new Error(
      `codeOnly: unknown extension ${JSON.stringify(ext)} (normalized to ${JSON.stringify(key)}). ` +
        `Returning the source unchanged would silently restore the comment-satisfiable-assertion ` +
        `defect, so this fails closed. Add ${JSON.stringify(key)} to LINE_COMMENT in ` +
        `packages/core/src/__tests__/helpers/code-only.ts (and to LINE_COMMENT in ` +
        `scripts/ops/probe-comment-satisfiable-assertions.py, which the parity test binds it to) ` +
        `with its line-comment marker, or null when it has none. Known: ` +
        `${Object.keys(LINE_COMMENT).join(', ')}.`,
    );
  }
  return LINE_COMMENT[key] as '//' | '#' | null;
}

/**
 * Does `ext` have line-comment syntax at all?
 *
 * Exported for READABILITY only. It is deliberately NOT the signal a caller relies on —
 * nothing forces anyone to consult a predicate, so it would detect the mistake instead of
 * preventing it. `codeOnly`'s `string | null` return is what the compiler enforces.
 * Throws on an unknown extension for the same fail-closed reason `codeOnly` does.
 */
export function hasCommentSyntax(ext: string): boolean {
  return markerFor(ext) !== null;
}

/**
 * Python `str.splitlines()` semantics: split on CRLF/CR/LF and drop the empty final element
 * a trailing newline produces. See the header — this is the byte-parity linchpin.
 */
function splitLines(text: string): string[] {
  const parts = text.split(/\r\n|\n|\r/);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Index of the first comment marker in `line` that is OUTSIDE any quoted string, or -1.
 *
 * For the `//` marker an occurrence immediately preceded by `:` is skipped, so a URL is not
 * truncated at `://` — the defect in strippers #7 and #8.
 */
function commentMarkerIndex(line: string, marker: '//' | '#'): number {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') {
        i++; // skip the escaped character
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (marker === '#') {
      if (ch === '#') return i;
    } else if (ch === '/' && line[i + 1] === '/') {
      if (i > 0 && line[i - 1] === ':') {
        i++; // `://` — a URL scheme, not a comment. Resume past both slashes.
        continue;
      }
      return i;
    }
  }
  return -1;
}

/**
 * Return `src` with its comments removed, or `null` when `ext` has no comment syntax.
 *
 * @param src the file's raw text
 * @param ext the GUARDED file's extension (`'.sh'`, `'.ts'`, …; a leading dot is optional)
 * @param opts see {@link CodeOnlyOptions}
 * @throws when `ext` is not in {@link LINE_COMMENT}
 */
export function codeOnly(src: string, ext: string, opts?: CodeOnlyOptions): string | null {
  const marker = markerFor(ext); // throws on an unknown extension, before any work
  if (marker === null) return null;

  // A `#!` shebang is executable configuration, not documentation. Held aside so the
  // line loop cannot mistake it for a full-line `#` comment.
  const lines0 = splitLines(src);
  const hasShebang = lines0.length > 0 && lines0[0].startsWith('#!');
  const shebang = hasShebang ? lines0[0] : null;
  const body = hasShebang ? lines0.slice(1).join('\n') : src;

  const blockStripped = BLOCK_COMMENT_MARKERS.has(marker)
    ? // A space, not an empty string: `foo/* c */bar` must not become the identifier `foobar`.
      body.replace(/\/\*[\s\S]*?\*\//g, ' ')
    : body;

  const kept: string[] = [];
  for (let line of splitLines(blockStripped)) {
    if (line.trimStart().startsWith(marker)) continue; // full-line comment: drop the LINE
    const idx = commentMarkerIndex(line, marker);
    if (idx > 0) line = line.slice(0, idx); // trailing comment: truncate, keep the whitespace
    kept.push(line);
  }

  let out = kept.join('\n');
  if (shebang !== null) out = kept.length > 0 ? `${shebang}\n${out}` : shebang;

  if (opts?.stripStringLiterals) {
    out = out.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''");
  }
  return out;
}
