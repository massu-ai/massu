// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval Phase 1.5 review fixes:
// - ARCH-01: claude-md-cr writer splices the Canonical Rules table row + body
// - ARCH-02: dismissRuleCandidate() writes the dismissal-loop UPSERT
// - SEC-02: realpathSync symlink-bypass guard on custom-destination paths
// - SEC-03: opts.slug is always re-sanitized through deriveSlug regardless of source
// - SEC-04: candidate payload validated at runtime before write

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initMemorySchema } from '../memory-db.ts';
import {
  applyRuleCandidate,
  dismissRuleCandidate,
  type RuleCandidatePayload,
  CandidatePayloadValidationError,
  InvalidCandidateIdError,
} from '../rule-candidate-applier.ts';
import { encodeMemoryDirName } from '../lib/memory-path.ts';
import type { CustomDestinationConfig } from '../rule-classifier.ts';
import { _setCachedTierForTest, _resetCachedTier } from '../license.ts';

let tmpHome: string;
let tmpProjectRoot: string;
let db: Database.Database;

function setup(): void {
  tmpHome = mkdtempSync(join(tmpdir(), 'massu-arch-home-'));
  tmpProjectRoot = mkdtempSync(join(tmpdir(), 'massu-arch-proj-'));
  const memoryDir = join(tmpHome, '.claude', 'projects', encodeMemoryDirName(tmpProjectRoot), 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, 'MEMORY.md'), '# Memory Index\n', 'utf-8');
  mkdirSync(join(tmpProjectRoot, '.massu', 'rule-candidates'), { recursive: true });
  mkdirSync(join(tmpProjectRoot, '.claude'), { recursive: true });
  writeFileSync(join(tmpProjectRoot, '.claude', 'CLAUDE.md'),
    '# CLAUDE.md\n\n## Canonical Rules\n\n| ID | Rule | Verification Type |\n|---|---|---|\n| CR-1 | first | VR-A |\n| CR-2 | second | VR-B |\n\n## Body\n\n### CR-1: first body\n',
    'utf-8');
}

function teardown(): void {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpProjectRoot, { recursive: true, force: true });
}

function writeCandidate(hash = 'abc123def4567890'): string {
  const candidate: RuleCandidatePayload = {
    prompt: 'this is wrong, use getConfig() instead of yaml.load',
    prompt_hash: hash,
    score: 90,
    signals: [
      { name: 'strong_correction_phrase', baseWeight: 40, applied: 40 },
      { name: 'prior_edit_or_write', baseWeight: 25, applied: 25 },
      { name: 'bugfix_or_refactor_category', baseWeight: 15, applied: 15 },
      { name: 'prompt_length_gt_10', baseWeight: 10, applied: 10 },
    ],
    prior_turn_files: ['packages/core/src/foo.ts'],
    timestamp: '2026-05-20T12:00:00Z',
    session_id: 'session-arch',
  };
  const path = join(tmpProjectRoot, '.massu', 'rule-candidates', `${candidate.prompt_hash}.json`);
  writeFileSync(path, JSON.stringify(candidate, null, 2), 'utf-8');
  return candidate.prompt_hash;
}

describe('Phase 1.5 architecture-fix tests', () => {
  beforeEach(() => {
    setup();
    // CR-54: applyRuleCandidate is tier-gated (Pro+). Seed Pro so promotion runs.
    _setCachedTierForTest('pro');
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initMemorySchema(db);
    db.prepare(`INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('session-arch', datetime('now'), 0)`).run();
  });
  afterEach(() => { _resetCachedTier(); db.close(); teardown(); });

  describe('ARCH-01: claude-md-cr splices the Canonical Rules table', () => {
    it('inserts a new row in the table AND appends body section', async () => {
      const id = writeCandidate();
      const result = await applyRuleCandidate(db, {
        candidateId: id, destination: 'claude-md-cr',
        draftText: 'Every X must Y for class of bug Z.',
        slug: 'cr_table_test', claudeMdCrNumber: 53,
        projectRoot: tmpProjectRoot, home: tmpHome,
      });
      expect(result.ok).toBe(true);
      const claude = readFileSync(join(tmpProjectRoot, '.claude', 'CLAUDE.md'), 'utf-8');
      // Table row inserted (the existing rows are still present)
      expect(claude).toMatch(/\| CR-1 \| first \| VR-A \|/);
      expect(claude).toMatch(/\| CR-2 \| second \| VR-B \|/);
      expect(claude).toMatch(/\| CR-53 \| Every X must Y/);
      // Body section appended
      expect(claude).toContain('### CR-53: cr_table_test');
    });

    it('refuses when CLAUDE.md has no Canonical Rules table', async () => {
      writeFileSync(join(tmpProjectRoot, '.claude', 'CLAUDE.md'), '# CLAUDE.md\n\n(no table here)\n', 'utf-8');
      const id = writeCandidate();
      const result = await applyRuleCandidate(db, {
        candidateId: id, destination: 'claude-md-cr', draftText: 'body',
        slug: 'no_table', claudeMdCrNumber: 99,
        projectRoot: tmpProjectRoot, home: tmpHome,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/recognizable Canonical Rules table/);
    });
  });

  describe('ARCH-02: dismissRuleCandidate write path', () => {
    it('UPSERTs each positive signal into prompt_outcomes_signal_blacklist', () => {
      const id = writeCandidate();
      const result = dismissRuleCandidate(db, {
        candidateId: id,
        reason: 'no problem was a greeting, false positive',
        projectRoot: tmpProjectRoot,
      });
      expect(result.ok).toBe(true);
      expect(result.signals_blacklisted_or_incremented).toBe(4);  // all 4 are positive
      const rows = db.prepare(`SELECT signal, dismissal_count FROM prompt_outcomes_signal_blacklist ORDER BY signal LIMIT 100`).all() as Array<{ signal: string; dismissal_count: number }>;
      expect(rows.map(r => r.signal).sort()).toEqual([
        'bugfix_or_refactor_category',
        'prior_edit_or_write',
        'prompt_length_gt_10',
        'strong_correction_phrase',
      ]);
      for (const r of rows) expect(r.dismissal_count).toBe(1);
    });

    it('increments dismissal_count on second dismissal of a signal', () => {
      const id1 = writeCandidate('aaaaaaaaaaaaaaaa');
      dismissRuleCandidate(db, { candidateId: id1, reason: 'x', projectRoot: tmpProjectRoot });
      const id2 = writeCandidate('bbbbbbbbbbbbbbbb');
      dismissRuleCandidate(db, { candidateId: id2, reason: 'y', projectRoot: tmpProjectRoot });
      const row = db.prepare(`SELECT dismissal_count FROM prompt_outcomes_signal_blacklist WHERE signal = ?`).get('strong_correction_phrase') as { dismissal_count: number };
      expect(row.dismissal_count).toBe(2);
    });

    it('writes audit_log row with event_type=rule_dismissed', () => {
      const id = writeCandidate();
      const result = dismissRuleCandidate(db, { candidateId: id, reason: 'r', projectRoot: tmpProjectRoot });
      expect(result.audit_log_id).toBeGreaterThan(0);
      const row = db.prepare(`SELECT event_type, metadata FROM audit_log WHERE id = ?`).get(result.audit_log_id!) as { event_type: string; metadata: string };
      expect(row.event_type).toBe('rule_dismissed');
      const meta = JSON.parse(row.metadata);
      expect(meta.prompt_hash).toBe('abc123def4567890');
      expect(meta.reason).toBe('r');
    });

    it('appends to .dismissed.jsonl + deletes candidate sidecar', () => {
      const id = writeCandidate();
      dismissRuleCandidate(db, { candidateId: id, reason: 'r', projectRoot: tmpProjectRoot });
      const dismissedLog = join(tmpProjectRoot, '.massu', 'rule-candidates', '.dismissed.jsonl');
      expect(existsSync(dismissedLog)).toBe(true);
      const entry = JSON.parse(readFileSync(dismissedLog, 'utf-8').trim());
      expect(entry.prompt_hash).toBe('abc123def4567890');
      expect(existsSync(join(tmpProjectRoot, '.massu', 'rule-candidates', `${id}.json`))).toBe(false);
    });

    it('throws InvalidCandidateIdError on malformed id', () => {
      expect(() => dismissRuleCandidate(db, {
        candidateId: '../../../tmp/escape',
        reason: 'x',
        projectRoot: tmpProjectRoot,
      })).toThrow(InvalidCandidateIdError);
    });
  });

  describe('SEC-02: realpathSync symlink-bypass guard', () => {
    it('refuses a custom-destination path that resolves OUTSIDE the project root via symlink', async () => {
      // Create a target outside the project root
      const outsideDir = mkdtempSync(join(tmpdir(), 'outside-'));
      try {
        writeFileSync(join(outsideDir, 'leaked.md'), 'pre-existing\n', 'utf-8');
        // Symlink inside project root pointing OUTSIDE
        const linkPath = join(tmpProjectRoot, 'leak-link');
        symlinkSync(outsideDir, linkPath);
        const dangerous: CustomDestinationConfig = {
          name: 'sneaky',
          path: 'leak-link/leaked.md',
          triggerKeywords: [],
          template: '${date}\n',
        };
        const id = writeCandidate();
        const result = await applyRuleCandidate(db, {
          candidateId: id, destination: 'custom-destination', draftText: 'body',
          slug: 'sec02', customDestination: dangerous,
          projectRoot: tmpProjectRoot, home: tmpHome,
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/escapes project root/);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe('SEC-03: opts.slug is always re-sanitized', () => {
    it('caller-supplied slug with shell-injection chars is sanitized', async () => {
      const id = writeCandidate();
      // Write the scanner script + a recognizable Canonical Rules table
      // (test fixture for pattern-scanner destination)
      mkdirSync(join(tmpProjectRoot, 'scripts'), { recursive: true });
      writeFileSync(join(tmpProjectRoot, 'scripts', 'massu-pattern-scanner.sh'), '#!/usr/bin/env bash\n', 'utf-8');
      mkdirSync(join(tmpProjectRoot, 'packages', 'core', 'src', '__tests__'), { recursive: true });
      const result = await applyRuleCandidate(db, {
        candidateId: id, destination: 'pattern-scanner',
        draftText: 'echo safe',
        slug: '$(rm -rf $HOME) && echo pwned',   // shell-injection attempt
        patternScannerCheckNumber: 50,
        projectRoot: tmpProjectRoot, home: tmpHome,
      });
      expect(result.ok).toBe(true);
      // Verify the slug was sanitized down to [a-z0-9_]
      const scanner = readFileSync(join(tmpProjectRoot, 'scripts', 'massu-pattern-scanner.sh'), 'utf-8');
      expect(scanner).not.toContain('$(');
      expect(scanner).not.toContain('rm -rf');
      expect(scanner).toMatch(/Check 50: rm_rf_home_echo_pwned/);
    });
  });

  describe('SEC-04: candidate payload runtime validation', () => {
    it('throws CandidatePayloadValidationError on malformed prompt_hash', async () => {
      const path = join(tmpProjectRoot, '.massu', 'rule-candidates', 'abc123def4567890.json');
      writeFileSync(path, JSON.stringify({
        prompt: 'x', prompt_hash: 'not-hex-not-16', score: 50, signals: [],
        prior_turn_files: [], timestamp: 'iso', session_id: 's',
      }), 'utf-8');
      await expect(applyRuleCandidate(db, {
        candidateId: 'abc123def4567890', destination: 'corrections-md', draftText: 'b',
        projectRoot: tmpProjectRoot, home: tmpHome,
      })).rejects.toThrow(CandidatePayloadValidationError);
    });

    it('throws on missing required fields', async () => {
      const path = join(tmpProjectRoot, '.massu', 'rule-candidates', 'abc123def4567890.json');
      writeFileSync(path, JSON.stringify({ prompt: 'x' }), 'utf-8');
      await expect(applyRuleCandidate(db, {
        candidateId: 'abc123def4567890', destination: 'corrections-md', draftText: 'b',
        projectRoot: tmpProjectRoot, home: tmpHome,
      })).rejects.toThrow(CandidatePayloadValidationError);
    });
  });
});
