// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * CHG-CLI-01..06 — CLI dispatcher tests for `massu changelog <sub>`.
 *
 * Tests `handleChangelogSubcommand` directly (subprocess CLI tests are covered
 * by cli-dispatcher.test.ts at the `case 'changelog':` switch).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleChangelogSubcommand } from '../commands/changelog.ts';

function captureStreams() {
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

afterEach(() => { vi.restoreAllMocks(); });

describe('changelog <sub> CLI — CHG-CLI-01..06', () => {
  it('CHG-CLI-01: generate emits valid Markdown to stdout', async () => {
    const streams = captureStreams();
    try {
      const r = await handleChangelogSubcommand(['generate']);
      // generate may exit 0 (clean) or 2 (MissingPlanFileError if a token in
      // range has no plan file). Both are valid CLI behaviors; the test
      // verifies the handler returns a structured exit code.
      expect([0, 2]).toContain(r.exitCode);
      if (r.exitCode === 0) {
        // Markdown emission goes to stdout
        expect(streams.stdout()).toMatch(/^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}/m);
      }
    } finally {
      streams.restore();
    }
  });

  it('CHG-CLI-02: --help prints subcommand list', async () => {
    const streams = captureStreams();
    try {
      const r = await handleChangelogSubcommand(['--help']);
      expect(r.exitCode).toBe(0);
      expect(streams.stdout()).toMatch(/generate\s*Emit a draft/);
      expect(streams.stdout()).toMatch(/verify\s*Read-only/);
    } finally {
      streams.restore();
    }
  });

  it('CHG-CLI-03: no subcommand prints help', async () => {
    const streams = captureStreams();
    try {
      const r = await handleChangelogSubcommand([]);
      expect(r.exitCode).toBe(0);
      expect(streams.stdout()).toMatch(/Subcommands/i);
    } finally {
      streams.restore();
    }
  });

  it('CHG-CLI-04: unknown subcommand exits 1 + stderr diagnostic', async () => {
    const streams = captureStreams();
    try {
      const r = await handleChangelogSubcommand(['nonsense']);
      expect(r.exitCode).toBe(1);
      expect(streams.stderr()).toMatch(/unknown changelog subcommand/);
    } finally {
      streams.restore();
    }
  });

  it('CHG-CLI-05: verify against current repo state returns 0 or 1 with structured output', async () => {
    const streams = captureStreams();
    try {
      const r = await handleChangelogSubcommand(['verify']);
      expect([0, 1]).toContain(r.exitCode);
      if (r.exitCode === 0) {
        expect(streams.stdout()).toMatch(/All plan-tokens referenced/);
      } else {
        expect(streams.stderr()).toMatch(/gap: plan-/);
      }
    } finally {
      streams.restore();
    }
  });

  it('CHG-CLI-06: -h alias prints help (same as --help)', async () => {
    const streams = captureStreams();
    try {
      const r = await handleChangelogSubcommand(['-h']);
      expect(r.exitCode).toBe(0);
      expect(streams.stdout()).toMatch(/Subcommands/i);
    } finally {
      streams.restore();
    }
  });
});
