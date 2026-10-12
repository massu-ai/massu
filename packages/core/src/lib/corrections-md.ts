// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * A-09 — `memory/corrections.md`: ONE format, ONE writer helper, ONE parser.
 *
 * THE BUG: there were THREE writers, in three different formats, and a reader that
 * parsed a FOURTH:
 *   - reader   `hooks/session-start.ts`          — a 4-column markdown TABLE
 *   - writer 1 `knowledge-tools.ts`              — `### date - title` + bullets
 *   - writer 2 `rule-candidate-applier.ts`       — `## date: slug` + bullets
 * So the reader found nothing either writer produced. Every prevention rule ever
 * written to corrections.md was invisible to the session-start injection that exists to
 * surface them. (And A-00 showed the reader was ALSO looking in a directory that does
 * not exist — fixing only the format would have left it dead.)
 *
 * WHY HEADING+BULLETS AND NOT THE TABLE: a markdown table splits on `|`, so any
 * correction whose prose contains a pipe — a regex alternation, a shell pipeline, a SQL
 * `OR` — silently shreds its own row. Corrections are exactly the place such text
 * appears. The table format is hostile to its own content.
 *
 * THE FORMAT (canonical):
 *
 *   ### 2026-07-12 - Never guess a referent
 *   - **Wrong**: picked the most recent ADR without asking
 *   - **Correction**: enumerate the candidates and ask
 *   - **Rule**: when more than one candidate exists, ASK — never pick silently
 *   - prompt_hash: abc123        <- extra metadata bullets are allowed and ignored
 *
 * `- **Rule**:` is the line the reader extracts. It is the whole point of the file.
 */

/** A correction entry, as both writers construct it. */
export interface CorrectionEntry {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  title: string;
  wrong?: string;
  correction?: string;
  /** THE prevention rule. This is what session-start injects. */
  rule: string;
  /** Extra provenance bullets (`prompt_hash: …`). Preserved, ignored by the parser. */
  extra?: Record<string, string | number>;
}

/** The heading that opens every entry. Both writers MUST use this shape. */
export const CORRECTION_HEADING = /^###\s+(\d{4}-\d{2}-\d{2})\s+-\s+(.+)$/;

/** The bullet the reader extracts. */
export const CORRECTION_RULE_BULLET = /^-\s+\*\*Rule\*\*:\s*(.+)$/;

/** Render ONE entry in the canonical format. Newlines in values are collapsed: a
 *  multi-line value would break the one-bullet-per-fact contract the parser relies on. */
export function formatCorrectionEntry(e: CorrectionEntry): string {
  const one = (s: string) => s.replace(/\s*\n+\s*/g, ' ').trim();
  const lines: string[] = [`### ${e.date} - ${one(e.title)}`];
  if (e.wrong) lines.push(`- **Wrong**: ${one(e.wrong)}`);
  if (e.correction) lines.push(`- **Correction**: ${one(e.correction)}`);
  lines.push(`- **Rule**: ${one(e.rule)}`);
  for (const [k, v] of Object.entries(e.extra ?? {})) {
    lines.push(`- ${k}: ${one(String(v))}`);
  }
  return `\n${lines.join('\n')}\n`;
}

/**
 * Extract every prevention rule. THE reader — `session-start` uses this and nothing else.
 *
 * Tolerates the two legacy shapes so a file written by an older release is not silently
 * dropped: the old 4-column table (`| date | wrong | correction | prevention |`) and the
 * applier's old `## date: slug` heading. A parser that only understands what it writes
 * today discards the history it exists to preserve.
 */
export function parseCorrectionRules(content: string): string[] {
  const rules: string[] = [];

  for (const raw of content.split('\n')) {
    const line = raw.trim();

    // Canonical: `- **Rule**: …`
    const m = line.match(CORRECTION_RULE_BULLET);
    if (m && m[1].trim()) {
      rules.push(m[1].trim());
      continue;
    }

    // Legacy table: | date | wrong | correction | prevention |
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line
        .split('|')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      if (cells.length < 4) continue;
      if (cells[0] === 'Date' || cells[0].startsWith('-')) continue;
      const prevention = cells[3];
      if (prevention && !prevention.startsWith('-') && !prevention.startsWith('<!--')) {
        rules.push(prevention);
      }
    }
  }

  return rules;
}

// ============================================================
// THE PATH AND THE PLACEMENT — A-09 AMENDMENT, 2026-09-20
// ============================================================
//
// WHY THIS SECTION EXISTS. A-09 shipped ONE format and ONE parser, but left the PATH and
// the WRITE outside this module. The literal `'corrections.md'` was therefore rebuilt
// independently in six files, and each writer did its own `writeFileSync`. A new writer
// could reach a valid path without ever touching the module that would have handed it the
// formatter — which is exactly how three formats appeared in the first place.
//
// A-09's drift-guard papered over that gap by trying to DETECT writers from source text:
// "mentions corrections.md" AND "contains `const entry =`". Both are correlates of the
// property, not the property (G28). Measured 2026-09-20, it flagged `config.ts` — a file
// that merely lists the filename in a default knowledge-source array — because unrelated
// new code there happened to declare a variable called `entry`.
//
// The structural answer is not a better regex. It is to remove the thing being detected:
// this module owns the filename, the path and the placement, so a writer that does not go
// through it cannot reach the file at all. The guard then asserts a property with no
// heuristic and no allowlist — the literal occurs in exactly one module.
//
// IT ALSO FIXES A SECOND DEFECT THE OLD GUARD COULD NOT SEE. The two writers disagreed on
// PLACEMENT: `knowledge-tools.ts` inserted before `## Archived`, while
// `rule-candidate-applier.ts` always appended to the end — so an applier-written
// correction landed INSIDE the archive. One rule, here, for both.

/** The one true filename. Every other site imports this rather than retyping it. */
export const CORRECTIONS_FILENAME = 'corrections.md';

/** Header for a corrections.md that does not exist yet. */
export const CORRECTIONS_HEADER = '# Corrections\n';

/** Marker opening the archive section. Live entries go BEFORE it, never after. */
const ARCHIVE_MARKER = '## Archived';

/**
 * The path to a memory directory's corrections.md. The only way to obtain it.
 *
 * Takes the directory rather than reading config, so the pure-function tests and the
 * multi-file atomic writer can both use it without a config in scope.
 */
export function correctionsPath(memoryDir: string): string {
  // `join` is not imported here deliberately: this module is imported by hooks that must
  // stay dependency-light, and a single separator is all that is needed.
  return memoryDir.endsWith('/') ? `${memoryDir}${CORRECTIONS_FILENAME}` : `${memoryDir}/${CORRECTIONS_FILENAME}`;
}

/**
 * Produce the NEW full contents of corrections.md with `entry` inserted.
 *
 * Pure: takes the existing content, returns the new content. Callers keep control of how
 * they write (one writer needs a multi-file atomic sequence), but none of them decides
 * the FORMAT or the PLACEMENT — that is settled here.
 *
 * Placement: immediately BEFORE `## Archived` when that section exists, otherwise at the
 * end. An entry appended after the archive marker reads as archived and is invisible to
 * anyone scanning live corrections.
 */
export function insertCorrectionEntry(existing: string, entry: CorrectionEntry): string {
  const rendered = formatCorrectionEntry(entry);
  const base = existing.length > 0 ? existing : CORRECTIONS_HEADER;
  const archiveIdx = base.indexOf(ARCHIVE_MARKER);
  if (archiveIdx > 0) {
    return base.slice(0, archiveIdx) + rendered + base.slice(archiveIdx);
  }
  return base + rendered;
}
