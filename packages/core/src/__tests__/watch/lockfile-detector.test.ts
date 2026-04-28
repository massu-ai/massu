// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { gitMidOperation, lockfileMidWrite } from '../../watch/lockfile-detector.ts';

describe('watch/lockfile-detector', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'massu-lockfile-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when no lockfiles present', () => {
    expect(lockfileMidWrite(dir)).toBe(false);
  });

  it('returns true when package-lock.json was just modified', () => {
    const path = resolve(dir, 'package-lock.json');
    writeFileSync(path, '{}', 'utf-8');
    // mtime = now - 100ms (within 500ms window)
    const t = (Date.now() - 100) / 1000;
    utimesSync(path, t, t);
    expect(lockfileMidWrite(dir, Date.now(), 500)).toBe(true);
  });

  it('returns false when lockfile mtime is outside window', () => {
    const path = resolve(dir, 'yarn.lock');
    writeFileSync(path, '', 'utf-8');
    const t = (Date.now() - 5_000) / 1000;
    utimesSync(path, t, t);
    expect(lockfileMidWrite(dir, Date.now(), 500)).toBe(false);
  });

  it('gitMidOperation: false when .git absent', () => {
    expect(gitMidOperation(dir)).toBe(false);
  });

  it('gitMidOperation: true with MERGE_HEAD', () => {
    mkdirSync(resolve(dir, '.git'), { recursive: true });
    writeFileSync(resolve(dir, '.git', 'MERGE_HEAD'), 'abc\n', 'utf-8');
    expect(gitMidOperation(dir)).toBe(true);
  });

  it('gitMidOperation: true with REBASE_HEAD', () => {
    mkdirSync(resolve(dir, '.git'), { recursive: true });
    writeFileSync(resolve(dir, '.git', 'REBASE_HEAD'), 'abc\n', 'utf-8');
    expect(gitMidOperation(dir)).toBe(true);
  });

  it('gitMidOperation: true with CHERRY_PICK_HEAD (iter-5 coverage gap)', () => {
    // Plan §113: hard-stops include CHERRY_PICK_HEAD alongside MERGE_HEAD /
    // REBASE_HEAD. Iter-5 audit found no test exercising this branch even
    // though the source's sentinel list at lockfile-detector.ts:60 includes
    // it. Without this test, a regression that drops CHERRY_PICK_HEAD from
    // the sentinel array would silently allow refreshes during conflict
    // resolution of a cherry-pick — corrupting `.claude/`.
    mkdirSync(resolve(dir, '.git'), { recursive: true });
    writeFileSync(resolve(dir, '.git', 'CHERRY_PICK_HEAD'), 'abc\n', 'utf-8');
    expect(gitMidOperation(dir)).toBe(true);
  });

  it('gitMidOperation: true with .git/rebase-apply directory', () => {
    // `git rebase` (without `--interactive`) creates `.git/rebase-apply/`
    // rather than REBASE_HEAD; without this sentinel coverage we'd silently
    // allow refreshes during a long rebase that never sets REBASE_HEAD.
    mkdirSync(resolve(dir, '.git', 'rebase-apply'), { recursive: true });
    expect(gitMidOperation(dir)).toBe(true);
  });

  it('gitMidOperation: true with .git/rebase-merge directory', () => {
    // `git rebase -i` creates `.git/rebase-merge/`; same blast-radius as
    // rebase-apply but a different on-disk shape.
    mkdirSync(resolve(dir, '.git', 'rebase-merge'), { recursive: true });
    expect(gitMidOperation(dir)).toBe(true);
  });
});
