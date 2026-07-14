// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P2-003 (plan-living-memory-slice-2a-embedder): `massu memory embed-backfill`.
//
// Embeds the full memory + knowledge corpus so semantic recall covers history,
// not just newly-captured rows. Idempotent (a second run reports 0 new),
// resumable (safe to Ctrl-C and re-run — a memory_meta / knowledge_meta cursor
// tracks progress), unbounded (no time box — the whole corpus).
//
// Distinct from the md-file `massu_memory_backfill` MCP tool (which ingests
// markdown memory files into observations) — this backfills VECTORS for rows
// that already exist.
// ============================================================

import { getMemoryDb, embedMissingObservations } from '../memory-db.ts';
import { getKnowledgeDb, embedMissingChunks } from '../knowledge-db.ts';
import { getResolvedPaths } from '../config.ts';
import { embed, getActiveEmbedModel } from '../memory-embedder.ts';
import { existsSync } from 'fs';

export interface SubcommandResult {
  exitCode: number;
}

/**
 * Run the embedding backfill. Resolves the active embedder tier first (so a
 * model switch re-embeds mismatched rows), then sweeps observations and
 * knowledge chunks unbounded. Prints counts.
 */
export async function runMemoryEmbedBackfill(_args: string[] = []): Promise<SubcommandResult> {
  // Probe the embedder once so the active (model_id, dim) is resolved before
  // the sweeps run — this makes the sweeps re-embed rows tagged with a stale
  // model after a Tier-0/Tier-1 switch, not just brand-new rows.
  await embed('massu memory embed backfill probe');
  const active = getActiveEmbedModel();

  if (!active) {
    // Fail-open: no embedder available (disabled / assets missing / endpoint
    // down). Nothing to do — recall stays FTS-only.
    process.stdout.write(
      'massu memory embed-backfill: embedder unavailable (Tier 2 / disabled) — nothing embedded; semantic recall stays keyword-only.\n',
    );
    return { exitCode: 0 };
  }

  process.stdout.write(
    `massu memory embed-backfill: active model = ${active.modelId} (dim ${active.dim})\n`,
  );

  // Observations (memory DB).
  const memDb = getMemoryDb();
  let obs = { embedded: 0, scanned: 0 };
  try {
    obs = await embedMissingObservations(memDb);
  } finally {
    memDb.close();
  }
  process.stdout.write(
    `  observations: ${obs.embedded} embedded (${obs.scanned} scanned)\n`,
  );

  // Knowledge chunks (knowledge DB) — only if the DB exists.
  let chunks = { embedded: 0, scanned: 0 };
  const knowledgeDbPath = getResolvedPaths().knowledgeDbPath;
  if (existsSync(knowledgeDbPath)) {
    const knowledgeDb = getKnowledgeDb();
    try {
      chunks = await embedMissingChunks(knowledgeDb);
    } finally {
      knowledgeDb.close();
    }
    process.stdout.write(
      `  knowledge chunks: ${chunks.embedded} embedded (${chunks.scanned} scanned)\n`,
    );
  } else {
    process.stdout.write('  knowledge chunks: (no knowledge DB — skipped)\n');
  }

  const total = obs.embedded + chunks.embedded;
  process.stdout.write(
    total === 0
      ? 'Done — corpus already fully embedded (0 new).\n'
      : `Done — ${total} new embedding(s) written.\n`,
  );
  return { exitCode: 0 };
}
