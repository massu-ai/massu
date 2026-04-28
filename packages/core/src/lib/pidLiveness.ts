// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Cross-platform PID liveness probe.
 *
 * POSIX (macOS / Linux):
 *   process.kill(pid, 0) → no-throw == alive; ESRCH → dead; EPERM → alive
 *   (the process exists but we lack permission to signal it).
 *
 * Windows:
 *   `tasklist /FI "PID eq <pid>" /NH` and grep for the PID. Best-effort.
 *
 * Returns boolean; never throws. Used by hooks/session-start.ts
 * (banner suppression) and watch/daemon.ts (registry sweep).
 */

import { spawnSync } from 'child_process';

interface ProbeOpts {
  /** When set, override `process.platform` (test seam). */
  platformOverride?: NodeJS.Platform;
  /** When set, override `process.kill` (test seam). */
  killOverride?: (pid: number, signal: number) => boolean;
}

export function isPidAlive(pid: number, opts: ProbeOpts = {}): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;

  const platform = opts.platformOverride ?? process.platform;

  if (platform === 'win32') {
    return checkWindows(pid);
  }
  return checkPosix(pid, opts.killOverride);
}

function checkPosix(pid: number, killOverride?: (pid: number, signal: number) => boolean): boolean {
  try {
    if (killOverride) {
      killOverride(pid, 0);
    } else {
      process.kill(pid, 0);
    }
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    // ESRCH or anything else → treat as dead.
    return false;
  }
}

function checkWindows(pid: number): boolean {
  try {
    const res = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
      encoding: 'utf-8',
      windowsHide: true,
    });
    if (res.error || res.status !== 0) return false;
    const stdout = res.stdout || '';
    // Each match is a line that starts with the image name and includes the PID.
    return new RegExp(`\\b${pid}\\b`).test(stdout);
  } catch {
    return false;
  }
}
