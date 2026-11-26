// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// `massu memory inspect` / `massu memory repair` — plan 2026-07-23 P8-007/P8-008.
//
// CLI-ONLY, deliberately, like the other `massu memory` commands that change stored
// memory: `repair` rewrites the database file, and an MCP tool is MODEL-CALLABLE. There is
// no MCP tool for it; memory-repair-cli.test.ts asserts tools.ts never names it.
//
//   massu memory inspect [--db <path>]
//   massu memory repair  [--db <path>] [--dry-run] [--yes]
//
// `repair` asks before changing anything on a terminal; without a terminal it refuses
// unless --yes is given, so a script cannot rewrite a database by accident.
// `massu doctor --fix` calls runMemoryRepair with the same rules.
// ============================================================

import { createInterface } from 'readline';
import { resolve } from 'path';
import { getResolvedPaths } from '../config.ts';
import { inspectMemoryDb, repairMemoryDb, type RepairOptions } from '../memory-db-maintenance.ts';

export interface CliResult {
  exitCode: number;
  output: string;
}

export interface RepairIo {
  isTTY?: boolean;
  /** Ask a yes/no question; resolves true only for an explicit yes. */
  ask?: (question: string) => Promise<boolean>;
  repairOptions?: RepairOptions;
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((res) => rl.question(question, res));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function parse(argv: string[]): { db?: string; dryRun: boolean; yes: boolean; error?: string } {
  const out = { dryRun: false, yes: false } as { db?: string; dryRun: boolean; yes: boolean; error?: string };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--yes') out.yes = true;
    else if (a === '--db') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) return { ...out, error: '--db needs a path' };
      out.db = resolve(v);
    } else return { ...out, error: `unknown argument: ${a}` };
  }
  return out;
}

const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;

export function formatInspection(path: string): { ok: boolean; text: string; needsRepair: boolean } {
  try {
    const r = inspectMemoryDb(path);
    const dup = r.duplicateSummaryRows === null ? 'n/a' : String(r.duplicateSummaryRows);
    return {
      ok: true,
      needsRepair: r.needsRepair,
      text:
        `${path}: auto_vacuum=${r.autoVacuum}, journal=${r.journalMode}, ${mb(r.fileBytes)} file, ` +
        `${mb(r.dataBytes)} data, ${mb(r.reclaimableBytes)} reclaimable, duplicate summary rows ${dup}` +
        (r.needsRepair ? ' — repair available: massu memory repair' : ' — nothing to repair'),
    };
  } catch (e) {
    return { ok: false, needsRepair: false, text: `${path}: could not inspect — ${(e as Error).message}` };
  }
}

/** The shared repair flow (also used by `massu doctor --fix`). */
export async function runMemoryRepair(
  path: string,
  flags: { dryRun: boolean; yes: boolean },
  io: RepairIo = {},
): Promise<CliResult> {
  const preflight = repairMemoryDb(path, { ...io.repairOptions, dryRun: true });
  if (preflight.status !== 'dry-run' || flags.dryRun) {
    return { exitCode: preflight.exitCode, output: preflight.lines.join('\n') };
  }
  const tty = io.isTTY ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!flags.yes) {
    if (!tty) {
      return {
        exitCode: 1,
        output:
          `${preflight.lines.join('\n')}\n` +
          'REFUSED: not a terminal, so there is no one to confirm. Re-run with --yes to repair without asking.',
      };
    }
    const go = await (io.ask ?? askYesNo)(
      `${preflight.lines.join('\n')}\nRepair this database now? A backup is kept. [y/N] `,
    );
    if (!go) return { exitCode: 1, output: 'Not repaired: you did not confirm. Nothing was changed.' };
  }
  const r = repairMemoryDb(path, io.repairOptions);
  return { exitCode: r.exitCode, output: r.lines.join('\n') };
}

export async function runMemoryRepairCli(sub: 'inspect' | 'repair', argv: string[], io: RepairIo = {}): Promise<CliResult> {
  const a = parse(argv);
  if (a.error) {
    return { exitCode: 2, output: `massu memory ${sub}: ${a.error}\nUsage: massu memory ${sub} [--db <path>]${sub === 'repair' ? ' [--dry-run] [--yes]' : ''}` };
  }
  if (sub === 'inspect' && (a.dryRun || a.yes)) {
    return { exitCode: 2, output: 'massu memory inspect: --dry-run and --yes apply to repair only (inspect never writes)' };
  }
  const path = a.db ?? getResolvedPaths().memoryDbPath;
  if (sub === 'inspect') {
    const r = formatInspection(path);
    return { exitCode: r.ok ? 0 : 1, output: r.text };
  }
  return runMemoryRepair(path, { dryRun: a.dryRun, yes: a.yes }, io);
}
