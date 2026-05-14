// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Tests for the shared settings.local.json IO helper (SSOT for
 * install-commands / init.ts installHooks / doctor.ts and the new
 * permissions.ts:readGlobalSettings consumer).
 *
 * SLOC-01..06 cover read+write semantics under all degenerate-input paths.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  readSettingsLocal,
  writeSettingsLocalAtomic,
  readSettingsAtPath,
  atomicWriteFile,
} from '../lib/settings-local.ts';

const createdDirs: string[] = [];

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `massu-settings-local-test-${prefix}-`));
  createdDirs.push(d);
  return d;
}

function cleanupAll(): void {
  while (createdDirs.length) {
    const d = createdDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

afterEach(cleanupAll);

describe('lib/settings-local — SLOC-01..06', () => {
  it('SLOC-01: readSettingsLocal returns {} when file missing', () => {
    const claudeDir = mkTmp('sloc-01');
    expect(readSettingsLocal(claudeDir)).toEqual({});
  });

  it('SLOC-02: readSettingsLocal returns {} when JSON corrupt', () => {
    const claudeDir = mkTmp('sloc-02');
    writeFileSync(resolve(claudeDir, 'settings.local.json'), '{invalid json}', 'utf-8');
    expect(readSettingsLocal(claudeDir)).toEqual({});
  });

  it('SLOC-03: writeSettingsLocalAtomic creates parent dir and emits valid JSON', () => {
    const baseDir = mkTmp('sloc-03');
    // Pass a NESTED claudeDir that does not exist yet
    const claudeDir = resolve(baseDir, 'nested', '.claude');
    writeSettingsLocalAtomic(claudeDir, { foo: 'bar', nested: { count: 3 } });

    const target = resolve(claudeDir, 'settings.local.json');
    expect(existsSync(target)).toBe(true);
    const parsed = JSON.parse(readFileSync(target, 'utf-8'));
    expect(parsed).toEqual({ foo: 'bar', nested: { count: 3 } });
  });

  it('SLOC-04: atomicWriteFile leaves no intermediate .tmp file after success', () => {
    const dir = mkTmp('sloc-04');
    const target = resolve(dir, 'output.txt');
    atomicWriteFile(target, 'hello world');

    expect(readFileSync(target, 'utf-8')).toBe('hello world');
    // Verify no stray tmp files survive
    const entries = readdirSync(dir);
    const tmpEntries = entries.filter((e) => e.endsWith('.tmp'));
    expect(tmpEntries).toEqual([]);
  });

  it('SLOC-05: readSettingsAtPath returns {} for arbitrary nonexistent absolute path', () => {
    const result = readSettingsAtPath('/tmp/massu-settings-local-test-nonexistent-9999.json');
    expect(result).toEqual({});
  });

  it('SLOC-06: readSettingsAtPath parses valid JSON when file exists', () => {
    const dir = mkTmp('sloc-06');
    const target = resolve(dir, 'arbitrary-config.json');
    writeFileSync(target, JSON.stringify({ permissions: { defaultMode: 'auto' } }), 'utf-8');

    const result = readSettingsAtPath(target);
    expect(result).toEqual({ permissions: { defaultMode: 'auto' } });
  });

  it('SLOC-extra: readSettingsAtPath returns {} when JSON root is an array (defensive shape check)', () => {
    const dir = mkTmp('sloc-extra');
    const target = resolve(dir, 'array-root.json');
    writeFileSync(target, JSON.stringify(['not', 'an', 'object']), 'utf-8');
    expect(readSettingsAtPath(target)).toEqual({});
  });
});
