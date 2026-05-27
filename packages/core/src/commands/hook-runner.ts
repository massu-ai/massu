// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu hook-runner <hook-name>` — dynamic hook dispatcher.
 *
 * Closes the P-003 install-path drift class: previously, `installHooks`
 * baked an ABSOLUTE path to the installer's `dist/hooks/*.js` location
 * (whatever npx happened to cache, e.g. `/opt/homebrew/lib/node_modules/...`).
 * Any cache clear, global-install relocation, or npx upgrade silently 404'd
 * every hook — customers thought auto-learning was working but nothing fired.
 *
 * The fix: settings.json now invokes `npx -y @massu/core@<pinned-version> hook-runner <name>`.
 * This subcommand resolves the hook script via Node's module resolver at
 * fire-time, dispatching to the same compiled hook file that ships with
 * the installer. Customer never sees an absolute path.
 *
 * Performance: each hook fire spawns npx + node. Measured ~120-300ms cold
 * (npx cache hit). Acceptable for hooks not on UI critical path; SessionStart
 * and PreCompact are infrequent, PostToolUse is per-tool-call.
 *
 * Hook name → compiled-file mapping is exhaustive (closed enum) so we fail
 * loudly on typos rather than silent-no-op. Unknown hook names print a
 * diagnostic to stderr and exit 2 (distinct from hook's own non-zero exits).
 */

import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { REGISTERED_HOOKS } from '../lib/hook-registry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Recognized hook names → compiled JS filename under `dist/hooks/`.
 *
 * Derived from `REGISTERED_HOOKS` (the single source of truth in
 * `lib/hook-registry.ts`) so the dispatcher cannot drift from the
 * installer / source / build-output triad that already passes 3-way
 * parity. Closes the 1.13.0 regression where `pre-tool-use-gate` was
 * added to REGISTERED_HOOKS + src/hooks + buildHooksConfig but the
 * hand-maintained dispatcher map missed the entry, causing every new
 * install's PreToolUse hook to throw `Unknown hook` and block
 * Bash/Edit/Write at the CC tool gate.
 */
export const HOOK_NAME_TO_FILE: Record<string, string> = Object.freeze(
  Object.fromEntries(REGISTERED_HOOKS.map((name) => [name, `${name}.js`])),
) as Record<string, string>;

/**
 * Resolve the compiled hook file path for a given hook name.
 *
 * Search order (in order of likelihood at runtime):
 *   1. `./hooks/<file>` — bundled compiled layout: dist/cli.js + dist/hooks/*.js
 *      (the canonical layout under npx cache + global install).
 *   2. `../hooks/<file>` — TS-source dev layout: src/commands/hook-runner.ts +
 *      src/hooks/<file>.ts (used by direct-tsx invocation in tests).
 *   3. `../../dist/hooks/<file>` — TS-source dev layout fallback after build.
 *
 * Hard error on miss — silently swallowing a missing hook is exactly the bug
 * class P-003 closes.
 */
export function resolveHookFile(hookName: string): string {
  const file = HOOK_NAME_TO_FILE[hookName];
  if (!file) {
    throw new Error(
      `Unknown hook: "${hookName}". Recognized: ${Object.keys(HOOK_NAME_TO_FILE).join(', ')}`,
    );
  }
  const candidates = [
    // Bundled compiled layout: dist/cli.js → ./hooks/<file>.js
    resolve(__dirname, 'hooks', file),
    // TS-source dev / sibling layout: src/commands/ → ../hooks/<file>
    resolve(__dirname, '../hooks', file),
    // TS-source dev fallback: src/commands/ → ../../dist/hooks/<file>
    resolve(__dirname, '../../dist/hooks', file),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Hook file not found for "${hookName}". Searched: ${candidates.join(', ')}. ` +
      'This indicates a broken @massu/core install. Re-run `npx -y @massu/core init`.',
  );
}

/**
 * Subcommand entrypoint. Spawns `node <resolved-hook-file>` as a child
 * with stdin/stdout/stderr piped through, so the hook receives the same
 * JSON-on-stdin contract Claude Code expects, and stdout/stderr surface
 * to Claude Code unchanged.
 *
 * Returns the child's exit code (or 2 on resolution error before spawn).
 */
export async function runHookRunner(args: string[]): Promise<{ exitCode: number }> {
  const hookName = args[0];
  if (!hookName) {
    process.stderr.write(
      'massu hook-runner: missing hook name.\n' +
        'Usage: massu hook-runner <hook-name>\n' +
        `Recognized: ${Object.keys(HOOK_NAME_TO_FILE).join(', ')}\n`,
    );
    return { exitCode: 2 };
  }

  let hookFile: string;
  try {
    hookFile = resolveHookFile(hookName);
  } catch (err) {
    process.stderr.write(`massu hook-runner: ${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 2 };
  }

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [hookFile], {
      stdio: ['inherit', 'inherit', 'inherit'],
      env: process.env,
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        // Mirror typical shell convention: 128 + signal number; signals are not
        // easily mapped to numbers here without an explicit table, so we just
        // report 128 as a sentinel "killed by signal".
        resolvePromise({ exitCode: 128 });
        return;
      }
      resolvePromise({ exitCode: code ?? 0 });
    });
    child.on('error', (err) => {
      process.stderr.write(`massu hook-runner: failed to spawn hook "${hookName}": ${err.message}\n`);
      resolvePromise({ exitCode: 2 });
    });
  });
}
