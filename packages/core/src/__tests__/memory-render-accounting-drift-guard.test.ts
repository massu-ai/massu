// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * CONSERVATION IN THE RENDER PIPELINE — every source row lands in exactly one bucket.
 *
 * ── The incident this exists to make impossible ────────────────────────────────
 * `Massu would write 0 file(s)` is what an EMPTY corpus prints, what a correctly-IDLE
 * pipeline prints, what a pipeline that CRASHED after the query prints, and what a BROKEN
 * one prints. Four states, one string, and it is the reassuring one.
 *
 * On 2026-08-08 that produced a HIGH-SEVERITY INCIDENT FOR A DEFECT THAT DID NOT EXIST:
 * the pipeline was correct (all 59 matching rows were `[memory-file]` re-ingestions,
 * properly excluded by B-07), and the missing denominator made eighteen days of correct
 * behaviour indistinguishable from a dead capability. The absence of a denominator did not
 * hide a bug — it MANUFACTURED one.
 *
 * ── Why an INVARIANT and not a printout ────────────────────────────────────────
 * Printing a number makes the NEXT silent drop visible. The conservation assertion makes
 * it unrepresentable: a contributor who adds a seventh `continue` without a bucket breaks
 * the build. Six drop sites existed and only two were inside the loop that maintained
 * `refusals`; three were upstream in the LOADER and one bypassed the renderer entirely.
 *
 * ── Why the source-level assertions are here too ───────────────────────────────
 * The behavioural tests prove the books balance for the paths a test can reach. They
 * cannot reach a NEW early-return someone adds next month. The source assertions bind the
 * shape: every `EMPTY(` call site passes a denominator, and the CLI never swallows
 * `skippedReason`. Both were real defects (`skippedReason` was discarded for every reason
 * except `no_memory_dir`).
 *
 * Live-fire companion (CR-72): `scripts/tests/live-fire-render-accounting.sh` plants the
 * defect in the REAL source and demands RED.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { initMemorySchema, createSession, addObservation } from '../memory-db.ts';
import { renderMemoryFiles } from '../memory-renderer.ts';
import { DEFAULT_MEMORY_FILES_CONFIG } from '../memory-files-config.ts';
import {
  loadRenderCandidates,
  EXCLUSION_MEMORY_FILE_REINGEST,
} from '../memory-render-candidates.ts';

/**
 * A COMMENT IS NOT CODE — and this guard learned it the hard way, on its first run.
 *
 * The `EMPTY()` assertion below matched `// it degrades to EMPTY('error') and an audit row.`
 * — a comment written three hours earlier in the very fix this guard was covering — and
 * reported it as a call site with a missing denominator. That is the FIFTH prose-read-as-code
 * instance found on 2026-08-09 (a `git init` in a comment, a JSDoc `/**` opener, an incident
 * path in a hook header, a file path read as English prose by the memory-contradiction
 * checker, and now this).
 *
 * The rule is fixed, never the comment. Any source-level guard that matches a code shape
 * MUST strip non-code spans first, or it punishes people for documenting the thing it
 * guards — which teaches them to stop writing the documentation.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments (incl. JSDoc)
    .replace(/^\s*\/\/.*$/gm, ' ') // whole-line comments
    .replace(/([^:'"`\\])\/\/.*$/gm, '$1'); // trailing comments, sparing `://` in URLs
}

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = join(SRC, 'memory-renderer.ts');
const LOADER = join(SRC, 'memory-render-candidates.ts');
const CLI = join(SRC, 'commands/memory-render-cli-entry.ts');

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  initMemorySchema(db);
  createSession(db, 's1');
});
afterEach(() => db.close());

describe('candidate ledger — the loader accounts for every row', () => {
  it('balances: population === returned + truncated + excluded', () => {
    for (let i = 0; i < 8; i++) {
      addObservation(db, 's1', 'decision', `real lesson ${i}`, 'body', { importance: 5 });
    }
    for (let i = 0; i < 5; i++) {
      addObservation(db, 's1', 'decision', `[memory-file] slug-${i}`, 'body', { importance: 5 });
    }

    const { candidates, ledger } = loadRenderCandidates(db);
    const excluded = ledger.excluded.reduce((n, e) => n + e.count, 0);

    expect(ledger.population, 'population must count every matching row').toBe(13);
    expect(ledger.returned).toBe(candidates.length);
    expect(ledger.returned + ledger.truncatedByWindow + excluded).toBe(ledger.population);
  });

  it('names the exclusion REASON, never a bare count', () => {
    addObservation(db, 's1', 'decision', 'real lesson', 'body', { importance: 5 });
    addObservation(db, 's1', 'decision', '[memory-file] a-slug', 'body', { importance: 5 });

    const { ledger } = loadRenderCandidates(db);
    expect(ledger.excluded).toEqual([{ reason: EXCLUSION_MEMORY_FILE_REINGEST, count: 1 }]);
    expect(ledger.returned).toBe(1);
  });

  it('a corpus larger than the row window reports the TRUNCATION rather than hiding it', () => {
    // 60 rows against a 50-row window. Before this ledger the 10 lost rows were invisible:
    // the loader returned an array and nothing said it had been cut short.
    for (let i = 0; i < 60; i++) {
      addObservation(db, 's1', 'decision', `lesson ${i}`, 'body', { importance: 5 });
    }
    const { candidates, ledger } = loadRenderCandidates(db);

    expect(ledger.population).toBe(60);
    expect(ledger.windowed, 'ROW-WINDOW-DRIFT').toBe(50);
    expect(ledger.truncatedByWindow, 'the window hid 10 rows and must say so').toBe(10);
    expect(candidates.length).toBe(50);
  });

  it('an EMPTY corpus is distinguishable from a truncated one — both report a denominator', () => {
    const { candidates, ledger } = loadRenderCandidates(db);
    expect(candidates).toEqual([]);
    // The whole point: 0 written with population 0 is a DIFFERENT statement from 0 written
    // with population 60, and the caller can now tell them apart.
    expect(ledger.population).toBe(0);
    expect(ledger.truncatedByWindow).toBe(0);
    expect(ledger.excluded).toEqual([]);
  });
});

describe('renderer accounting — observable through the PUBLIC API, not only in source', () => {
  /**
   * WHY THIS TEST EXISTS, and what it caught.
   *
   * The conservation assertion throws `RenderAccountingLeak` — and `renderMemoryFiles`
   * GATE 3 catches everything that is not `MemoryIndexLockBusy` and degrades it to
   * `EMPTY('error')`, because an accounting bug must never crash session start. That is
   * correct for production and it made the invariant INVISIBLE to a test: the live-fire
   * harness planted a removed `unchanged` bucket and the whole `memory-render` suite
   * stayed GREEN. A guard nobody can observe failing is decoration (CR-72).
   *
   * So the observable consequences are asserted directly: on a clean tree the idempotent
   * re-render reports `unchanged: 1` and NO `skippedReason`; under the plant it reports
   * `skippedReason: 'error'` and an `accounting_leak` audit row.
   */
  it('an idempotent re-render is COUNTED, and the books balance through the public API', () => {
    const home = mkdtempSync(join(tmpdir(), 'massu-accounting-'));
    const memoryDir = join(home, '.claude', 'projects', 'p', 'memory');
    mkdirSync(memoryDir, { recursive: true });
    const NOW = Date.parse('2026-07-12T12:00:00Z');
    db.prepare(
      `INSERT INTO sessions (session_id, started_at, started_at_epoch) VALUES ('s2','2026-07-12',?)`
    ).run(Math.floor(NOW / 1000));

    const c = {
      observationId: 1,
      name: 'a_learned_lesson',
      title: 'A learned lesson',
      body: 'The lesson body. Nothing secret here.',
      importance: 5,
      origin: 'local',
    };
    db.prepare(
      `INSERT OR REPLACE INTO observations
         (id, session_id, type, title, detail, importance, origin, created_at, created_at_epoch)
       VALUES (?, 's2', 'decision', ?, ?, ?, ?, '2026-07-12', ?)`
    ).run(c.observationId, c.title, c.body, c.importance, c.origin, Math.floor(NOW / 1000));

    const events: string[] = [];
    const o = {
      memoryDir,
      home,
      now: NOW,
      config: { ...DEFAULT_MEMORY_FILES_CONFIG, renderEnabled: true },
      audit: (e: string, d: Record<string, unknown>) => events.push(`${e}:${String(d.reason ?? '')}`),
    };

    try {
      const first = renderMemoryFiles(db, [c], o);
      expect(first.considered, 'first render must account for its one candidate').toBe(1);
      expect(first.written.length + first.refusals.length + first.unchanged + first.capped).toBe(1);

      // Second pass: the bytes on disk already equal the bytes we would write (B-07).
      const second = renderMemoryFiles(db, [c], o);
      // SHORT marker on purpose: vitest ELIDES a long custom message with `…`, so the
      // live-fire harness could never grep a full sentence. Measured, not assumed.
      expect(second.skippedReason, 'ACCOUNTING-LEAK-DEGRADED').toBeUndefined();
      expect(second.unchanged, 'the idempotent drop must land in the unchanged bucket').toBe(1);
      expect(second.considered).toBe(1);
      expect(
        second.written.length + second.refusals.length + second.unchanged + second.capped
      ).toBe(second.considered);
      expect(events.filter((e) => e.includes('accounting_leak'))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('renderer accounting — the shape is bound in source, not only in behaviour', () => {
  it('every EMPTY() call site passes a denominator', () => {
    // codeOnly(): a comment mentioning EMPTY('error') is documentation, not a call site.
    const src = codeOnly(readFileSync(RENDERER, 'utf8'));
    // Definition + call sites. A call site with no second argument silently defaults the
    // denominator to 0, which is the exact "walked away from N rows, reported 0" bug.
    const calls = [...src.matchAll(/EMPTY\((?!reason)[^)]*\)/g)].map((m) => m[0]);
    expect(calls.length, 'no EMPTY() call sites found — this guard is reading the wrong file').toBeGreaterThan(3);
    const bare = calls.filter((c) => !c.includes(','));
    expect(bare, `EMPTY() call site(s) with no denominator: ${bare.join(', ')}`).toEqual([]);
  });

  it('the conservation invariant exists and throws a NAMED error', () => {
    const src = codeOnly(readFileSync(RENDERER, 'utf8'));
    expect(src).toContain('RenderAccountingLeak');
    expect(src, 'the invariant must compare against candidates.length').toMatch(
      /accounted\s*!==\s*candidates\.length/
    );
    expect(src, 'the leak must be auditable, not only thrown').toContain("reason: 'accounting_leak'");
  });

  it('the loader has exactly ONE definition — no sibling ledger loader', () => {
    const src = codeOnly(readFileSync(LOADER, 'utf8'));
    const defs = [...src.matchAll(/export function loadRenderCandidates\w*/g)].map((m) => m[0]);
    expect(defs, 'a second "which memories are renderable?" function is banned').toEqual([
      'export function loadRenderCandidates',
    ]);
  });
});

describe('CLI — the denominator reaches the operator', () => {
  it('prints the ledger and NEVER swallows skippedReason', () => {
    const src = codeOnly(readFileSync(CLI, 'utf8'));
    expect(src, 'the population line is the denominator (M1)').toContain('candidate population');
    expect(src).toContain('reached the renderer');
    expect(src, 'considered/written/refused/unchanged/capped must all be shown').toMatch(
      /considered \$\{result\.considered\}/
    );
    // Before the fix, `skippedReason` was read ONLY to special-case `no_memory_dir`, so a
    // busy lock and a clean idle run printed identical output.
    expect(src).toMatch(/skipped: \$\{result\.skippedReason \?\? '\(none\)'\}/);
  });
});
