// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 2026-07-23 P8-008 — `massu memory inspect|repair` and `massu doctor --fix`.
 *   - plain doctor and `inspect` never write;
 *   - repair asks on a terminal, refuses without one unless --yes;
 *   - the repair is never model-callable (no MCP tool reaches the module);
 *   - both `doctor` dispatch sites pass their flags through.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { rmSync, readFileSync, readdirSync } from 'fs';
import { join, resolve, sep } from 'path';
import { createHash } from 'crypto';

const paths = vi.hoisted(() => ({ memoryDbPath: '', dataDbPath: '', knowledgeDbPath: '' }));
vi.mock('../config.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.ts')>();
  return { ...real, getResolvedPaths: () => ({ ...real.getResolvedPaths(), ...paths }) };
});

import { legacyMemoryStore } from './helpers/legacy-memory-store.ts';
import { codeOnly } from './helpers/code-only.ts';
import { runMemoryRepairCli } from '../commands/memory-repair-cli.ts';
import { checkMemoryDatabase, parseDoctorArgs } from '../commands/doctor.ts';
import { inspectMemoryDb } from '../memory-db-maintenance.ts';

const SRC = resolve(__dirname, '..');
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const store = () => legacyMemoryStore(roots, (p) => { paths.memoryDbPath = p; });
const backups = (p: string) => readdirSync(join(p, '..')).filter((f) => f.includes('pre-maintenance'));
// Every call gets an `ask` that THROWS unless a test overrides it: a defect that reaches the
// prompt must fail at once, never wait on a real stdin (this repo sets no per-test timeout).
const plenty = {
  repairOptions: { availableBytes: () => 1e15 },
  ask: async (): Promise<boolean> => {
    throw new Error('the repair asked a question it should not have asked');
  },
};

describe('massu memory inspect / repair', () => {
  it('inspect reports the default database and writes nothing', async () => {
    const p = store();
    const h = sha(p);
    const r = await runMemoryRepairCli('inspect', []);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('duplicate summary rows 2');
    expect(r.output).toContain('repair available');
    expect(sha(p)).toBe(h);
  });

  it('repair without a terminal and without --yes refuses and changes nothing', async () => {
    const p = store();
    const h = sha(p);
    const r = await runMemoryRepairCli('repair', [], { ...plenty, isTTY: false });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Re-run with --yes');
    expect(sha(p)).toBe(h);
    expect(backups(p)).toEqual([]);
  });

  it('on a terminal it asks; "no" changes nothing, "yes" repairs', async () => {
    const p = store();
    const h = sha(p);
    const no = await runMemoryRepairCli('repair', [], { ...plenty, isTTY: true, ask: async () => false });
    expect(no.exitCode).toBe(1);
    expect(sha(p)).toBe(h);
    const asked: string[] = [];
    const yes = await runMemoryRepairCli('repair', [], {
      ...plenty,
      isTTY: true,
      ask: async (q) => (asked.push(q), true),
    });
    expect(yes.exitCode, yes.output).toBe(0);
    expect(asked[0]).toContain('A backup is kept');
    expect(inspectMemoryDb(p).needsRepair).toBe(false);
  });

  it('--yes repairs without asking; --dry-run writes nothing; --db picks the file', async () => {
    const p = store();
    paths.memoryDbPath = '/nonexistent/should-not-be-used.db';
    const h = sha(p);
    const dry = await runMemoryRepairCli('repair', ['--db', p, '--dry-run'], plenty);
    expect(dry.exitCode).toBe(0);
    expect(sha(p)).toBe(h);
    const r = await runMemoryRepairCli('repair', ['--db', p, '--yes'], { ...plenty, isTTY: false });
    expect(r.exitCode, r.output).toBe(0);
    expect(r.output).toContain('RESULT: repaired');
  });

  it('refuses ambiguous input instead of guessing', async () => {
    expect((await runMemoryRepairCli('repair', ['--bogus'])).exitCode).toBe(2);
    expect((await runMemoryRepairCli('repair', ['--db'])).exitCode).toBe(2);
    expect((await runMemoryRepairCli('inspect', ['--yes'])).exitCode).toBe(2);
  });
});

describe('massu doctor: memory database check and --fix flags', () => {
  it('warns on a database that needs repair, passes after, passes when none exists yet', async () => {
    const p = store();
    const h = sha(p);
    const warn = checkMemoryDatabase(p);
    expect(warn.status).toBe('warn');
    expect(warn.detail).toContain('massu doctor --fix');
    expect(sha(p)).toBe(h); // the check is read-only
    await runMemoryRepairCli('repair', ['--db', p, '--yes'], plenty);
    expect(checkMemoryDatabase(p).status).toBe('pass');
    expect(checkMemoryDatabase(join(p, '..', 'absent.db')).status).toBe('pass');
  });

  it('parses --fix flags and refuses typos and orphan flags', () => {
    expect(parseDoctorArgs([])).toEqual({ fix: false, yes: false, dryRun: false });
    expect(parseDoctorArgs(['--fix', '--yes'])).toEqual({ fix: true, yes: true, dryRun: false });
    expect(parseDoctorArgs(['--fixx'])).toHaveProperty('error');
    expect(parseDoctorArgs(['--yes'])).toHaveProperty('error');
  });

  it('both doctor dispatch sites in cli.ts pass their arguments through', () => {
    const code = codeOnly(readFileSync(join(SRC, 'cli.ts'), 'utf8'), '.ts')!;
    const calls = code.match(/runDoctor\([^)]*\)/g) ?? [];
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).not.toBe('runDoctor()');
  });
});

describe('the repair is CLI-only (never model-callable)', () => {
  it('only memory-repair-cli.ts imports the maintenance module, and no MCP tool file names it', () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const f = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__' && e.name !== 'node_modules') walk(f);
        } else if (f.endsWith('.ts')) {
          const code = codeOnly(readFileSync(f, 'utf8'), '.ts') ?? '';
          if (/from ['"][./]+memory-db-maintenance\.ts['"]/.test(code)) importers.push(f.slice(SRC.length + 1).split(sep).join('/'));
        }
      }
    };
    walk(SRC);
    expect(importers.sort()).toEqual(['commands/memory-repair-cli.ts']);
    const tools = codeOnly(readFileSync(join(SRC, 'tools.ts'), 'utf8'), '.ts')!;
    expect(tools).not.toMatch(/memory-repair-cli|repairMemoryDb|runMemoryRepair/);
    expect(tools).toContain('memory'); // positive control: tools.ts was read and has content
  });
});
