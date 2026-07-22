// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * shared-memory-sanitize.ts — neutralize a cross-repo record's text so it can NEVER
 * break out of the fenced, provenance-headed DATA frame it is rendered inside
 * (Living Memory Slice 5, C-02 / B-05).
 *
 * A cross-repo memory is text ANOTHER trust domain wrote into this domain's prompt.
 * It is DATA, never an instruction. These are the SAME machine-derived rules Slice 4
 * B-06 applies to machine-rendered memory-file bodies (`memory-renderer.ts:488`),
 * applied here at BOTH the accept-time write (B-05) and the recall-time render
 * (C-02) — belt and braces, so a record that somehow reached the store un-sanitized
 * is still neutralized when it is shown.
 */

/** Default body cap — long enough for a real decision, short enough to bound a block. */
export const CROSS_REPO_BODY_CAP = 4000;
/** Titles are single-line and short (they head the fenced block). */
export const CROSS_REPO_TITLE_CAP = 200;

/**
 * Neutralize a multi-line body: strip anything that could break out of a Markdown
 * fence or forge structure, then cap. Mirrors Slice 4 B-06's `machineBody`.
 */
export function sanitizeCrossRepoBody(text: string, cap: number = CROSS_REPO_BODY_CAP): string {
  return (text ?? '')
    .replace(/^---$/gm, '—') // a `---` delimiter would forge a frontmatter block
    .replace(/^#/gm, '\\#') // a leading `#` would forge a heading
    .replace(/```/g, "'''") // a fence terminator would break out of the fence
    .slice(0, cap)
    .trimEnd();
}

/**
 * Neutralize a title into a single, capped line (no newlines/CR that could inject a
 * new block or a fake header line into the rendered pointer/label).
 */
export function sanitizeCrossRepoTitle(text: string, cap: number = CROSS_REPO_TITLE_CAP): string {
  return (text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/```/g, "'''")
    .trim()
    .slice(0, cap);
}
