/**
 * G-2 — FAILURE MAY NEVER LOOK LIKE EMPTINESS.
 *
 * WHY THIS EXISTS (S-1 / S-4, 2026-07-12):
 * All 18 hooks were fired against a deliberately destroyed database. All 18 exited 0.
 * Not one of them wrote a single byte, anywhere. A totally broken Massu and a quiet
 * day were byte-identical — same exit code, same empty stdout, same empty stderr.
 * There was no channel through which a hook could report its own death, so the
 * post-tool-use hook died on 96% of tool calls for months and nothing ever said so.
 *
 * THE INVARIANT THIS ESTABLISHES:
 *   A hook may fail. A hook may not fail SILENTLY.
 *
 * DESIGN — the file channel is primary, the DB row is best-effort. This is deliberate:
 * this function is called *because something already broke*, and the thing that broke
 * may well be the database. A signal that depends on the failing subsystem is not a
 * signal. So the JSONL append uses `fs` only — no DB, no config, no imports that can
 * themselves throw — and the DB row is attempted afterwards, guarded.
 *
 * Consumed by: `massu doctor`, the G-4 Guardian `massu_hook_health_watcher`, and the
 * G-1 reality gate (which asserts this file is EMPTY — a non-empty file fails the build).
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

export interface HookFailureRecord {
  hook: string;
  error: string;
  stack?: string;
  /** Free-form context (tool name, response shape, session id …). Never secrets. */
  context?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Resolve `.massu/hook-failures.jsonl` WITHOUT importing config.ts.
 *
 * config.ts loads and parses YAML and can throw; this module must survive a broken
 * config, because "the config is broken" is exactly the kind of failure it must report.
 * So we walk up from cwd looking for the repo marker, and fall back to cwd.
 */
function resolveFailureLogPath(): string {
  const explicit = process.env.MASSU_HOOK_FAILURE_LOG;
  if (explicit) return explicit;

  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.massu')) || existsSync(join(dir, 'massu.config.yaml'))) {
      return join(dir, '.massu', 'hook-failures.jsonl');
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), '.massu', 'hook-failures.jsonl');
}

/**
 * Record that a hook failed internally.
 *
 * TOTAL FUNCTION: never throws, whatever the state of the machine. If this threw it
 * would be caught by the same outer `catch {}` it exists to defeat.
 *
 * @returns true if a durable signal was written somewhere (file or stderr).
 */
export function recordHookFailure(
  hook: string,
  error: unknown,
  context?: Record<string, unknown>,
): boolean {
  const record: HookFailureRecord = {
    hook,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n') : undefined,
    context,
    timestamp: new Date().toISOString(),
  };

  let wroteSomething = false;

  // Channel 1 — the durable file. Dependency-free, survives a dead DB.
  try {
    const path = resolveFailureLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf-8');
    wroteSomething = true;
  } catch {
    // Disk full / read-only / permissions. Fall through to stderr — still not silent.
  }

  // Channel 2 — stderr. Claude Code surfaces hook stderr, so a human sees it.
  // This is the channel that would have surfaced S-1 on day one.
  try {
    process.stderr.write(
      `[massu] HOOK FAILURE in ${hook}: ${record.error}\n` +
        `[massu]   This is a bug in Massu, not in your code. See .massu/hook-failures.jsonl\n`,
    );
    wroteSomething = true;
  } catch {
    /* stderr closed — nothing further we can do. */
  }

  // Channel 3 — the DB row, for `doctor` and the Guardian watcher. Strictly optional:
  // it is attempted last precisely because the DB is a plausible cause of the failure.
  try {
    recordHookHealthRow(record);
  } catch {
    /* best-effort by construction. */
  }

  return wroteSomething;
}

/**
 * Best-effort `hook_health` row. Imported lazily so that a module-load failure in
 * memory-db.ts (native binding, ABI mismatch, corrupt file) cannot take down the
 * file/stderr channels above — which are the ones that actually have to work.
 */
function recordHookHealthRow(record: HookFailureRecord): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getMemoryDb } = require('../../memory-db.ts') as {
    getMemoryDb: () => import('better-sqlite3').Database;
  };
  const db = getMemoryDb();
  try {
    db.prepare(
      `INSERT INTO hook_health (hook, error, context_json, occurred_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      record.hook,
      record.error,
      record.context ? JSON.stringify(record.context) : null,
      record.timestamp,
    );
  } finally {
    db.close();
  }
}

/**
 * Wrap a hook's `main()` so that an internal throw becomes a LOUD, durable signal
 * instead of a silent `exit 0`.
 *
 * Exit code stays 0 on purpose: a PostToolUse/SessionStart hook must never block the
 * user's Claude Code session over a Massu-internal bug. The point was never that the
 * hook should crash the session — it is that the failure must leave a TRACE. It now
 * always does, in three places.
 *
 * NOTE the deliberate exception: the *security* hooks (pre-tool-use gate, pre-delete)
 * must NOT use this. A security gate that fails open is not a gate (S-3) — those
 * fail CLOSED with exit 2. See `pre-tool-use-gate.ts`.
 */
export async function runHookSafely(hook: string, main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (err) {
    recordHookFailure(hook, err);
  }
}
