// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu doctor` License-line formatter tests (CR-59).
 *
 * formatLicenseCheck() is the pure formatter that — critically — distinguishes
 * "no key anywhere" from "a key IS present but did not validate to a paid
 * tier". Additionally (P2-003) it distinguishes an AUTHORITATIVE Free from a
 * "could not validate" (server error / unreachable), so a 500 is never
 * reported as a Free downgrade. All branches are asserted without a live server:
 *   1. source 'none'                          → pass, "Free (no API key configured)"
 *   2. source set + paid tier                 → pass, "<Tier> (via <label>[, valid until <date>])"
 *   3. source set + paid tier, no validUntil  → pass, "<Tier> (via <label>)"  (no ", valid until")
 *   4. source set + free tier (authoritative) → warn, "...key present via <label> but validated to Free..."
 *   5. source set + free + server_error       → warn, "Could not validate — license server error ... tier UNKNOWN"
 *   6. source set + free + network/no_endpoint→ warn, "Could not reach license server ... tier UNKNOWN"
 */

import { describe, it, expect } from 'vitest';
import { formatLicenseCheck } from '../commands/doctor.ts';

describe('formatLicenseCheck()', () => {
  it('branch 1 — source "none" reports genuine Free with pass status', () => {
    const r = formatLicenseCheck({ source: 'none', tier: 'free', validUntil: '' });
    expect(r.name).toBe('License');
    expect(r.status).toBe('pass');
    expect(r.detail).toBe('Free (no API key configured)');
  });

  it('branch 2 — env source + enterprise tier + validUntil reports tier, label, and expiry', () => {
    const r = formatLicenseCheck({ source: 'env', tier: 'enterprise', validUntil: '2027-01-01' });
    expect(r.status).toBe('pass');
    expect(r.detail).toBe('Enterprise (via MASSU_API_KEY env, valid until 2027-01-01)');
  });

  it('branch 3 — user-file source + pro tier + empty validUntil omits the expiry clause', () => {
    const r = formatLicenseCheck({ source: 'user-file', tier: 'pro', validUntil: '' });
    expect(r.status).toBe('pass');
    expect(r.detail).toBe('Pro (via ~/.massu/credentials)');
    expect(r.detail).not.toContain('valid until');
  });

  it('branch 4 — config source but authoritative free tier WARNS the key validated to Free', () => {
    const r = formatLicenseCheck({ source: 'config', tier: 'free', validUntil: '', outcome: 'rejected' });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('key present via explicit cloud.apiKey but validated to Free');
  });

  // P2-003 (plan-2026-07-06-validate-key-deploy-drift): a server error or an
  // unreachable server must NOT be reported as a Free downgrade. Before this,
  // both collapsed into the same "Free" line — the masking that hid the
  // validate-key 500 outage for 5 weeks.
  it('P2-003 — server_error reports tier UNKNOWN, NOT a Free downgrade', () => {
    const r = formatLicenseCheck({ source: 'user-file', tier: 'free', validUntil: '', outcome: 'server_error' });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('Could not validate — license server error');
    expect(r.detail).toContain('tier UNKNOWN');
    expect(r.detail).not.toContain('validated to Free');
  });

  it('P2-003 — network_error reports could-not-reach, tier UNKNOWN', () => {
    const r = formatLicenseCheck({ source: 'env', tier: 'free', validUntil: '', outcome: 'network_error' });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('Could not reach license server');
    expect(r.detail).toContain('tier UNKNOWN');
  });

  it('P2-003 — no_endpoint is treated as could-not-reach (tier UNKNOWN)', () => {
    const r = formatLicenseCheck({ source: 'env', tier: 'free', validUntil: '', outcome: 'no_endpoint' });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('Could not reach license server');
  });

  it('P2-003 — a genuinely no_key env still reports Free (no API key configured) via source none', () => {
    // no_key outcome only ever coexists with source 'none' (getCurrentTier sets
    // both together); source 'none' short-circuits before outcome is consulted.
    const r = formatLicenseCheck({ source: 'none', tier: 'free', validUntil: '', outcome: 'no_key' });
    expect(r.status).toBe('pass');
    expect(r.detail).toBe('Free (no API key configured)');
  });

  it('capitalizes the tier name and uses the config label for a paid config key', () => {
    const r = formatLicenseCheck({ source: 'config', tier: 'team', validUntil: '2028-06-30' });
    expect(r.status).toBe('pass');
    expect(r.detail).toBe('Team (via explicit cloud.apiKey, valid until 2028-06-30)');
  });

  it('always names the check "License"', () => {
    for (const source of ['none', 'env', 'user-file', 'config'] as const) {
      const r = formatLicenseCheck({ source, tier: 'free', validUntil: '' });
      expect(r.name).toBe('License');
    }
  });
});
