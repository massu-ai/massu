// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P3-003 (plan-living-memory-slice-1) — recall block formatting + token cap.
 */

import { describe, it, expect } from 'vitest';
import { formatRecallBlock } from '../memory-recall-format.ts';
import type { HybridSearchResult } from '../memory-hybrid-search.ts';

function res(partial: Partial<HybridSearchResult>): HybridSearchResult {
  return {
    id: 1,
    source: 'observation',
    title: 'a title',
    snippet: 'a snippet',
    score: 1,
    importance: 3,
    ageDays: 1,
    ...partial,
  };
}

function estTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

describe('P3-003: formatRecallBlock', () => {
  it('returns empty string for no results (fail-open)', () => {
    expect(formatRecallBlock([])).toBe('');
    expect(formatRecallBlock([], { maxTokens: 1200 })).toBe('');
  });

  it('renders a header, one line per item, and a pointer footer', () => {
    const out = formatRecallBlock([
      res({ id: 1, title: 'login fail fast', snippet: 'guard isTTY' }),
      res({ id: 2, source: 'failure_class', title: 'validate-key 500', snippet: 'deploy drift' }),
    ]);
    expect(out).toContain('🧠 Relevant memory');
    expect(out).toContain('login fail fast');
    expect(out).toContain('validate-key 500');
    expect(out).toContain('massu_memory_detail');
  });

  it('never exceeds the token cap and keeps the highest-ranked items', () => {
    const many: HybridSearchResult[] = [];
    for (let i = 0; i < 200; i++) {
      many.push(
        res({
          id: i,
          title: `topic number ${i} with a fairly long descriptive title`,
          snippet: `and a reasonably long snippet body for item ${i} to consume budget`,
        }),
      );
    }
    const maxTokens = 200;
    const out = formatRecallBlock(many, { maxTokens });
    expect(estTokens(out)).toBeLessThanOrEqual(maxTokens);
    // The first (highest-ranked) item must be retained.
    expect(out).toContain('topic number 0 ');
    // A late item must have been trimmed.
    expect(out).not.toContain('topic number 199 ');
  });

  it('omits the "why" when snippet equals title', () => {
    const out = formatRecallBlock([res({ title: 'same', snippet: 'same' })]);
    // Only one occurrence of "same" (no " — same" duplication).
    const matches = out.match(/same/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
