// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PB-010 (plan-2026-05-28-team-shared-rule-promotion): tier + destination-
 * allowlist cases for the applier's team-shared publish branch and team-origin
 * apply gate.
 *
 *  - Team + shareable destination → team_shared:true + outbound enqueued.
 *  - (H1) Team + pattern-scanner → team_shared:false, NOT enqueued.
 *  - Pro → team_shared:false, NOT enqueued.
 *  - team-origin candidate: tier<team → tier_refused (zero mutation);
 *    signature_verified:false → refused (zero mutation); non-shareable
 *    destination → refused; verified + Team + shareable → applies normally.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initMemorySchema } from '../memory-db.ts';
import {
  applyRuleCandidate,
  resolveMemoryDir,
  type RuleCandidatePayload,
  type RuleCandidateProvenance,
} from '../rule-candidate-applier.ts';
import { encodeMemoryDirName } from '../lib/memory-path.ts';
import { _setCachedTierForTest, _resetCachedTier, type ToolTier } from '../license.ts';

let tmpHome: string;
let tmpProjectRoot: string;
let db: Database.Database;

function setup(): void {
  tmpHome = mkdtempSync(join(tmpdir(), 'massu-ts-home-'));
  tmpProjectRoot = mkdtempSync(join(tmpdir(), 'massu-ts-proj-'));
  const memoryDir = join(tmpHome, '.claude', 'projects', encodeMemoryDirName(tmpProjectRoot), 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, 'MEMORY.md'), '# Memory Index\n\n- existing\n', 'utf-8');
  mkdirSync(join(tmpProjectRoot, '.massu', 'rule-candidates'), { recursive: true });
  // pattern-scanner destination writes scripts/massu-pattern-scanner.sh + a
  // drift-guard under packages/core/src/__tests__ — their dirs must exist.
  mkdirSync(join(tmpProjectRoot, 'scripts'), { recursive: true });
  mkdirSync(join(tmpProjectRoot, 'packages', 'core', 'src', '__tests__'), { recursive: true });
}

function teardown(): void {
  try { chmodSync(join(resolveMemoryDir(tmpProjectRoot, tmpHome), 'MEMORY.md'), 0o644); } catch { /* ok */ }
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpProjectRoot, { recursive: true, force: true });
}

function writeCandidate(payload: Partial<RuleCandidatePayload> = {}): string {
  const candidate: RuleCandidatePayload = {
    prompt: 'always prefer getConfig() over yaml.load',
    prompt_hash: 'abc123def4567890',
    score: 80,
    signals: [{ name: 'strong_correction_phrase', baseWeight: 40, applied: 40 }],
    prior_turn_files: [],
    timestamp: '2026-05-31T12:00:00Z',
    session_id: 'session-xyz',
    ...payload,
  };
  // ARCH-FIX (destination fidelity): a provenance-bearing (team|pack) sidecar MUST
  // carry an authoritative stored destination — exactly as real materialization
  // writes it. Default it to corrections-md when a provenance test does not pin one
  // explicitly (matches the shareable-destination path the existing cases exercise).
  if (candidate.provenance !== undefined && candidate.destination === undefined) {
    candidate.destination = 'corrections-md';
  }
  const path = join(tmpProjectRoot, '.massu', 'rule-candidates', `${candidate.prompt_hash}.json`);
  writeFileSync(path, JSON.stringify(candidate, null, 2), 'utf-8');
  return candidate.prompt_hash;
}

function teamProvenance(over: Partial<RuleCandidateProvenance> = {}): RuleCandidateProvenance {
  return { origin: 'team', org_id: 'org-1', promoted_by: 'u2', promoted_at: '2026-05-31T00:00:00Z', signature_verified: true, ...over };
}

function packProvenance(over: Partial<RuleCandidateProvenance> = {}): RuleCandidateProvenance {
  return {
    origin: 'pack',
    org_id: 'org-1',
    promoted_by: 'pack:sec-baseline',
    promoted_at: '2026-05-31T00:00:00Z',
    signature_verified: true,
    pack_slug: 'sec-baseline',
    pack_version: '1.0.0',
    ...over,
  };
}

function outboundCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM team_promotion_outbound').get() as { n: number }).n;
}
function auditPromotedCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type='rule_promoted'").get() as { n: number }).n;
}
function correctionsMdExists(): boolean {
  return existsSync(join(resolveMemoryDir(tmpProjectRoot, tmpHome), 'corrections.md'));
}

function setTier(t: ToolTier): void { _setCachedTierForTest(t); }

beforeEach(() => {
  setup();
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initMemorySchema(db);
  db.prepare(`INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('session-xyz', datetime('now'), 0)`).run();
});

afterEach(() => {
  _resetCachedTier();
  db.close();
  teardown();
});

describe('PB-010: team-shared publish branch', () => {
  it('Team + shareable destination → team_shared:true + outbound enqueued', async () => {
    setTier('team');
    const id = writeCandidate();
    const res = await applyRuleCandidate(db, {
      candidateId: id, destination: 'corrections-md', draftText: 'Use getConfig().',
      projectRoot: tmpProjectRoot, home: tmpHome,
    });
    expect(res.ok).toBe(true);
    expect(res.team_shared).toBe(true);
    expect(outboundCount()).toBe(1);
    const row = db.prepare('SELECT prompt_hash, destination, content_hash FROM team_promotion_outbound').get() as Record<string, unknown>;
    expect(row.prompt_hash).toBe('abc123def4567890');
    expect(row.destination).toBe('corrections-md');
    expect(typeof row.content_hash).toBe('string');
    expect((row.content_hash as string).length).toBe(64);
  });

  it('(H1) Team + pattern-scanner → team_shared:false, NOT enqueued', async () => {
    setTier('team');
    const id = writeCandidate();
    const res = await applyRuleCandidate(db, {
      candidateId: id, destination: 'pattern-scanner', draftText: 'grep -q foo bar || exit 1',
      patternScannerCheckNumber: 99, projectRoot: tmpProjectRoot, home: tmpHome,
    });
    expect(res.ok).toBe(true);
    expect(res.team_shared).toBeFalsy();
    expect(outboundCount()).toBe(0);
  });

  it('Pro → team_shared:false, NOT enqueued', async () => {
    setTier('pro');
    const id = writeCandidate();
    const res = await applyRuleCandidate(db, {
      candidateId: id, destination: 'corrections-md', draftText: 'Use getConfig().',
      projectRoot: tmpProjectRoot, home: tmpHome,
    });
    expect(res.ok).toBe(true);
    expect(res.team_shared).toBeFalsy();
    expect(outboundCount()).toBe(0);
  });
});

describe('PB-010: team-origin apply gate', () => {
  it('tier < team → tier_refused with ZERO mutation', async () => {
    setTier('pro');
    const id = writeCandidate({ provenance: teamProvenance() });
    const res = await applyRuleCandidate(db, {
      candidateId: id, destination: 'corrections-md', draftText: 'shared rule',
      projectRoot: tmpProjectRoot, home: tmpHome,
    });
    expect(res.ok).toBe(false);
    expect(res.tier_refused).toBe(true);
    expect(correctionsMdExists()).toBe(false);
    expect(auditPromotedCount()).toBe(0);
    // candidate sidecar untouched
    expect(existsSync(join(tmpProjectRoot, '.massu', 'rule-candidates', `${id}.json`))).toBe(true);
  });

  it('signature_verified:false → refused with ZERO mutation', async () => {
    setTier('team');
    const id = writeCandidate({ provenance: teamProvenance({ signature_verified: false }) });
    const res = await applyRuleCandidate(db, {
      candidateId: id, destination: 'corrections-md', draftText: 'shared rule',
      projectRoot: tmpProjectRoot, home: tmpHome,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unverified provenance/);
    expect(correctionsMdExists()).toBe(false);
    expect(auditPromotedCount()).toBe(0);
  });

  it('(H1) hardened destination on a NON-hardened team candidate → refused (Phase 3 PA3-004)', async () => {
    setTier('team');
    // A team candidate to an executable destination WITHOUT hardened provenance is
    // refused at the hardened apply-gate (missing hardened flag). Phase 3 lets the
    // executable destinations propagate ONLY behind the hardened-review path; a
    // plain (non-hardened) team candidate targeting one is still refused, zero mutation.
    // The stored destination IS pattern-scanner (its authored destination), so the
    // ARCH-FIX destination-fidelity check passes and the hardened apply-gate fires.
    const id = writeCandidate({ provenance: teamProvenance(), destination: 'pattern-scanner' });
    const res = await applyRuleCandidate(db, {
      candidateId: id, destination: 'pattern-scanner', draftText: 'echo hi',
      patternScannerCheckNumber: 99, projectRoot: tmpProjectRoot, home: tmpHome,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/hardened provenance flag/);
    expect(auditPromotedCount()).toBe(0);
  });

  it('verified + Team + shareable → applies via the normal chokepoint (and is NOT re-published)', async () => {
    setTier('team');
    const id = writeCandidate({ provenance: teamProvenance() });
    const res = await applyRuleCandidate(db, {
      candidateId: id, destination: 'corrections-md', draftText: 'shared rule body',
      projectRoot: tmpProjectRoot, home: tmpHome,
    });
    expect(res.ok).toBe(true);
    expect(correctionsMdExists()).toBe(true);
    expect(auditPromotedCount()).toBe(1);
    // echo-loop guard: a team-ORIGIN candidate is not re-enqueued for publish.
    expect(res.team_shared).toBeFalsy();
    expect(outboundCount()).toBe(0);
  });
});

describe('ARCH-FIX 1 (FIX-4): destination fidelity — provenance-bearing candidates apply only to their authored destination', () => {
  it('PACK-origin: refused when opts.destination differs from the stored destination (zero mutation)', async () => {
    setTier('team');
    // Authored destination is claude-md-cr; an approve flow that re-classified to
    // corrections-md must be structurally refused BEFORE any mutation.
    const id = writeCandidate({
      provenance: packProvenance(),
      destination: 'claude-md-cr',
      draft_text: 'CR body',
    });
    const res = await applyRuleCandidate(db, {
      candidateId: id, destination: 'corrections-md', draftText: 'CR body',
      projectRoot: tmpProjectRoot, home: tmpHome,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/destination mismatch/);
    expect(correctionsMdExists()).toBe(false);
    expect(auditPromotedCount()).toBe(0);
    // sidecar left in place for retry
    expect(existsSync(join(tmpProjectRoot, '.massu', 'rule-candidates', `${id}.json`))).toBe(true);
  });

  it('TEAM-origin: refused when opts.destination differs from the stored destination (zero mutation)', async () => {
    setTier('team');
    const id = writeCandidate({
      provenance: teamProvenance(),
      destination: 'claude-md-cr',
      draft_text: 'CR body',
    });
    const res = await applyRuleCandidate(db, {
      candidateId: id, destination: 'corrections-md', draftText: 'CR body',
      projectRoot: tmpProjectRoot, home: tmpHome,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/destination mismatch/);
    expect(auditPromotedCount()).toBe(0);
  });

  it('PACK-origin: ACCEPTED when opts.destination matches the stored destination', async () => {
    setTier('team');
    const id = writeCandidate({
      provenance: packProvenance(),
      destination: 'corrections-md',
      draft_text: 'shared pack rule body',
    });
    const res = await applyRuleCandidate(db, {
      candidateId: id, destination: 'corrections-md', draftText: 'shared pack rule body',
      projectRoot: tmpProjectRoot, home: tmpHome,
    });
    expect(res.ok).toBe(true);
    expect(correctionsMdExists()).toBe(true);
    expect(auditPromotedCount()).toBe(1);
    // pack-origin candidate is NOT re-published cross-seat
    expect(res.team_shared).toBeFalsy();
    expect(outboundCount()).toBe(0);
  });

  it('TEAM-origin: ACCEPTED when opts.destination matches the stored destination', async () => {
    setTier('team');
    const id = writeCandidate({
      provenance: teamProvenance(),
      destination: 'corrections-md',
      draft_text: 'shared rule body',
    });
    const res = await applyRuleCandidate(db, {
      candidateId: id, destination: 'corrections-md', draftText: 'shared rule body',
      projectRoot: tmpProjectRoot, home: tmpHome,
    });
    expect(res.ok).toBe(true);
    expect(correctionsMdExists()).toBe(true);
    expect(auditPromotedCount()).toBe(1);
  });
});
