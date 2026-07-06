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
 * Primary input is a hidden interactive prompt (no echo). `--key <k>` is
 * supported for scripting but carries a shell-history warning; a piped
 * (non-TTY) stdin is read directly so CI can `echo "$KEY" | massu login`.
 */

import { createInterface } from 'readline';
import {
  writeUserCredentials,
  removeUserCredentials,
  credentialsPath,
  API_KEY_PREFIX,
} from '../credentials.ts';

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

/** Read a key from a piped (non-TTY) stdin. */
async function readStdinKey(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * `massu login [--key <k>] [--no-verify]`.
 * Stores the key in ~/.massu/credentials (0600) and — unless `--no-verify` —
 * validates it online and prints the resolved tier.
 */
export async function runLogin(argv: string[]): Promise<void> {
  const keyFlagIdx = argv.indexOf('--key');
  const noVerify = argv.includes('--no-verify');

  let key: string;
  if (keyFlagIdx >= 0 && argv[keyFlagIdx + 1]) {
    key = argv[keyFlagIdx + 1];
  } else if (process.stdin.isTTY) {
    key = await promptHidden('Massu API key: ');
  } else {
    key = await readStdinKey();
  }
  key = (key ?? '').trim();

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
