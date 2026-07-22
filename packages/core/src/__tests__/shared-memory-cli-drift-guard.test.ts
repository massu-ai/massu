// Slice 5 — B-01 + B-06 structural drift-guards for the human control surface.
//
//  (1) B-01: `shareable = 1` is written in EXACTLY ONE place — the CLI `share`
//      command. No heuristic, score, LLM, hook, or consolidation pass may set it.
//      (Non-vacuous: the CLI writer exists, so the allowed set is a real singleton.)
//  (2) B-06: accept/refuse are CLI-ONLY — NO MCP tool maps to them. An MCP tool is
//      model-callable, and the model may be reading attacker text. tools.ts must not
//      reference the share-CLI module or its accept/refuse handlers.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

describe('Slice 5 B-01 — shareable=1 has exactly one writer', () => {
  it('the ONLY `SET shareable = 1` writer is the memory-share CLI command', () => {
    const files = walk(SRC);
    const writers = files.filter((f) => /SET\s+shareable\s*=\s*1\b/.test(readFileSync(f, 'utf-8')));
    expect(writers.map((f) => f.replace(SRC + '/', ''))).toEqual(['commands/memory-share-cli.ts']);
  });

  it('no INSERT into observations sets shareable to 1 (accepted rows are shareable=0)', () => {
    for (const f of walk(SRC)) {
      const src = readFileSync(f, 'utf-8');
      // Any INSERT that names `shareable` must not give it the literal 1.
      const m = src.match(/INSERT INTO observations[\s\S]{0,400}?shareable[\s\S]{0,400}?VALUES[\s\S]{0,400}?\)/gi) ?? [];
      for (const stmt of m) {
        // crude but effective: an accepted row is `... shareable, ... ) VALUES (... 0 ...)`
        expect(/shareable/.test(stmt) && /,\s*1\s*,/.test(stmt.split('VALUES')[1] ?? ''), `${f}: ${stmt.slice(0, 80)}`).not.toBe(true);
      }
    }
  });
});

describe('Slice 5 B-06 — accept/refuse are CLI-only, never an MCP tool', () => {
  const tools = readFileSync(join(SRC, 'tools.ts'), 'utf-8');

  it('tools.ts references neither the share-CLI module nor its accept/refuse handlers', () => {
    expect(tools).not.toMatch(/memory-share-cli/);
    expect(tools).not.toMatch(/runMemoryShareCli/);
    expect(tools).not.toMatch(/acceptSharedMemory/);
    expect(tools).not.toMatch(/refuseSharedMemory/);
  });
});
