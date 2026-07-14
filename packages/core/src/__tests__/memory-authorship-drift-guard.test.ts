/**
 * B-01 drift-guard — the structural half of the authorship credential.
 *
 * The unit tests prove the credential is sound TODAY. This proves it cannot be
 * quietly unsound TOMORROW. The forgeable design (a public `sha256` body-hash in the
 * frontmatter) has already been reintroduced ONCE during this workstream, wearing a
 * longer string. These assertions are what make a third reintroduction a red test
 * rather than a silent catastrophe.
 *
 * Derived from the FILESYSTEM, not a static list (feedback_drift_guard_filesystem_
 * derived_over_static): a static array of "modules to check" fails open the moment
 * someone adds a new module.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every .ts file under src/, excluding tests.
 *
 * Tolerant of entries that vanish mid-walk: other suites write scratch files under
 * `packages/core/src/` and clean them up, so `statSync` races them in a parallel run.
 * (Reproduced: this guard passes alone, failed only in the full suite.) A guard that
 * fails at random is a guard nobody trusts.
 */
function allSourceFiles(dir: string = SRC, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      allSourceFiles(p, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

/** Read a file that may have vanished since the walk. */
function safeRead(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

const AUTHORSHIP_MODULE = 'memory-authorship.ts';

describe('B-01 drift-guard — one module owns the trust decision', () => {
  it('no module outside memory-authorship.ts reads a massu_* frontmatter key', () => {
    const offenders: string[] = [];

    for (const file of allSourceFiles()) {
      const rel = relative(SRC, file);
      if (rel === AUTHORSHIP_MODULE) continue;
      const src = safeRead(file);

      // Reading `massu_authored` / `massu_render_mac` OUT OF a frontmatter object is
      // the self-certifying-artifact bug. Column access in SQL is fine (the store is
      // a cache); indexing a parsed frontmatter record is not.
      const patterns = [
        /\bfm\s*\[\s*['"]massu_/,
        /\bfrontmatter\s*\[\s*['"]massu_/,
        /\bfm\.massu_/,
        /\bfrontmatter\.massu_/,
        /readMemoryKey\([^)]*massu_/,
      ];
      for (const re of patterns) {
        if (re.test(src)) offenders.push(`${rel} :: ${re}`);
      }
    }

    expect(
      offenders,
      `A massu_* frontmatter key is being read for trust outside ${AUTHORSHIP_MODULE}. ` +
        `An artifact may not certify its own authorship — that is exactly the forgery ` +
        `OD-1 exists to prevent.\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('the ingest path never assigns massu_authored from parsed frontmatter', () => {
    const ingest = readFileSync(join(SRC, 'memory-file-ingest.ts'), 'utf8');

    // Backfill sets massu_authored = 0 for every pre-existing file, UNCONDITIONALLY.
    // If ingest ever learns to read the flag out of the file, a human can grant
    // himself Massu-ownership by typing one line of YAML.
    expect(ingest).not.toMatch(/massu_authored\s*[=:]\s*(?!0)(fm|frontmatter|parsed)/);
    expect(ingest).not.toMatch(/massu_authored.*\bfm\b/);
  });

  it('no key material is a literal, a constant, an env default, or a committed file', () => {
    // NOTE on precision: a bare "no 64-hex literal anywhere" rule is WRONG and was
    // tried first — it fires on `detect/adapters/tree-sitter-loader.ts:146+`, whose
    // `sha256:` entries are supply-chain INTEGRITY PINS for downloaded WASM grammars.
    // Those are public by design; that is what a checksum IS. Verified at source
    // before loosening this guard (not silently dropped).
    //
    // A hex literal is key MATERIAL only when it is bound to a key-ish name. That is
    // the thing that would make every install on earth share one secret.
    // ...and a PUBLIC key is not key material either. `security/*-pubkey.generated.ts`
    // ships four `*_PUBKEY_FINGERPRINT_HEX` constants; a public key is MEANT to be
    // bundled — that is what lets a client verify a signature. Also verified at source.
    // The property under test is specifically: no SECRET is baked into the package.
    const KEYISH = /(key|secret|hmac|\bmac\b|pepper|token)/i;
    const PUBLIC_BY_DESIGN = /(pubkey|public[_-]?key|fingerprint|sha256|checksum|integrity|digest|expected)/i;
    const offenders: string[] = [];

    for (const file of allSourceFiles()) {
      const rel = relative(SRC, file);
      const src = safeRead(file);

      src.split('\n').forEach((line, i) => {
        if (!/['"][0-9a-fA-F]{64}['"]/.test(line)) return;
        if (PUBLIC_BY_DESIGN.test(line)) return;
        if (KEYISH.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });

      // An env-var fallback is the same defect wearing a config knob: whoever sets
      // the env var can forge every stamp on that machine.
      if (/process\.env\.\w*RENDER_KEY/.test(src)) {
        offenders.push(`${rel}: reads a render key from the environment`);
      }
    }

    expect(
      offenders,
      `Key material must be GENERATED on the user's machine — never a literal, a ` +
        `constant, an env default, or a committed file. A bundled key is forgeable by ` +
        `every downloader.\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('ANTI-VACUITY: the key-material rule still FIRES on a real bundled secret', () => {
    // A guard relaxed until it passes is worse than no guard. The exclusions above
    // were added to clear two proven false-positives (integrity pins, public keys) —
    // so this asserts the rule did not become vacuous in the process. These are the
    // exact shapes a future session might introduce.
    const KEYISH = /(key|secret|hmac|\bmac\b|pepper|token)/i;
    const PUBLIC_BY_DESIGN = /(pubkey|public[_-]?key|fingerprint|sha256|checksum|integrity|digest|expected)/i;
    const flags = (line: string): boolean =>
      /['"][0-9a-fA-F]{64}['"]/.test(line) && !PUBLIC_BY_DESIGN.test(line) && KEYISH.test(line);

    const MUST_FIRE = [
      `const RENDER_KEY = '${'a'.repeat(64)}';`,
      `const DEFAULT_HMAC_SECRET = '${'b'.repeat(64)}';`,
      `export const MASSU_MAC_KEY = '${'c'.repeat(64)}';`,
      `const key = process.env.MASSU_RENDER_KEY ?? '${'d'.repeat(64)}';`,
    ];
    for (const line of MUST_FIRE) {
      expect(flags(line), `guard went vacuous — it no longer catches: ${line}`).toBe(true);
    }

    // ...and still does NOT fire on the two legitimate shapes.
    const MUST_NOT_FIRE = [
      `sha256: '${'e'.repeat(64)}',`,
      `export const LICENSE_PUBKEY_FINGERPRINT_HEX = '${'f'.repeat(64)}';`,
    ];
    for (const line of MUST_NOT_FIRE) {
      expect(flags(line), `guard is over-broad — it wrongly catches: ${line}`).toBe(false);
    }
  });

  it('memory-authorship.ts itself carries NO hex literal of any kind', () => {
    // The strict rule, applied where it actually matters. No exceptions here: this
    // module has no legitimate reason to contain a 64-hex constant.
    const mod = readFileSync(join(SRC, AUTHORSHIP_MODULE), 'utf8');
    expect(mod.match(/['"][0-9a-fA-F]{64}['"]/g) ?? []).toEqual([]);
  });

  it('the credential is an HMAC, not a bare hash — createHash is never the stamp', () => {
    const mod = readFileSync(join(SRC, AUTHORSHIP_MODULE), 'utf8');
    expect(mod).toContain("createHmac('sha256', key)");
    // The whole finding: a stamp built from a PUBLIC function proves integrity, not
    // authorship. `createHash` must not appear in this module at all.
    expect(
      /createHash\s*\(/.test(mod),
      'memory-authorship.ts uses createHash — a body-hash is publicly computable and ' +
        'therefore forgeable by the human whose git repo the memory dir is. Use an HMAC.'
    ).toBe(false);
  });

  it('verification never mints — only the write path may create a key', () => {
    const mod = readFileSync(join(SRC, AUTHORSHIP_MODULE), 'utf8');
    const verify = mod.slice(mod.indexOf('export function verifyAuthorship'));
    const verifyBody = verify.slice(0, verify.indexOf('\n}\n') + 1);
    // If verify called ensureRenderKey, a fresh machine would mint a key during a
    // read, and the fail-safe ("no key ⇒ everything is human") would still hold —
    // but a secret would be created as a side effect of an observation. Keep the
    // write path the only minting path.
    expect(verifyBody).not.toContain('ensureRenderKey');
    expect(verifyBody).toContain('readRenderKey');
  });
});
