/**
 * B-01 / OD-1 — authorship is a CREDENTIAL, minted by Massu, never claimed by an artifact.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHY A KEYED MAC AND NOT A HASH
 * ═══════════════════════════════════════════════════════════════════════════════
 * Massu must prove *it* wrote a file before it overwrites it. A plain `sha256` in
 * the frontmatter cannot do that. `sha256` is a PUBLIC function: a body-hash proves
 * INTEGRITY (these bytes are the bytes that were written) but says NOTHING about
 * AUTHORSHIP (who wrote them). The memory directory is a git repo the human edits;
 * he — or anything running as him — can compute a valid hash in ten seconds, and
 * Massu would then adopt his hand-written file and overwrite it.
 *
 * A credential anyone can compute is not a credential.
 *
 * So the stamp is HMAC-SHA256(key, body), keyed by a secret only this install holds.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ⛔ THE KEY IS PER-INSTALL. NEVER SHIPPED, NEVER BUNDLED, NEVER DEFAULTED.
 * ═══════════════════════════════════════════════════════════════════════════════
 * Every downloader of `@massu/core` gets their OWN 32 random bytes, generated lazily
 * by `crypto.randomBytes(32)` on this machine the first time Massu renders. Zero
 * setup, zero config, zero network, zero prompt — the user never sees it.
 *
 * A key shipped inside the package would be WORTHLESS BY CONSTRUCTION: every copy on
 * earth would hold the same secret, so anyone could forge a stamp and the credential
 * would prove exactly nothing. There is therefore no default key, no constant, no env
 * fallback, and no committed key file — and `memory-authorship-drift-guard.test.ts`
 * asserts it. The key is generated, or it does not exist.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * FAIL-SAFE DIRECTION
 * ═══════════════════════════════════════════════════════════════════════════════
 * Key absent (fresh machine, deleted, never rendered) ⇒ no MAC verifies ⇒ EVERY file
 * is HUMAN ⇒ Massu writes nothing. That is the safe direction, and it is deliberate:
 * the cost of being wrong about "this is mine" is destroying irreplaceable prose; the
 * cost of being wrong about "this is the human's" is that Massu does not maintain a
 * file. Recovery is the explicit `massu memory adopt` ceremony (B-15) — never
 * automatic, never in a hook.
 *
 * This module is the ONLY place a `massu_*` frontmatter key may be read for a trust
 * decision (drift-guarded).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

/** The frontmatter key carrying the stamp. Massu writes it; Massu alone trusts it. */
export const RENDER_MAC_KEY = 'massu_render_mac';

/** The store row's view of a file. All fields optional — an absent row is the
 *  "frozen file" cell (B-15) and classifies HUMAN, like everything else unproven. */
export interface AuthorshipStoreRow {
  massu_authored?: number | null;
  massu_render_mac?: string | null;
  /** F-15 STICKINESS. Once set, the file is human until `massu memory adopt` clears
   *  it. Nothing else clears it — not a byte-identical `git checkout`, not a
   *  re-render, not a matching MAC. */
  adopted_human_at_epoch?: number | null;
}

/** `~/.massu/render-key` — outside every repo, never committed (same posture as
 *  `~/.massu/credentials`, CR-59). Parameterised by `home` so tests never touch the
 *  operator's real key. */
export function renderKeyPath(home: string = homedir()): string {
  return resolve(home, '.massu', 'render-key');
}

/**
 * Read this machine's key. Returns undefined if it does not exist — and DOES NOT
 * create one. Generation happens only in `mintAuthorship`, i.e. only on a real write.
 * Verification must never have the side effect of minting a secret.
 */
export function readRenderKey(home: string = homedir()): Buffer | undefined {
  const p = renderKeyPath(home);
  try {
    if (!existsSync(p)) return undefined;
    const raw = readFileSync(p);
    // A truncated / empty / corrupted key is NOT a key. Fail closed rather than
    // stamping with 3 bytes of garbage that would then "verify" against itself.
    if (raw.length !== 32) return undefined;
    return raw;
  } catch {
    return undefined; // unreadable ⇒ no key ⇒ everything is human
  }
}

/**
 * Read-or-create this machine's key. Called ONLY on the write path.
 * 32 bytes from the OS CSPRNG, mode 0600, in a 0700 directory.
 */
export function ensureRenderKey(home: string = homedir()): Buffer | undefined {
  const existing = readRenderKey(home);
  if (existing) return existing;

  const p = renderKeyPath(home);
  try {
    const dir = resolve(home, '.massu');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* pre-existing dir with other perms — the file mode below is what matters */
    }
    const key = randomBytes(32);
    writeFileSync(p, key, { mode: 0o600 });
    try {
      chmodSync(p, 0o600);
    } catch {
      /* best-effort on filesystems without POSIX modes (Windows) */
    }
    return key;
  } catch {
    // Cannot persist a key ⇒ cannot mint a durable credential ⇒ do not write.
    // Returning undefined makes `mintAuthorship` return null, which makes the
    // renderer refuse. Never stamp with an ephemeral in-memory key: the stamp
    // would not verify next session and Massu would disown its own file.
    return undefined;
  }
}

/**
 * Mint the stamp for a body. Returns null if no key can be established, which the
 * renderer MUST treat as "do not write this file".
 *
 * The MAC covers the BODY ONLY — never the whole file — because the frontmatter is
 * where the MAC itself lives, and a MAC cannot cover itself.
 */
export function mintAuthorship(body: string, home: string = homedir()): string | null {
  try {
    const key = ensureRenderKey(home);
    if (!key) return null;
    return createHmac('sha256', key).update(body, 'utf8').digest('hex');
  } catch {
    return null;
  }
}

/**
 * Is this file Massu's, such that Massu may overwrite it?
 *
 * TRUE requires ALL of:
 *   - the file has NOT been adopted-human (F-15 stickiness), AND
 *   - this machine holds a key, AND
 *   - the artifact carries a MAC, AND
 *   - that MAC is exactly HMAC(key, body).
 *
 * Anything else — missing, stale, mismatched, unparseable, an exception anywhere —
 * is FALSE: the file is the human's and Massu never writes it.
 *
 * `storeRow` is a CACHE, not the credential. The artifact + the key decide. That is
 * what lets a Massu file survive a DB wipe (the store is gitignored; the corpus is
 * not — the two halves are not lost and restored together).
 */
export function verifyAuthorship(
  body: string,
  frontmatter: Record<string, unknown> | undefined,
  storeRow?: AuthorshipStoreRow | null,
  home: string = homedir()
): boolean {
  try {
    // F-15 — STICKY. Checked FIRST, before the MAC, so that a human edit followed by
    // a byte-identical `git checkout --` does NOT silently re-grant Massu ownership.
    if (storeRow?.adopted_human_at_epoch != null) return false;

    const key = readRenderKey(home);
    if (!key) return false; // no key ⇒ nothing is ours ⇒ write nothing

    const claimed = frontmatter?.[RENDER_MAC_KEY];
    if (typeof claimed !== 'string' || claimed.length === 0) return false;

    const expected = createHmac('sha256', key).update(body, 'utf8').digest('hex');

    // Constant-time. The MAC is a secret-derived value; a length-leaking or
    // early-exit compare is a side channel on the credential itself.
    const a = Buffer.from(claimed, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    // An error inside verification is treated as "not ours". Never throw out of the
    // renderer — a crash in the authorship check must not become a crash at session
    // start, and must never fall through to a write.
    return false;
  }
}

/**
 * Read the stamp out of a parsed frontmatter.
 *
 * This module is the ONLY place a `massu_*` frontmatter key may be touched — including
 * for a merely-mechanical read like caching the MAC into the store. The drift-guard
 * enforces that with no exceptions, deliberately: "I am only reading it, not trusting it"
 * is precisely the sentence that precedes a self-certifying artifact. Callers that need
 * the value get it from here.
 *
 * Returns null for anything that is not a non-empty string. Reading it confers NO trust —
 * only `verifyAuthorship` does that.
 */
export function extractRenderMac(frontmatter: Record<string, unknown> | undefined): string | null {
  const v = frontmatter?.[RENDER_MAC_KEY];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Test/diagnostic helper: does this machine hold a key at all?
 * Used by `massu memory adopt` (B-15) to explain the "frozen file" state to the
 * operator in plain terms, and by `doctor`. Never used to make a trust decision.
 */
export function renderKeyExists(home: string = homedir()): boolean {
  return readRenderKey(home) !== undefined;
}

/** The key file's mode, for the security test. undefined if absent. */
export function renderKeyMode(home: string = homedir()): number | undefined {
  try {
    const p = renderKeyPath(home);
    if (!existsSync(p)) return undefined;
    return statSync(p).mode & 0o777;
  } catch {
    return undefined;
  }
}
