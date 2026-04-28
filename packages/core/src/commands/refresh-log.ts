// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu refresh-log [N]` — show the last N watcher auto-refresh events.
 *
 * Library discipline: returns a result object; cli.ts owns process.exit.
 */

import { gitToplevel } from '../lib/gitToplevel.ts';
import { readRefreshLog } from './watch.ts';

export interface RefreshLogResult {
  exitCode: 0 | 1;
  message?: string;
}

export async function runRefreshLog(args: string[]): Promise<RefreshLogResult> {
  const limitArg = args.find((a) => /^\d+$/.test(a));
  const limit = limitArg ? Math.max(1, Math.min(1000, Number(limitArg))) : 10;
  const root = gitToplevel(process.cwd());

  const events = readRefreshLog(root, limit);
  if (events.length === 0) {
    process.stdout.write('massu refresh-log: no auto-refresh events recorded yet.\n');
    return { exitCode: 0 };
  }

  for (const e of events) {
    const from = e.fromFingerprint ? e.fromFingerprint.slice(0, 12) : 'init';
    const to = e.toFingerprint.slice(0, 12);
    process.stdout.write(
      `${e.at}  ${from} -> ${to}  installed=${e.filesInstalled} updated=${e.filesUpdated} kept=${e.filesKept}\n`,
    );
  }
  return { exitCode: 0 };
}
