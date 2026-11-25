#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Massu MCP Server
 *
 * An MCP server that provides project-specific intelligence on top of
 * vanilla CodeGraph. Communicates via JSON-RPC 2.0 over stdio.
 *
 * Tool names are configurable via massu.config.yaml toolPrefix.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getMemoryDb } from './memory-db.ts';
import { runMemoryRetention, describeRetention } from './memory-retention.ts';
import { getCurrentTier } from './license.ts';
import { createDispatcher } from './server-dispatch.ts';
import { assertMemoryEngineHealthy, FatalStartupError } from './startup-health.ts';
import { openDatabase, probeMemoryDbUsable, NATIVE_DB_REMEDY } from './db-driver.ts';
import { getResolvedPaths } from './config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const dispatcher = createDispatcher({ serverInfoVersion: PKG_VERSION });

// === Startup: prune stale memory data (non-blocking) ===

function pruneMemoryOnStartup(): void {
  try {
    const memDb = getMemoryDb();
    try {
      // The retention pass itself lives in memory-retention.ts; the session-end hook runs the same function,
      // so retention no longer depends on the MCP server restarting (plan 2026-07-23 P8-004).
      process.stderr.write(describeRetention(runMemoryRetention(memDb), 'on startup'));
    } finally {
      memDb.close();
    }
  } catch (error) {
    process.stderr.write(
      `massu: Memory pruning failed (non-fatal): ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

// === Startup: PROBE the memory engine before anything reports "connected" ===
// A native-binding / ABI failure here is FATAL — every DB tool would fail — so we
// fail closed and loud rather than swallow it (the "connected but broken" class).
// This runs BEFORE the non-fatal prune below so an open failure can never be
// misclassified as a transient maintenance hiccup.
try {
  // P6-016 (plan-massu-resilience-layer1): startup heals-or-fails-LOUD.
  // `probeMemoryDbUsable` is the SAME shared probe `massu doctor` runs (so startup
  // and doctor can never diverge — the lying-doctor class). selfHeal:true rebuilds
  // the native binding for the running Node ONCE via the SSOT loader; a terminal
  // failure stops the server rather than masquerade as "connected but broken".
  const memoryDbPath = getResolvedPaths().memoryDbPath;
  const verdict = probeMemoryDbUsable({ dbPath: memoryDbPath, selfHeal: true });
  if (!verdict.ok) {
    throw new FatalStartupError(
      `the memory database engine is unusable (reason: ${verdict.reason}). ` +
        `${verdict.detail ? verdict.detail.trim() + ' ' : ''}${NATIVE_DB_REMEDY}`,
    );
  }
  // The probe opened the real memory DB READ-ONLY. This assert opens it READ-WRITE — the
  // mode getMemoryDb() actually needs — and makes a RW-open failure FATAL here, before the
  // NON-fatal pruneMemoryOnStartup() below (which calls getMemoryDb() and swallows its
  // errors). So the assert uniquely guarantees a RW failure fails loud, not silently.
  assertMemoryEngineHealthy(() => openDatabase(memoryDbPath));
} catch (error) {
  if (error instanceof FatalStartupError) {
    process.stderr.write(`massu: FATAL — ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

pruneMemoryOnStartup();

// === License init: pre-cache tier status ===
getCurrentTier().then(tier => {
  process.stderr.write(`massu: License tier: ${tier}\n`);
}).catch(error => {
  process.stderr.write(
    `massu: License check failed (non-fatal): ${error instanceof Error ? error.message : String(error)}\n`
  );
});

// === stdio JSON-RPC transport ===

let buffer = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', async (chunk: string) => {
  buffer += chunk;

  // Process complete messages (newline-delimited JSON-RPC)
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);

    const result = await dispatcher.processLine(line);
    if (result && result.emit) {
      process.stdout.write(JSON.stringify(result.response) + '\n');
    }
  }
});

process.stdin.on('end', () => {
  // Close cached CodeGraph + Data connections. Memory + Knowledge are
  // per-call (closed inside their routing branches in tools.ts).
  dispatcher.closeCachedDbs();
  process.exit(0);
});

// Handle errors gracefully
process.on('uncaughtException', (error) => {
  process.stderr.write(`massu: Uncaught exception: ${error.message}\n`);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`massu: Unhandled rejection: ${reason}\n`);
});
