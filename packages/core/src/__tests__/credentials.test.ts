// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Credentials resolver tests (CR-59) — the SINGLE source of truth for the
 * Massu cloud API key + endpoint. Covers:
 *   - resolveApiKey() precedence: config > env > user-file > none
 *   - source reporting for every branch
 *   - empty/whitespace config treated as absent
 *   - `${VAR}` unresolved-literal config treated as absent (falls to env)
 *   - readUserCredentials() missing / malformed / empty-key / valid
 *   - writeUserCredentials() enforces 0600 file + 0700 dir permissions
 *   - removeUserCredentials() idempotency
 *   - resolveEndpoint() precedence: config > env > DEFAULT_CLOUD_ENDPOINT
 *   - apiKeySourceLabel() for all four sources
 *
 * Every test uses an isolated `mkdtempSync` temp home under os.tmpdir() and
 * NEVER touches the real ~/.massu. Temp dirs are removed in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';

import {
  resolveApiKey,
  resolveEndpoint,
  readUserCredentials,
  writeUserCredentials,
  removeUserCredentials,
  credentialsPath,
  credentialsDir,
  apiKeySourceLabel,
  DEFAULT_CLOUD_ENDPOINT,
  MASSU_ENV_API_KEY,
  MASSU_ENV_CLOUD_ENDPOINT,
  API_KEY_PREFIX,
  type ApiKeySource,
} from '../credentials.ts';

// ============================================================
// Temp-home fixture
// ============================================================

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'massu-cred-test-'));
});

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

/** An env map with NO Massu keys — the deterministic "empty env" baseline. */
function emptyEnv(): NodeJS.ProcessEnv {
  return {};
}

// ============================================================
// Path helpers
// ============================================================

describe('credentialsDir() / credentialsPath()', () => {
  it('credentialsDir resolves to <home>/.massu', () => {
    expect(credentialsDir(home)).toBe(resolve(home, '.massu'));
  });

  it('credentialsPath resolves to <home>/.massu/credentials', () => {
    expect(credentialsPath(home)).toBe(resolve(home, '.massu', 'credentials'));
  });
});

// ============================================================
// Constants
// ============================================================

describe('constants', () => {
  it('exposes the expected constant values', () => {
    expect(DEFAULT_CLOUD_ENDPOINT).toBe('https://api.massu.ai/v1');
    expect(MASSU_ENV_API_KEY).toBe('MASSU_API_KEY');
    expect(MASSU_ENV_CLOUD_ENDPOINT).toBe('MASSU_CLOUD_ENDPOINT');
    expect(API_KEY_PREFIX).toBe('ms_live_');
  });
});

// ============================================================
// readUserCredentials()
// ============================================================

describe('readUserCredentials()', () => {
  it('returns undefined when the file is missing', () => {
    expect(readUserCredentials(home)).toBeUndefined();
  });

  it('returns undefined on malformed JSON (never throws)', () => {
    mkdirSync(credentialsDir(home), { recursive: true });
    writeFileSync(credentialsPath(home), 'this is { not json');
    expect(readUserCredentials(home)).toBeUndefined();
  });

  it('returns undefined when apiKey is an empty string', () => {
    mkdirSync(credentialsDir(home), { recursive: true });
    writeFileSync(credentialsPath(home), JSON.stringify({ apiKey: '' }));
    expect(readUserCredentials(home)).toBeUndefined();
  });

  it('returns undefined when apiKey is only whitespace', () => {
    mkdirSync(credentialsDir(home), { recursive: true });
    writeFileSync(credentialsPath(home), JSON.stringify({ apiKey: '   ' }));
    expect(readUserCredentials(home)).toBeUndefined();
  });

  it('returns undefined when apiKey key is absent entirely', () => {
    mkdirSync(credentialsDir(home), { recursive: true });
    writeFileSync(credentialsPath(home), JSON.stringify({ somethingElse: 'x' }));
    expect(readUserCredentials(home)).toBeUndefined();
  });

  it('returns the trimmed key when the file is valid', () => {
    mkdirSync(credentialsDir(home), { recursive: true });
    writeFileSync(credentialsPath(home), JSON.stringify({ apiKey: '  ms_live_valid_key  ' }));
    expect(readUserCredentials(home)).toBe('ms_live_valid_key');
  });
});

// ============================================================
// writeUserCredentials()
// ============================================================

describe('writeUserCredentials()', () => {
  it('writes the key and returns the absolute path', () => {
    const p = writeUserCredentials('ms_live_write_key', home);
    expect(p).toBe(credentialsPath(home));
    expect(existsSync(p)).toBe(true);
    expect(readUserCredentials(home)).toBe('ms_live_write_key');
  });

  it('trims the key before persisting', () => {
    writeUserCredentials('  ms_live_trim_me  ', home);
    expect(readUserCredentials(home)).toBe('ms_live_trim_me');
  });

  it('creates the credentials file with 0600 permissions', () => {
    const p = writeUserCredentials('ms_live_perm_key', home);
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates the ~/.massu directory with 0700 permissions', () => {
    writeUserCredentials('ms_live_perm_key', home);
    const dirMode = statSync(credentialsDir(home)).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it('re-enforces 0600/0700 on re-write even if permissions were widened', () => {
    // First write, then loosen both, then re-write must tighten them back.
    writeUserCredentials('ms_live_first', home);
    chmodSync(credentialsDir(home), 0o755);
    chmodSync(credentialsPath(home), 0o644);
    writeUserCredentials('ms_live_second', home);
    expect(statSync(credentialsPath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(credentialsDir(home)).mode & 0o777).toBe(0o700);
    expect(readUserCredentials(home)).toBe('ms_live_second');
  });
});

// ============================================================
// removeUserCredentials()
// ============================================================

describe('removeUserCredentials()', () => {
  it('returns false when there is nothing to remove', () => {
    expect(removeUserCredentials(home)).toBe(false);
  });

  it('removes an existing file and is idempotent (true then false)', () => {
    writeUserCredentials('ms_live_remove_me', home);
    expect(existsSync(credentialsPath(home))).toBe(true);
    expect(removeUserCredentials(home)).toBe(true);
    expect(existsSync(credentialsPath(home))).toBe(false);
    // Second removal: nothing left → false.
    expect(removeUserCredentials(home)).toBe(false);
  });
});

// ============================================================
// resolveApiKey() — precedence + source reporting
// ============================================================

describe('resolveApiKey() precedence', () => {
  it('returns source "none" when nothing is set anywhere', () => {
    const r = resolveApiKey({ env: emptyEnv(), home });
    expect(r.source).toBe('none');
    expect(r.apiKey).toBeUndefined();
  });

  it('config wins over env AND user-file', () => {
    writeUserCredentials('ms_live_from_file', home);
    const r = resolveApiKey({
      configApiKey: 'ms_live_from_config',
      env: { [MASSU_ENV_API_KEY]: 'ms_live_from_env' },
      home,
    });
    expect(r.source).toBe('config');
    expect(r.apiKey).toBe('ms_live_from_config');
  });

  it('env wins over user-file when no config key is present', () => {
    writeUserCredentials('ms_live_from_file', home);
    const r = resolveApiKey({
      env: { [MASSU_ENV_API_KEY]: 'ms_live_from_env' },
      home,
    });
    expect(r.source).toBe('env');
    expect(r.apiKey).toBe('ms_live_from_env');
  });

  it('user-file is used when only the credentials file is present', () => {
    writeUserCredentials('ms_live_from_file', home);
    const r = resolveApiKey({ env: emptyEnv(), home });
    expect(r.source).toBe('user-file');
    expect(r.apiKey).toBe('ms_live_from_file');
  });

  it('trims a config key before returning it', () => {
    const r = resolveApiKey({ configApiKey: '  ms_live_padded  ', env: emptyEnv(), home });
    expect(r.source).toBe('config');
    expect(r.apiKey).toBe('ms_live_padded');
  });

  it('trims an env key before returning it', () => {
    const r = resolveApiKey({ env: { [MASSU_ENV_API_KEY]: '  ms_live_env_padded  ' }, home });
    expect(r.source).toBe('env');
    expect(r.apiKey).toBe('ms_live_env_padded');
  });

  it('treats an empty-string config key as absent (falls through to env)', () => {
    const r = resolveApiKey({
      configApiKey: '',
      env: { [MASSU_ENV_API_KEY]: 'ms_live_env_fallback' },
      home,
    });
    expect(r.source).toBe('env');
    expect(r.apiKey).toBe('ms_live_env_fallback');
  });

  it('treats a whitespace-only config key as absent (falls through to env)', () => {
    const r = resolveApiKey({
      configApiKey: '    ',
      env: { [MASSU_ENV_API_KEY]: 'ms_live_env_fallback2' },
      home,
    });
    expect(r.source).toBe('env');
    expect(r.apiKey).toBe('ms_live_env_fallback2');
  });

  it('treats an unresolved ${VAR} literal config key as absent (falls through to env)', () => {
    const r = resolveApiKey({
      configApiKey: '${MASSU_API_KEY}',
      env: { [MASSU_ENV_API_KEY]: 'ms_live_real_env_key' },
      home,
    });
    expect(r.source).toBe('env');
    expect(r.apiKey).toBe('ms_live_real_env_key');
  });

  it('treats an unresolved ${VAR} literal as absent all the way down to none', () => {
    const r = resolveApiKey({ configApiKey: '${SOME_OTHER_VAR}', env: emptyEnv(), home });
    expect(r.source).toBe('none');
    expect(r.apiKey).toBeUndefined();
  });

  it('treats an empty-string env key as absent (falls through to user-file)', () => {
    writeUserCredentials('ms_live_file_wins', home);
    const r = resolveApiKey({ env: { [MASSU_ENV_API_KEY]: '   ' }, home });
    expect(r.source).toBe('user-file');
    expect(r.apiKey).toBe('ms_live_file_wins');
  });
});

// ============================================================
// resolveEndpoint() — precedence
// ============================================================

describe('resolveEndpoint() precedence', () => {
  it('returns the default endpoint when nothing is configured', () => {
    expect(resolveEndpoint({ env: emptyEnv() })).toBe(DEFAULT_CLOUD_ENDPOINT);
  });

  it('config endpoint wins over env and default', () => {
    const ep = resolveEndpoint({
      configEndpoint: 'https://config.example.com/v1',
      env: { [MASSU_ENV_CLOUD_ENDPOINT]: 'https://env.example.com/v1' },
    });
    expect(ep).toBe('https://config.example.com/v1');
  });

  it('env endpoint wins over default when no config endpoint is present', () => {
    const ep = resolveEndpoint({ env: { [MASSU_ENV_CLOUD_ENDPOINT]: 'https://env.example.com/v1' } });
    expect(ep).toBe('https://env.example.com/v1');
  });

  it('trims a config endpoint', () => {
    const ep = resolveEndpoint({ configEndpoint: '  https://trim.example.com  ', env: emptyEnv() });
    expect(ep).toBe('https://trim.example.com');
  });

  it('trims an env endpoint', () => {
    const ep = resolveEndpoint({ env: { [MASSU_ENV_CLOUD_ENDPOINT]: '  https://trim-env.example.com  ' } });
    expect(ep).toBe('https://trim-env.example.com');
  });

  it('falls back to default when config endpoint is whitespace-only', () => {
    const ep = resolveEndpoint({ configEndpoint: '   ', env: emptyEnv() });
    expect(ep).toBe(DEFAULT_CLOUD_ENDPOINT);
  });
});

// ============================================================
// apiKeySourceLabel() — all four sources
// ============================================================

describe('apiKeySourceLabel()', () => {
  it('labels every source with a human-readable string', () => {
    const cases: Array<[ApiKeySource, string]> = [
      ['config', 'explicit cloud.apiKey'],
      ['env', 'MASSU_API_KEY env'],
      ['user-file', '~/.massu/credentials'],
      ['none', 'no source'],
    ];
    for (const [source, label] of cases) {
      expect(apiKeySourceLabel(source)).toBe(label);
    }
  });
});
