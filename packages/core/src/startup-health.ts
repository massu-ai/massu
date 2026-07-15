// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Startup dependency assertions.
 *
 * A boundary you have not probed is a boundary you have not built. The memory
 * database is a hard dependency of nearly every MCP tool. If its native SQLite
 * binding cannot be opened (e.g. built for a different Node.js ABI after a Node
 * major upgrade — incident 2026-07-05), EVERY DB-backed tool fails at call time,
 * yet the JSON-RPC `initialize` handshake touches no DB and still reports the
 * server as connected. That is the "connected but broken" silent-failure class:
 * a fatal engine failure that looks identical to a healthy start.
 *
 * This module makes that impossible: it PROBES the engine at startup and, on
 * failure, fails CLOSED (throws a fatal, actionable error) instead of letting a
 * broken engine masquerade as a working one. The open-failure path is kept
 * distinct from a transient prune error (which is legitimately non-fatal — the
 * engine opened fine, one maintenance query hiccuped).
 */

/** Minimal shape we need from an opened DB handle: the ability to close it. */
export interface ClosableDb {
  close(): void;
}

/** Thrown when a hard startup dependency is unusable. Not catchable-and-ignore. */
export class FatalStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalStartupError';
  }
}

/**
 * Probe that the memory DB engine actually opens. Injectable opener so this is
 * testable without a real better-sqlite3 binding.
 *
 * @throws FatalStartupError if the opener throws (native binding / ABI failure).
 */
export function assertMemoryEngineHealthy(open: () => ClosableDb): void {
  let db: ClosableDb;
  try {
    db = open();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new FatalStartupError(
      `the memory database engine could not be opened: ${msg}\n` +
      `This usually means the native SQLite binding was built for a different ` +
      `Node.js ABI (e.g. after a Node major upgrade). Remedy: rebuild the native ` +
      `binding for this Node version — 'npm rebuild better-sqlite3' inside the ` +
      `@massu/core install, or reinstall @massu/core. Refusing to start in a ` +
      `"connected but broken" state where every database tool would fail silently.`
    );
  }
  // Opened cleanly — release the probe handle; real callers reopen per their needs.
  db.close();
}
