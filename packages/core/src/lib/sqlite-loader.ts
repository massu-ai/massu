// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * SSOT SQLite loader — the SINGLE construction chokepoint for `better-sqlite3`.
 *
 * WHY THIS EXISTS (incident 2026-07-12, bug class B — native engine):
 * `better-sqlite3` is a NATIVE module. Its `.node` binary is compiled for the
 * ABI of whichever Node ran `npm install`. The Massu launcher forces the RUNTIME
 * to node@22 (NODE_MODULE_VERSION / ABI 127). A customer who installed under
 * Node 24/26 (ABI 147) gets a binary that `dlopen`-FAILS at runtime — and the
 * failure is LAZY: it fires on the first `new Database()`, INSIDE the constructor
 * (`node_modules/better-sqlite3/lib/database.js:48` — `require('bindings')(...)`),
 * NOT at `import` time. Two defects fell out of this, one class:
 *   #1 ABI silent-death — DB-touching commands died; a published build printed
 *      the raw NODE_MODULE_VERSION error and EXITED 0 (silently-dead memory).
 *   #2 lying doctor — `massu doctor` did `await import('better-sqlite3')`, which
 *      loads only the JS wrapper (the native dlopen is lazy), so it reported
 *      "loads correctly" while a real DB touch died.
 *
 * THE STRUCTURAL FIX (this module):
 *   - ONE loader/construction chokepoint (`openDatabase`) so a native-load
 *     failure is detected, healed, and typed-error'd in exactly ONE place —
 *     no N scattered `new Database()` calls each free to swallow differently.
 *   - A GATED, ABI-DETERMINISTIC self-heal (`attemptNativeHeal`): on an ABI /
 *     dlopen failure it rebuilds the binary for the RUNNING Node via
 *     `prebuild-install` → `node-gyp rebuild`, driven by `process.execPath` so
 *     the rebuilt ABI deterministically matches the runtime, cross-process
 *     locked, retries ONCE, and on any precondition-miss or retry-failure throws
 *     a LOUD, structured `MemoryEngineUnusableError` carrying the remedy — NEVER
 *     swallowed, NEVER exit 0.
 *   - A SHARED probe (`probeMemoryDbUsable`) that actually CONSTRUCTS a DB and
 *     runs `SELECT 1`, so `doctor` and startup can never diverge (bug #2).
 *   - File-based heal telemetry (`recordHealEvent` → `~/.massu/native-heal-events.jsonl`).
 *
 * SECURITY (CR-63 / S5): every child process is spawned with an ARGV ARRAY and
 * `process.execPath` — NEVER a shell string, the shell option is never enabled,
 * and no value is ever interpolated into a shell.
 *
 * DRIFT-GUARD: this file is the ONLY place in `packages/core/src` allowed to do a
 * value-load of `better-sqlite3` (`import type` is exempt everywhere). Enforced by
 * `sqlite-loader-drift-guard.test.ts` + pattern-scanner Check 42. See CR-65.
 */

import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { accessSync, appendFileSync, chmodSync, constants as fsConstants, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type Database from 'better-sqlite3';
import { credentialsDir } from '../credentials.ts';
import { withFileLockSync } from './fileLock.ts';

// A require bound to THIS module — used to load the native ctor lazily and to
// resolve the better-sqlite3 package dir. `req('better-sqlite3')` is NOT a
// `require('better-sqlite3')`/`await import('better-sqlite3')` literal, so it is
// invisible to the drift-guard grep AND this file is exempt regardless.
const req = createRequire(import.meta.url);

/** The single canonical remedy string surfaced everywhere a native load fails. */
export const NATIVE_DB_REMEDY =
  "Run 'massu heal' to rebuild the database engine for your Node version, then restart your MCP client / Claude Code.";

/** Why the memory engine is unusable. */
export type MemoryEngineReason = 'abi-mismatch' | 'heal-failed' | 'unreadable' | 'missing';

/**
 * Thrown when the native SQLite engine cannot be loaded and cannot be healed.
 * LOUD and structured — never swallowed, never turned into an exit-0 empty result.
 */
export class MemoryEngineUnusableError extends Error {
  readonly reason: MemoryEngineReason;
  readonly remedy: string;
  readonly detail?: string;

  constructor(reason: MemoryEngineReason, detail?: string) {
    super(
      `Massu memory engine is unusable (${reason}). ${NATIVE_DB_REMEDY}` +
        (detail ? ` [${detail}]` : ''),
    );
    this.name = 'MemoryEngineUnusableError';
    this.reason = reason;
    this.remedy = NATIVE_DB_REMEDY;
    this.detail = detail;
  }
}

/** Options for {@link openDatabase}: better-sqlite3's own options + loader control. */
export type OpenDatabaseOptions = Database.Options & {
  /**
   * When `true` (default) a native-ABI load failure triggers a gated rebuild +
   * one retry. When `false` (hooks, 5s budget / CR-12) the failure is surfaced
   * loud immediately — the next server/CLI touch heals. See P0-003.
   */
  selfHeal?: boolean;
};

/** Classifier: is this the native ABI / dlopen failure class (vs a real DB error)? */
export function isNativeAbiError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ERR_DLOPEN_FAILED') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /NODE_MODULE_VERSION/.test(msg) ||
    /was compiled against a different Node\.js version/.test(msg) ||
    /ERR_DLOPEN_FAILED/.test(msg) ||
    (/\.node\b/.test(msg) &&
      /dlopen|invalid ELF|mach-o|image not found|no such file|not a valid Win32/i.test(msg))
  );
}

/**
 * Load the `better-sqlite3` constructor. Loading the wrapper does NOT trigger the
 * native dlopen (that is lazy, inside the constructor) — so this rarely throws;
 * the ABI failure surfaces at `new Ctor()` in {@link openDatabase}.
 *
 * @param opts.fresh bust the module cache first (used after a rebuild so the new
 *   `.node` is loaded instead of the stale in-process binding).
 */
export function loadBetterSqlite3(opts: { fresh?: boolean } = {}): typeof Database {
  if (_testCtor) return _testCtor;
  if (opts.fresh) bustNativeCache();
  return req('better-sqlite3') as typeof Database;
}

/** Drop every cached module related to the native binding so a rebuild reloads. */
function bustNativeCache(): void {
  try {
    const cache = req.cache;
    if (!cache) return;
    for (const key of Object.keys(cache)) {
      if (/better[-_]sqlite3|better_sqlite3\.node|[\\/]bindings[\\/]/.test(key)) {
        delete cache[key];
      }
    }
  } catch {
    /* best-effort — a failed cache bust just means the retry may still be stale */
  }
}

/**
 * THE SOLE construction chokepoint. Constructs a better-sqlite3 `Database`,
 * self-healing the native binding on an ABI failure (unless `selfHeal:false`).
 *
 * `selfHeal` is stripped before the remaining options are forwarded VERBATIM to
 * the constructor — so `{ readonly: true }` (and `fileMustExist`/`timeout`/
 * `verbose`) reach better-sqlite3 unchanged (dropping `readonly` would silently
 * open the read-only CodeGraph DB read-write — a CR-11 violation).
 */
export function openDatabase(dbPath: string, opts: OpenDatabaseOptions = {}): Database.Database {
  const { selfHeal: selfHealOpt = true, ...ctorOpts } = opts;
  // Hooks run under a 5s budget (CR-12 / P0-003): a native rebuild can exceed it. When
  // running inside the hook-runner child (MASSU_HOOK_RUNTIME=1), NEVER self-heal —
  // regardless of the caller's opt — so INDIRECT opens (e.g. getMemoryDb() from a hook)
  // also fail fast and loud instead of blocking on a rebuild. The next server/CLI touch heals.
  const selfHeal = selfHealOpt && process.env.MASSU_HOOK_RUNTIME !== '1';
  const Ctor = loadBetterSqlite3();
  try {
    return new Ctor(dbPath, ctorOpts);
  } catch (err) {
    if (!isNativeAbiError(err)) {
      throw err; // a real DB error (corrupt file, locked, missing dir) — not our class
    }
    if (!selfHeal) {
      recordHealEvent({ phase: 'skipped', reason: 'self-heal-disabled', abiTo: process.versions.modules });
      throw new MemoryEngineUnusableError('abi-mismatch', detailOf(err));
    }
    const result = (_testHeal ?? attemptNativeHeal)(err);
    // Retry the load ONCE when EITHER we rebuilt OR a concurrent process held the heal
    // lock the whole window (`contended`) and may already have healed it (R2). Only a
    // genuine, uncontended failure to heal is terminal.
    if (!result.healed && !result.contended) {
      throw new MemoryEngineUnusableError(result.reason ?? 'heal-failed', result.detail ?? detailOf(err));
    }
    try {
      const FreshCtor = loadBetterSqlite3({ fresh: true });
      return new FreshCtor(dbPath, ctorOpts);
    } catch (retryErr) {
      throw new MemoryEngineUnusableError('heal-failed', detailOf(retryErr));
    }
  }
}

/** Verdict returned by {@link probeMemoryDbUsable}. Never thrown. */
export interface ProbeVerdict {
  ok: boolean;
  reason?: MemoryEngineReason;
  remedy?: string;
  detail?: string;
  healed?: boolean;
}

/**
 * The SHARED, non-throwing health probe reused by `doctor` and `server.ts`
 * startup — so a green doctor can never again coexist with a dead `consolidate`.
 *
 * (1) Constructs a `:memory:` DB via the loader and runs `SELECT 1` — this is the
 *     REAL native touch (catches the ABI class an `import` alone hides).
 * (2) If `dbPath` exists, ALSO opens it read-only and runs `SELECT 1` — catches a
 *     corrupt / unreadable real DB.
 *
 * @param opts.selfHeal default `false` — a health check reports the truth and
 *   does not mutate. Startup passes `true` to heal-or-fail-loud.
 */
export function probeMemoryDbUsable(opts: { dbPath?: string; selfHeal?: boolean } = {}): ProbeVerdict {
  const selfHeal = opts.selfHeal ?? false;

  // (1) The native touch.
  try {
    const db = openDatabase(':memory:', { selfHeal });
    try {
      db.prepare('SELECT 1').get();
    } finally {
      db.close();
    }
  } catch (err) {
    if (err instanceof MemoryEngineUnusableError) {
      return { ok: false, reason: err.reason, remedy: err.remedy, detail: err.detail };
    }
    // openDatabase re-throws a non-ABI construction fault raw — don't mislabel it as an
    // ABI mismatch (which would steer the user to `massu heal`, which can't fix it).
    return {
      ok: false,
      reason: isNativeAbiError(err) ? 'abi-mismatch' : 'unreadable',
      remedy: NATIVE_DB_REMEDY,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // (2) The real-file touch.
  const dbPath = opts.dbPath;
  if (dbPath && dbPath !== ':memory:' && existsSync(dbPath)) {
    try {
      const rdb = openDatabase(dbPath, { readonly: true, selfHeal: false });
      try {
        rdb.prepare('SELECT 1').get();
      } finally {
        rdb.close();
      }
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof MemoryEngineUnusableError ? err.reason : 'unreadable',
        remedy: NATIVE_DB_REMEDY,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { ok: true };
}

/** Result of an {@link attemptNativeHeal}. */
export interface HealResult {
  healed: boolean;
  /** True when a concurrent process held the heal lock the whole window — the caller
   *  should still retry the load once, since that sibling may already have healed. */
  contended?: boolean;
  method?: 'prebuild-install' | 'node-gyp';
  reason?: MemoryEngineReason;
  abiFrom?: string;
  abiTo?: string;
  durationMs?: number;
  detail?: string;
}

/**
 * Gated, ABI-deterministic rebuild of the native binding for the RUNNING Node.
 *
 * Preconditions gate the attempt (install dir writable; a build tool present); on
 * a precondition miss the attempt is SKIPPED (recorded), not attempted-and-failed,
 * and control falls deterministically to the loud error. Every child is spawned
 * with `process.execPath` + an argv array (no shell). Cross-process locked at
 * `~/.massu/native-heal.lock` so concurrent processes don't stampede.
 */
export function attemptNativeHeal(err?: unknown): HealResult {
  const start = Date.now();
  const abiTo = process.versions.modules;
  const abiFrom = parseAbiFrom(err);

  let pkgDir: string;
  try {
    pkgDir = dirname(req.resolve('better-sqlite3/package.json'));
  } catch {
    recordHealEvent({ phase: 'skipped', reason: 'not-resolvable', abiFrom, abiTo });
    return { healed: false, reason: 'missing', abiFrom, abiTo, detail: 'better-sqlite3 not resolvable' };
  }

  if (!isWritable(pkgDir)) {
    recordHealEvent({ phase: 'skipped', reason: 'dir-not-writable', abiFrom, abiTo });
    return { healed: false, reason: 'heal-failed', abiFrom, abiTo, detail: `install dir not writable: ${pkgDir}` };
  }

  recordHealEvent({ phase: 'attempt', reason: 'abi-mismatch', abiFrom, abiTo });

  try {
    return withFileLockSync(
      join(credentialsDir(), 'native-heal.lock'),
      () => runRebuild(pkgDir, abiFrom, abiTo, start),
      { blockMs: 60_000, staleMs: 300_000 },
    );
  } catch (lockErr) {
    // Another process held the lock the whole window — it very likely healed. Signal
    // `contended` so the caller retries the load once (it may already be healed, R2).
    const detail = lockErr instanceof Error ? lockErr.message : String(lockErr);
    recordHealEvent({ phase: 'failed', reason: 'heal-failed', abiFrom, abiTo, detail: `lock: ${detail}` });
    return { healed: false, contended: true, reason: 'heal-failed', abiFrom, abiTo, detail: `heal lock contended: ${detail}` };
  }
}

/** Run the actual rebuild: prebuild-install (compiler-free) → node-gyp fallback. */
function runRebuild(pkgDir: string, abiFrom: string | undefined, abiTo: string, start: number): HealResult {
  // A concurrent process may have healed the binary while we waited for the lock — re-probe
  // with a fresh binding BEFORE spending minutes on a redundant rebuild (ARCH-01).
  try {
    const FreshCtor = loadBetterSqlite3({ fresh: true });
    new FreshCtor(':memory:').close();
    const res: HealResult = {
      healed: true,
      abiFrom,
      abiTo,
      durationMs: Date.now() - start,
      detail: 'already healed by a concurrent process',
    };
    recordHealEvent({ phase: 'success', reason: 'already-healed', abiFrom, abiTo, durationMs: res.durationMs });
    return res;
  } catch (probeErr) {
    if (!isNativeAbiError(probeErr)) {
      // Not the ABI class → a rebuild cannot help; fail loud rather than compile pointlessly.
      return { healed: false, reason: 'heal-failed', abiFrom, abiTo, durationMs: Date.now() - start, detail: detailOf(probeErr) };
    }
    // Still ABI-broken — proceed to rebuild.
  }

  // Primary — a compiler-free prebuilt for the running ABI/platform.
  const prebuildBin = resolveLocalBin(pkgDir, 'prebuild-install');
  if (prebuildBin) {
    const r = spawnSync(process.execPath, [prebuildBin], {
      cwd: pkgDir,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    if (r.status === 0) {
      const res: HealResult = { healed: true, method: 'prebuild-install', abiFrom, abiTo, durationMs: Date.now() - start };
      recordHealEvent({ phase: 'success', reason: 'abi-mismatch', ...res });
      return res;
    }
  }

  // Fallback — compile from source (requires a toolchain).
  const gypBin = resolveNodeGypBin();
  if (gypBin && hasCompiler()) {
    const r = spawnSync(process.execPath, [gypBin, 'rebuild', '--release'], {
      cwd: pkgDir,
      encoding: 'utf-8',
      timeout: 300_000,
    });
    if (r.status === 0) {
      const res: HealResult = { healed: true, method: 'node-gyp', abiFrom, abiTo, durationMs: Date.now() - start };
      recordHealEvent({ phase: 'success', reason: 'abi-mismatch', ...res });
      return res;
    }
  }

  const res: HealResult = {
    healed: false,
    reason: 'heal-failed',
    abiFrom,
    abiTo,
    durationMs: Date.now() - start,
    detail: prebuildBin
      ? 'prebuild-install failed; node-gyp fallback unavailable or failed'
      : 'no prebuild-install bin resolvable',
  };
  recordHealEvent({ phase: 'failed', reason: 'heal-failed', abiFrom, abiTo, durationMs: res.durationMs });
  return res;
}

/** One heal-telemetry row. No secrets, no paths beyond the package dir. */
export interface HealEvent {
  ts: string;
  phase: 'attempt' | 'success' | 'failed' | 'skipped';
  reason?: string;
  method?: string;
  abiFrom?: string;
  abiTo?: string;
  durationMs?: number;
  detail?: string;
  node: string;
  platform: string;
  arch: string;
}

/**
 * Best-effort append of ONE JSON line to `~/.massu/native-heal-events.jsonl`
 * (mode 0600, via `credentialsDir()` — no second home-dir resolver). NEVER throws:
 * telemetry must not break the heal, and it must record on success AND on terminal
 * failure (dual-safe — works even when the DB never heals).
 */
export function recordHealEvent(
  event: Partial<Omit<HealEvent, 'node' | 'platform' | 'arch' | 'ts'>> & { phase: HealEvent['phase'] },
): void {
  try {
    const rec: HealEvent = {
      ts: new Date().toISOString(),
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      ...event,
    };
    const dir = credentialsDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'native-heal-events.jsonl');
    appendFileSync(file, JSON.stringify(rec) + '\n', 'utf-8');
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best-effort — mode enforcement is a nicety, not a correctness gate */
    }
  } catch {
    /* telemetry MUST NEVER throw */
  }
}

// ============================================================
// Test seams — used ONLY by __tests__ to inject a failing/healing binding without a
// real ABI break. NEVER referenced by any production code path.
// ============================================================

let _testCtor: typeof Database | null = null;
let _testHeal: ((err?: unknown) => HealResult) | null = null;

/** @internal test-only — inject a fake ctor / healer, or pass `null` to clear. */
export function __setSqliteLoaderTestHooks(
  hooks: { ctor?: typeof Database | null; heal?: ((err?: unknown) => HealResult) | null } = {},
): void {
  if ('ctor' in hooks) _testCtor = hooks.ctor ?? null;
  if ('heal' in hooks) _testHeal = hooks.heal ?? null;
}

// ============================================================
// Internal helpers
// ============================================================

/** Parse the module's ABI from an ABI-mismatch message (S1: validated as digits). */
function parseAbiFrom(err: unknown): string | undefined {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const m = /NODE_MODULE_VERSION (\d+)/.exec(msg);
  if (m && /^\d+$/.test(m[1])) return m[1];
  return undefined;
}

function detailOf(err: unknown): string | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  // Bound the surfaced detail; never dump a multi-KB native stack.
  return msg.slice(0, 300);
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a bin from the nearest `.bin` dir (local or hoisted), if present. */
function resolveLocalBin(pkgDir: string, name: string): string | undefined {
  const candidates = [
    join(pkgDir, 'node_modules', '.bin', name), // nested install
    join(pkgDir, '..', '.bin', name), // hoisted (node_modules/.bin)
    join(pkgDir, '..', '..', 'node_modules', '.bin', name), // workspace hoist
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/** Resolve node-gyp's CLI entry (present only when node-gyp is installed). */
function resolveNodeGypBin(): string | undefined {
  try {
    return req.resolve('node-gyp/bin/node-gyp.js');
  } catch {
    return undefined;
  }
}

/** Detect a C/C++ compiler without a shell (argv-array probe of cc/clang/gcc). */
function hasCompiler(): boolean {
  for (const cc of ['cc', 'clang', 'gcc']) {
    try {
      const r = spawnSync(cc, ['--version'], { encoding: 'utf-8', timeout: 5_000 });
      if (r.status === 0) return true;
    } catch {
      /* try the next candidate */
    }
  }
  return false;
}
