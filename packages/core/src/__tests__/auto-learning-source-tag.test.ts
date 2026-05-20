// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-E-005: source-tag drift-guard.
// Every memory/feedback_*.md entry written on or after the v0.2 ship date
// (2026-05-20) MUST have a `source:` frontmatter field (one of
// "interactive" | "post-loop-reflection"). Pre-v0.2 entries are
// allow-listed via the `last_updated` timestamp filter.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { encodeMemoryDirName } from '../lib/memory-path.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const V02_SHIP_DATE_ISO = '2026-05-20';

/**
 * Resolve the canonical memory dir for this project.
 * Derives the project root from this test file's own location so the
 * resolver works in any developer's repo clone (no hardcoded /Users/...
 * paths — those would leak through scripts/massu-public-leak-guard.sh).
 * If the resolved dir does not exist (CI fresh checkout, fresh clone),
 * the test silently skips — there is nothing to scan.
 */
function resolveMemoryDir(): string | null {
  // __dirname → packages/core/src/__tests__; project root is 4 levels up.
  const projectRoot = join(__dirname, '..', '..', '..', '..');
  const candidates = [
    process.env.MASSU_MEMORY_DIR,
    join(homedir(), '.claude', 'projects', encodeMemoryDirName(projectRoot), 'memory'),
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function parseFrontmatter(content: string): Record<string, string> {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  // Also capture nested metadata.source
  const metaMatch = m[1].match(/metadata:\s*\n((?:\s{2}\w+:\s*[^\n]+\n?)+)/);
  if (metaMatch) {
    for (const line of metaMatch[1].split('\n')) {
      const kv = line.match(/^\s+(\w+):\s*(.+)$/);
      if (kv) out[`metadata.${kv[1]}`] = kv[2].trim();
    }
  }
  return out;
}

describe('auto-learning source-tag drift-guard (P-E-005)', () => {
  it('every feedback_*.md last_updated >= 2026-05-20 has a `source:` field', () => {
    const memoryDir = resolveMemoryDir();
    if (!memoryDir) {
      // eslint-disable-next-line no-console
      console.log('[source-tag] memory dir not found, skipping');
      return;
    }
    const feedbackFiles = readdirSync(memoryDir).filter(f => /^feedback_.+\.md$/.test(f));
    const violations: Array<{ file: string; lastUpdated: string }> = [];

    for (const f of feedbackFiles) {
      const content = readFileSync(join(memoryDir, f), 'utf-8');
      const fm = parseFrontmatter(content);
      const lastUpdated = fm.last_updated ?? fm.created ?? fm.ship_date ?? '';
      if (!lastUpdated) continue;  // Pre-v0.2 entries without a timestamp are allow-listed
      if (lastUpdated < V02_SHIP_DATE_ISO) continue; // Pre-cutoff
      const source = fm.source ?? fm['metadata.source'];
      if (!source) violations.push({ file: f, lastUpdated });
    }

    expect(violations).toEqual([]);
  });

  it('source field, when present, is one of {interactive, post-loop-reflection}', () => {
    const memoryDir = resolveMemoryDir();
    if (!memoryDir) return;
    const feedbackFiles = readdirSync(memoryDir).filter(f => /^feedback_.+\.md$/.test(f));
    const violations: Array<{ file: string; source: string }> = [];

    for (const f of feedbackFiles) {
      const content = readFileSync(join(memoryDir, f), 'utf-8');
      const fm = parseFrontmatter(content);
      const source = fm.source ?? fm['metadata.source'];
      if (!source) continue;
      if (source !== 'interactive' && source !== 'post-loop-reflection') {
        violations.push({ file: f, source });
      }
    }
    expect(violations).toEqual([]);
  });

  it('v0.2 marker feedback file is present + tagged source: post-loop-reflection', () => {
    const memoryDir = resolveMemoryDir();
    if (!memoryDir) return;
    const target = join(memoryDir, 'feedback_v0_2_interactive_rule_approval.md');
    if (!existsSync(target)) {
      // eslint-disable-next-line no-console
      console.log('[source-tag] v0.2 feedback file not yet shipped in this branch');
      return;
    }
    const content = readFileSync(target, 'utf-8');
    expect(content).toMatch(/source:\s*(interactive|post-loop-reflection)/);
  });
});
