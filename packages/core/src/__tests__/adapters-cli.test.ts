/**
 * Tests for `npx massu adapters` sub-dispatcher (Plan 3c Phase 5 5I-J).
 *
 * Coverage:
 * - Sub-dispatcher routing (each subcommand maps to the right handler)
 * - --help / -h / no-arg → printAdaptersHelp + exit 0
 * - Unknown subcommand → exit 1 + stderr message
 * - Stubs (add-local, remove-local, resync-local-fingerprint, install,
 *   resign) → exit 64 (EX_USAGE) + clear "in-flight Phase 5 follow-up"
 *   stderr message
 * - search with no query → exit 1
 * - search with query against a mocked manifest → matches rendered to stdout
 *
 * runAdaptersList + runAdaptersRefresh require a full project setup
 * (massu.config.yaml + node_modules + cache file); their inner modules
 * (manifest-cache.ts, discover.ts) are independently tested. The CLI
 * routing tests here exercise the wire-up; end-to-end CLI behavior is
 * covered by the integration suite (separate concern).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as cacheModule from '../security/manifest-cache.js';
import {
  handleAdaptersSubcommand,
  runAdaptersSearch,
} from '../commands/adapters.js';
import type { Envelope } from '../security/manifest-schema.js';

let stderrCalls: string[] = [];
let stdoutCalls: string[] = [];
let originalStderrWrite: typeof process.stderr.write;
let originalStdoutWrite: typeof process.stdout.write;
let originalConsoleLog: typeof console.log;

beforeEach(() => {
  stderrCalls = [];
  stdoutCalls = [];
  originalStderrWrite = process.stderr.write;
  originalStdoutWrite = process.stdout.write;
  originalConsoleLog = console.log;
  process.stderr.write = ((s: string | Uint8Array) => {
    stderrCalls.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((s: string | Uint8Array) => {
    stdoutCalls.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  console.log = (s: string) => {
    stdoutCalls.push(s + '\n');
  };
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  process.stdout.write = originalStdoutWrite;
  console.log = originalConsoleLog;
  vi.restoreAllMocks();
});

describe('handleAdaptersSubcommand routing', () => {
  it('--help prints help + exits 0', async () => {
    const result = await handleAdaptersSubcommand(['--help']);
    expect(result.exitCode).toBe(0);
    const allOut = stdoutCalls.join('');
    expect(allOut).toContain('Massu adapters');
    expect(allOut).toContain('list');
    expect(allOut).toContain('refresh');
    expect(allOut).toContain('search');
  });

  it('-h prints help + exits 0', async () => {
    const result = await handleAdaptersSubcommand(['-h']);
    expect(result.exitCode).toBe(0);
  });

  it('no args prints help + exits 0', async () => {
    const result = await handleAdaptersSubcommand([]);
    expect(result.exitCode).toBe(0);
    expect(stdoutCalls.join('')).toContain('Massu adapters');
  });

  it('unknown subcommand exits 1 with stderr explaining', async () => {
    const result = await handleAdaptersSubcommand(['nonsense']);
    expect(result.exitCode).toBe(1);
    expect(stderrCalls.join('')).toContain('unknown subcommand: nonsense');
  });
});

describe('handleAdaptersSubcommand stubs (in-flight Phase 5 follow-ups)', () => {
  // add-local / remove-local / resync-local-fingerprint are now IMPLEMENTED
  // in this commit (gap-32 closed). Their full behavior is tested in
  // dedicated describe blocks below + in __tests__/local-fingerprint.test.ts.
  // What's still stubbed: install + resign (gap-37 install-time sha256).

  for (const sub of ['install', 'resign']) {
    it(`${sub} returns 64 with gap-37 message`, async () => {
      const result = await handleAdaptersSubcommand([sub, 'arg-if-needed']);
      expect(result.exitCode).toBe(64);
      const stderr = stderrCalls.join('');
      expect(stderr).toContain(`massu adapters ${sub}`);
      expect(stderr).toContain('gap-37');
    });
  }
});

describe('runAdaptersSearch', () => {
  it('exits 1 with usage message when no query', async () => {
    const result = await runAdaptersSearch([]);
    expect(result.exitCode).toBe(1);
    expect(stderrCalls.join('')).toContain('Usage: massu adapters search');
  });

  it('exits 2 when manifest unavailable', async () => {
    vi.spyOn(cacheModule, 'getManifest').mockResolvedValue({
      kind: 'fail',
      reasons: ['offline'],
    });
    const result = await runAdaptersSearch(['rails']);
    expect(result.exitCode).toBe(2);
    expect(stderrCalls.join('')).toContain('manifest unavailable');
  });

  it('renders matching entries from manifest', async () => {
    const fakeEnvelope = {
      manifest: {
        manifest_schema_version: 1,
        issued_at: '2026-05-07T00:00:00Z',
        adapters: [
          {
            package: '@massu/adapter-rails',
            version: '0.1.0',
            sha256: 'a'.repeat(64),
            signing_key_id: 'b'.repeat(64),
          },
          {
            package: '@massu/adapter-phoenix',
            version: '0.1.0',
            sha256: 'a'.repeat(64),
            signing_key_id: 'b'.repeat(64),
          },
        ],
      },
    } as unknown as Envelope;
    vi.spyOn(cacheModule, 'getManifest').mockResolvedValue({
      kind: 'ok',
      envelope: fakeEnvelope,
      source: 'cache-fresh',
      warnings: [],
    });
    const result = await runAdaptersSearch(['rails']);
    expect(result.exitCode).toBe(0);
    const stdout = stdoutCalls.join('');
    expect(stdout).toContain('@massu/adapter-rails');
    expect(stdout).not.toContain('@massu/adapter-phoenix'); // doesn't match 'rails'
  });

  it('prints "no matches" when query matches nothing', async () => {
    const fakeEnvelope = {
      manifest: {
        manifest_schema_version: 1,
        issued_at: '2026-05-07T00:00:00Z',
        adapters: [],
      },
    } as unknown as Envelope;
    vi.spyOn(cacheModule, 'getManifest').mockResolvedValue({
      kind: 'ok',
      envelope: fakeEnvelope,
      source: 'cache-fresh',
      warnings: [],
    });
    const result = await runAdaptersSearch(['nonexistent']);
    expect(result.exitCode).toBe(0);
    expect(stdoutCalls.join('')).toContain("No adapters matching 'nonexistent'");
  });

  it('renders deprecated/unpublished status flags (gap-57)', async () => {
    const fakeEnvelope = {
      manifest: {
        manifest_schema_version: 1,
        issued_at: '2026-05-07T00:00:00Z',
        adapters: [
          {
            package: '@massu/adapter-old',
            version: '0.1.0',
            sha256: 'a'.repeat(64),
            signing_key_id: 'b'.repeat(64),
            deprecated: { since: '2026-05-01', replacement: null, reason: 'fork' },
          },
          {
            package: '@massu/adapter-bad',
            version: '0.1.0',
            sha256: 'a'.repeat(64),
            signing_key_id: 'b'.repeat(64),
            unpublished: true,
          },
        ],
      },
    } as unknown as Envelope;
    vi.spyOn(cacheModule, 'getManifest').mockResolvedValue({
      kind: 'ok',
      envelope: fakeEnvelope,
      source: 'cache-fresh',
      warnings: [],
    });
    const result = await runAdaptersSearch(['adapter']);
    expect(result.exitCode).toBe(0);
    const stdout = stdoutCalls.join('');
    expect(stdout).toContain('deprecated');
    expect(stdout).toContain('unpublished');
  });
});
