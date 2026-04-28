// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Iter-6 coverage gap: every prior watch test uses `noWatcher: true` so the
 * chokidar bootstrap is bypassed. This file exercises the actual chokidar
 * watcher end-to-end against a tmpdir + real fs writes, asserting that:
 *
 *   1. A real `fs.writeFile` event is observed and queued via `pushEvent`
 *   2. The quiescence FSM still fires `onQuiescent` after the debounce window
 *   3. `stop()` cleanly closes the chokidar instance
 *
 * Uses a short debounce_ms so the test stays under a second of real wall
 * clock — no fake timers (chokidar's own fs.watch / FSEvents fires on real
 * time, not vitest's controllable clock).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { startDaemon } from '../../watch/daemon.ts';
import { resetConfig } from '../../config.ts';

function setupRepo(dir: string, debounceMs: number): void {
  writeFileSync(
    resolve(dir, 'massu.config.yaml'),
    [
      'schema_version: 1',
      'project:',
      '  name: t',
      '  root: auto',
      'paths:',
      '  source: src',
      'framework:',
      '  type: typescript',
      'watch:',
      `  debounce_ms: ${debounceMs}`,
      '  storm_threshold: 1000',
      '  deep_storm_threshold: 10000',
      '  hard_timeout_ms: 60000',
      '',
    ].join('\n'),
    'utf-8',
  );
  mkdirSync(resolve(dir, 'src'), { recursive: true });
}

describe('watch/daemon real-chokidar end-to-end', () => {
  let dir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    dir = mkdtempSync(resolve(tmpdir(), 'massu-real-chokidar-'));
    setupRepo(dir, 200); // 200ms debounce keeps the test fast
    process.chdir(dir);
    resetConfig();
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
    resetConfig();
  });

  it('observes a real fs write and fires onQuiescent (no noWatcher)', async () => {
    let fired = 0;
    const handle = startDaemon(dir, {
      onQuiescent: () => {
        fired++;
        return Promise.resolve();
      },
      // No noWatcher — chokidar runs for real.
    });

    // Give chokidar a moment to bootstrap its FS watcher (chokidar v3 emits
    // 'ready' but we don't expose it; ~150ms is enough on macOS FSEvents).
    await new Promise<void>((r) => setTimeout(r, 250));

    // Write a fresh file inside src/ — chokidar must observe it.
    writeFileSync(resolve(dir, 'src', 'real-event.ts'), 'export const x = 1;\n', 'utf-8');

    // Wait long enough for the debounce window to elapse + onQuiescent to run.
    await new Promise<void>((r) => setTimeout(r, 1_000));

    expect(fired).toBeGreaterThanOrEqual(1);

    await handle.stop();
  }, 8_000);

  it('stop() cleanly closes the real chokidar watcher', async () => {
    const handle = startDaemon(dir, {
      onQuiescent: () => Promise.resolve(),
    });
    await new Promise<void>((r) => setTimeout(r, 200));
    // No assertion beyond "doesn't throw or hang".
    await handle.stop();
  }, 5_000);
});
