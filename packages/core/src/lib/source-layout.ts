// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * SoT for WHERE THIS PROJECT'S SOURCE LIVES, and for the contract every index
 * builder holds over its candidate set.
 *
 * **Bug class closed** (plan-2026-08-13-index-builder-input-contracts, Q3+Q4):
 * a single-package `src/…` layout was compiled into seven places across four
 * modules — two SQL predicates over CodeGraph's `files` table, a duplicate of
 * one of them, a components predicate, two `startsWith('src/')` recursion
 * guards, and a route-deriving regex. Measured against this monorepo's
 * `.codegraph/codegraph.db`: `path LIKE 'src/%'` matched **0 of 1266** files,
 * so `massu_imports` was empty and nine read sites across four modules answered
 * from an empty table. Nothing reported it, because an empty index and a
 * correctly-empty index are the same output.
 *
 * **Structural fix**: the layout DECLARES ITSELF in `massu.config.yaml` and
 * every consumer ASKS here. One derivation feeds both the SQL predicates and
 * the in-JS path guards, so the two cannot drift apart — the failure mode where
 * a query is widened and the recursion guard that follows it is not.
 *
 * Nothing in this module introduces a config surface. Every value is derived
 * from a declaration that already existed:
 *
 * | derived value | declared by |
 * |---|---|
 * | source dirs | `paths.source`, `paths.monorepo_roots`, `framework.languages.*.source_dirs` |
 * | parseable extensions | `getResolvedPaths().extensions` |
 * | pages dir | `paths.pages`, falling back to `<paths.source>/app` |
 * | components dir | `paths.components`, falling back to `<paths.source>/components` |
 *
 * **No caching.** `getConfig()` is already cached and `resetConfig()` is the
 * documented way to invalidate it; a second cache here would be a second thing
 * to reset, and a test that reset one but not the other would read a layout
 * from a config that no longer exists.
 */

import { getConfig, getResolvedPaths } from '../config.ts';
import type Database from 'better-sqlite3';

/** The resolved answer to "where does this project's source live?". */
export interface SourceLayout {
  /**
   * Declared source dirs, repo-relative POSIX, no trailing slash, deduped and
   * sorted. Empty when {@link includesRoot} is true — the root subsumes them.
   */
  readonly sourceDirs: readonly string[];
  /**
   * True when a source dir of `.` is declared: every tracked path is a source
   * candidate, so a directory predicate would be vacuous and is omitted.
   */
  readonly includesRoot: boolean;
  /** Extensions a JS/TS import parser can read, from `getResolvedPaths()`. */
  readonly extensions: readonly string[];
  /** Repo-relative dir holding app-router pages, e.g. `website/src/app`. */
  readonly pagesDir: string;
  /** Repo-relative dir holding shared components, e.g. `website/src/components`. */
  readonly componentsDir: string;
}

/** A SQL fragment plus the parameters it binds, in order. */
export interface SqlPredicate {
  readonly sql: string;
  readonly params: readonly string[];
}

/**
 * Normalise a declared dir to repo-relative POSIX with no trailing slash.
 * Returns `'.'` for the project root and `null` for anything that cannot be a
 * repo-relative source dir (absolute paths, `..` traversal, empty strings) —
 * dropping those is deliberate: a source dir outside the repo cannot describe a
 * row in CodeGraph's `files` table, which stores repo-relative paths.
 */
function normalizeDir(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const posix = raw.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[A-Za-z]:\//.test(posix)) return null;
  const parts = posix.split('/').filter(p => p !== '' && p !== '.');
  if (parts.some(p => p === '..')) return null;
  if (parts.length === 0) return '.';
  return parts.join('/');
}

/**
 * Read `framework.languages.<lang>.source_dirs` across every declared language.
 *
 * The union is deliberate rather than a JS/TS filter: the extension predicate
 * already restricts the candidate set to files an import parser can read, so a
 * language filter here would be a second, narrower answer to the same question —
 * and the two would drift.
 */
function declaredLanguageSourceDirs(): string[] {
  const languages = getConfig().framework.languages;
  if (!languages) return [];

  const out: string[] = [];
  for (const entry of Object.values(languages)) {
    if (Array.isArray(entry.source_dirs)) out.push(...entry.source_dirs);
  }
  return out;
}

/** Resolve the project's source layout from the config's own declarations. */
export function getSourceLayout(): SourceLayout {
  const config = getConfig();
  const paths = config.paths;

  const declared = [
    paths.source,
    ...(paths.monorepo_roots ?? []),
    ...declaredLanguageSourceDirs(),
  ];

  const normalized = declared
    .map(normalizeDir)
    .filter((d): d is string => d !== null);

  const includesRoot = normalized.includes('.');
  const sourceDirs = includesRoot
    ? []
    : [...new Set(normalized)].sort();

  const source = normalizeDir(paths.source) ?? '.';
  const under = (child: string) => (source === '.' ? child : `${source}/${child}`);

  return {
    sourceDirs,
    includesRoot,
    extensions: getResolvedPaths().extensions,
    pagesDir: normalizeDir(paths.pages ?? under('app')) ?? under('app'),
    componentsDir: normalizeDir(paths.components ?? under('components')) ?? under('components'),
  };
}

/**
 * Escape the SQL `LIKE` metacharacters in a literal so a directory containing
 * `%` or `_` matches itself rather than acting as a wildcard. Paired with an
 * explicit `ESCAPE '\'` clause at every use site.
 */
function escapeLike(literal: string): string {
  return literal.replace(/[\\%_]/g, m => `\\${m}`);
}

/**
 * Column names are interpolated (SQL cannot bind an identifier), so the shape
 * is checked rather than trusted. Every call site passes a literal today; this
 * refuses the day one does not.
 */
function assertIdentifier(column: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new Error(`source-layout: refusing to interpolate '${column}' as a SQL column name`);
  }
  return column;
}

function likeAny(column: string, patterns: string[]): SqlPredicate {
  if (patterns.length === 0) return { sql: '1=0', params: [] };
  const col = assertIdentifier(column);
  const sql = patterns.map(() => `${col} LIKE ? ESCAPE '\\'`).join(' OR ');
  return { sql: `(${sql})`, params: patterns };
}

/**
 * Rows whose `column` is under any declared source dir. `1=1` when the config
 * declares the root as a source dir — a vacuous predicate is the CORRECT
 * rendering of "everything is source", and it is reported as such by
 * {@link SourceLayout.includesRoot} rather than hidden.
 *
 * `column` exists because the same question is asked of `files.path`,
 * `massu_imports.source_file` and `massu_imports.target_file`. Before this
 * module those three had two different answers.
 */
export function sourceDirPredicate(
  column: string = 'path',
  layout: SourceLayout = getSourceLayout(),
): SqlPredicate {
  if (layout.includesRoot) return { sql: `(${assertIdentifier(column)} IS NOT NULL)`, params: [] };
  return likeAny(column, layout.sourceDirs.map(d => `${escapeLike(d)}/%`));
}

/** Rows under a declared source dir AND carrying a parseable extension. */
export function sourceFilePredicate(
  column: string = 'path',
  layout: SourceLayout = getSourceLayout(),
): SqlPredicate {
  const dirs = sourceDirPredicate(column, layout);
  const exts = likeAny(column, layout.extensions.map(e => `%${escapeLike(e)}`));
  return {
    sql: `${dirs.sql} AND ${exts.sql}`,
    params: [...dirs.params, ...exts.params],
  };
}

/** App-router page files under the declared pages dir. */
export function pagesPredicate(layout: SourceLayout = getSourceLayout()): SqlPredicate {
  const dir = escapeLike(layout.pagesDir);
  return {
    sql: `(path LIKE ? ESCAPE '\\' OR path = ?)`,
    params: [`${dir}/%/page.tsx`, `${layout.pagesDir}/page.tsx`],
  };
}

/** Files under the declared components dir. */
export function componentsPredicate(layout: SourceLayout = getSourceLayout()): SqlPredicate {
  return {
    sql: `path LIKE ? ESCAPE '\\'`,
    params: [`${escapeLike(layout.componentsDir)}/%`],
  };
}

/**
 * The in-JS twin of {@link sourceDirPredicate}, for the import-graph recursion
 * guards. Absolute paths and `..` traversal are refused even when the config
 * declares the root as a source dir: `resolveImportPath` returns an absolute
 * path for a target outside the project, and following one would walk the
 * import graph out of the repo.
 */
export function isUnderSourceDir(path: string, layout: SourceLayout = getSourceLayout()): boolean {
  if (normalizeDir(path) === null) return false;
  if (layout.includesRoot) return true;
  return layout.sourceDirs.some(d => path.startsWith(`${d}/`));
}

/**
 * Thrown when a builder's declared candidate set matches nothing in a populated
 * CodeGraph. Distinct type so a caller can tell a misconfiguration from an I/O
 * or SQL failure.
 */
export class CandidateSetContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandidateSetContractError';
  }
}

/**
 * Assert that the declared source dirs select at least one row from a populated
 * `files` table, and say so LOUDLY when they do not.
 *
 * **The contract is `matched == 0 && present > 0`, never `matched == 0`.** A
 * repo with an empty or not-yet-built CodeGraph legitimately matches nothing,
 * and a rule that fires there would be red by design in exactly the state it is
 * supposed to tolerate.
 *
 * **The level matters.** This asserts the SHARED source-dir candidate set, not
 * each builder's own narrowing. `buildPageDeps` finding 0 pages is legitimate —
 * a library-only repo has no pages — whereas declared source dirs matching 0 of
 * 1266 files is a misconfiguration for every consumer, present and future.
 *
 * The message reports the denominator and the prefixes that ARE present, so the
 * error names the fix rather than only the symptom.
 */
export function assertSourceCandidateSet(
  codegraphDb: Database.Database,
  builder: string,
  layout: SourceLayout = getSourceLayout(),
): void {
  const present = (codegraphDb.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
  if (present === 0) return;

  const pred = sourceDirPredicate('path', layout);
  const matched = (
    codegraphDb.prepare(`SELECT COUNT(*) AS n FROM files WHERE ${pred.sql}`).get(...pred.params) as { n: number }
  ).n;
  if (matched > 0) return;

  // LIMIT 20 caps the diagnostic, not the check (P-DG-001). The verdict is
  // already decided; this only names the prefixes a human needs to see.
  const prefixes = codegraphDb
    .prepare(
      `SELECT CASE WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1) ELSE '<root>' END AS prefix,
              COUNT(*) AS n
         FROM files GROUP BY prefix ORDER BY n DESC LIMIT 20`,
    )
    .all() as { prefix: string; n: number }[];

  const declared = layout.includesRoot ? '<project root>' : layout.sourceDirs.join(', ') || '<none>';
  const found = prefixes.map(p => `${p.prefix} (${p.n})`).join(', ') || '<none>';

  throw new CandidateSetContractError(
    `${builder}: declared source dirs match 0 of ${present} indexed files. ` +
      `Declared: ${declared}. Present in CodeGraph: ${found}. ` +
      `Declare the real layout in massu.config.yaml (paths.source, paths.monorepo_roots, ` +
      `or framework.languages.<lang>.source_dirs) — an index built from an empty candidate ` +
      `set is indistinguishable from a project with no imports.`,
  );
}
