// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Resolve the git repository root for a given working directory, falling
 * back to the cwd itself when not inside a git repo.
 *
 * Used by `massu watch` and `massu refresh-log` so the watcher root and the
 * refresh-log path always anchor on the same toplevel rather than wherever
 * the user happened to invoke the CLI from.
 */

import { spawnSync } from 'child_process';

export function gitToplevel(cwd: string): string {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf-8',
  });
  if (res.status === 0 && res.stdout) return res.stdout.trim();
  return cwd;
}
