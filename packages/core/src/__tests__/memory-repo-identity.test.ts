// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Living Memory Slice 5 A-02 — repo identity (repo_id / repo_label) + A-07 TOFU pins.
 *
 *  - A fresh repo (sharing off) has NO repo_id — mints nothing.
 *  - Enabling once mints a v4 UUID; enabling again is idempotent.
 *  - repo_label is deriveSlug(project.name); a hostile name (`../../etc`) yields a
 *    label matching SLUG_ALLOWED.
 *  - TOFU pins are set-once (never silently overwritten); an explicit re-pin does.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initMemorySchema } from '../memory-db.ts';
import { SLUG_ALLOWED } from '../lib/safe-write.ts';
import {
  getRepoId,
  mintRepoId,
  deriveRepoLabel,
  getSharedPin,
  tofuPinSharedFingerprint,
  repinSharedFingerprint,
} from '../memory-repo-identity.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  initMemorySchema(db);
});
afterEach(() => db.close());

describe('A-02 repo identity', () => {
  it('A-02.1: a fresh repo has no repo_id (dormant mints nothing)', () => {
    expect(getRepoId(db)).toBeNull();
  });

  it('A-02.2: mint on first share-enable, idempotent thereafter', () => {
    const id = mintRepoId(db);
    expect(id).toMatch(UUID_RE);
    expect(getRepoId(db)).toBe(id);
    expect(mintRepoId(db)).toBe(id); // idempotent — same id, mints nothing new
  });

  it('A-02.3: repo_label is slugged; a hostile project.name is neutralized', () => {
    expect(deriveRepoLabel('massu-internal')).toMatch(SLUG_ALLOWED);
    const hostile = deriveRepoLabel('../../etc');
    expect(hostile).toMatch(SLUG_ALLOWED);
    expect(hostile).not.toContain('/');
    expect(deriveRepoLabel('')).toBe('repo'); // empty slug → safe fallback
  });
});

describe('A-07 TOFU pins (memory_meta)', () => {
  const R = '11111111-2222-4333-8444-555555555555';

  it('A-07.pin.1: no pin initially; TOFU sets once and never silently overwrites', () => {
    expect(getSharedPin(db, R)).toBeNull();
    expect(tofuPinSharedFingerprint(db, R, 'fp-first')).toBe('fp-first');
    expect(getSharedPin(db, R)).toBe('fp-first');
    // A second TOFU attempt with a DIFFERENT fingerprint keeps the original.
    expect(tofuPinSharedFingerprint(db, R, 'fp-second')).toBe('fp-first');
    expect(getSharedPin(db, R)).toBe('fp-first');
  });

  it('A-07.pin.2: an explicit human re-pin overwrites', () => {
    tofuPinSharedFingerprint(db, R, 'fp-first');
    repinSharedFingerprint(db, R, 'fp-new');
    expect(getSharedPin(db, R)).toBe('fp-new');
  });
});
