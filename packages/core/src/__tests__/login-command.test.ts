// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu login` / `massu logout` command tests (CR-59, git-safe API-key mgmt).
 *
 * Covers:
 *   - runLogin(['--key', <valid>, '--no-verify']) writes a 0600 credentials
 *     file under $HOME/.massu containing the key
 *   - an invalid-prefix key calls process.exit(1) and writes nothing
 *   - runLogout() removes the file and is idempotent
 *
 * The credentials module resolves the home directory via os.homedir(), which
 * on POSIX honours $HOME — so we point process.env.HOME at an isolated
 * mkdtempSync temp dir for the duration of each test and restore it after.
 * process.exit is stubbed so an invalid-key path cannot tear down the test
 * runner. All spies + $HOME are restored in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';

import { runLogin, runLogout } from '../commands/login.ts';
import { credentialsPath, credentialsDir, readUserCredentials } from '../credentials.ts';

// P2-003 (plan-2026-07-06-validate-key-deploy-drift): mock the license
// validator so the online-verify messaging branch can be exercised without a
// live server. runLogin dynamically imports '../license.ts'; the hoisted mock
// intercepts it. `mocks.result` is set per test to drive the outcome.
const mocks = vi.hoisted(() => ({ result: undefined as unknown }));
vi.mock('../license.ts', () => ({
  validateLicense: vi.fn(async () => mocks.result),
}));

// ============================================================
// Fixtures
// ============================================================

let tempHome: string;
let originalHome: string | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'massu-login-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;

  // Prevent an invalid-key path from actually exiting the vitest worker.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errorSpy.mockRestore();
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** The path the command should write under our temp $HOME. */
function expectedPath(): string {
  return resolve(tempHome, '.massu', 'credentials');
}

// ============================================================
// runLogin() — happy path
// ============================================================

describe('runLogin() with a valid key', () => {
  it('writes a credentials file containing the key under $HOME/.massu', async () => {
    await runLogin(['--key', 'ms_live_abc123def456', '--no-verify']);

    const p = expectedPath();
    expect(existsSync(p)).toBe(true);
    // Sanity: it lands where credentials.ts would resolve it via $HOME.
    expect(credentialsPath()).toBe(p);
    expect(readUserCredentials()).toBe('ms_live_abc123def456');
  });

  it('writes the credentials file with 0600 permissions and dir with 0700', async () => {
    await runLogin(['--key', 'ms_live_abc123def456', '--no-verify']);

    expect(statSync(expectedPath()).mode & 0o777).toBe(0o600);
    expect(statSync(credentialsDir()).mode & 0o777).toBe(0o700);
  });

  it('does not exit the process on the happy path', async () => {
    await runLogin(['--key', 'ms_live_abc123def456', '--no-verify']);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints a confirmation that mentions the written path', async () => {
    await runLogin(['--key', 'ms_live_abc123def456', '--no-verify']);
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain(expectedPath());
    expect(output).toContain('0600');
  });
});

// ============================================================
// P2-003 — runLogin() online-verify messaging honesty
// ============================================================

describe('runLogin() online-verify messaging (P2-003)', () => {
  function loggedOutput(): string {
    return logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  }

  it('paid tier → "Verified: <Tier> tier"', async () => {
    mocks.result = { tier: 'enterprise', validUntil: '2027-01-01', features: [], outcome: 'validated' };
    await runLogin(['--key', 'ms_live_paid_key_123']);
    expect(loggedOutput()).toContain('Verified: Enterprise tier');
  });

  it('server_error → says could NOT verify and NOT a Free determination (never "Free tier")', async () => {
    mocks.result = { tier: 'free', validUntil: '', features: [], outcome: 'server_error' };
    await runLogin(['--key', 'ms_live_err_key_123']);
    const out = loggedOutput();
    expect(out).toContain('could NOT verify');
    expect(out).toContain('NOT a Free determination');
    expect(out).not.toContain('on the Free tier');
  });

  it('network_error → says could not reach the license server', async () => {
    mocks.result = { tier: 'free', validUntil: '', features: [], outcome: 'network_error' };
    await runLogin(['--key', 'ms_live_net_key_123']);
    expect(loggedOutput()).toContain('could not reach the license server');
  });

  it('authoritative rejected/free → says this key is on the Free tier', async () => {
    mocks.result = { tier: 'free', validUntil: '', features: [], outcome: 'rejected' };
    await runLogin(['--key', 'ms_live_free_key_123']);
    expect(loggedOutput()).toContain('on the Free tier');
  });
});

// ============================================================
// runLogin() — invalid prefix
// ============================================================

describe('runLogin() with an invalid-prefix key', () => {
  it('calls process.exit(1) and writes no credentials file', async () => {
    await runLogin(['--key', 'badkey', '--no-verify']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(existsSync(expectedPath())).toBe(false);
  });

  it('reports the prefix requirement on stderr', async () => {
    await runLogin(['--key', 'badkey', '--no-verify']);
    const errOutput = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errOutput).toContain('ms_live_');
  });
});

// ============================================================
// runLogout()
// ============================================================

describe('runLogout()', () => {
  it('removes a previously-written credentials file', async () => {
    await runLogin(['--key', 'ms_live_logout_target', '--no-verify']);
    expect(existsSync(expectedPath())).toBe(true);

    await runLogout();
    expect(existsSync(expectedPath())).toBe(false);
  });

  it('is idempotent — a second logout with nothing present does not throw', async () => {
    // Nothing written yet.
    await expect(runLogout()).resolves.toBeUndefined();
    expect(existsSync(expectedPath())).toBe(false);

    // Write then remove twice.
    await runLogin(['--key', 'ms_live_logout_twice', '--no-verify']);
    await runLogout();
    await expect(runLogout()).resolves.toBeUndefined();
    expect(existsSync(expectedPath())).toBe(false);
  });

  it('reports the removed path when a file was present', async () => {
    await runLogin(['--key', 'ms_live_logout_report', '--no-verify']);
    logSpy.mockClear();
    await runLogout();
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Removed stored credentials');
    expect(output).toContain(expectedPath());
  });

  it('reports "no stored credentials" when nothing is present', async () => {
    logSpy.mockClear();
    await runLogout();
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('No stored credentials to remove');
  });
});
