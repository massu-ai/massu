// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-C-005: rule-candidate-applier tests.
// 4 mandated scenarios — (1) happy path, (2) rollback on Step-3 failure,
// (3) idempotency via duplicate prompt_hash, (4) snapshot-set NEW file
// restore-as-delete (strict `=== null` assertion).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initMemorySchema } from '../memory-db.ts';
import {
  applyRuleCandidate,
  takeSnapshots,
  restoreSnapshots,
  resolveMemoryDir,
  deriveSlug,
  type RuleCandidatePayload,
  CandidateNotFoundError,
  MemoryIndexMissingError,
} from '../rule-candidate-applier.ts';
import { encodeMemoryDirName } from '../lib/memory-path.ts';
import { _setCachedTierForTest, _resetCachedTier } from '../license.ts';

let tmpHome: string;
let tmpProjectRoot: string;
let db: Database.Database;

function setupTmpFixture(): void {
  tmpHome = mkdtempSync(join(tmpdir(), 'massu-applier-home-'));
  tmpProjectRoot = mkdtempSync(join(tmpdir(), 'massu-applier-proj-'));
  const memoryDir = join(tmpHome, '.claude', 'projects', encodeMemoryDirName(tmpProjectRoot), 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, 'MEMORY.md'), '# Memory Index\n\n- existing entry\n', 'utf-8');
  mkdirSync(join(tmpProjectRoot, '.massu', 'rule-candidates'), { recursive: true });
}

function teardownTmpFixture(): void {
  try {
    chmodSync(join(resolveMemoryDir(tmpProjectRoot, tmpHome), 'MEMORY.md'), 0o644);
  } catch { /* ok */ }
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpProjectRoot, { recursive: true, force: true });
}

function writeCandidate(payload: Partial<RuleCandidatePayload> = {}): string {
  const candidate: RuleCandidatePayload = {
    prompt: 'this is wrong, use getConfig() instead of yaml.load',
    prompt_hash: 'abc123def4567890',
    score: 90,
    signals: [
      { name: 'strong_correction_phrase', baseWeight: 40, applied: 40, evidence: 'matched "this is wrong"' },
      { name: 'prior_edit_or_write', baseWeight: 25, applied: 25 },
      { name: 'bugfix_or_refactor_category', baseWeight: 15, applied: 15 },
      { name: 'prompt_length_gt_10', baseWeight: 10, applied: 10 },
    ],
    prior_turn_files: ['packages/core/src/config-loader.ts'],
    timestamp: '2026-05-20T12:00:00Z',
    session_id: 'session-xyz',
    ...payload,
  };
  const path = join(tmpProjectRoot, '.massu', 'rule-candidates', `${candidate.prompt_hash}.json`);
  writeFileSync(path, JSON.stringify(candidate, null, 2), 'utf-8');
  return candidate.prompt_hash;
}

describe('rule-candidate-applier', () => {
  beforeEach(() => {
    setupTmpFixture();
    // CR-54: applyRuleCandidate is tier-gated (Pro+). Seed the in-memory tier
    // cache to Pro so the existing four-destination promotion tests stay green.
    _setCachedTierForTest('pro');
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initMemorySchema(db);
    db.prepare(`INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('session-xyz', datetime('now'), 0)`).run();
  });

  afterEach(() => {
    _resetCachedTier();
    db.close();
    teardownTmpFixture();
  });

  describe('Scenario 1: happy path (corrections-md)', () => {
    it('runs the 4-step transaction end-to-end', async () => {
      const id = writeCandidate();
      const result = await applyRuleCandidate(db, {
        candidateId: id,
        destination: 'corrections-md',
        draftText: 'Always use getConfig() from config.ts. Direct yaml.load bypasses caching.',
        projectRoot: tmpProjectRoot,
        home: tmpHome,
      });
      expect(result.ok).toBe(true);
      expect(result.idempotent_noop).toBeFalsy();
      expect(result.audit_log_id).toBeGreaterThan(0);

      const memDir = resolveMemoryDir(tmpProjectRoot, tmpHome);
      const slug = deriveSlug('this is wrong, use getConfig() instead of yaml.load');
      const correctionsMd = readFileSync(join(memDir, 'corrections.md'), 'utf-8');
      expect(correctionsMd).toContain(slug);
      expect(correctionsMd).toContain('prompt_hash: abc123def4567890');

      const feedbackMd = readFileSync(join(memDir, `feedback_${slug}.md`), 'utf-8');
      expect(feedbackMd).toMatch(/^---/);
      expect(feedbackMd).toContain('source: interactive');
      expect(feedbackMd).toContain('prompt_hash: abc123def4567890');

      const memoryIndex = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
      expect(memoryIndex).toContain(`feedback_${slug}.md`);
      expect(memoryIndex).toContain('# Memory Index');

      const candidatePath = join(tmpProjectRoot, '.massu', 'rule-candidates', `${id}.json`);
      expect(existsSync(candidatePath)).toBe(false);

      const auditRow = db.prepare(`SELECT event_type, metadata FROM audit_log WHERE id = ?`).get(result.audit_log_id) as { event_type: string; metadata: string };
      expect(auditRow.event_type).toBe('rule_promoted');
      const meta = JSON.parse(auditRow.metadata);
      expect(meta.prompt_hash).toBe('abc123def4567890');
      expect(meta.recurrence_count).toBe(0);
    });
  });

  describe('Scenario 2: rollback on Step-3 failure (MEMORY.md write blocked)', () => {
    it('restores all snapshotted files and leaves candidate in place', async () => {
      const id = writeCandidate();
      const memDir = resolveMemoryDir(tmpProjectRoot, tmpHome);
      const memoryIndexPath = join(memDir, 'MEMORY.md');
      const preIndex = readFileSync(memoryIndexPath, 'utf-8');

      // Make MEMORY.md read-only — Step 3 append will throw EACCES.
      // (Note: skip on platforms that ignore chmod for the test owner.)
      chmodSync(memoryIndexPath, 0o444);
      const stat = statSync(memoryIndexPath);
      const writableByOwner = (stat.mode & 0o200) !== 0;
      if (writableByOwner) {
        // chmod was a no-op on this platform; skip the test honestly rather
        // than passing a false positive.
        chmodSync(memoryIndexPath, 0o644);
        return;
      }

      try {
        const result = await applyRuleCandidate(db, {
          candidateId: id,
          destination: 'corrections-md',
          draftText: 'rule body',
          projectRoot: tmpProjectRoot,
          home: tmpHome,
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/EACCES|permission|EPERM/i);

        // MEMORY.md restored to pre-write content
        chmodSync(memoryIndexPath, 0o644);
        const postIndex = readFileSync(memoryIndexPath, 'utf-8');
        expect(postIndex).toBe(preIndex);

        // corrections.md should NOT exist (was a NEW file pre-write, snapshot null)
        expect(existsSync(join(memDir, 'corrections.md'))).toBe(false);

        // feedback_<slug>.md should NOT exist (also a NEW file pre-write)
        const slug = deriveSlug('this is wrong, use getConfig() instead of yaml.load');
        expect(existsSync(join(memDir, `feedback_${slug}.md`))).toBe(false);

        // candidate file remains for retry
        expect(existsSync(join(tmpProjectRoot, '.massu', 'rule-candidates', `${id}.json`))).toBe(true);

        // audit_log row rolled back
        const auditCount = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type='rule_promoted'`).get() as { n: number }).n;
        expect(auditCount).toBe(0);

        // failure log appended
        const failureLog = join(tmpProjectRoot, '.massu', 'rule-candidates', '.failures.jsonl');
        expect(existsSync(failureLog)).toBe(true);
        const lastLine = readFileSync(failureLog, 'utf-8').trim().split('\n').pop()!;
        expect(JSON.parse(lastLine).candidate_id).toBe(id);
      } finally {
        chmodSync(memoryIndexPath, 0o644);
      }
    });
  });

  describe('Scenario 3: idempotency via duplicate prompt_hash', () => {
    it('second call with same prompt_hash returns idempotent_noop', async () => {
      const id = writeCandidate();
      const first = await applyRuleCandidate(db, {
        candidateId: id,
        destination: 'corrections-md',
        draftText: 'rule body',
        projectRoot: tmpProjectRoot,
        home: tmpHome,
      });
      expect(first.ok).toBe(true);
      expect(first.idempotent_noop).toBeFalsy();

      // Re-write the candidate sidecar (the first run deleted it) so the
      // re-applier reaches Step 1 and trips the UNIQUE index.
      writeCandidate();
      const second = await applyRuleCandidate(db, {
        candidateId: id,
        destination: 'corrections-md',
        draftText: 'rule body',
        projectRoot: tmpProjectRoot,
        home: tmpHome,
      });
      expect(second.ok).toBe(true);
      expect(second.idempotent_noop).toBe(true);

      // Only one promoted row in audit_log
      const promotedCount = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type='rule_promoted'`).get() as { n: number }).n;
      expect(promotedCount).toBe(1);
    });
  });

  describe('Scenario 4: snapshot-set NEW file restored as delete (=== null)', () => {
    it('NEW file path has snapshot.get(path) === null strictly', () => {
      const newPath = join(tmpProjectRoot, 'definitely-does-not-exist.md');
      const snapshot = takeSnapshots([newPath]);
      expect(snapshot.get(newPath)).toBeNull();
      // Sanity: empty-string content is NOT the same as ABSENT.
      expect(snapshot.get(newPath)).not.toBe('');
      expect(snapshot.get(newPath)).not.toBe(undefined);
    });

    it('restoreSnapshots() unlinks files whose snapshot value is null', () => {
      const newPath = join(tmpProjectRoot, 'created-then-rolled-back.md');
      const snapshot = takeSnapshots([newPath]);
      expect(snapshot.get(newPath)).toBeNull();
      writeFileSync(newPath, 'created mid-transaction', 'utf-8');
      expect(existsSync(newPath)).toBe(true);
      restoreSnapshots(snapshot);
      expect(existsSync(newPath)).toBe(false);
    });

    it('restoreSnapshots() rewrites files whose snapshot value is a string (empty included)', () => {
      const emptyPath = join(tmpProjectRoot, 'empty-pre-write.md');
      writeFileSync(emptyPath, '', 'utf-8');
      const snapshot = takeSnapshots([emptyPath]);
      expect(snapshot.get(emptyPath)).toBe('');
      writeFileSync(emptyPath, 'overwritten body', 'utf-8');
      restoreSnapshots(snapshot);
      expect(readFileSync(emptyPath, 'utf-8')).toBe('');
    });
  });

  describe('Preconditions and errors', () => {
    it('refuses with MemoryIndexMissingError when MEMORY.md absent', async () => {
      const memDir = resolveMemoryDir(tmpProjectRoot, tmpHome);
      rmSync(join(memDir, 'MEMORY.md'));
      const id = writeCandidate();
      await expect(applyRuleCandidate(db, {
        candidateId: id,
        destination: 'corrections-md',
        draftText: 'body',
        projectRoot: tmpProjectRoot,
        home: tmpHome,
      })).rejects.toThrow(MemoryIndexMissingError);
    });

    it('throws CandidateNotFoundError on missing sidecar (valid id shape, file absent)', async () => {
      await expect(applyRuleCandidate(db, {
        // SEC-01: id MUST be 16 hex chars; using a valid-shape id that
        // does not exist on disk exercises the file-not-found branch.
        candidateId: 'deadbeefcafe1234',
        destination: 'corrections-md',
        draftText: 'body',
        projectRoot: tmpProjectRoot,
        home: tmpHome,
      })).rejects.toThrow(CandidateNotFoundError);
    });

    it('throws InvalidCandidateIdError on malformed candidateId (path traversal guard)', async () => {
      const { InvalidCandidateIdError } = await import('../rule-candidate-applier.ts');
      for (const bogus of ['nonexistent', '../../../tmp/foo', 'A'.repeat(16), '../../../etc/passwd']) {
        await expect(applyRuleCandidate(db, {
          candidateId: bogus,
          destination: 'corrections-md',
          draftText: 'body',
          projectRoot: tmpProjectRoot,
          home: tmpHome,
        })).rejects.toThrow(InvalidCandidateIdError);
      }
    });

    it('non-corrections-md destinations require their config args', async () => {
      const id = writeCandidate();
      // pattern-scanner without patternScannerCheckNumber
      let result = await applyRuleCandidate(db, {
        candidateId: id, destination: 'pattern-scanner', draftText: 'body',
        projectRoot: tmpProjectRoot, home: tmpHome,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/patternScannerCheckNumber/);

      // claude-md-cr without claudeMdCrNumber
      result = await applyRuleCandidate(db, {
        candidateId: id, destination: 'claude-md-cr', draftText: 'body',
        projectRoot: tmpProjectRoot, home: tmpHome,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/claudeMdCrNumber/);

      // custom-destination without customDestination
      result = await applyRuleCandidate(db, {
        candidateId: id, destination: 'custom-destination', draftText: 'body',
        projectRoot: tmpProjectRoot, home: tmpHome,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/customDestination/);
    });
  });

  describe('CR-54: tier gate (Free refused / Pro works)', () => {
    it('Free tier → refused with tier_refused; ZERO mutation', async () => {
      _setCachedTierForTest('free');
      const id = writeCandidate();
      const memDir = resolveMemoryDir(tmpProjectRoot, tmpHome);
      const memoryIndexPre = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');

      const result = await applyRuleCandidate(db, {
        candidateId: id,
        destination: 'corrections-md',
        draftText: 'Always use getConfig() instead of yaml.load.',
        projectRoot: tmpProjectRoot,
        home: tmpHome,
      });

      expect(result.ok).toBe(false);
      expect(result.tier_refused).toBe(true);
      expect(result.error).toContain('https://massu.ai/pricing');

      // No audit_log row.
      const promoted = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type='rule_promoted'`).get() as { n: number }).n;
      expect(promoted).toBe(0);
      // No destination edit (corrections.md / feedback file never created).
      expect(existsSync(join(memDir, 'corrections.md'))).toBe(false);
      const slug = deriveSlug('this is wrong, use getConfig() instead of yaml.load');
      expect(existsSync(join(memDir, `feedback_${slug}.md`))).toBe(false);
      // MEMORY.md not appended.
      expect(readFileSync(join(memDir, 'MEMORY.md'), 'utf-8')).toBe(memoryIndexPre);
      // Candidate sidecar untouched (left in place).
      expect(existsSync(join(tmpProjectRoot, '.massu', 'rule-candidates', `${id}.json`))).toBe(true);
    });

    it('Pro tier → promotion succeeds as before', async () => {
      _setCachedTierForTest('pro');
      const id = writeCandidate();
      const result = await applyRuleCandidate(db, {
        candidateId: id,
        destination: 'corrections-md',
        draftText: 'Always use getConfig() instead of yaml.load.',
        projectRoot: tmpProjectRoot,
        home: tmpHome,
      });
      expect(result.ok).toBe(true);
      expect(result.tier_refused).toBeFalsy();
      expect(result.audit_log_id).toBeGreaterThan(0);
    });
  });
});
