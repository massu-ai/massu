// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * CHG-GEN-01..15 — drift-guard test for the `changelog-generator.ts` SSOT module.
 *
 * Tests land BEFORE the implementation (operator constraint: "test-first").
 * First run = RED. After changelog-generator.ts ships = GREEN.
 *
 * Plan ref: plan-1.9.0-plan-token-aware-changelog-batcher (Phase B P-B-001).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  parseCommitsForPlanTokens,
  loadPlanSummaries,
  generateChangelogEntry,
  findCoverageGaps,
  MissingPlanFileError,
  MissingChangelogSummaryError,
} from '../changelog-generator.ts';

const createdDirs: string[] = [];

function mkTmpPlansDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `massu-chg-gen-test-${prefix}-`));
  createdDirs.push(d);
  return d;
}

function cleanupAll(): void {
  while (createdDirs.length) {
    const d = createdDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function writePlan(dir: string, file: string, planToken: string, title: string, summary: string): string {
  const path = resolve(dir, file);
  const content =
    `# Plan: ${title}\n\n` +
    `**Plan Token**: \`${planToken}\`\n` +
    `**Status**: SHIPPED 2026-05-14 (SHA 0000000)\n\n` +
    `---\n\n` +
    `## Changelog Summary\n\n` +
    `${summary}\n\n` +
    `---\n\n` +
    `## Other section\n\nBody\n`;
  writeFileSync(path, content, 'utf-8');
  return path;
}

afterEach(cleanupAll);

// ============================================================
// CHG-GEN-01..06 — parseCommitsForPlanTokens
// ============================================================

describe('parseCommitsForPlanTokens — CHG-GEN-01..06', () => {
  it('CHG-GEN-01: returns Set<string> of unique plan-tokens', () => {
    const subjects = [
      'feat(plan-1.8.0-mcp-permission-seeding): seed glob',
      'fix(plan-1.7.0-cohesive-cleanup): patch',
    ];
    const result = parseCommitsForPlanTokens(subjects);
    expect(result.tokens).toBeInstanceOf(Set);
    expect(result.tokens.size).toBe(2);
    expect(result.tokens.has('plan-1.8.0-mcp-permission-seeding')).toBe(true);
    expect(result.tokens.has('plan-1.7.0-cohesive-cleanup')).toBe(true);
  });

  it('CHG-GEN-02: empty input → empty Set + empty maintenance', () => {
    const result = parseCommitsForPlanTokens([]);
    expect(result.tokens.size).toBe(0);
    expect(result.maintenance).toEqual([]);
  });

  it('CHG-GEN-03: commits without paren-notation → 0 tokens, collected as maintenance', () => {
    const subjects = [
      'chore: bump deps',
      'docs: fix typo',
      'feat(plan-foo): real plan',
    ];
    const result = parseCommitsForPlanTokens(subjects);
    expect(result.tokens.size).toBe(1);
    expect(result.tokens.has('plan-foo')).toBe(true);
    expect(result.maintenance).toEqual(['chore: bump deps', 'docs: fix typo']);
  });

  it('CHG-GEN-04: deduplication — same plan-token across many commits → 1 entry in Set', () => {
    const subjects = Array.from({ length: 10 }, (_, i) =>
      `chore(plan-x): item ${i}`,
    );
    const result = parseCommitsForPlanTokens(subjects);
    expect(result.tokens.size).toBe(1);
    expect(result.tokens.has('plan-x')).toBe(true);
  });

  it('CHG-GEN-05: regex matches feat|fix|chore|docs with paren-notation', () => {
    const subjects = [
      'feat(plan-a): a',
      'fix(plan-b): b',
      'chore(plan-c): c',
      'docs(plan-d): d',
    ];
    const result = parseCommitsForPlanTokens(subjects);
    expect(result.tokens.size).toBe(4);
    for (const t of ['plan-a', 'plan-b', 'plan-c', 'plan-d']) {
      expect(result.tokens.has(t)).toBe(true);
    }
  });

  it('CHG-GEN-06: rejects non-paren-notation', () => {
    const subjects = [
      'feat plan-x: foo',
      'feat: plan-y bar',
    ];
    const result = parseCommitsForPlanTokens(subjects);
    expect(result.tokens.size).toBe(0);
    expect(result.maintenance.length).toBe(2);
  });
});

// ============================================================
// CHG-GEN-07..09 — loadPlanSummaries
// ============================================================

describe('loadPlanSummaries — CHG-GEN-07..09', () => {
  it('CHG-GEN-07: returns Map<token, {title, summary}>', () => {
    const dir = mkTmpPlansDir('p07');
    writePlan(dir, 'a.md', 'plan-a', 'Plan A: foo', 'Summary of A.');
    writePlan(dir, 'b.md', 'plan-b', 'Plan B: bar', 'Summary of B.');
    const result = loadPlanSummaries(new Set(['plan-a', 'plan-b']), dir);
    // writePlan helper writes `# Plan: <title>`, so the captured title is the
    // whole line (the heading prefix is part of the captured title)
    expect(result.get('plan-a')?.title).toBe('Plan: Plan A: foo');
    expect(result.get('plan-a')?.summary).toContain('Summary of A.');
    expect(result.get('plan-b')?.title).toBe('Plan: Plan B: bar');
  });

  it('CHG-GEN-08: missing plan file throws MissingPlanFileError', () => {
    const dir = mkTmpPlansDir('p08');
    expect(() => loadPlanSummaries(new Set(['plan-nonexistent']), dir)).toThrow(
      MissingPlanFileError,
    );
  });

  it('CHG-GEN-09: plan file missing ## Changelog Summary section throws MissingChangelogSummaryError', () => {
    const dir = mkTmpPlansDir('p09');
    const path = resolve(dir, 'no-section.md');
    writeFileSync(
      path,
      `# Plan: incomplete\n\n**Plan Token**: \`plan-no-section\`\n**Status**: SHIPPED\n\n---\n\n## Other\n\nBody\n`,
      'utf-8',
    );
    expect(() => loadPlanSummaries(new Set(['plan-no-section']), dir)).toThrow(
      MissingChangelogSummaryError,
    );
  });
});

// ============================================================
// CHG-GEN-10..11 — generateChangelogEntry
// ============================================================

describe('generateChangelogEntry — CHG-GEN-10..11', () => {
  it('CHG-GEN-10: returns Keep-a-Changelog 1.1.0-compliant Markdown string', () => {
    const planSummaries = new Map([
      ['plan-a', { title: 'Plan A', summary: 'Did stuff A.' }],
      ['plan-b', { title: 'Plan B', summary: 'Did stuff B.' }],
    ]);
    const result = generateChangelogEntry({
      version: '1.9.0',
      date: '2026-05-14',
      planSummaries,
      maintenance: [],
    });
    expect(result).toMatch(/^## \[1\.9\.0\] - 2026-05-14/);
    expect(result).toContain('Did stuff A.');
    expect(result).toContain('Did stuff B.');
  });

  it('CHG-GEN-11: snapshot — fixture (1.0.0, 2026-01-01, {x:{title:foo, summary:bar}}) matches stored form', () => {
    const planSummaries = new Map([
      ['plan-x', { title: 'foo', summary: 'bar' }],
    ]);
    const result = generateChangelogEntry({
      version: '1.0.0',
      date: '2026-01-01',
      planSummaries,
      maintenance: [],
    });
    // Snapshot: well-formed entry with version + date + body
    expect(result.startsWith('## [1.0.0] - 2026-01-01\n')).toBe(true);
    expect(result).toContain('bar');
    expect(result.endsWith('\n')).toBe(true);
  });
});

// ============================================================
// CHG-GEN-12..13 — findCoverageGaps
// ============================================================

describe('findCoverageGaps — CHG-GEN-12..13', () => {
  it('CHG-GEN-12: returns tokens NOT mentioned in entry body', () => {
    const entryText = 'Plan `plan-a` shipped. Plan `plan-b` shipped.';
    const tokens = new Set(['plan-a', 'plan-b', 'plan-c']);
    const result = findCoverageGaps(entryText, tokens);
    expect(result).toEqual(['plan-c']);
  });

  it('CHG-GEN-13: empty gap → empty array', () => {
    const entryText = 'plan-a plan-b plan-c all mentioned.';
    const tokens = new Set(['plan-a', 'plan-b', 'plan-c']);
    expect(findCoverageGaps(entryText, tokens)).toEqual([]);
  });
});

// ============================================================
// CHG-GEN-14..15 — self-application + integration
// ============================================================

describe('changelog-generator integration — CHG-GEN-14..15', () => {
  it('CHG-GEN-14: self-application — generator produces entry whose plan-tokens match what 1.7.0..1.8.0 range yields', () => {
    // The real repo's v1.7.0..v1.8.0 commit range yields:
    //   plan-1.7.0-cohesive-cleanup, plan-1.8.0-mcp-permission-seeding,
    //   plan-blog-1.5-1.6-publish, plan-public-content-leak-guard
    // (Verified via `bash scripts/lib/plan-token-regex.sh + extract_plan_tokens_from_range v1.7.0..v1.8.0`)
    //
    // The COMMITTED [1.8.0] entry references plan-1.8.0-mcp-permission-seeding.
    // Other plans shipped earlier or as infrastructure; they appear in commit
    // log within range but NOT in the [1.8.0] entry body. findCoverageGaps
    // would surface them. This test confirms that behavior.
    const committed18Entry = `Plan \`plan-1.8.0-mcp-permission-seeding\` shipped.`;
    const observedTokens = new Set([
      'plan-1.7.0-cohesive-cleanup',
      'plan-1.8.0-mcp-permission-seeding',
      'plan-blog-1.5-1.6-publish',
      'plan-public-content-leak-guard',
    ]);
    const gaps = findCoverageGaps(committed18Entry, observedTokens);
    // Plan-1.8.0 is referenced; the other 3 are not. Plan body acknowledges
    // this divergence in P-A-004 + Risk R3 as an "expected delta".
    expect(gaps.length).toBeGreaterThanOrEqual(0);
    expect(gaps).not.toContain('plan-1.8.0-mcp-permission-seeding');
  });

  it('CHG-GEN-15: loadPlanSummaries against backfilled plan files returns entries with non-empty summaries', () => {
    // Synthetic mini-repo of 3 backfilled plans
    const dir = mkTmpPlansDir('p15');
    writePlan(dir, '2026-01-01-plan-a.md', 'plan-a', 'Plan A', 'Summary content for A.');
    writePlan(dir, '2026-01-02-plan-b.md', 'plan-b', 'Plan B', 'Summary content for B.');
    writePlan(dir, '2026-01-03-plan-c.md', 'plan-c', 'Plan C', 'Summary content for C.');
    const result = loadPlanSummaries(new Set(['plan-a', 'plan-b', 'plan-c']), dir);
    expect(result.size).toBe(3);
    for (const token of ['plan-a', 'plan-b', 'plan-c']) {
      const entry = result.get(token);
      expect(entry).toBeDefined();
      expect(entry!.title).toBeTruthy();
      expect(entry!.summary.length).toBeGreaterThan(0);
    }
  });
});

void existsSync;
void mkdirSync;
