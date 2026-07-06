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

import {
  runLogin,
  runLogout,
  resolveLoginKey,
  loginStdinTimeoutMs,
  NoLoginKeyError,
  NO_KEY_MESSAGE,
  MASSU_ENV_STDIN_TIMEOUT,
  MAX_STDIN_BYTES,
} from '../commands/login.ts';
import {
  credentialsPath,
  credentialsDir,
  readUserCredentials,
  MASSU_ENV_API_KEY,
} from '../credentials.ts';

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

// ============================================================
// P2-001/002/003 — resolveLoginKey precedence + non-interactive seam
// (plan-2026-07-06-login-noninteractive-env-hang)
// ============================================================

/** Build resolveLoginKey deps with spies; each test overrides what it exercises. */
function makeDeps(
  overrides: Partial<Parameters<typeof resolveLoginKey>[0]> = {}
): Parameters<typeof resolveLoginKey>[0] {
  return {
    argv: [],
    env: {} as NodeJS.ProcessEnv,
    isTTY: false,
    readStdin: vi.fn(async () => ''),
    prompt: vi.fn(async () => ''),
    timeoutMs: 2000,
    ...overrides,
  };
}

describe('resolveLoginKey() precedence', () => {
  it('--key flag wins over env, prompt, and stdin', async () => {
    const deps = makeDeps({
      argv: ['--key', 'ms_live_flag_wins'],
      env: { [MASSU_ENV_API_KEY]: 'ms_live_env' },
      isTTY: true,
    });
    const r = await resolveLoginKey(deps);
    expect(r).toEqual({ key: 'ms_live_flag_wins', source: 'flag' });
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.readStdin).not.toHaveBeenCalled();
  });

  it('MASSU_API_KEY env is used when no flag; prompt/stdin are NEVER reached (P2-002 structural guard)', async () => {
    const deps = makeDeps({ env: { [MASSU_ENV_API_KEY]: 'ms_live_env_key' }, isTTY: false });
    const r = await resolveLoginKey(deps);
    expect(r).toEqual({ key: 'ms_live_env_key', source: 'env' });
    // The blocking prompt / stdin read is structurally unreachable when a key is
    // available and isTTY is false — the login-hang class is impossible here.
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.readStdin).not.toHaveBeenCalled();
  });

  it('honors MASSU_API_KEY — the help/docstring-advertised path (P2-003 contract drift-guard)', async () => {
    // If a future refactor drops the env read, this fails, closing the
    // "help advertises a path the code ignores" bug class that caused the incident.
    const deps = makeDeps({ env: { [MASSU_ENV_API_KEY]: 'ms_live_contract' }, isTTY: false });
    expect((await resolveLoginKey(deps)).source).toBe('env');
  });

  it('env wins over a piped stdin when BOTH are present (matches resolveApiKey precedence)', async () => {
    const deps = makeDeps({
      env: { [MASSU_ENV_API_KEY]: 'ms_live_env_over_pipe' },
      isTTY: false,
      readStdin: vi.fn(async () => 'ms_live_piped'),
    });
    const r = await resolveLoginKey(deps);
    expect(r).toEqual({ key: 'ms_live_env_over_pipe', source: 'env' });
    expect(deps.readStdin).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace on the env key', async () => {
    const deps = makeDeps({ env: { [MASSU_ENV_API_KEY]: '  ms_live_padded  ' } });
    expect(await resolveLoginKey(deps)).toEqual({ key: 'ms_live_padded', source: 'env' });
  });

  it('an empty/whitespace env key is ignored (falls through to the next source)', async () => {
    const deps = makeDeps({
      env: { [MASSU_ENV_API_KEY]: '   ' },
      isTTY: true,
      prompt: vi.fn(async () => 'ms_live_prompted'),
    });
    expect(await resolveLoginKey(deps)).toEqual({ key: 'ms_live_prompted', source: 'prompt' });
  });

  it('TTY with no flag/env → interactive prompt; stdin read never reached', async () => {
    const deps = makeDeps({ isTTY: true, prompt: vi.fn(async () => 'ms_live_typed') });
    const r = await resolveLoginKey(deps);
    expect(r).toEqual({ key: 'ms_live_typed', source: 'prompt' });
    expect(deps.readStdin).not.toHaveBeenCalled();
  });

  it('non-TTY pipe (echo | login) → reads the piped key; the pipe feature is preserved', async () => {
    const deps = makeDeps({ isTTY: false, readStdin: vi.fn(async () => 'ms_live_piped_key\n') });
    const r = await resolveLoginKey(deps);
    expect(r).toEqual({ key: 'ms_live_piped_key\n', source: 'stdin' });
    expect(deps.prompt).not.toHaveBeenCalled();
  });
});

describe('resolveLoginKey() non-TTY hang backstop (bounded timeout)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('an idle non-TTY stdin that never EOFs fails fast with the actionable message — no infinite hang', async () => {
    const neverResolves = (): Promise<string> => new Promise<string>(() => {});
    const promptSpy = vi.fn(async () => 'unreachable');
    const p = resolveLoginKey({
      argv: [],
      env: {},
      isTTY: false,
      readStdin: neverResolves,
      prompt: promptSpy,
      timeoutMs: 2000,
    });
    // Avoid an unhandled-rejection warning while we advance fake time.
    const settled = expect(p).rejects.toBeInstanceOf(NoLoginKeyError);
    // Deterministically cross the bound instead of waiting on the wall clock.
    await vi.advanceTimersByTimeAsync(2000);
    await settled;
    await expect(p).rejects.toThrow(NO_KEY_MESSAGE);
    expect(promptSpy).not.toHaveBeenCalled();
  });
});

describe('loginStdinTimeoutMs()', () => {
  it('defaults to 2000ms when unset, empty, non-numeric, zero, or negative', () => {
    expect(loginStdinTimeoutMs({})).toBe(2000);
    expect(loginStdinTimeoutMs({ [MASSU_ENV_STDIN_TIMEOUT]: '' })).toBe(2000);
    expect(loginStdinTimeoutMs({ [MASSU_ENV_STDIN_TIMEOUT]: 'abc' })).toBe(2000);
    expect(loginStdinTimeoutMs({ [MASSU_ENV_STDIN_TIMEOUT]: '0' })).toBe(2000);
    expect(loginStdinTimeoutMs({ [MASSU_ENV_STDIN_TIMEOUT]: '-5' })).toBe(2000);
  });

  it('honors a positive numeric override', () => {
    expect(loginStdinTimeoutMs({ [MASSU_ENV_STDIN_TIMEOUT]: '500' })).toBe(500);
  });
});

// ============================================================
// runLogin() — env path + --key warning (integration over the seam)
// ============================================================

describe('runLogin() non-interactive behavior', () => {
  let originalEnvKey: string | undefined;
  let originalTTY: unknown;

  beforeEach(() => {
    originalEnvKey = process.env[MASSU_ENV_API_KEY];
    originalTTY = (process.stdin as unknown as { isTTY: unknown }).isTTY;
    delete process.env[MASSU_ENV_API_KEY];
  });

  afterEach(() => {
    if (originalEnvKey === undefined) delete process.env[MASSU_ENV_API_KEY];
    else process.env[MASSU_ENV_API_KEY] = originalEnvKey;
    Object.defineProperty(process.stdin, 'isTTY', { value: originalTTY, configurable: true });
  });

  it('reads MASSU_API_KEY with non-TTY stdin, writes it, and returns without hanging', async () => {
    process.env[MASSU_ENV_API_KEY] = 'ms_live_from_env_contract';
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await runLogin(['--no-verify']);

    expect(readUserCredentials()).toBe('ms_live_from_env_contract');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('no key + non-TTY stdin that never EOFs → exits non-zero with the actionable message, no hang', async () => {
    // A real Readable that never pushes data and never ends models the exact hang
    // (an idle non-TTY stdin). The bounded read must time out and fail fast —
    // deterministic, not dependent on the environment's real stdin EOF behavior.
    const { Readable } = await import('stream');
    const idleStdin = new Readable({ read() {} });
    const originalStdinDesc = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { value: idleStdin, configurable: true });
    process.env[MASSU_ENV_STDIN_TIMEOUT] = '25'; // fast, deterministic bound

    try {
      await runLogin(['--no-verify']);
    } finally {
      if (originalStdinDesc) Object.defineProperty(process, 'stdin', originalStdinDesc);
      delete process.env[MASSU_ENV_STDIN_TIMEOUT];
      idleStdin.destroy();
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    const err = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(err).toContain(NO_KEY_MESSAGE);
    expect(existsSync(expectedPath())).toBe(false);
  });

  it('rejects an oversized piped input (> MAX_STDIN_BYTES) fail-closed — exits 1, nothing written (L1)', async () => {
    const { Readable } = await import('stream');
    const oversized = Buffer.alloc(MAX_STDIN_BYTES + 1024, 0x61); // just past the cap
    const stdin = Readable.from([oversized]); // one big chunk, then EOF
    const originalStdinDesc = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });

    try {
      await runLogin(['--no-verify']);
    } finally {
      if (originalStdinDesc) Object.defineProperty(process, 'stdin', originalStdinDesc);
      stdin.destroy();
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(existsSync(expectedPath())).toBe(false);
    const err = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(err).toContain('exceeds');
  });

  it('--key emits a stderr shell-history warning and still writes the key (P1-002)', async () => {
    await runLogin(['--key', 'ms_live_warn_me', '--no-verify']);
    const err = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(err).toContain('shell history');
    expect(readUserCredentials()).toBe('ms_live_warn_me');
  });

  it('the env path does NOT emit the --key shell-history warning', async () => {
    process.env[MASSU_ENV_API_KEY] = 'ms_live_env_no_warn';
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await runLogin(['--no-verify']);
    const err = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(err).not.toContain('shell history');
  });
});
