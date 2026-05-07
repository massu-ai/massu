/**
 * adapters.local postinstall-poisoning fingerprint (Plan 3c gap-32).
 *
 * Threat model: a malicious npm package's `postinstall` script could mutate
 * `massu.config.yaml > adapters.local` to add a path pointing at attacker-
 * controlled code. Local adapters bypass the registry-signed allowlist
 * entirely (operator opt-in per-path), so the only defense is verifying
 * that the operator INTENDED the mutation. The mechanism:
 *
 * 1. Every time the operator runs `massu adapters add-local <path>`,
 *    `massu adapters remove-local <path>`, or `massu adapters resync-local-
 *    fingerprint`, this module writes a sentinel file at
 *    `~/.massu/adapters-local-fingerprint.json` recording:
 *      { fingerprint: <sha256-hex of canonical-stringified sorted array>,
 *        source:      "cli" | "cli-resync",
 *        ts:          ISO8601-string }
 *
 * 2. At loader startup, discoverAdapters compares the CURRENT
 *    massu.config.yaml.adapters.local content's fingerprint against the
 *    sentinel. If they differ, the loader REFUSES to load any local
 *    adapter and emits a stderr warning naming the additions/removals
 *    that diverged from the last operator-acknowledged state.
 *
 * 3. Operators can re-acknowledge the current state by running
 *    `massu adapters resync-local-fingerprint` — which recomputes the
 *    fingerprint over whatever adapters.local currently holds (regardless
 *    of how it got there) and writes the sentinel anew. This is
 *    explicitly a "trust me, I know what I edited" CLI escape hatch.
 *
 * Why a SEPARATE file (not stored inside the cache, not stored in the
 * yaml itself):
 * - In yaml: a postinstall script could update both the entry AND the
 *   fingerprint, defeating detection.
 * - In ~/.massu/adapter-manifest.json (signed cache): the cache wraps
 *   registry data, mixing operator-trust state into it would conflate
 *   two different security domains.
 * - Standalone: the file's path is well-known + stable; CLI-only
 *   writes are the explicit acknowledgment signal.
 *
 * File mode: 0o600 (gap-37 — security-relevant cache files are owner-only).
 *
 * Drift-prevention (CR-46 / Rule 0 self-attest #2): the SAME canonical-
 * fingerprint computation is used at write time AND at check time —
 * `computeLocalFingerprint` is the single source of truth. A future
 * caller that hashes locally-different bytes would silently drift; this
 * module's API makes that impossible by exposing only the high-level
 * write/check primitives, not the raw sha256 step.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite } from './atomic-write.js';

export const FINGERPRINT_PATH = resolve(homedir(), '.massu', 'adapters-local-fingerprint.json');

/**
 * Canonical fingerprint: lowercase sha256 hex of JSON.stringify of the
 * SORTED array. Sorting makes the fingerprint stable regardless of yaml
 * key order. The array is the exact AdapterLocalPathSchema-validated +
 * POSIX-normalized content from getConfig().adapters?.local.
 */
export function computeLocalFingerprint(localPaths: ReadonlyArray<string>): string {
  const sorted = [...localPaths].sort();
  const canonical = JSON.stringify(sorted);
  return createHash('sha256').update(canonical).digest('hex');
}

const FingerprintSentinelSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  source: z.enum(['cli', 'cli-resync']),
  ts: z.string().min(1),
}).strict();
export type FingerprintSentinel = z.infer<typeof FingerprintSentinelSchema>;

/**
 * Read the on-disk sentinel. Returns null when:
 * - file is absent (no operator action has ever been recorded)
 * - file is present but unparseable (treat as absent — caller should
 *   surface a stderr warning about the corrupt sentinel)
 * - file's shape doesn't match the strict schema
 *
 * Caller decides what to do with `null` (typically: refuse all
 * LOCAL-EXPLICIT loading until `massu adapters resync-local-fingerprint`
 * is run).
 */
export function readFingerprintSentinel(path: string = FINGERPRINT_PATH): FingerprintSentinel | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
  const parsed = FingerprintSentinelSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

export type FingerprintWriteResult = { written: true } | { written: false; error: string };

/**
 * Atomically write the sentinel with the given paths' fingerprint + source
 * tag. Mode 0o600; parent dir 0o700. Uses the shared atomicWrite primitive
 * so torn writes are impossible.
 */
export function writeFingerprintSentinel(
  localPaths: ReadonlyArray<string>,
  source: FingerprintSentinel['source'],
  path: string = FINGERPRINT_PATH,
): FingerprintWriteResult {
  const sentinel: FingerprintSentinel = {
    fingerprint: computeLocalFingerprint(localPaths),
    source,
    ts: new Date().toISOString(),
  };
  const result = atomicWrite(path, JSON.stringify(sentinel, null, 2), {
    mode: 0o600,
    ensureParentDirMode: 0o700,
  });
  if (!result.written) {
    return { written: false, error: result.error ?? 'unknown atomicWrite error' };
  }
  return { written: true };
}

export type FingerprintCheckResult =
  | { kind: 'match'; sentinel: FingerprintSentinel }
  | { kind: 'no-sentinel'; reason: string }
  | { kind: 'drift'; sentinel: FingerprintSentinel; currentFingerprint: string; reason: string };

/**
 * Compare the current adapters.local fingerprint to the on-disk sentinel.
 * Caller (typically discoverAdapters) interprets the result:
 *   - 'match'        — proceed to load LOCAL-EXPLICIT adapters
 *   - 'no-sentinel'  — refuse all LOCAL-EXPLICIT; tell operator to run
 *                       `massu adapters resync-local-fingerprint` once
 *   - 'drift'        — refuse all LOCAL-EXPLICIT; surface the additions/
 *                       removals so the operator can audit + ack via
 *                       `massu adapters resync-local-fingerprint`
 *
 * Note: `localPaths` MUST be the AdapterLocalPathSchema-validated +
 * POSIX-normalized content from getConfig() — passing a non-normalized
 * array will produce a fingerprint that doesn't match what the CLI
 * wrote. Drift-prevention from the schema side: AdapterLocalPathSchema
 * runs at config-parse time, so any code path reading
 * cfg.adapters.local always sees the canonical form.
 */
export function checkFingerprintDrift(
  localPaths: ReadonlyArray<string>,
  path: string = FINGERPRINT_PATH,
): FingerprintCheckResult {
  const sentinel = readFingerprintSentinel(path);
  if (!sentinel) {
    return {
      kind: 'no-sentinel',
      reason:
        `no adapters-local-fingerprint sentinel at ${path}. ` +
        `If you have entries in adapters.local, run \`massu adapters resync-local-fingerprint\` ` +
        `to acknowledge them once.`,
    };
  }
  const currentFingerprint = computeLocalFingerprint(localPaths);
  if (currentFingerprint === sentinel.fingerprint) {
    return { kind: 'match', sentinel };
  }
  return {
    kind: 'drift',
    sentinel,
    currentFingerprint,
    reason:
      `adapters.local fingerprint drift: sentinel was ${sentinel.fingerprint.slice(0, 16)}... ` +
      `(written by ${sentinel.source} at ${sentinel.ts}); current is ${currentFingerprint.slice(0, 16)}.... ` +
      `If you edited massu.config.yaml directly OR a postinstall script may have mutated adapters.local, ` +
      `audit the diff and run \`massu adapters resync-local-fingerprint\` to acknowledge.`,
  };
}
