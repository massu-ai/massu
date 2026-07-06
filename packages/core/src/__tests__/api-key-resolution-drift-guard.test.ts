// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * CR-59 drift-guard — API-key resolution has ONE resolver, ONE precedence,
 * ONE reported source, and a leak-safe default endpoint.
 *
 * This test makes the "key set but tier still Free" bug class (dogfooding
 * incident 2026-07-05) structurally impossible by locking the invariants:
 *
 *  (a) The API key / cloud endpoint are read from the environment ONLY inside
 *      credentials.ts. No other module may read `process.env.MASSU_API_KEY`
 *      or `process.env.MASSU_CLOUD_ENDPOINT` directly — a second ad-hoc read
 *      is exactly how the runtime and `doctor` diverged before.
 *  (b) The user-level credentials FILE is read ONLY inside credentials.ts.
 *  (c) DEFAULT_CLOUD_ENDPOINT is a branded `api.massu.ai` host with NO Supabase
 *      project ref, so it passes the public-content leak-guard by construction.
 *  (d) `massu doctor` renders the License line through formatLicenseCheck, so
 *      the "no key" vs "key present but Free" distinction cannot regress.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  DEFAULT_CLOUD_ENDPOINT,
  resolveApiKey,
  resolveEndpoint,
} from '../credentials.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, '..');

/** Recursively collect every `.ts` file under src/ (excluding __tests__). */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    // A directory that vanished mid-walk — e.g. a parallel test's scratch dir
    // removed in its afterEach — is a benign race, not a source violation. Skip
    // it; re-throw anything that isn't a not-found.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return acc;
    throw e;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      collectSourceFiles(full, acc);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('CR-59: single API-key resolver invariant', () => {
  const files = collectSourceFiles(SRC_DIR);
  const CREDENTIALS = resolve(SRC_DIR, 'credentials.ts');

  it('reads the API key / cloud endpoint env vars ONLY in credentials.ts', () => {
    // Build the forbidden patterns without embedding the literal env-var names
    // (keeps this test from tripping its own grep). `.env` member-access read.
    const envRead = 'process' + '.env.';
    const forbidden = [envRead + 'MASSU_API_KEY', envRead + 'MASSU_CLOUD_ENDPOINT'];
    const offenders: string[] = [];
    for (const f of files) {
      if (f === CREDENTIALS) continue;
      const content = readFileSync(f, 'utf-8');
      for (const pat of forbidden) {
        if (content.includes(pat)) offenders.push(`${f} :: ${pat}`);
      }
    }
    expect(offenders, `Direct env reads must go through credentials.ts:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('assembles the user-level credentials file path ONLY in credentials.ts', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f === CREDENTIALS) continue;
      const content = readFileSync(f, 'utf-8');
      // The path is built from the quoted `'credentials'` segment literal. A
      // user-facing mention like `(~/.massu/credentials)` is NOT a quoted
      // segment literal, so help text / comments do not trip this.
      if (/['"]credentials['"]/.test(content)) offenders.push(f);
    }
    expect(offenders, `Credentials file path must be assembled only in credentials.ts:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('ships a leak-safe branded default endpoint (no Supabase project ref)', () => {
    expect(DEFAULT_CLOUD_ENDPOINT).toMatch(/^https:\/\/api\.massu\.ai\//);
    // The public-content leak-guard pattern: `[a-z0-9]{20}\.supabase\.co`.
    expect(DEFAULT_CLOUD_ENDPOINT).not.toMatch(/[a-z0-9]{20}\.supabase\.co/);
  });

  it('no packages/core/src file embeds a Supabase project-ref URL (leak-guard parity)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, 'utf-8');
      if (/[a-z0-9]{20}\.supabase\.co/.test(content)) offenders.push(f);
    }
    expect(offenders, `Supabase project-ref URLs leak to the public package:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('doctor renders the License line via formatLicenseCheck', () => {
    const doctor = readFileSync(resolve(SRC_DIR, 'commands/doctor.ts'), 'utf-8');
    expect(doctor).toMatch(/formatLicenseCheck\s*\(/);
    // The old conflating message must exist ONLY inside formatLicenseCheck's
    // no-key branch, never as a second inline hardcode.
    const occurrences = (doctor.match(/no API key configured/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

describe('CR-59: resolver precedence + endpoint default', () => {
  it('config > env > user-file > none', () => {
    const home = '/nonexistent-home-cr59'; // no ~/.massu there
    expect(resolveApiKey({ configApiKey: 'ms_live_cfg', env: { MASSU_API_KEY: 'ms_live_env' }, home })).toEqual({
      apiKey: 'ms_live_cfg',
      source: 'config',
    });
    expect(resolveApiKey({ env: { MASSU_API_KEY: 'ms_live_env' }, home })).toEqual({
      apiKey: 'ms_live_env',
      source: 'env',
    });
    expect(resolveApiKey({ env: {}, home })).toEqual({ source: 'none' });
  });

  it('treats an unresolved ${VAR} config literal as absent', () => {
    const home = '/nonexistent-home-cr59';
    expect(resolveApiKey({ configApiKey: '${MASSU_API_KEY}', env: { MASSU_API_KEY: 'ms_live_env' }, home })).toEqual({
      apiKey: 'ms_live_env',
      source: 'env',
    });
  });

  it('endpoint: config > env > branded default', () => {
    expect(resolveEndpoint({ configEndpoint: 'https://self.example/v1', env: {} })).toBe('https://self.example/v1');
    expect(resolveEndpoint({ env: { MASSU_CLOUD_ENDPOINT: 'https://env.example/v1' } })).toBe('https://env.example/v1');
    expect(resolveEndpoint({ env: {} })).toBe(DEFAULT_CLOUD_ENDPOINT);
  });
});
