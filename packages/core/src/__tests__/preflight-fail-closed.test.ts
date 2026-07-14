/**
 * G-3 DRIFT-GUARD — a dependency is not "present". It is USABLE, or it is not there.
 *
 * THE BUG THIS MAKES IMPOSSIBLE (M-2/C-1, verified live 2026-07-13):
 * `getCodeGraphDb()` guarded with `existsSync(dbPath)` — a check for the LOUD failure,
 * blind to every quiet one. The live DB existed with 0 files / 0 nodes / 0 edges, the
 * guard raised NOTHING, and every dependent tool answered from an empty graph.
 * `massu_impact` reported "(safe)" for any change — because it looked and found nothing.
 * "No impact" and "I have no data" were byte-identical to the caller.
 *
 * AND THE REMEDY WAS WRONG: the error told customers to run `codegraph init`, which is a
 * NO-OP on an already-initialized repo ("Already initialized"). The command that actually
 * populates the graph is `index`. A customer could follow our instructions exactly, see a
 * success message, and still have five dead tools forever.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  assertCodegraphUsable,
  checkCodegraph,
  checkNodeVersion,
  CodegraphDbUnusableError,
  CodegraphDbNotInitializedError,
  MIN_NODE_MAJOR,
} from '../preflight.ts';

function makeDb(dir: string, name: string, rows: number, tableName = 'files'): string {
  const p = join(dir, `${name}.db`);
  const db = new Database(p);
  db.exec(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, path TEXT)`);
  const ins = db.prepare(`INSERT INTO ${tableName} (path) VALUES (?)`);
  for (let i = 0; i < rows; i++) ins.run(`f${i}.ts`);
  db.close();
  return p;
}

describe('G-3: fail-closed startup (CodeGraph)', () => {
  it('THE ONE THAT MATTERS: a present-but-EMPTY database is REFUSED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'g3-'));
    try {
      const empty = makeDb(dir, 'empty', 0);
      // Before this gate, `existsSync` said yes and the tools answered from nothing.
      expect(() => assertCodegraphUsable(empty)).toThrow(CodegraphDbUnusableError);
      try {
        assertCodegraphUsable(empty);
      } catch (e) {
        expect((e as CodegraphDbUnusableError).reason).toBe('empty');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a populated database is ACCEPTED (a gate that refuses everything is useless)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'g3-'));
    try {
      expect(() => assertCodegraphUsable(makeDb(dir, 'full', 3))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing and corrupt are refused too, each with its own reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'g3-'));
    try {
      try {
        assertCodegraphUsable(join(dir, 'nope.db'));
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as CodegraphDbUnusableError).reason).toBe('missing');
      }
      // A DB with no `files` table at all — corrupt/foreign, not a CodeGraph DB.
      try {
        assertCodegraphUsable(makeDb(dir, 'corrupt', 1, 'not_files'));
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as CodegraphDbUnusableError).reason).toBe('unreadable');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the error stays dispatcher-compatible — the -32001 path must still fire', () => {
    // If this were a SIBLING class instead of a subclass, every `instanceof` catch site
    // in server.ts would go blind to the empty case, and I would have replaced one silent
    // failure with another.
    const dir = mkdtempSync(join(tmpdir(), 'g3-'));
    try {
      try {
        assertCodegraphUsable(makeDb(dir, 'empty', 0));
      } catch (e) {
        expect(e).toBeInstanceOf(CodegraphDbNotInitializedError);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the EMPTY remedy is `index`, NOT `init` — `init` is a no-op and sends the user in a circle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'g3-'));
    try {
      const r = checkCodegraph(makeDb(dir, 'empty', 0));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('empty');
      // Executed 2026-07-13: `codegraph init` on an initialized repo prints
      // "Already initialized" and changes nothing. Recommending it here would be a
      // remedy that does not remedy.
      expect(r.remedy).toContain('index');
      expect(r.remedy).not.toMatch(/\binit\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('STRUCTURAL: getCodeGraphDb must not guard with a bare existsSync ever again', () => {
    // The type system cannot express "you must check emptiness". The source can.
    const src = readFileSync(join(__dirname, '..', 'db.ts'), 'utf-8');
    const fn = src.slice(src.indexOf('export function getCodeGraphDb'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(
      body.includes('assertCodegraphUsable'),
      'getCodeGraphDb() must call assertCodegraphUsable() — an existsSync check is blind ' +
        'to the present-but-empty database, which is the failure that actually happened.',
    ).toBe(true);
  });
});

describe('G-3: Node version — ONE source of truth (C-2)', () => {
  it('enforces the floor from the engines field', () => {
    expect(checkNodeVersion('v18.20.0').ok).toBe(false);
    expect(checkNodeVersion(`v${MIN_NODE_MAJOR}.0.0`).ok).toBe(true);
  });

  it('C-2 REFUTED: Node 26 is NOT rejected — codegraph 1.4.1 runs on it', () => {
    // The plan asserted CodeGraph "hard-refuses" Node >= 25, so the remedy could not run
    // on this machine's default. EXECUTED 2026-07-13: codegraph@1.4.1 indexed 1,266 files
    // / 11,512 nodes / 35,213 edges on Node v26.0.0. Encoding a ceiling nobody had
    // verified would have blocked every user on a modern Node for no reason.
    expect(checkNodeVersion('v26.0.0').ok).toBe(true);
    expect(checkNodeVersion('v25.0.0').ok).toBe(true);
  });

  it('the floor matches package.json engines (no second copy to drift)', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    // NB: `.replace(/[^\d]/, '')` strips only the FIRST non-digit — ">=20.0.0" -> "=20.0.0"
    // -> NaN. Match the number instead of trying to delete everything around it.
    const declared = Number.parseInt(String(pkg.engines?.node ?? '').match(/(\d+)/)![1], 10);
    expect(
      declared,
      'MIN_NODE_MAJOR must equal the engines floor — a second copy is how four sources ' +
        'came to disagree about the supported range in the first place (C-2).',
    ).toBe(MIN_NODE_MAJOR);
  });
});
