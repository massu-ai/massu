// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Node-floor SoT — the SINGLE source of truth for the minimum supported Node version.
 *
 * This is a LEAF module: it imports NOTHING (no fs, no db-driver, no config). That property
 * is load-bearing for CR-70: `lib/node-bootstrap.ts` runs at the very top of `cli.ts:main()`
 * to RESCUE a sub-floor Node, and it must be able to read the floor WITHOUT dragging in the
 * DB-driver / config import chain — a module-eval side effect (or a `>=22.13`-only API) in any
 * of those transitive modules would crash the very rescuer meant to escape the sub-floor Node.
 * `preflight.ts` RE-EXPORTS these so every existing importer (doctor, the preflight assertions,
 * the drift-guards) keeps its `from '../preflight.ts'` path unchanged — still ONE SoT, now with
 * a dependency-free reader for the bootstrap path.
 *
 * LAYER 2 (CR-69): the default DB engine is Node's built-in `node:sqlite`, which is flag-free +
 * FTS5-capable only from v22.13.0 — so the floor is `>=22.13.0` (a MINOR-precision boundary:
 * 22.0..22.12 have node:sqlite behind a flag). These literals are LOCKED to `@massu/core`'s
 * `engines.node` by the `node-compat-drift-guard` / `preflight-fail-closed` tests — a mutation
 * here that disagrees with `engines` fails the guard, so the two cannot silently drift (that
 * drift is how four sources once disagreed about the range, C-2).
 *
 * NOTE (C-2 partially REFUTED, 2026-07-13): the plan claimed CodeGraph "hard-refuses" Node >= 25.
 * EXECUTED: `@colbymchenry/codegraph@1.4.1` ran on Node v26.0.0 and indexed 1,266 files. There is
 * NO upper ceiling to enforce.
 */

export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 13;

export function checkNodeVersion(version: string = process.version): {
  ok: boolean;
  major: number;
  message?: string;
} {
  const [major, minor] = version.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(major)) {
    return { ok: false, major: 0, message: `could not parse Node version "${version}"` };
  }
  const meets = major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && (minor ?? 0) >= MIN_NODE_MINOR);
  if (!meets) {
    return {
      ok: false,
      major,
      message:
        `Massu requires Node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0 (its built-in node:sqlite engine). ` +
        `You are on ${version}.`,
    };
  }
  return { ok: true, major };
}
