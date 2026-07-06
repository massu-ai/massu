// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu login` / `massu logout` — git-safe, user-level API-key management.
 *
 * `massu login` stores the Enterprise/Pro API key in `~/.massu/credentials`
 * (mode 0600), OUTSIDE every repo, so a customer sets the key ONCE without
 * committing a secret and without per-repo edits. The key is then resolved by
 * credentials.ts on every `getConfig()` (precedence: config > env > this file).
 *
 * Key-source precedence (resolveLoginKey, plan-2026-07-06-login-noninteractive-env-hang):
 *   1. `--key <k>` flag              — scripted; emits a shell-history warning.
 *   2. `MASSU_API_KEY` env var        — the recommended non-exposing scripted/CI path.
 *   3. TTY stdin                       — hidden interactive prompt (no echo).
 *   4. Non-TTY stdin                   — a piped key is read directly so CI can
 *      `echo "$KEY" | massu login`, but the read is BOUNDED by a timeout
 *      (`MASSU_LOGIN_STDIN_TIMEOUT_MS`, default 2000ms) so an idle non-TTY stdin
 *      fails fast with an actionable message instead of hanging forever.
 *
 * Login persists the resolved key (env-sourced included) to the credentials file
 * so future shells that DON'T export the env still resolve it — persistence is
 * the purpose of `login`.
 */

import { createInterface } from 'readline';
import {
  writeUserCredentials,
  removeUserCredentials,
  credentialsPath,
  API_KEY_PREFIX,
  MASSU_ENV_API_KEY,
} from '../credentials.ts';

/** Default bound on the non-TTY stdin read (ms) — the hang backstop. */
const DEFAULT_STDIN_TIMEOUT_MS = 2000;

/** Env var overriding {@link DEFAULT_STDIN_TIMEOUT_MS}. */
export const MASSU_ENV_STDIN_TIMEOUT = 'MASSU_LOGIN_STDIN_TIMEOUT_MS';

/** Actionable failure when no key is available in a non-TTY context (no hang). */
export const NO_KEY_MESSAGE =
  `No API key found. Set ${MASSU_ENV_API_KEY}, pipe the key (echo "$KEY" | massu login), ` +
  'or pass --key <k>; the interactive prompt needs a TTY.';

/** Thrown when key resolution finds no key and cannot prompt (non-TTY). */
export class NoLoginKeyError extends Error {
  constructor(message: string = NO_KEY_MESSAGE) {
    super(message);
    this.name = 'NoLoginKeyError';
  }
}

/** Where a resolved key came from — drives the `--key` shell-history warning. */
export type LoginKeySource = 'flag' | 'env' | 'prompt' | 'stdin';

/** Injectable dependencies so key resolution is a pure, deterministically testable unit. */
export interface ResolveLoginKeyDeps {
  argv: string[];
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  /** Read a piped (non-TTY) stdin to EOF. */
  readStdin: () => Promise<string>;
  /** Prompt interactively (TTY only). */
  prompt: (question: string) => Promise<string>;
  /** Bound (ms) on the non-TTY stdin read before failing fast. */
  timeoutMs: number;
}

/** Resolve the effective stdin-read timeout from the environment. */
export function loginStdinTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env[MASSU_ENV_STDIN_TIMEOUT];
  const n = raw != null && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STDIN_TIMEOUT_MS;
}

/**
 * Read a piped stdin but BOUND it: a real `echo | login` EOFs in milliseconds,
 * while an idle non-TTY stdin that never closes would otherwise hang forever.
 * On timeout, throw {@link NoLoginKeyError} instead of blocking.
 */
async function readStdinBounded(
  readStdin: () => Promise<string>,
  timeoutMs: number
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = readStdin();
  // Once the race is decided by the timeout, the losing read may reject later
  // (e.g. its stream is destroyed) — mark it handled so it isn't an unhandled rejection.
  read.catch(() => undefined);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new NoLoginKeyError()), timeoutMs);
    // Never keep the event loop alive solely for this backstop timer.
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve the login key by explicit precedence: `--key` > `MASSU_API_KEY` env >
 * TTY prompt > bounded non-TTY stdin. Pure and dependency-injected so every
 * branch (including the non-TTY hang backstop) is deterministically testable.
 * Reads the env var directly (via the {@link MASSU_ENV_API_KEY} constant) — NOT
 * via `resolveApiKey()`, which would also read the already-saved file/config and
 * "succeed" without capturing the new key that `login` exists to persist.
 */
export async function resolveLoginKey(
  deps: ResolveLoginKeyDeps
): Promise<{ key: string; source: LoginKeySource }> {
  const { argv, env, isTTY, readStdin, prompt, timeoutMs } = deps;

  const keyFlagIdx = argv.indexOf('--key');
  if (keyFlagIdx >= 0 && argv[keyFlagIdx + 1]) {
    return { key: argv[keyFlagIdx + 1], source: 'flag' };
  }

  const envRaw = env[MASSU_ENV_API_KEY];
  const envKey = typeof envRaw === 'string' ? envRaw.trim() : '';
  if (envKey.length > 0) {
    return { key: envKey, source: 'env' };
  }

  if (isTTY) {
    return { key: await prompt('Massu API key: '), source: 'prompt' };
  }

  // Non-TTY, no flag/env: read a piped key, bounded so an idle stdin can't hang.
  return { key: await readStdinBounded(readStdin, timeoutMs), source: 'stdin' };
}

/** Mask a key for display: `ms_live_…ab12`. */
function maskKey(k: string): string {
  return k.length <= 12 ? '****' : `${k.slice(0, API_KEY_PREFIX.length)}…${k.slice(-4)}`;
}

/** Read a line from stdin with the typed characters hidden (no echo). */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Suppress echo of the typed key: write the prompt itself once, but nothing
    // for the subsequent keystrokes.
    let promptWritten = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rl as any)._writeToOutput = (chunk: string): void => {
      if (!promptWritten) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (rl as any).output.write(question);
        promptWritten = true;
      }
      // swallow keystroke echo
      void chunk;
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolvePromise(answer);
    });
  });
}

/**
 * Cap on piped stdin (bytes). An API key is < 100 bytes; anything past this is
 * junk, so we abort fail-closed rather than buffer unbounded memory (a huge pipe
 * that EOFs inside the timeout window would otherwise be fully buffered).
 */
export const MAX_STDIN_BYTES = 64 * 1024;

/** Read a key from a piped (non-TTY) stdin, bounded to {@link MAX_STDIN_BYTES}. */
async function readStdinKey(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_STDIN_BYTES) {
      // Fail closed: stop reading, tear down stdin, write nothing.
      (process.stdin as unknown as { destroy?: () => void }).destroy?.();
      throw new NoLoginKeyError(
        `Piped input exceeds ${MAX_STDIN_BYTES} bytes — an API key is under 100 bytes. ` +
          'Aborting; nothing was written.'
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * `massu login [--key <k>] [--no-verify]`.
 * Stores the key in ~/.massu/credentials (0600) and — unless `--no-verify` —
 * validates it online and prints the resolved tier.
 */
export async function runLogin(argv: string[]): Promise<void> {
  const noVerify = argv.includes('--no-verify');

  let resolved: { key: string; source: LoginKeySource };
  try {
    resolved = await resolveLoginKey({
      argv,
      env: process.env,
      isTTY: Boolean(process.stdin.isTTY),
      readStdin: readStdinKey,
      prompt: promptHidden,
      timeoutMs: loginStdinTimeoutMs(process.env),
    });
  } catch (err) {
    // Non-TTY with no key (or the bounded read timed out): fail fast, never hang.
    if (err instanceof NoLoginKeyError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
      return;
    }
    throw err;
  }

  // P1-002: warn when the key came from --key (exposed to shell history).
  if (resolved.source === 'flag') {
    console.error(
      'Warning: --key exposes your API key to shell history. Prefer MASSU_API_KEY or a ' +
        'piped key (echo "$KEY" | massu login) for automation.'
    );
  }

  const key = (resolved.key ?? '').trim();

  if (!key.startsWith(API_KEY_PREFIX)) {
    console.error(`Error: API key must start with "${API_KEY_PREFIX}".`);
    process.exit(1);
    return;
  }

  const path = writeUserCredentials(key);
  console.log(`\nSaved API key ${maskKey(key)} to ${path} (permissions 0600).`);
  console.log('This file lives outside every repository — your key is never committed to git.');

  if (!noVerify) {
    try {
      // Re-read config so the newly-written credentials file is resolved
      // (source: user-file) and the branded default endpoint is populated.
      const { resetConfig } = await import('../config.ts');
      resetConfig();
      const { validateLicense } = await import('../license.ts');
      const info = await validateLicense(key);

      if (info.tier !== 'free') {
        // Paid tier confirmed (outcome: validated / cache_fresh / grace).
        const cap = info.tier.charAt(0).toUpperCase() + info.tier.slice(1);
        console.log(
          `Verified: ${cap} tier${info.validUntil ? `, valid until ${info.validUntil}` : ''}.`
        );
      } else {
        // Tier resolved to Free — but WHY matters (P2-003). A server error or an
        // unreachable server must NOT be reported as a Free downgrade.
        switch (info.outcome) {
          case 'server_error':
            console.log(
              'Saved, but could NOT verify your key: the license server returned an error.'
            );
            console.log(
              'This is NOT a Free determination — your tier is unknown. It will re-validate automatically on next use; if this persists, the license server may be down.'
            );
            break;
          case 'network_error':
          case 'no_endpoint':
            console.log(
              'Saved; could not reach the license server right now (offline). Your key will validate automatically on next use.'
            );
            break;
          default:
            // 'validated' | 'rejected' | 'cache_fresh' | 'grace' — an
            // authoritative Free (or a cached Free). Report it plainly.
            console.log(
              'Verified: this key is on the Free tier (check the key or your subscription at https://massu.ai/dashboard).'
            );
        }
      }
    } catch {
      console.log('Saved; could not verify online right now (it will validate on next use).');
    }
  }
  console.log('');
}

/** `massu logout` — remove the stored user-level credentials. Idempotent. */
export async function runLogout(): Promise<void> {
  const removed = removeUserCredentials();
  console.log(
    removed
      ? `Removed stored credentials at ${credentialsPath()}.`
      : 'No stored credentials to remove.'
  );
}
