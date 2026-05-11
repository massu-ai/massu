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
import { getMemoryDb, pruneOldConversationTurns, pruneOldObservations } from './memory-db.ts';
import { getCurrentTier } from './license.ts';
import { createDispatcher } from './server-dispatch.ts';

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
      const turns = pruneOldConversationTurns(memDb, 7);
      const obsDeleted = pruneOldObservations(memDb, 90);

      const totalPruned = turns.turnsDeleted + turns.detailsDeleted + obsDeleted;
      if (totalPruned > 0) {
        process.stderr.write(
          `massu: Pruned memory DB on startup — ` +
          `${turns.turnsDeleted} conversation turns, ` +
          `${turns.detailsDeleted} tool call details (>7d), ` +
          `${obsDeleted} observations (>90d)\n`
        );
      }
    } finally {
      memDb.close();
    }
  } catch (error) {
    process.stderr.write(
      `massu: Memory pruning failed (non-fatal): ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
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
