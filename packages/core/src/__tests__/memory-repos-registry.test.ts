// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Living Memory Slice 5 A-03 — the ~/.massu/repos.json registry + the two config
 * opt-ins (both default OFF).
 *
 *  - DORMANCY: with no config change, reading the registry on a faked $HOME
 *    performs ZERO filesystem writes — the directory is left untouched (this is
 *    the state of every fresh install: off means NOTHING exists).
 *  - upsert creates repos.json LAZILY with mode 0600; idempotent by repo_id.
 *  - a corrupt/absent registry reads as EMPTY (dormant), never throws.
 *  - the config opt-ins default to enabled:false + subscribe:[] (no `subscribe:all`).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, statSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readReposRegistry,
  upsertRepoRegistration,
  reposRegistryPath,
  findRepoById,
  findRepoByLabel,
  type RepoRegistryEntry,
} from '../memory-repos-registry.ts';
import { MemoryConfigSchema } from '../config-memory-schema.ts';

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'massu-a03-home-'));
}
function entry(over: Partial<RepoRegistryEntry> = {}): RepoRegistryEntry {
  return {
    repo_id: '11111111-2222-4333-8444-555555555555',
    label: 'massu',
    pubkey_fingerprint: 'deadbeef',
    last_seen_path: '/tmp/massu',
    share_enabled: true,
    ...over,
  };
}

describe('A-03 repos registry', () => {
  it('A-03.1: DORMANT — reading the registry writes NOTHING (untouched $HOME)', () => {
    const home = freshHome();
    try {
      expect(readReposRegistry(home)).toEqual({ version: 1, repos: [] });
      // No file created, no .massu dir created — the home is byte-for-byte untouched.
      expect(existsSync(reposRegistryPath(home))).toBe(false);
      expect(existsSync(join(home, '.massu'))).toBe(false);
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('A-03.2: upsert creates repos.json LAZILY, mode 0600', () => {
    const home = freshHome();
    try {
      upsertRepoRegistration(entry(), home);
      const p = reposRegistryPath(home);
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(findRepoById(home, entry().repo_id)?.label).toBe('massu');
      expect(findRepoByLabel(home, 'massu')?.repo_id).toBe(entry().repo_id);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('A-03.3: idempotent by repo_id; distinct ids coexist', () => {
    const home = freshHome();
    try {
      upsertRepoRegistration(entry({ share_enabled: false }), home);
      upsertRepoRegistration(entry({ share_enabled: true }), home); // same id → replace
      expect(readReposRegistry(home).repos).toHaveLength(1);
      expect(findRepoById(home, entry().repo_id)?.share_enabled).toBe(true);
      upsertRepoRegistration(entry({ repo_id: '99999999-8888-4777-8666-555544443333', label: 'other' }), home);
      expect(readReposRegistry(home).repos).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('A-03.4: a corrupt registry reads as EMPTY (dormant), never throws', () => {
    const home = freshHome();
    try {
      mkdirSync(join(home, '.massu'), { recursive: true });
      writeFileSync(reposRegistryPath(home), '{ not valid json ', 'utf-8');
      expect(readReposRegistry(home)).toEqual({ version: 1, repos: [] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('A-03 config opt-ins (both default OFF)', () => {
  it('A-03.5: memory.share defaults to enabled:false + subscribe:[] (no `all`)', () => {
    const parsed = MemoryConfigSchema.parse({});
    expect(parsed?.share.enabled).toBe(false);
    expect(parsed?.share.subscribe).toEqual([]);
  });

  it('A-03.6: subscribe accepts an explicit label list', () => {
    const parsed = MemoryConfigSchema.parse({ share: { enabled: true, subscribe: ['massu', 'other'] } });
    expect(parsed?.share.enabled).toBe(true);
    expect(parsed?.share.subscribe).toEqual(['massu', 'other']);
  });
});
