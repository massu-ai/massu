// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P1-013 (plan-2026-05-27-tier-gate-auto-learning / CR-54): `massu license
 * <sub>` CLI dispatcher exit-code matrix.
 *
 * Exit code matrix for `check`:
 *   0 = entitled (current tier >= --min)
 *   2 = usage error (missing/invalid --min)
 *   3 = not entitled (current tier < --min)
 *
 * Mirrors the `permissions-cli.test.ts` dispatch + exit-code + stderr
 * invocation style.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Control the resolved tier without a live license server.
let mockTier: 'free' | 'pro' | 'team' | 'enterprise' | (() => never) = 'free';

vi.mock('../license.ts', async () => {
  const actual = await vi.importActual<typeof import('../license.ts')>('../license.ts');
  return {
    ...actual,
    getCurrentTier: vi.fn(async () => {
      if (typeof mockTier === 'function') return (mockTier as () => never)();
      return mockTier;
    }),
  };
});

import { handleLicenseSubcommand } from '../commands/license.ts';

function captureStreams(): {
  restore: () => void;
  stdout: () => string;
  stderr: () => string;
} {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: string | Uint8Array): boolean => {
      outChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as never);
  const errSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((chunk: string | Uint8Array): boolean => {
      errChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as never);
  return {
    restore: () => { outSpy.mockRestore(); errSpy.mockRestore(); },
    stdout: () => outChunks.join(''),
    stderr: () => errChunks.join(''),
  };
}

beforeEach(() => {
  mockTier = 'free';
  vi.clearAllMocks();
});

describe('license <sub> CLI — VLC exit-code matrix', () => {
  it('VLC-01: check --min pro at pro tier exits 0', async () => {
    mockTier = 'pro';
    const streams = captureStreams();
    try {
      const r = await handleLicenseSubcommand(['check', '--min', 'pro']);
      expect(r.exitCode).toBe(0);
    } finally {
      streams.restore();
    }
  });

  it('VLC-02: check --min pro at team tier exits 0 (higher tier entitled)', async () => {
    mockTier = 'team';
    const streams = captureStreams();
    try {
      const r = await handleLicenseSubcommand(['check', '--min', 'pro']);
      expect(r.exitCode).toBe(0);
    } finally {
      streams.restore();
    }
  });

  it('VLC-03: check --min pro at free tier exits 3 + upgrade text on stderr', async () => {
    mockTier = 'free';
    const streams = captureStreams();
    try {
      const r = await handleLicenseSubcommand(['check', '--min', 'pro']);
      expect(r.exitCode).toBe(3);
      expect(streams.stderr()).toContain('https://massu.ai/pricing');
      expect(streams.stderr()).toMatch(/Pro feature/);
    } finally {
      streams.restore();
    }
  });

  it('VLC-04: check without --min exits 2 (usage error)', async () => {
    const streams = captureStreams();
    try {
      const r = await handleLicenseSubcommand(['check']);
      expect(r.exitCode).toBe(2);
      expect(streams.stderr()).toMatch(/Usage: massu license check/);
    } finally {
      streams.restore();
    }
  });

  it('VLC-05: check --min with trailing flag but no value exits 2', async () => {
    const streams = captureStreams();
    try {
      const r = await handleLicenseSubcommand(['check', '--min']);
      expect(r.exitCode).toBe(2);
    } finally {
      streams.restore();
    }
  });

  it('VLC-06: invalid --min tier exits 2', async () => {
    const streams = captureStreams();
    try {
      const r = await handleLicenseSubcommand(['check', '--min', 'platinum']);
      expect(r.exitCode).toBe(2);
      expect(streams.stderr()).toMatch(/invalid --min tier/);
    } finally {
      streams.restore();
    }
  });

  it('VLC-07: a throwing tier resolver fails closed (non-zero exit)', async () => {
    mockTier = () => { throw new Error('network down'); };
    const streams = captureStreams();
    try {
      const r = await handleLicenseSubcommand(['check', '--min', 'pro']);
      expect(r.exitCode).not.toBe(0);
    } finally {
      streams.restore();
    }
  });

  it('VLC-help: --help prints the subcommand list + exits 0', async () => {
    const streams = captureStreams();
    try {
      const r = await handleLicenseSubcommand(['--help']);
      expect(r.exitCode).toBe(0);
      expect(streams.stdout()).toMatch(/check --min/);
    } finally {
      streams.restore();
    }
  });

  it('VLC-unknown: unknown subcommand exits 1', async () => {
    const streams = captureStreams();
    try {
      const r = await handleLicenseSubcommand(['not-a-real-subcommand']);
      expect(r.exitCode).toBe(1);
      expect(streams.stderr()).toMatch(/unknown license subcommand/);
    } finally {
      streams.restore();
    }
  });
});
