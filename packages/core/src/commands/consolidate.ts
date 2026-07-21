// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// `massu consolidate` (P6-001, plan-living-memory-slice-3-consolidation).
//
// The manual / scheduled entry point to the consolidation pass. Consolidation
// ALSO happens automatically in the session-end hook (a bounded slice per
// session), so nobody NEEDS this command — it exists for people who want a
// full pass on demand or on their own schedule, on any OS.
//
// Exit 0 = the pass completed. Exit 1 = a hard failure worth alerting on.
// The result JSON is printed so a scheduler can spot a pass that "succeeded"
// while silently doing nothing (no embedder, sub-Pro tier, sessions whose raw
// turns were pruned before we could distill them).
// ============================================================

import { getMemoryDb } from '../memory-db.ts';
import { runConsolidation } from '../memory-consolidate.ts';
import { resolveConsolidationConfig } from '../consolidation-config.ts';
import { MemoryEngineUnusableError } from '../lib/sqlite-loader.ts';

export interface SubcommandResult {
  exitCode: number;
}

export async function runConsolidateCommand(args: string[] = []): Promise<SubcommandResult> {
  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');

  const budgetIdx = args.indexOf('--budget-ms');
  const budgetMs =
    budgetIdx >= 0 && args[budgetIdx + 1] ? Number(args[budgetIdx + 1]) : 60_000;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    process.stderr.write('massu consolidate: --budget-ms must be a positive number\n');
    return { exitCode: 1 };
  }

  const cfg = resolveConsolidationConfig();

  // CLI NON-ZERO CONTRACT (bug #1, incident 2026-07-12): a native-ABI failure must
  // surface a CLEAR message + remedy and exit NON-ZERO — never a silent exit 0, never
  // a raw dlopen string. `getMemoryDb()` self-heals via the SSOT loader; if it cannot,
  // it throws a structured `MemoryEngineUnusableError` which we render and exit 1 on.
  let db: ReturnType<typeof getMemoryDb>;
  try {
    db = getMemoryDb();
  } catch (err) {
    if (err instanceof MemoryEngineUnusableError) {
      if (json) {
        process.stdout.write(
          JSON.stringify({ error: 'memory-engine-unusable', reason: err.reason, remedy: err.remedy }) + '\n',
        );
      } else {
        process.stderr.write(`massu consolidate: the memory engine is unavailable — ${err.remedy}\n`);
      }
      return { exitCode: 1 };
    }
    throw err;
  }

  try {
    const result = await runConsolidation(db, {
      config: cfg,
      budgetMs,
      dryRun,
      projectRoot: process.cwd(),
    });

    if (json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return { exitCode: result.stagesFailed.length > 0 ? 1 : 0 };
    }

    if (result.skipped === 'disabled') {
      process.stdout.write('Consolidation is disabled (memory.consolidation.enabled: false).\n');
      return { exitCode: 0 };
    }
    if (result.skipped === 'lease-held') {
      process.stdout.write('Another consolidation pass is already running — nothing to do.\n');
      return { exitCode: 0 };
    }

    const lines: string[] = [];
    lines.push(dryRun ? 'Consolidation (dry run — nothing was written):' : 'Consolidation complete:');
    lines.push(`  Duplicates merged:        ${result.deduped}`);
    lines.push(`  Sessions distilled:       ${result.summarized}`);
    lines.push(`  Rule candidates proposed: ${result.promoted}`);
    lines.push(`  Records reweighted:       ${result.reweighted}`);
    lines.push(`  Records expired:          ${result.expired} (expired, never deleted)`);

    // Be honest about a pass that ran but could not do its job.
    if (result.warmingUp) {
      lines.push(
        '  Note: expiry is still disarmed while Massu learns which memories you actually use.',
      );
    }
    if (result.sessionsMissed > 0) {
      lines.push(
        `  Warning: ${result.sessionsMissed} session(s) had their raw transcripts already deleted ` +
          'before they could be distilled — run consolidation more often to avoid losing lessons.',
      );
    }
    if (result.candidatesRefusedByTier > 0) {
      lines.push(
        `  Note: ${result.candidatesRefusedByTier} recurring correction(s) could become rules on Pro.`,
      );
    }
    if (result.embedderUnavailable) {
      lines.push('  Note: no embedder was available, so duplicate-merging was skipped.');
    }
    if (result.summaryTier) {
      lines.push(
        result.summaryTier === 'model'
          ? '  Summaries: written by your configured local model.'
          : '  Summaries: built from your own sentences (no model configured — this is the default).',
      );
    }
    if (result.stagesFailed.length > 0) {
      lines.push(`  FAILED stages: ${result.stagesFailed.join(', ')}`);
    }

    process.stdout.write(`${lines.join('\n')}\n`);
    return { exitCode: result.stagesFailed.length > 0 ? 1 : 0 };
  } catch (err) {
    process.stderr.write(
      `massu consolidate failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { exitCode: 1 };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}
