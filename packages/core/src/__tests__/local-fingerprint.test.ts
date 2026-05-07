/**
 * Tests for adapters.local fingerprint sentinel (Plan 3c gap-32).
 *
 * Coverage:
 * - computeLocalFingerprint is order-independent (sorted before hashing)
 * - computeLocalFingerprint distinguishes different path sets
 * - readFingerprintSentinel returns null on absent / corrupt / wrong-shape file
 * - writeFingerprintSentinel atomic + 0o600 file mode
 * - checkFingerprintDrift returns 'match' on aligned state
 * - checkFingerprintDrift returns 'no-sentinel' when file absent
 * - checkFingerprintDrift returns 'drift' on mismatch with reason naming
 *   the divergent fingerprints
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeLocalFingerprint,
  readFingerprintSentinel,
  writeFingerprintSentinel,
  checkFingerprintDrift,
} from '../security/local-fingerprint.js';

let workdir: string;
let fpPath: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'massu-fp-'));
  fpPath = join(workdir, 'adapters-local-fingerprint.json');
});

afterEach(() => {
  if (existsSync(workdir)) {
    rmSync(workdir, { recursive: true, force: true });
  }
});

describe('computeLocalFingerprint', () => {
  it('order-independent: same content in different order → same fingerprint', () => {
    const a = computeLocalFingerprint(['a.js', 'b.js', 'c.js']);
    const b = computeLocalFingerprint(['c.js', 'a.js', 'b.js']);
    expect(a).toBe(b);
  });

  it('distinguishes different path sets', () => {
    const a = computeLocalFingerprint(['a.js']);
    const b = computeLocalFingerprint(['b.js']);
    expect(a).not.toBe(b);
  });

  it('empty array produces a stable fingerprint', () => {
    const a = computeLocalFingerprint([]);
    const b = computeLocalFingerprint([]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('readFingerprintSentinel', () => {
  it('returns null when file does not exist', () => {
    expect(readFingerprintSentinel(fpPath)).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    writeFileSync(fpPath, 'not-json{', 'utf-8');
    expect(readFingerprintSentinel(fpPath)).toBeNull();
  });

  it('returns null on wrong shape', () => {
    writeFileSync(fpPath, JSON.stringify({ wrong: 'shape' }), 'utf-8');
    expect(readFingerprintSentinel(fpPath)).toBeNull();
  });

  it('returns null on bad source enum', () => {
    writeFileSync(fpPath, JSON.stringify({
      fingerprint: 'a'.repeat(64),
      source: 'malicious',
      ts: '2026-05-07T00:00:00Z',
    }), 'utf-8');
    expect(readFingerprintSentinel(fpPath)).toBeNull();
  });

  it('returns the parsed sentinel on valid file', () => {
    const result = writeFingerprintSentinel(['adapter-foo.js'], 'cli', fpPath);
    expect(result.written).toBe(true);
    const sentinel = readFingerprintSentinel(fpPath);
    expect(sentinel).not.toBeNull();
    expect(sentinel?.source).toBe('cli');
    expect(sentinel?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('writeFingerprintSentinel', () => {
  it('writes file with mode 0o600', () => {
    writeFingerprintSentinel(['a.js'], 'cli', fpPath);
    expect(existsSync(fpPath)).toBe(true);
    expect(statSync(fpPath).mode & 0o777).toBe(0o600);
  });

  it('subsequent writes overwrite (atomic)', () => {
    writeFingerprintSentinel(['a.js'], 'cli', fpPath);
    const fp1 = readFingerprintSentinel(fpPath)?.fingerprint;
    writeFingerprintSentinel(['a.js', 'b.js'], 'cli-resync', fpPath);
    const fp2 = readFingerprintSentinel(fpPath)?.fingerprint;
    expect(fp1).not.toBe(fp2);
    expect(readFingerprintSentinel(fpPath)?.source).toBe('cli-resync');
  });
});

describe('checkFingerprintDrift', () => {
  it('match when current paths align with sentinel', () => {
    writeFingerprintSentinel(['a.js', 'b.js'], 'cli', fpPath);
    const result = checkFingerprintDrift(['a.js', 'b.js'], fpPath);
    expect(result.kind).toBe('match');
  });

  it('match is order-independent', () => {
    writeFingerprintSentinel(['a.js', 'b.js'], 'cli', fpPath);
    const result = checkFingerprintDrift(['b.js', 'a.js'], fpPath);
    expect(result.kind).toBe('match');
  });

  it('no-sentinel when file does not exist', () => {
    const result = checkFingerprintDrift(['a.js'], fpPath);
    expect(result.kind).toBe('no-sentinel');
    if (result.kind === 'no-sentinel') {
      expect(result.reason).toMatch(/resync-local-fingerprint/);
    }
  });

  it('drift when current paths diverge from sentinel', () => {
    writeFingerprintSentinel(['a.js'], 'cli', fpPath);
    const result = checkFingerprintDrift(['a.js', 'b.js'], fpPath);
    expect(result.kind).toBe('drift');
    if (result.kind === 'drift') {
      expect(result.sentinel.fingerprint).not.toBe(result.currentFingerprint);
      expect(result.reason).toMatch(/fingerprint drift/i);
      expect(result.reason).toMatch(/resync-local-fingerprint/);
    }
  });

  it('postinstall-poisoning scenario: sentinel records empty, attacker adds entry → drift', () => {
    writeFingerprintSentinel([], 'cli', fpPath);
    const result = checkFingerprintDrift(['adapters/attacker.js'], fpPath);
    expect(result.kind).toBe('drift');
  });
});
