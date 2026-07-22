// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Living Memory Slice 5 A-04 (D1) drift-guard — the apply gate is an ALLOWLIST.
 *
 * D1: a candidate whose provenance origin is unrecognized (or a cross-repo
 * `repo:<uuid>`) must NEVER fall through to the ungated local apply path. Slice 5
 * inverts the gate so:
 *   - a `repo:<uuid>` provenance sidecar is REFUSED before any mutation (a
 *     cross-repo memory is not a rule; its path is `acceptSharedMemory`, B-05);
 *   - an UNRECOGNIZED origin (`'anything'`) is refused at payload validation;
 *   - both refuse with ZERO rows / ZERO file bytes changed (asserted by count);
 *   - the gate is expressed as "provenance present ⇒ recognized origin", not as a
 *     two-literal `origin === 'team' || origin === 'pack'` enumeration (source AST).
 *
 * Entitlement is seeded to Pro so the ORIGIN gate — not the Free tier gate — is
 * what refuses (both refuse with zero mutation, but we assert the origin path).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  chmodSync,
} from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initMemorySchema } from '../memory-db.ts';
import { applyRuleCandidate, resolveMemoryDir, CandidatePayloadValidationError } from '../rule-candidate-applier.ts';
import { encodeMemoryDirName } from '../lib/memory-path.ts';
import { _setCachedTierForTest, _resetCachedTier } from '../license.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLIER_SRC = resolve(__dirname, '..', 'rule-candidate-applier.ts');

let tmpHome: string;
let tmpProjectRoot: string;
let db: Database.Database;

function setup(): void {
  tmpHome = mkdtempSync(join(tmpdir(), 'massu-a04-home-'));
  tmpProjectRoot = mkdtempSync(join(tmpdir(), 'massu-a04-proj-'));
  const memoryDir = join(tmpHome, '.claude', 'projects', encodeMemoryDirName(tmpProjectRoot), 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, 'MEMORY.md'), '# Memory Index\n\n- existing entry\n', 'utf-8');
  mkdirSync(join(tmpProjectRoot, '.massu', 'rule-candidates'), { recursive: true });
}

function teardown(): void {
  try {
    chmodSync(join(resolveMemoryDir(tmpProjectRoot, tmpHome), 'MEMORY.md'), 0o644);
  } catch { /* ok */ }
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpProjectRoot, { recursive: true, force: true });
}

/** Write a raw candidate sidecar (bypasses the typed helper so we can plant an
 *  arbitrary provenance.origin the type system would reject). */
function writeRawCandidate(promptHash: string, extra: Record<string, unknown>): void {
  const candidate = {
    prompt: 'a cross-repo memory masquerading as a rule',
    prompt_hash: promptHash,
    score: 50,
    signals: [{ name: 's', baseWeight: 10, applied: 10 }],
    prior_turn_files: [],
    timestamp: '2026-07-21T00:00:00Z',
    session_id: 'session-a04',
    ...extra,
  };
  writeFileSync(
    join(tmpProjectRoot, '.massu', 'rule-candidates', `${promptHash}.json`),
    JSON.stringify(candidate, null, 2),
    'utf-8',
  );
}

/** A stable fingerprint of all mutation surfaces: DB row counts + every file byte
 *  under the memory dir and the rule-candidates dir. */
function mutationFingerprint(): string {
  const obs = (db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n;
  const audit = (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
  const dirs = [resolveMemoryDir(tmpProjectRoot, tmpHome), join(tmpProjectRoot, '.massu', 'rule-candidates')];
  const files: string[] = [];
  for (const d of dirs) {
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { /* dir may be absent */ }
    for (const f of entries.sort()) {
      const p = join(d, f);
      try {
        if (statSync(p).isFile()) files.push(`${p}:${readFileSync(p, 'utf-8')}`);
      } catch { /* ok */ }
    }
  }
  return `obs=${obs};audit=${audit};\n${files.join('\n')}`;
}

describe('A-04 cross-repo apply-gate drift-guard (D1)', () => {
  beforeEach(() => {
    setup();
    _setCachedTierForTest('pro'); // entitlement PASSES → the origin gate is what refuses
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initMemorySchema(db);
    db.prepare(`INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('session-a04', datetime('now'), 0)`).run();
  });
  afterEach(() => {
    _resetCachedTier();
    db.close();
    teardown();
  });

  it('A-04.1: a repo:<uuid> provenance sidecar is REFUSED with ZERO mutation', async () => {
    writeRawCandidate('aaaa1111bbbb2222', {
      provenance: { origin: 'repo:11111111-2222-4333-8444-555555555555' },
    });
    const before = mutationFingerprint(); // sidecar is INPUT, not a mutation
    const result = await applyRuleCandidate(db, {
      candidateId: 'aaaa1111bbbb2222',
      destination: 'corrections-md',
      draftText: 'irrelevant',
      projectRoot: tmpProjectRoot,
      home: tmpHome,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cross-repo \(repo:\) provenance is not applied via the rule path/);
    // ZERO mutation — refused BEFORE takeSnapshots / BEGIN.
    expect(mutationFingerprint()).toBe(before);
  });

  it('A-04.2: an UNRECOGNIZED origin is refused at validation with ZERO mutation', async () => {
    writeRawCandidate('cccc3333dddd4444', {
      provenance: { origin: 'anything', org_id: 'x', promoted_by: 'y', promoted_at: 'z', signature_verified: true },
    });
    const before = mutationFingerprint();
    await expect(
      applyRuleCandidate(db, {
        candidateId: 'cccc3333dddd4444',
        destination: 'corrections-md',
        draftText: 'irrelevant',
        projectRoot: tmpProjectRoot,
        home: tmpHome,
      }),
    ).rejects.toBeInstanceOf(CandidatePayloadValidationError);
    expect(mutationFingerprint()).toBe(before);
  });

  it('A-04.3: a malformed repo: origin (bad uuid) is refused with ZERO mutation', async () => {
    writeRawCandidate('eeee5555ffff6666', { provenance: { origin: 'repo:not-a-uuid' } });
    const before = mutationFingerprint();
    await expect(
      applyRuleCandidate(db, {
        candidateId: 'eeee5555ffff6666',
        destination: 'corrections-md',
        draftText: 'irrelevant',
        projectRoot: tmpProjectRoot,
        home: tmpHome,
      }),
    ).rejects.toBeInstanceOf(CandidatePayloadValidationError);
    expect(mutationFingerprint()).toBe(before);
  });

  it('A-04.4: the gate is allowlist-shaped in source, not a two-literal enumeration', () => {
    const src = readFileSync(APPLIER_SRC, 'utf-8');
    // The apply gate opens on "provenance present", not on the old two-literal `||`.
    expect(src).toContain('if (candidate.provenance !== undefined) {');
    // The recognized cross-repo origin is checked via the shared predicate (allowlist),
    // not re-spelled inline.
    expect(src).toContain('isCrossRepoOrigin(provOrigin)');
    // The validator recognizes repo: as first-class (via the predicate), so a repo:
    // origin no longer throws "must be 'team' or 'pack'".
    expect(src).toContain('isCrossRepoOrigin(origin)');
    expect(src).not.toContain("provenance.origin must be 'team' or 'pack'");
  });
});
