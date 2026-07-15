// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * DF-1 (audit 2026-07-14): `massu rule show <id>` — the real, reachable entry
 * point that finally makes renderCandidatePreview a live surface (it had zero
 * production callers). This drives the CLI handler end-to-end against a real
 * sidecar on disk and asserts it renders the candidate. A regression that drops
 * the `show` case or unwires the renderer turns this RED.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let ROOT: string;

vi.mock('../config.ts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getProjectRoot: () => ROOT };
});

vi.mock('../memory-db.ts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getMemoryDb: () => new Database(':memory:') };
});

import { handleRuleSubcommand } from '../commands/rule.ts';

const ID = 'a'.repeat(16);

function writeSidecar(root: string, id: string): void {
  const dir = join(root, '.massu', 'rule-candidates');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      prompt: "that's wrong, use getConfig() instead of direct YAML access",
      prompt_hash: id,
      score: 90,
      signals: [{ name: 'strong_correction_phrase', baseWeight: 40, applied: 40, evidence: 'matched' }],
      prior_turn_files: ['packages/core/src/config-loader.ts'],
      timestamp: '2026-07-14T00:00:00Z',
      session_id: 'sess_1',
    }),
    'utf-8',
  );
}

let out: string;
let writeSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'massu-rule-show-'));
  out = '';
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out += String(s);
    return true;
  });
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  writeSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('massu rule show <id>', () => {
  it('renders a real candidate from its sidecar', async () => {
    writeSidecar(ROOT, ID);
    const res = await handleRuleSubcommand(['show', ID]);
    expect(res.exitCode).toBe(0);
    expect(out).toContain(`## Candidate ${ID}`);
    expect(out).toContain('### 1. Detected correction');
    expect(out).toContain('use getConfig() instead of direct YAML access');
    expect(out).toContain('- strong_correction_phrase (+40)');
    expect(out).toContain('### 4. Next steps');
  });

  it('exits 2 with a usage message when no id is given', async () => {
    const res = await handleRuleSubcommand(['show']);
    expect(res.exitCode).toBe(2);
  });

  it('exits 1 when the candidate does not exist (not a silent empty pass)', async () => {
    const res = await handleRuleSubcommand(['show', 'b'.repeat(16)]);
    expect(res.exitCode).toBe(1);
    expect(out).not.toContain('## Candidate');
  });
});
