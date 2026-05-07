/**
 * Tests for the HTTPS fetcher allowlist (Plan 3c gap-3).
 *
 * Coverage:
 * - Allowed hosts (registry.massu.ai, telemetry.massu.ai) pass the allowlist
 *   check (network call mocked — we only test the allowlist gate, not the
 *   HTTP behavior of fetch itself).
 * - Disallowed hosts throw FetchAllowlistError with the actual host name in
 *   the error.
 * - http:// (non-HTTPS) throws FetchAllowlistError.
 * - Invalid URL throws TypeError.
 * - Custom allowlist (test override) works for fixture testing.
 * - ALLOWED_HOSTS export is read-only (compile-time).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchUrl,
  ALLOWED_HOSTS,
  FetchAllowlistError,
} from '../security/fetcher.js';

describe('fetchUrl allowlist', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('exposes the production allowlist as a stable readonly tuple', () => {
    expect(ALLOWED_HOSTS).toContain('registry.massu.ai');
    expect(ALLOWED_HOSTS).toContain('telemetry.massu.ai');
    expect(ALLOWED_HOSTS.length).toBe(2);
  });

  it('passes the allowlist for registry.massu.ai (HTTPS)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => '{"manifest":{"manifest_schema_version":1}}',
    } as Response);

    const result = await fetchUrl('https://registry.massu.ai/adapters/manifest.json');
    expect(result.status).toBe(200);
    expect(result.body).toContain('manifest_schema_version');
  });

  it('passes the allowlist for telemetry.massu.ai (HTTPS)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 204,
      text: async () => '',
    } as Response);

    const result = await fetchUrl('https://telemetry.massu.ai/adapter-discovery');
    expect(result.status).toBe(204);
  });

  it('refuses arbitrary hosts (HTTPS) — supply-chain leak guard', async () => {
    await expect(
      fetchUrl('https://attacker.example.com/exfil'),
    ).rejects.toBeInstanceOf(FetchAllowlistError);

    try {
      await fetchUrl('https://attacker.example.com/exfil');
    } catch (err) {
      expect(err).toBeInstanceOf(FetchAllowlistError);
      expect((err as FetchAllowlistError).host).toBe('attacker.example.com');
      expect((err as Error).message).toContain('attacker.example.com');
      expect((err as Error).message).toContain('not in the @massu/core');
    }
  });

  it('refuses http:// (non-HTTPS) even for allowed hostnames', async () => {
    await expect(
      fetchUrl('http://registry.massu.ai/adapters/manifest.json'),
    ).rejects.toBeInstanceOf(FetchAllowlistError);
  });

  it('throws TypeError for invalid URL strings', async () => {
    await expect(fetchUrl('not a url')).rejects.toBeInstanceOf(TypeError);
  });

  it('honors test allowlist override for fixture testing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => 'test-fixture',
    } as Response);

    const result = await fetchUrl('https://test-fixture.example.com/data', {
      allowedHosts: ['test-fixture.example.com'],
    });
    expect(result.body).toBe('test-fixture');
  });

  it('test override does NOT widen the production allowlist (test-only param)', async () => {
    // Without override, the same URL should still be refused.
    await expect(
      fetchUrl('https://test-fixture.example.com/data'),
    ).rejects.toBeInstanceOf(FetchAllowlistError);
  });

  it('refuses fetch() redirects (allowlist defeat protection)', async () => {
    // Verify the fetcher passes redirect: 'error' to the underlying fetch.
    // We capture the init object and inspect its redirect option.
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedInit = init;
      return Promise.resolve({ status: 200, text: async () => 'ok' } as Response);
    });
    await fetchUrl('https://registry.massu.ai/test');
    expect(capturedInit?.redirect).toBe('error');
  });
});
