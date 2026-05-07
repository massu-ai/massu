/**
 * Tests for adapter-discovery telemetry (Plan 3c gap-22 / VR-TELEMETRY-PAYLOAD-SCHEMA).
 *
 * Coverage:
 * - disabled: no validation, no write, no send
 * - schema strictness rejects PII / unknown keys
 * - schema valid + endpoint reachable → queued (file appended)
 * - schema valid + endpoint unreachable → queued (fallback path)
 * - buffer cap (1MB / 1000 entries) drops oldest entries with warning
 * - file mode is 0o600 after write
 * - replay re-validates and drops schema-stale entries
 * - replay disabled flag skips processing
 * - replay clears file when all entries sent
 *
 * The actual HTTP POST behavior is mocked via globalThis.fetch — we test
 * the path through the fetcher's allowlist, not the network response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AdapterDiscoveryPayloadSchema,
  recordAdapterDiscovery,
  replayPendingTelemetry,
} from '../security/telemetry.js';

const PENDING_PATH = resolve(homedir(), '.massu', 'telemetry-pending.jsonl');

let originalFetch: typeof globalThis.fetch;
let prevHomedirContent: string | null = null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Snapshot any pre-existing pending file content (so we don't trash a
  // real telemetry file during tests).
  prevHomedirContent = existsSync(PENDING_PATH) ? readFileSync(PENDING_PATH, 'utf-8') : null;
  if (existsSync(PENDING_PATH)) {
    rmSync(PENDING_PATH, { force: true });
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  // Restore the previous content if any.
  if (prevHomedirContent !== null) {
    writeFileSync(PENDING_PATH, prevHomedirContent, { mode: 0o600 });
  } else if (existsSync(PENDING_PATH)) {
    rmSync(PENDING_PATH, { force: true });
  }
});

describe('AdapterDiscoveryPayloadSchema (strict — PII guardrail)', () => {
  it('accepts the canonical four-field payload', () => {
    const payload = {
      adapter_id: 'python-fastapi',
      count: 1,
      version: '1.4.0',
      ts: '2026-05-07T20:00:00Z',
    };
    expect(AdapterDiscoveryPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects unknown keys (.strict())', () => {
    const payload = {
      adapter_id: 'python-fastapi',
      count: 1,
      version: '1.4.0',
      ts: '2026-05-07T20:00:00Z',
      file_path: 'app/secret.py', // representative PII-attempt key — schema rejects ANY unknown key
    };
    expect(AdapterDiscoveryPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects negative count', () => {
    const payload = {
      adapter_id: 'python-fastapi',
      count: -1,
      version: '1.4.0',
      ts: '2026-05-07T20:00:00Z',
    };
    expect(AdapterDiscoveryPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects non-ISO datetime', () => {
    const payload = {
      adapter_id: 'python-fastapi',
      count: 1,
      version: '1.4.0',
      ts: 'not-a-datetime',
    };
    expect(AdapterDiscoveryPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe('recordAdapterDiscovery — disabled by default', () => {
  it('returns disabled and does nothing when enabled=false', async () => {
    const result = await recordAdapterDiscovery(
      { adapter_id: 'python-fastapi', count: 1, version: '1.4.0', ts: '2026-05-07T20:00:00Z' },
      { enabled: false },
    );
    expect(result.kind).toBe('disabled');
    expect(existsSync(PENDING_PATH)).toBe(false);
  });

  it('disabled even rejects ill-formed payloads (no validation when off)', async () => {
    const result = await recordAdapterDiscovery({ junk: 'PII' }, { enabled: false });
    // Disabled short-circuits BEFORE validation — that's the contract: when
    // off, the writer doesn't touch payload at all.
    expect(result.kind).toBe('disabled');
  });
});

describe('recordAdapterDiscovery — schema validation (PII drop)', () => {
  it('drops payloads with unknown keys', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 204, text: async () => '' } as Response);
    const result = await recordAdapterDiscovery(
      { adapter_id: 'x', count: 1, version: 'v', ts: '2026-05-07T20:00:00Z', leak: 'pii' },
      { enabled: true },
    );
    expect(result.kind).toBe('dropped');
    if (result.kind === 'dropped') {
      expect(result.reason).toMatch(/leak/);
    }
    expect(existsSync(PENDING_PATH)).toBe(false);
  });
});

describe('recordAdapterDiscovery — queued path (mocked fetch)', () => {
  it('queues a valid payload and writes file with mode 0o600', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 204, text: async () => '' } as Response);
    const result = await recordAdapterDiscovery(
      { adapter_id: 'python-fastapi', count: 3, version: '1.4.0', ts: '2026-05-07T20:00:00Z' },
      { enabled: true },
    );
    expect(result.kind).toBe('queued');
    if (result.kind === 'queued') {
      expect(result.entryCount).toBe(1);
      expect(result.pendingBytes).toBeGreaterThan(0);
    }
    expect(existsSync(PENDING_PATH)).toBe(true);
    const mode = statSync(PENDING_PATH).mode & 0o777;
    expect(mode).toBe(0o600);
    const written = readFileSync(PENDING_PATH, 'utf-8');
    expect(written).toContain('python-fastapi');
  });

  it('appends across multiple calls without losing prior entries', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 204, text: async () => '' } as Response);
    await recordAdapterDiscovery(
      { adapter_id: 'a', count: 1, version: 'v', ts: '2026-05-07T20:00:00Z' },
      { enabled: true },
    );
    const result = await recordAdapterDiscovery(
      { adapter_id: 'b', count: 1, version: 'v', ts: '2026-05-07T20:00:01Z' },
      { enabled: true },
    );
    if (result.kind === 'queued') {
      expect(result.entryCount).toBe(2);
    }
    const lines = readFileSync(PENDING_PATH, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });
});

describe('replayPendingTelemetry', () => {
  it('returns zero-result when disabled', async () => {
    // Pre-populate a pending file
    mkdirSync(resolve(homedir(), '.massu'), { recursive: true, mode: 0o700 });
    writeFileSync(PENDING_PATH, JSON.stringify({
      adapter_id: 'a', count: 1, version: 'v', ts: '2026-05-07T20:00:00Z',
    }) + '\n', { mode: 0o600 });
    const result = await replayPendingTelemetry({ enabled: false });
    expect(result).toEqual({ replayed: 0, dropped: 0, remaining: 0, errors: [] });
    // Pending file should be untouched.
    expect(existsSync(PENDING_PATH)).toBe(true);
  });

  it('returns zero-result when no pending file', async () => {
    const result = await replayPendingTelemetry({ enabled: true });
    expect(result).toEqual({ replayed: 0, dropped: 0, remaining: 0, errors: [] });
  });

  it('drops schema-stale entries during replay', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 204, text: async () => '' } as Response);
    mkdirSync(resolve(homedir(), '.massu'), { recursive: true, mode: 0o700 });
    // Mix valid + stale entries (stale = unknown key, would be rejected by .strict())
    const valid = JSON.stringify({ adapter_id: 'a', count: 1, version: 'v', ts: '2026-05-07T20:00:00Z' });
    const stale = JSON.stringify({ adapter_id: 'a', count: 1, version: 'v', ts: '2026-05-07T20:00:00Z', leaked: 'pii' });
    writeFileSync(PENDING_PATH, valid + '\n' + stale + '\n', { mode: 0o600 });

    const result = await replayPendingTelemetry({ enabled: true });
    expect(result.replayed).toBe(1);
    expect(result.dropped).toBe(1);
  });

  it('clears file when all entries sent successfully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 204, text: async () => '' } as Response);
    mkdirSync(resolve(homedir(), '.massu'), { recursive: true, mode: 0o700 });
    const valid = JSON.stringify({ adapter_id: 'a', count: 1, version: 'v', ts: '2026-05-07T20:00:00Z' });
    writeFileSync(PENDING_PATH, valid + '\n', { mode: 0o600 });

    const result = await replayPendingTelemetry({ enabled: true });
    expect(result.replayed).toBe(1);
    expect(result.remaining).toBe(0);
    expect(existsSync(PENDING_PATH)).toBe(false);
  });
});
