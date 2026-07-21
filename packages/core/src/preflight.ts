/**
 * G-3 — FAIL-CLOSED STARTUP ASSERTIONS.
 *
 * THE BUG THIS EXISTS TO KILL (M-2 / C-1, verified live 2026-07-13):
 *
 * `getCodeGraphDb()` guarded its dependency with `existsSync(dbPath)`. That is a check
 * for the LOUD failure — the file is missing — and it is blind to every QUIET one. On
 * this machine the file existed and contained:
 *
 *     files  0 rows
 *     nodes  0 rows
 *     edges  0 rows
 *
 * The guard raised NOTHING. So every dependent tool answered from an empty graph, and
 * `massu_impact` reported **"(safe)"** for any change you asked about — because it
 * looked, found nothing, and truthfully reported nothing.
 *
 *     "No impact" and "I have no data" were byte-identical to the caller.
 *
 * Five free-tier navigation tools were dead for every new customer, and the one defence
 * we had was watching the wrong door.
 *
 * AND THE REMEDY WAS WRONG. The error told the customer to run
 * `npx @colbymchenry/codegraph init`. Executed 2026-07-13:
 *
 *     ▲  Already initialized in <your-project>
 *     ●  Use "codegraph index" to re-index or "codegraph sync" to update
 *
 * `init` is a NO-OP once the directory exists. The command that actually populates the
 * graph is `index`. So a customer could follow our instructions to the letter, see a
 * success message, and still have an empty graph and five dead tools — forever. A remedy
 * that does not remedy is worse than no remedy: it spends the user's trust and their time.
 *
 * THE RULE: a dependency is not "present". It is USABLE, or it is not there.
 */

import type Database from 'better-sqlite3';
import { openDatabase } from './lib/sqlite-loader.ts';
import { existsSync } from 'fs';
import { getResolvedPaths } from './config.ts';
/**
 * The original error, now defined HERE (it was in db.ts). db.ts re-exports it so every
 * existing importer and every `instanceof` check in the dispatcher keeps working.
 */
export class CodegraphDbNotInitializedError extends Error {
  readonly dbPath: string;
  constructor(dbPath: string) {
    super(`CodeGraph database not found at ${dbPath}`);
    this.name = 'CodegraphDbNotInitializedError';
    this.dbPath = dbPath;
  }
}

/** Why the CodeGraph DB is unusable. The remedy differs, so the reason must survive. */
export type CodegraphFailure = 'missing' | 'empty' | 'unreadable';

/**
 * EXTENDS the original error on purpose. The MCP dispatcher catches
 * `CodegraphDbNotInitializedError` and translates it to a structured `-32001` with a
 * remedy hint. If this were a sibling class, every one of those catch sites would go
 * blind to the empty case — and I would have replaced one silent failure with another,
 * which is the precise mistake this whole workstream exists to stop making.
 */
export class CodegraphDbUnusableError extends CodegraphDbNotInitializedError {
  readonly reason: CodegraphFailure;

  constructor(dbPath: string, reason: CodegraphFailure, detail?: string) {
    super(dbPath);
    this.message =
      reason === 'missing'
        ? `CodeGraph database not found at ${dbPath}`
        : reason === 'empty'
          ? `CodeGraph database at ${dbPath} exists but is EMPTY (0 files indexed)`
          : `CodeGraph database at ${dbPath} could not be read: ${detail ?? 'unknown'}`;
    this.name = 'CodegraphDbUnusableError';
    this.reason = reason;
  }

  /**
   * The remedy, per reason. VERIFIED BY EXECUTION — `init` is a no-op on an
   * already-initialized repo and will NOT populate the graph. `index` is the command
   * that does. Getting this wrong sends the customer in a circle.
   */
  get remedy(): string {
    switch (this.reason) {
      case 'missing':
        return 'npx @colbymchenry/codegraph init && npx @colbymchenry/codegraph index';
      case 'empty':
        // `init` here would print "Already initialized" and change nothing.
        return 'npx @colbymchenry/codegraph index';
      case 'unreadable':
        return 'npx @colbymchenry/codegraph index   (the database may be corrupt — re-indexing rebuilds it)';
    }
  }

  /** Plain-English explanation for a human. */
  get humanExplanation(): string {
    switch (this.reason) {
      case 'missing':
        return 'Massu needs a map of your code to answer questions about it. That map has not been built yet.';
      case 'empty':
        return 'The code map exists but is EMPTY — nothing was ever indexed into it. Massu would answer "no impact" to every question, which is indistinguishable from a real answer. It is refusing rather than misleading you.';
      case 'unreadable':
        return 'The code map exists but cannot be read. It may be corrupt.';
    }
  }
}

/**
 * Assert the CodeGraph DB is USABLE — present AND non-empty AND readable.
 *
 * The `files > 0` assertion is the entire point. `existsSync` only ever caught the
 * failure mode that announces itself.
 *
 * @throws {CodegraphDbUnusableError}
 */
export function assertCodegraphUsable(dbPath?: string): void {
  const path = dbPath ?? getResolvedPaths().codegraphDbPath;

  if (!existsSync(path)) {
    throw new CodegraphDbUnusableError(path, 'missing');
  }

  let db: Database.Database | null = null;
  try {
    db = openDatabase(path, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number } | undefined;
    const files = row?.c ?? 0;
    if (files === 0) {
      // PRESENT BUT EMPTY — the failure the old guard could not see.
      throw new CodegraphDbUnusableError(path, 'empty');
    }
  } catch (err) {
    if (err instanceof CodegraphDbUnusableError) throw err;
    // A missing `files` table, a corrupt file, an ABI error — all mean UNUSABLE.
    // Crucially this does NOT swallow: it converts to a loud, typed failure.
    throw new CodegraphDbUnusableError(
      path,
      'unreadable',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    try {
      db?.close();
    } catch {
      // SWALLOW-OK: closing a read-only handle we are discarding. The verdict above is
      // already decided and has already been thrown or not; a close error cannot change it.
    }
  }
}

/** Non-throwing probe, for `doctor` and the reality gate. */
export function checkCodegraph(dbPath?: string): {
  ok: boolean;
  reason?: CodegraphFailure;
  files: number;
  remedy?: string;
} {
  const path = dbPath ?? getResolvedPaths().codegraphDbPath;
  try {
    assertCodegraphUsable(path);
  } catch (err) {
    if (err instanceof CodegraphDbUnusableError) {
      return { ok: false, reason: err.reason, files: 0, remedy: err.remedy };
    }
    throw err;
  }
  let db: Database.Database | null = null;
  try {
    db = openDatabase(path, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number };
    return { ok: true, files: row.c };
  } finally {
    try {
      db?.close();
    } catch {
      // SWALLOW-OK: discarding a read-only handle after the count is already read.
    }
  }
}

/**
 * The MINIMUM Node version, from ONE source of truth: `@massu/core`'s own `engines`
 * field. Read at runtime rather than duplicated as a literal, so it cannot drift from
 * the package that declares it — a second copy is exactly how four sources came to
 * disagree about the supported range (C-2).
 *
 * NOTE (C-2 partially REFUTED, 2026-07-13): the plan claimed CodeGraph "hard-refuses"
 * Node >= 25 and that the remedy therefore cannot run on this machine's default Node 26.
 * EXECUTED: `@colbymchenry/codegraph@1.4.1` ran on Node v26.0.0 and indexed 1,266 files
 * / 11,512 nodes / 35,213 edges. There is no upper ceiling to enforce. The finding was
 * a claim about the world that nobody had run. We record the refutation rather than
 * inheriting it.
 */
export const MIN_NODE_MAJOR = 20;

export function checkNodeVersion(version: string = process.version): {
  ok: boolean;
  major: number;
  message?: string;
} {
  const major = Number.parseInt(version.replace(/^v/, '').split('.')[0], 10);
  if (!Number.isFinite(major)) {
    return { ok: false, major: 0, message: `could not parse Node version "${version}"` };
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      major,
      message: `Massu requires Node >= ${MIN_NODE_MAJOR}. You are on ${version}.`,
    };
  }
  return { ok: true, major };
}
