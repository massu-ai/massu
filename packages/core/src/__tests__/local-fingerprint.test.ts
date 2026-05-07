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
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
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
    const a = computeLocalFingerprint(['a.js', 'b.js', 'c.js'], workdir);
    const b = computeLocalFingerprint(['c.js', 'a.js', 'b.js'], workdir);
    expect(a).toBe(b);
  });

  it('distinguishes different path sets', () => {
    const a = computeLocalFingerprint(['a.js'], workdir);
    const b = computeLocalFingerprint(['b.js'], workdir);
    expect(a).not.toBe(b);
  });

  it('empty array produces a stable fingerprint', () => {
    const a = computeLocalFingerprint([], workdir);
    const b = computeLocalFingerprint([], workdir);
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
    const result = writeFingerprintSentinel(['adapter-foo.js'], 'cli', workdir, fpPath);
    expect(result.written).toBe(true);
    const sentinel = readFingerprintSentinel(fpPath);
    expect(sentinel).not.toBeNull();
    expect(sentinel?.source).toBe('cli');
    expect(sentinel?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('writeFingerprintSentinel', () => {
  it('writes file with mode 0o600', () => {
    writeFingerprintSentinel(['a.js'], 'cli', workdir, fpPath);
    expect(existsSync(fpPath)).toBe(true);
    expect(statSync(fpPath).mode & 0o777).toBe(0o600);
  });

  it('subsequent writes overwrite (atomic)', () => {
    writeFingerprintSentinel(['a.js'], 'cli', workdir, fpPath);
    const fp1 = readFingerprintSentinel(fpPath)?.fingerprint;
    writeFingerprintSentinel(['a.js', 'b.js'], 'cli-resync', workdir, fpPath);
    const fp2 = readFingerprintSentinel(fpPath)?.fingerprint;
    expect(fp1).not.toBe(fp2);
    expect(readFingerprintSentinel(fpPath)?.source).toBe('cli-resync');
  });
});

describe('checkFingerprintDrift', () => {
  it('match when current paths align with sentinel', () => {
    writeFingerprintSentinel(['a.js', 'b.js'], 'cli', workdir, fpPath);
    const result = checkFingerprintDrift(['a.js', 'b.js'], workdir, fpPath);
    expect(result.kind).toBe('match');
  });

  it('match is order-independent', () => {
    writeFingerprintSentinel(['a.js', 'b.js'], 'cli', workdir, fpPath);
    const result = checkFingerprintDrift(['b.js', 'a.js'], workdir, fpPath);
    expect(result.kind).toBe('match');
  });

  it('no-sentinel when file does not exist', () => {
    const result = checkFingerprintDrift(['a.js'], workdir, fpPath);
    expect(result.kind).toBe('no-sentinel');
    if (result.kind === 'no-sentinel') {
      expect(result.reason).toMatch(/resync-local-fingerprint/);
    }
  });

  it('drift when current paths diverge from sentinel', () => {
    writeFingerprintSentinel(['a.js'], 'cli', workdir, fpPath);
    const result = checkFingerprintDrift(['a.js', 'b.js'], workdir, fpPath);
    expect(result.kind).toBe('drift');
    if (result.kind === 'drift') {
      expect(result.sentinel.fingerprint).not.toBe(result.currentFingerprint);
      expect(result.reason).toMatch(/fingerprint drift/i);
      expect(result.reason).toMatch(/resync-local-fingerprint/);
    }
  });

  it('postinstall-poisoning scenario: sentinel records empty, attacker adds entry → drift', () => {
    writeFingerprintSentinel([], 'cli', workdir, fpPath);
    const result = checkFingerprintDrift(['adapters/attacker.js'], workdir, fpPath);
    expect(result.kind).toBe('drift');
  });

  it('CR-9 audit C3: postinstall file-swap at acknowledged path → drift', () => {
    // The structural fix for the CRITICAL-3 finding. With the prior path-only
    // fingerprint, swapping the FILE at an already-acknowledged path was
    // a silent bypass: same path, different content, fingerprint matched,
    // loader trusted attacker code. Content-hashing makes that scenario
    // detectable.
    mkdirSync(join(workdir, 'adapters'), { recursive: true });
    const adapterPath = 'adapters/my-rails.ts';
    writeFileSync(join(workdir, adapterPath), 'export default { id: "real" };', 'utf-8');
    writeFingerprintSentinel([adapterPath], 'cli', workdir, fpPath);

    // Sanity: no drift before tampering.
    expect(checkFingerprintDrift([adapterPath], workdir, fpPath).kind).toBe('match');

    // Attacker swaps the file content.
    writeFileSync(join(workdir, adapterPath), 'export default { id: "evil" };', 'utf-8');

    // Drift detected — file content is part of the fingerprint.
    expect(checkFingerprintDrift([adapterPath], workdir, fpPath).kind).toBe('drift');
  });

  it('CR-9 audit C3: missing file at sentinel-acknowledged path → drift', () => {
    mkdirSync(join(workdir, 'adapters'), { recursive: true });
    const adapterPath = 'adapters/local.ts';
    writeFileSync(join(workdir, adapterPath), 'real content', 'utf-8');
    writeFingerprintSentinel([adapterPath], 'cli', workdir, fpPath);
    // File deleted out-of-band — fingerprint includes <missing> sentinel,
    // so deletion is detectable as drift.
    rmSync(join(workdir, adapterPath));
    expect(checkFingerprintDrift([adapterPath], workdir, fpPath).kind).toBe('drift');
  });

  it('CR-9 audit C3: symlink at acknowledged path is hashed as <symlink>, not followed', () => {
    // Defense against attacker creating a symlink to /etc/shadow at the
    // acknowledged path: lstatSync detects + the fingerprint records
    // <symlink> rather than the link target's content.
    mkdirSync(join(workdir, 'adapters'), { recursive: true });
    const adapterPath = 'adapters/sym.ts';
    writeFileSync(join(workdir, adapterPath), 'real content', 'utf-8');
    writeFingerprintSentinel([adapterPath], 'cli', workdir, fpPath);

    rmSync(join(workdir, adapterPath));
    // Replace with a symlink to another file in the workdir (we don't
    // actually point at /etc/shadow in tests because that's invasive; the
    // structural protection — lstatSync, not statSync — applies regardless
    // of target).
    writeFileSync(join(workdir, 'sentinel-target.txt'), 'real content', 'utf-8');
    symlinkSync(join(workdir, 'sentinel-target.txt'), join(workdir, adapterPath));

    expect(checkFingerprintDrift([adapterPath], workdir, fpPath).kind).toBe('drift');
  });
});
