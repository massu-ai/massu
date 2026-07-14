/**
 * B-01 / OD-1 — authorship is a credential, not a claim.
 *
 * The catastrophe this prevents: Massu overwrites the operator's ~73 irreplaceable
 * hand-written memory files, which include his standing Laws.
 *
 * The test that matters most is `a forged artifact is never adopted`: the whole point
 * of OD-1 is that the human — whose git repo the memory dir IS — can trivially write
 * `massu_authored: true` and a correct `sha256` into a file. Under the rejected
 * hash-based design that file would be adopted and overwritten. It must not be.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash, createHmac } from 'crypto';
import {
  mintAuthorship,
  verifyAuthorship,
  readRenderKey,
  ensureRenderKey,
  renderKeyPath,
  renderKeyMode,
  renderKeyExists,
  RENDER_MAC_KEY,
} from '../memory-authorship.ts';

let home: string;

beforeEach(() => {
  // Scratch HOME. The operator's real ~/.massu/render-key is never touched.
  home = mkdtempSync(join(tmpdir(), 'massu-authorship-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const BODY = 'This is the body of a rendered memory.\n\nIt has paragraphs.\n';

describe('B-01 — the key is per-install, generated locally, never shipped', () => {
  it('does not exist until the first render, then is 32 random bytes at 0600', () => {
    expect(readRenderKey(home)).toBeUndefined();
    expect(renderKeyExists(home)).toBe(false);

    const mac = mintAuthorship(BODY, home);
    expect(mac).toMatch(/^[0-9a-f]{64}$/);

    const key = readRenderKey(home);
    expect(key).toBeDefined();
    expect(key!.length).toBe(32);
    // 0600 — same posture as ~/.massu/credentials (CR-59).
    expect(renderKeyMode(home)).toBe(0o600);
  });

  it('two installs get DIFFERENT keys — a shipped key would be worthless', () => {
    const homeA = mkdtempSync(join(tmpdir(), 'massu-inst-a-'));
    const homeB = mkdtempSync(join(tmpdir(), 'massu-inst-b-'));
    try {
      const keyA = ensureRenderKey(homeA)!;
      const keyB = ensureRenderKey(homeB)!;
      expect(keyA.equals(keyB)).toBe(false);

      // ...and therefore install B cannot verify install A's stamp. This is the
      // entire security property: the credential is not publicly computable.
      const macFromA = mintAuthorship(BODY, homeA)!;
      expect(verifyAuthorship(BODY, { [RENDER_MAC_KEY]: macFromA }, null, homeB)).toBe(false);
      expect(verifyAuthorship(BODY, { [RENDER_MAC_KEY]: macFromA }, null, homeA)).toBe(true);
    } finally {
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
    }
  });

  it('is stable across calls — minting twice does not re-key and disown prior files', () => {
    const mac1 = mintAuthorship(BODY, home);
    const keyAfter1 = readRenderKey(home)!;
    const mac2 = mintAuthorship(BODY, home);
    const keyAfter2 = readRenderKey(home)!;

    expect(keyAfter1.equals(keyAfter2)).toBe(true);
    expect(mac1).toBe(mac2);
  });
});

describe('B-01 — verification is fail-closed in the direction of NOT writing', () => {
  it('ADOPTS its own freshly-minted file', () => {
    const mac = mintAuthorship(BODY, home)!;
    expect(verifyAuthorship(BODY, { [RENDER_MAC_KEY]: mac }, null, home)).toBe(true);
  });

  it('⛔ NEVER adopts a forged artifact — the human can compute a sha256, not a MAC', () => {
    // Establish a key, so this is not passing merely because no key exists.
    mintAuthorship('some other file', home);

    // The exact forgery the rejected design permitted: a hand-written file that
    // asserts it is Massu's AND carries a correct body hash.
    const forged = {
      massu_authored: true,
      [RENDER_MAC_KEY]: createHash('sha256').update(BODY, 'utf8').digest('hex'),
    };
    expect(verifyAuthorship(BODY, forged, null, home)).toBe(false);

    // Even the store agreeing does not save it — the artifact + key decide.
    expect(
      verifyAuthorship(BODY, forged, { massu_authored: 1, massu_render_mac: 'x' }, home)
    ).toBe(false);
  });

  it('rejects a stale MAC after the body is edited by hand', () => {
    const mac = mintAuthorship(BODY, home)!;
    const edited = BODY + '\nThe human added this sentence.\n';
    expect(verifyAuthorship(edited, { [RENDER_MAC_KEY]: mac }, null, home)).toBe(false);
  });

  it('no key on this machine ⇒ EVERY file is human ⇒ Massu writes nothing', () => {
    // A real, valid MAC minted elsewhere...
    const other = mkdtempSync(join(tmpdir(), 'massu-other-'));
    const mac = mintAuthorship(BODY, other)!;
    rmSync(other, { recursive: true, force: true });

    // ...on a machine that holds no key. Fail-safe: not ours.
    expect(readRenderKey(home)).toBeUndefined();
    expect(verifyAuthorship(BODY, { [RENDER_MAC_KEY]: mac }, null, home)).toBe(false);

    // And verification did NOT mint a key as a side effect. Only writes mint.
    expect(readRenderKey(home)).toBeUndefined();
  });

  it('a truncated / empty key file is not a key (fail closed, not stamp-with-garbage)', () => {
    mkdirSync(join(home, '.massu'), { recursive: true });
    writeFileSync(renderKeyPath(home), Buffer.alloc(3), { mode: 0o600 });
    expect(readRenderKey(home)).toBeUndefined();
    expect(verifyAuthorship(BODY, { [RENDER_MAC_KEY]: 'a'.repeat(64) }, null, home)).toBe(false);
  });

  it('missing / empty / non-string MAC is refused', () => {
    mintAuthorship(BODY, home);
    for (const fm of [
      undefined,
      {},
      { [RENDER_MAC_KEY]: '' },
      { [RENDER_MAC_KEY]: 123 },
      { [RENDER_MAC_KEY]: null },
      { massu_authored: true }, // the self-certifying claim, with no credential
    ]) {
      expect(verifyAuthorship(BODY, fm as Record<string, unknown>, null, home)).toBe(false);
    }
  });
});

describe('B-01 — adoption is STICKY (F-15)', () => {
  it('a file adopted-human stays human EVEN WITH a perfectly valid MAC', () => {
    const mac = mintAuthorship(BODY, home)!;
    // Sanity: without the sticky flag this exact input verifies.
    expect(verifyAuthorship(BODY, { [RENDER_MAC_KEY]: mac }, null, home)).toBe(true);

    // The human edited it once ⇒ adopted_human_at_epoch was set.
    const sticky = { adopted_human_at_epoch: 1_768_000_000 };
    expect(verifyAuthorship(BODY, { [RENDER_MAC_KEY]: mac }, sticky, home)).toBe(false);
  });

  it('a byte-identical `git checkout --` does NOT re-grant Massu ownership', () => {
    const mac = mintAuthorship(BODY, home)!;
    const fm = { [RENDER_MAC_KEY]: mac };

    // Timeline: Massu rendered it → human edited → store marked adopted_human →
    // human ran `git checkout --` restoring the EXACT original bytes. The MAC now
    // matches again. Under a naive design Massu silently re-owns the file.
    const restored = { adopted_human_at_epoch: 1_768_000_000, massu_authored: 1 };
    expect(verifyAuthorship(BODY, fm, restored, home)).toBe(false);
  });
});

describe('B-01 — the MAC covers the body, and nothing else', () => {
  it('is HMAC-SHA256(key, body) — not a hash, not over the frontmatter', () => {
    const mac = mintAuthorship(BODY, home)!;
    const key = readRenderKey(home)!;
    const expected = createHmac('sha256', key).update(BODY, 'utf8').digest('hex');
    expect(mac).toBe(expected);
    // Explicitly NOT the public hash.
    expect(mac).not.toBe(createHash('sha256').update(BODY, 'utf8').digest('hex'));
  });

  it('never throws — an authorship error can never crash session start', () => {
    const nasty: unknown[] = [null, undefined, 0, [], { [RENDER_MAC_KEY]: {} }];
    for (const fm of nasty) {
      expect(() =>
        verifyAuthorship(BODY, fm as Record<string, unknown>, null, home)
      ).not.toThrow();
    }
  });
});

describe('B-01 — no key material is bundled with the package', () => {
  it('the key file does not ship in the repo', () => {
    // A committed key would make every install share one secret ⇒ forgeable ⇒ the
    // credential proves nothing. It must be generated on the user's machine, only.
    const src = readFileSync(new URL('../memory-authorship.ts', import.meta.url), 'utf8');
    // No 32-byte hex/base64 literal anywhere in the module.
    expect(src).not.toMatch(/['"][0-9a-f]{64}['"]/);
    expect(src).not.toMatch(/process\.env\.[A-Z_]*RENDER_KEY/);
    // The key comes from the CSPRNG. This is the only permitted source.
    expect(src).toContain('randomBytes(32)');
  });
});
