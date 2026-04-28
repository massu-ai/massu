// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * readRefreshLog tests — covers empty / corrupt / truncated JSONL handling.
 *
 * The watcher writes events with appendFileSync (single-line). On crash a
 * partial last line may exist; readRefreshLog must skip it and warn rather
 * than throwing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { readRefreshLog } from '../../commands/watch.ts';

describe('readRefreshLog', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'massu-refresh-log-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] when log file does not exist', () => {
    const out = readRefreshLog(dir);
    expect(out).toEqual([]);
  });

  it('returns [] when log file is empty', () => {
    mkdirSync(resolve(dir, '.massu'), { recursive: true });
    writeFileSync(resolve(dir, '.massu', 'refresh-log.jsonl'), '', 'utf-8');
    const warnings: string[] = [];
    const out = readRefreshLog(dir, 10, { warn: (s) => warnings.push(s) });
    expect(out).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('parses well-formed lines and respects the limit (tail semantics)', () => {
    mkdirSync(resolve(dir, '.massu'), { recursive: true });
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({
        at: `2026-04-27T0${i}:00:00Z`,
        fromFingerprint: `fp${i}`,
        toFingerprint: `fp${i + 1}`,
        filesInstalled: i,
        filesUpdated: 0,
        filesKept: 0,
      }));
    }
    writeFileSync(resolve(dir, '.massu', 'refresh-log.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const last3 = readRefreshLog(dir, 3, { warn: () => {} });
    expect(last3).toHaveLength(3);
    expect(last3[0].at).toBe('2026-04-27T02:00:00Z');
    expect(last3[2].at).toBe('2026-04-27T04:00:00Z');
  });

  it('skips and warns on corrupt JSON lines (truncated trailing line)', () => {
    mkdirSync(resolve(dir, '.massu'), { recursive: true });
    const good = JSON.stringify({
      at: '2026-04-27T00:00:00Z',
      fromFingerprint: null,
      toFingerprint: 'abc',
      filesInstalled: 1,
      filesUpdated: 0,
      filesKept: 0,
    });
    const truncated = '{"at":"2026-04-27T01:00:00Z","fromFingerprint":"abc","toFingerprint":"de'; // partial
    writeFileSync(
      resolve(dir, '.massu', 'refresh-log.jsonl'),
      `${good}\n${truncated}\n`,
      'utf-8',
    );

    const warnings: string[] = [];
    const out = readRefreshLog(dir, 10, { warn: (s) => warnings.push(s) });
    expect(out).toHaveLength(1);
    expect(out[0].at).toBe('2026-04-27T00:00:00Z');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/skipped 1 corrupt line/);
  });

  it('skips non-object JSON values (string / array / null)', () => {
    mkdirSync(resolve(dir, '.massu'), { recursive: true });
    const good = JSON.stringify({
      at: '2026-04-27T00:00:00Z',
      fromFingerprint: null,
      toFingerprint: 'abc',
      filesInstalled: 1,
      filesUpdated: 0,
      filesKept: 0,
    });
    writeFileSync(
      resolve(dir, '.massu', 'refresh-log.jsonl'),
      `${good}\n"a string"\n[1,2,3]\nnull\n`,
      'utf-8',
    );

    const warnings: string[] = [];
    const out = readRefreshLog(dir, 10, { warn: (s) => warnings.push(s) });
    expect(out).toHaveLength(1);
    expect(warnings[0]).toMatch(/skipped 3 corrupt line/);
  });
});
