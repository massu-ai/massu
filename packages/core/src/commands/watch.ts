// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu watch` CLI runner.
 *
 * Default mode: spawn `claude-bg start ... -- npx @massu/core watch --foreground`
 * so the daemon registers in ~/.claude/bg-registry.jsonl and inherits the
 * SessionEnd reaper. (Phase 0 decision: claude-bg is a peer dependency, not
 * embedded.)
 *
 * --foreground: run the daemon in the current terminal. Used internally by
 * claude-bg-spawn AND by users who prefer their own process supervisor.
 *
 * --status / --stop: thin wrappers over `claude-bg list --mine` and
 * `claude-bg kill <name>`.
 *
 * --apply-now: bypass quiescence and apply immediately. Useful in CI.
 *
 * Library discipline (CR / VR-LIBRARY-NO-PROCESS-EXIT): runWatch() returns
 * a result object; only cli.ts calls process.exit on the returned code.
 */

import { spawnSync } from 'child_process';
import { basename, dirname, resolve } from 'path';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { runDetection } from '../detect/index.ts';
import { computeFingerprint } from '../detect/drift.ts';
import { runConfigRefresh } from './config-refresh.ts';
import { installAll } from './install-commands.ts';
import { withInstallLock, InstallLockBusyError } from '../lib/installLock.ts';
import { isPidAlive } from '../lib/pidLiveness.ts';
import { gitToplevel } from '../lib/gitToplevel.ts';
import { startDaemon } from '../watch/daemon.ts';
import { readState, updateState, watchStatePath } from '../watch/state.ts';

export interface WatchResult {
  exitCode: 0 | 1 | 2;
  message?: string;
}

interface ParsedFlags {
  foreground: boolean;
  status: boolean;
  stop: boolean;
  applyNow: boolean;
  root?: string;
  help: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  const out: ParsedFlags = {
    foreground: false,
    status: false,
    stop: false,
    applyNow: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--foreground') out.foreground = true;
    else if (a === '--status') out.status = true;
    else if (a === '--stop') out.stop = true;
    else if (a === '--apply-now') out.applyNow = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--root') {
      out.root = args[i + 1];
      i++;
    }
  }
  return out;
}

function findClaudeBg(): string | null {
  // Prefer the well-known Hedge-author install path; fall back to PATH.
  const home = process.env.HOME ?? '';
  const fixed = home ? resolve(home, '.claude', 'bin', 'claude-bg') : null;
  if (fixed && existsSync(fixed)) return fixed;
  const which = spawnSync('which', ['claude-bg'], { encoding: 'utf-8' });
  if (which.status === 0 && which.stdout) {
    const p = which.stdout.trim();
    if (p) return p;
  }
  return null;
}

function watchName(root: string): string {
  return `massu-watch-${basename(root)}`;
}

function printHelp(out: (s: string) => void): void {
  out(`
Usage: massu watch [flags]

  Default            Start the watcher under claude-bg.
  --foreground       Run the daemon in the current terminal (used by claude-bg).
  --status           Show running watcher info.
  --stop             Stop the watcher (kills via claude-bg).
  --apply-now        Bypass quiescence and apply immediately (CI use).
  --root <dir>       Daemon root (default: git rev-parse --show-toplevel).
  -h, --help         Show this help.
`);
}

export async function runWatch(args: string[]): Promise<WatchResult> {
  const flags = parseFlags(args);
  if (flags.help) {
    printHelp((s) => process.stdout.write(s));
    return { exitCode: 0 };
  }

  const cwd = process.cwd();
  const root = flags.root ?? gitToplevel(cwd);

  if (flags.status) return runStatus(root);
  if (flags.stop) return runStop(root);
  if (flags.applyNow) return runApplyNow(root);
  if (flags.foreground) return runForeground(root);

  // Default: spawn under claude-bg.
  const claudeBg = findClaudeBg();
  if (!claudeBg) {
    const msg =
      'massu watch needs `claude-bg` on your PATH (or installed at ~/.claude/bin/claude-bg).\n' +
      'Install: see https://massu.ai/docs/watch (or run `massu watch --foreground` to skip the bg supervisor).\n';
    process.stderr.write(msg);
    return { exitCode: 1, message: msg };
  }

  const name = watchName(root);
  const res = spawnSync(claudeBg, [
    'start',
    '--name', name,
    '--port', '0',
    '--',
    'npx', '@massu/core', 'watch', '--foreground', '--root', root,
  ], { stdio: 'inherit' });

  return { exitCode: (res.status ?? 1) === 0 ? 0 : 1 };
}

function runStatus(root: string): WatchResult {
  const path = watchStatePath(root);
  if (!existsSync(path)) {
    process.stdout.write('massu watch: not running (no state file)\n');
    return { exitCode: 0 };
  }
  let state;
  try {
    state = readState(root);
  } catch (err) {
    process.stderr.write(`massu watch: ${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 2 };
  }
  const alive = state.daemonPid ? isPidAlive(state.daemonPid) : false;
  process.stdout.write(
    `massu watch: ${alive ? 'running' : 'stale'}\n` +
    `  pid:           ${state.daemonPid ?? 'n/a'}\n` +
    `  started:       ${state.startedAt ?? 'n/a'}\n` +
    `  last refresh:  ${state.lastRefreshAt ?? 'never'}\n` +
    `  last tick:     ${state.tickedAt ?? 'never'}\n` +
    `  last error:    ${formatLastError(state.lastError)}\n`
  );
  return { exitCode: 0 };
}

/**
 * Iter-7 fix: `state.lastError` may be multi-line (e.g. a chokidar stack
 * trace persisted via `updateState({lastError: msg})`). Rendering it raw on
 * the single-line `last error: ...` row produces messy column-broken output.
 * Collapse to the first non-empty line + " (...)" indicator when there were
 * additional lines, capped at 200 chars so a runaway message can't push
 * `runStatus` into multi-screen output.
 */
function formatLastError(raw: string | null): string {
  if (raw === null || raw === undefined || raw === '') return 'none';
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (lines.length === 0) return 'none';
  const head = lines[0];
  const truncated = head.length > 200 ? head.slice(0, 197) + '...' : head;
  return lines.length > 1 ? `${truncated} (+${lines.length - 1} more line(s))` : truncated;
}

function runStop(root: string): WatchResult {
  const claudeBg = findClaudeBg();
  if (!claudeBg) {
    process.stderr.write('massu watch --stop: claude-bg not found; cannot kill registered daemon\n');
    return { exitCode: 1 };
  }
  const res = spawnSync(claudeBg, ['kill', watchName(root)], { stdio: 'inherit' });
  return { exitCode: (res.status ?? 1) === 0 ? 0 : 1 };
}

async function runApplyNow(root: string): Promise<WatchResult> {
  // One-shot manual refresh — same code path as the daemon's onQuiescent.
  await runOnQuiescent(root);
  return { exitCode: 0 };
}

/**
 * Iter-8 fix (Plan 3a §256 risk #6): "second watcher with same toplevel
 * refuses to start". Returns a non-null message when another live daemon
 * already owns this root, else null. Exposed for unit testing — the
 * runForeground caller writes the message to stderr and returns exit 1.
 *
 * Without this guard, two `massu watch --foreground` calls racing on the
 * same repo result in two chokidar watchers, two debounce timers, two
 * fireRefresh paths writing watch-state.json + refresh-log concurrently —
 * the install-lock prevents data corruption but the user gets bursty
 * `installAll already running` stderr spew on every quiescence cycle.
 *
 * The pre-flight peek at watch-state.json + isPidAlive is cheap and
 * catches the common case (user re-running the command in another shell)
 * before any side effects.
 */
export function checkConflictingDaemon(
  root: string,
  selfPid: number = process.pid,
  pidAlive: (pid: number) => boolean = isPidAlive,
): string | null {
  let existingState;
  try {
    existingState = readState(root);
  } catch {
    return null;
  }
  if (
    !existingState ||
    typeof existingState.daemonPid !== 'number' ||
    existingState.daemonPid <= 0 ||
    existingState.daemonPid === selfPid ||
    !pidAlive(existingState.daemonPid)
  ) {
    return null;
  }
  return (
    `massu watch: another daemon is already running for this root (PID=${existingState.daemonPid}).\n` +
    `  root:       ${root}\n` +
    `  state:      ${watchStatePath(root)}\n` +
    `  to stop it: massu watch --stop\n`
  );
}

/**
 * Foreground daemon entry. Resolves when SIGINT / SIGTERM is received.
 * cli.ts (the only allowed process.exit caller per VR-LIBRARY-NO-PROCESS-EXIT)
 * exits the process with the returned code.
 */
async function runForeground(root: string): Promise<WatchResult> {
  const conflict = checkConflictingDaemon(root);
  if (conflict !== null) {
    process.stderr.write(conflict);
    return { exitCode: 1, message: conflict };
  }

  // Ensure the watcher writes startup state at the registered root, not cwd.
  // Save the prior cwd so shutdown can restore it (defense-in-depth — when
  // SIGINT/SIGTERM fires the process is exiting, but tests and any embedder
  // calling runForeground multiple times benefit from a clean restore).
  const priorCwd = process.cwd();
  process.chdir(root);

  // Iter-2 fix: if startDaemon throws (e.g., invalid config, chokidar
  // bootstrap fails), we must restore cwd before propagating — otherwise
  // tests and embedders are left with a permanently-changed cwd.
  let stopped = false;
  let handle;
  try {
    handle = startDaemon(root, {
      onQuiescent: () => runOnQuiescent(root),
    });
  } catch (err) {
    try { process.chdir(priorCwd); } catch { /* best-effort */ }
    throw err;
  }

  return new Promise<WatchResult>((resolve) => {
    const shutdown = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      process.stderr.write('[massu] shutting down watcher\n');
      await handle.stop();
      try {
        process.chdir(priorCwd);
      } catch {
        // priorCwd may have been removed — best-effort restore.
      }
      resolve({ exitCode: 0 });
    };
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
  });
}

/**
 * Plan 3a Phase 6 quiescence callback:
 *   1. runDetection() — fresh stack inventory
 *   2. computeFingerprint() — compare to lastFingerprint
 *   3. on change: runConfigRefresh({silent, autoYes:true, skipCommands:true})
 *      (per iter-3 G3-A9 option A: skip the recursive installAll inside
 *       runConfigRefresh so we own the single `installAll` call ourselves)
 *   4. installAll(projectRoot) under withInstallLock
 *   5. updateState({lastFingerprint, lastRefreshAt})
 *   6. Append refresh-log event
 *   7. Stderr: `[massu] Stack changed, commands updated (N files). Diff: massu refresh-log latest`
 */
export async function runOnQuiescent(projectRoot: string): Promise<void> {
  const detection = await runDetection(projectRoot);
  const newFingerprint = computeFingerprint(detection);
  const state = readState(projectRoot);

  if (state.lastFingerprint === newFingerprint && state.lastFingerprint !== null) {
    // Nothing actually changed in the stack; only file events fired.
    return;
  }

  // Refresh the YAML (auto-apply, but DO NOT recursively installAll).
  const refresh = await runConfigRefresh({
    cwd: projectRoot,
    silent: true,
    autoYes: true,
    skipCommands: true,
  });

  if (refresh.exitCode !== 0) {
    updateState(projectRoot, { lastError: refresh.message ?? 'refresh failed' });
    process.stderr.write(`[massu] config refresh failed: ${refresh.message ?? 'unknown'}\n`);
    return;
  }

  let installResult;
  try {
    installResult = withInstallLock(projectRoot, () => installAll(projectRoot));
  } catch (err) {
    if (err instanceof InstallLockBusyError) {
      // Another caller already installing — let them finish; next event re-fires.
      process.stderr.write(`[massu] ${err.message}\n`);
      updateState(projectRoot, { lastError: err.message });
      return;
    }
    throw err;
  }

  const filesTouched =
    installResult.totalInstalled +
    installResult.totalUpdated;

  appendRefreshLog(projectRoot, {
    at: new Date().toISOString(),
    fromFingerprint: state.lastFingerprint,
    toFingerprint: newFingerprint,
    filesInstalled: installResult.totalInstalled,
    filesUpdated: installResult.totalUpdated,
    filesKept: installResult.totalKept,
  });

  updateState(projectRoot, {
    lastFingerprint: newFingerprint,
    lastRefreshAt: new Date().toISOString(),
    lastError: null,
  });

  process.stderr.write(
    `[massu] Stack changed, commands updated (${filesTouched} files). Diff: massu refresh-log latest\n`
  );
}

// ============================================================
// refresh-log support — append-only JSONL at .massu/refresh-log.jsonl
// ============================================================

export interface RefreshLogEvent {
  at: string;
  fromFingerprint: string | null;
  toFingerprint: string;
  filesInstalled: number;
  filesUpdated: number;
  filesKept: number;
}

function refreshLogPath(projectRoot: string): string {
  return resolve(projectRoot, '.massu', 'refresh-log.jsonl');
}

function appendRefreshLog(projectRoot: string, event: RefreshLogEvent): void {
  const path = refreshLogPath(projectRoot);
  try {
    // Append-only — at-most-one-line-per-event ensures partial writes corrupt
    // only the trailing line, which JSONL readers naturally tolerate.
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(event) + '\n', 'utf-8');
  } catch {
    // best-effort; never let log-write crash the daemon.
  }
}

export interface ReadRefreshLogOpts {
  /** Stderr writer for corrupt-line warnings (test seam; defaults to process.stderr). */
  warn?: (s: string) => void;
}

export function readRefreshLog(
  projectRoot: string,
  limit = 10,
  opts: ReadRefreshLogOpts = {},
): RefreshLogEvent[] {
  const path = refreshLogPath(projectRoot);
  if (!existsSync(path)) return [];
  const warn = opts.warn ?? ((s: string) => { process.stderr.write(s); });
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  const tail = lines.slice(-limit);
  const out: RefreshLogEvent[] = [];
  let corrupt = 0;
  for (const line of tail) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        out.push(obj as RefreshLogEvent);
      } else {
        corrupt++;
      }
    } catch {
      corrupt++;
    }
  }
  if (corrupt > 0) {
    warn(`[massu] refresh-log: skipped ${corrupt} corrupt line(s) in ${path}\n`);
  }
  return out;
}
