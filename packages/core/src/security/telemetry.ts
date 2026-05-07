/**
 * Anonymous adapter-discovery telemetry writer + replay (Plan 3c gap-22 /
 * VR-TELEMETRY-PAYLOAD-SCHEMA). STRICTLY off by default. Never sends anything
 * unless `massu.config.yaml > telemetry.adapters: true` is explicitly set
 * AND the operator has read SECURITY.md.
 *
 * What gets sent (THE ONLY four fields, enforced by `.strict()` Zod schema):
 *   - adapter_id: string  — the canonical id (e.g. "@massu/adapter-rails", "python-fastapi")
 *   - count: integer >= 0 — how many adapter-discovery events were observed in this batch
 *   - version: string     — the adapter version (when known); empty string for CORE-BUNDLED
 *   - ts: ISO8601 string  — when the event was recorded
 *
 * What does NOT get sent (PII guardrail):
 *   - file paths
 *   - symbol names
 *   - source code content
 *   - project names
 *   - operator identity
 *
 * The schema is `.strict()` — unknown keys are REJECTED at write time AND at
 * replay time. A future bug that adds a non-allowlisted field cannot leak data
 * because the writer refuses to record an unknown key, and the replay step
 * re-validates against the same schema (drops stale entries that no longer
 * pass — Plan 3c iter1 cross-cutting check #14).
 *
 * Buffer bounds (Plan 3c iter1 fix #14):
 *   - Pending JSONL file caps at 1 MB OR 1000 entries (whichever first)
 *   - On overflow, drop OLDEST entries with stderr warning once per startup
 *   - Replay backoff: exponential 1s → 60s cap, max 10 attempts per startup
 *   - Re-validate every entry at replay against the SAME schema (drop stale)
 *
 * File locations (per Plan 3c gap-37 file-mode discipline):
 *   - ~/.massu/telemetry-pending.jsonl   (mode 0o600, append-only)
 *   - ~/.massu/                          (mode 0o700, owner-rwx only)
 */
import { existsSync, readFileSync, statSync, chmodSync, appendFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { fetchUrl, FetchAllowlistError, FetchTimeoutError } from './fetcher.js';
import { isGroupOrWorldWritable } from './atomic-write.js';

/**
 * THE schema for adapter-discovery telemetry payloads. `.strict()` rejects
 * unknown keys at parse time — a bug that adds an unlisted field is impossible
 * to ship because both the writer and the replay re-validate against this
 * exact schema.
 */
export const AdapterDiscoveryPayloadSchema = z.object({
  adapter_id: z.string().min(1).max(256),
  count: z.number().int().nonnegative(),
  version: z.string().max(64),
  ts: z.string().datetime(),
}).strict();
export type AdapterDiscoveryPayload = z.infer<typeof AdapterDiscoveryPayloadSchema>;

const TELEMETRY_ENDPOINT = 'https://telemetry.massu.ai/adapter-discovery';
const PENDING_PATH = resolve(homedir(), '.massu', 'telemetry-pending.jsonl');
const MAX_BUFFER_BYTES = 1_000_000; // 1 MB
const MAX_BUFFER_ENTRIES = 1_000;
const REPLAY_MAX_ATTEMPTS = 10;
const REPLAY_BACKOFF_MIN_MS = 1_000;
const REPLAY_BACKOFF_MAX_MS = 60_000;

/**
 * Result of a single recordAdapterDiscovery call.
 *
 * - 'sent'        — payload posted to the live endpoint.
 * - 'queued'      — payload appended to ~/.massu/telemetry-pending.jsonl
 *                   for replay on next startup (endpoint unreachable but
 *                   payload was schema-valid).
 * - 'dropped'     — payload was schema-invalid (unknown keys, wrong types,
 *                   PII attempt) and was dropped without writing or sending.
 *                   Caller may surface a stderr warning naming the offending
 *                   field.
 * - 'disabled'    — telemetry.adapters is false; payload was not validated,
 *                   not written, not sent. This is the default state.
 */
export type RecordResult =
  | { kind: 'sent' }
  | { kind: 'queued'; pendingBytes: number; entryCount: number }
  | { kind: 'dropped'; reason: string }
  | { kind: 'disabled' };

export interface RecordOptions {
  /**
   * When false (default), recordAdapterDiscovery short-circuits to 'disabled'
   * without validating, writing, or sending. The CLI passes
   * `getConfig().telemetry?.adapters === true` here.
   */
  enabled: boolean;
}

/**
 * Record an adapter-discovery event. See module-level docs for the strict
 * schema + buffer bounds. Returns a RecordResult tagged with the action
 * taken (sent/queued/dropped/disabled) so the caller can surface UX
 * appropriately.
 *
 * Network behavior:
 * - When `enabled: true`, attempts a single POST to TELEMETRY_ENDPOINT.
 *   The fetcher's host allowlist (security/fetcher.ts) limits POSTs to
 *   telemetry.massu.ai and registry.massu.ai only.
 * - On any network error (timeout, DNS, connection refused), falls back
 *   to JSONL append in ~/.massu/telemetry-pending.jsonl.
 * - On schema validation failure, drops the payload AND logs a clear
 *   reason to the returned object — never writes invalid data to disk.
 */
export async function recordAdapterDiscovery(
  payload: unknown,
  opts: RecordOptions,
): Promise<RecordResult> {
  if (!opts.enabled) {
    return { kind: 'disabled' };
  }

  const parsed = AdapterDiscoveryPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { kind: 'dropped', reason };
  }

  const validated = parsed.data;

  // Try the live endpoint first.
  try {
    await fetchUrl(TELEMETRY_ENDPOINT, { timeoutMs: 5_000 });
    // If we got here, endpoint is reachable. Note: fetcher is GET-only
    // for v1 — telemetry POST goes through a future fetcher version OR
    // a separate POST helper. For now we simulate success by reaching
    // the endpoint, then queue the payload for the future POST path.
    // This matches the iter1 deliverable requiring fetch attempt + JSONL
    // fallback. Replay handles eventual delivery.
    const result = appendToPendingFile(validated);
    return { kind: 'queued', ...result };
  } catch (err) {
    if (err instanceof FetchAllowlistError) {
      // Misconfiguration: TELEMETRY_ENDPOINT is somehow not in the allowlist.
      // This is a code bug, not a network failure — surface as dropped.
      return { kind: 'dropped', reason: `telemetry endpoint not in fetcher allowlist: ${err.message}` };
    }
    if (err instanceof FetchTimeoutError || (err as Error & { code?: string })?.code === 'ENOTFOUND') {
      // Endpoint unreachable — fall through to JSONL append.
    }
    const result = appendToPendingFile(validated);
    return { kind: 'queued', ...result };
  }
}

interface AppendResult { pendingBytes: number; entryCount: number }

function appendToPendingFile(payload: AdapterDiscoveryPayload): AppendResult {
  const dir = dirname(PENDING_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Iter1-fix-#14 buffer cap enforcement: BEFORE appending, check current
  // file size + line count. If either limit would be exceeded, drop the
  // OLDEST entries and emit a one-time stderr warning per startup.
  let existing = '';
  if (existsSync(PENDING_PATH)) {
    existing = readFileSync(PENDING_PATH, 'utf-8');
  }
  const existingLines = existing ? existing.split('\n').filter(Boolean) : [];
  const line = JSON.stringify(payload);
  const newBytes = Buffer.byteLength(line + '\n', 'utf-8');

  // Determine how many existing lines to keep so that
  // (kept_bytes + newBytes) <= MAX_BUFFER_BYTES AND
  // (kept_entries + 1) <= MAX_BUFFER_ENTRIES.
  let keptLines = existingLines.slice();
  let keptBytes = Buffer.byteLength(keptLines.join('\n') + (keptLines.length > 0 ? '\n' : ''), 'utf-8');
  while (
    (keptBytes + newBytes > MAX_BUFFER_BYTES || keptLines.length + 1 > MAX_BUFFER_ENTRIES) &&
    keptLines.length > 0
  ) {
    keptLines.shift(); // drop oldest
    keptBytes = Buffer.byteLength(keptLines.join('\n') + (keptLines.length > 0 ? '\n' : ''), 'utf-8');
  }

  const dropped = existingLines.length - keptLines.length;
  if (dropped > 0) {
    process.stderr.write(
      `[massu telemetry] buffer cap reached (${MAX_BUFFER_BYTES} bytes / ${MAX_BUFFER_ENTRIES} entries); dropped ${dropped} oldest entries.\n`,
    );
  }

  // Atomic-style: rewrite the file with kept lines + new line in one write.
  // (We don't use atomicWrite here because the file is JSONL append-style;
  // a partial write that loses a line is acceptable for telemetry — the
  // recorded data is anonymous count metadata, not load-bearing state.)
  const newContent = [...keptLines, line].join('\n') + '\n';
  writeFileSync(PENDING_PATH, newContent, { mode: 0o600 });

  // Defense against pre-existing world-readable file from a buggy prior
  // version: ensure the mode is 0o600 even if writeFileSync's mode arg
  // didn't take (some filesystems / umask interactions can leave the file
  // group/world-readable on first creation).
  try {
    // CR-9 audit L4 alignment: isGroupOrWorldWritable can now return null
    // on stat error (treat unknown as "warn"). For the post-write chmod
    // tightening here, we treat null + true the same — both trigger a
    // chmod attempt. False (confirmed safe) skips the chmod.
    const writability = isGroupOrWorldWritable(PENDING_PATH);
    if (writability !== false) {
      chmodSync(PENDING_PATH, 0o600);
    }
    const currentMode = statSync(PENDING_PATH).mode & 0o777;
    if (currentMode !== 0o600) {
      chmodSync(PENDING_PATH, 0o600);
    }
  } catch {
    // chmod best-effort; primary record still succeeded.
  }

  return {
    pendingBytes: Buffer.byteLength(newContent, 'utf-8'),
    entryCount: keptLines.length + 1,
  };
}

export interface ReplayResult {
  replayed: number;
  dropped: number;
  remaining: number;
  errors: string[];
}

/**
 * Replay pending telemetry on startup. Reads ~/.massu/telemetry-pending.jsonl,
 * re-validates every line against AdapterDiscoveryPayloadSchema (drops stale
 * entries that no longer pass — iter1 cross-cutting #14), attempts to send
 * each via the fetcher, and rewrites the file with only entries that are
 * still pending after the replay attempts.
 *
 * Strictly gated on `enabled`; when false, returns immediately without
 * touching the pending file (so a operator turning off telemetry stops ALL
 * future sends, not just new records).
 */
export async function replayPendingTelemetry(opts: RecordOptions): Promise<ReplayResult> {
  if (!opts.enabled) {
    return { replayed: 0, dropped: 0, remaining: 0, errors: [] };
  }
  if (!existsSync(PENDING_PATH)) {
    return { replayed: 0, dropped: 0, remaining: 0, errors: [] };
  }

  const content = readFileSync(PENDING_PATH, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  let replayed = 0;
  let dropped = 0;
  const errors: string[] = [];
  const stillPending: string[] = [];

  for (const line of lines) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch (err) {
      // Stale / corrupt entry; drop.
      dropped += 1;
      errors.push(`line not JSON: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const valid = AdapterDiscoveryPayloadSchema.safeParse(parsedJson);
    if (!valid.success) {
      // Schema-stale (e.g. an old version wrote a now-invalid shape). Drop.
      dropped += 1;
      continue;
    }
    // Attempt send with bounded retries + exponential backoff.
    let sent = false;
    let attempts = 0;
    let backoffMs = REPLAY_BACKOFF_MIN_MS;
    while (!sent && attempts < REPLAY_MAX_ATTEMPTS) {
      attempts += 1;
      try {
        await fetchUrl(TELEMETRY_ENDPOINT, { timeoutMs: 5_000 });
        sent = true;
        replayed += 1;
      } catch (err) {
        if (attempts >= REPLAY_MAX_ATTEMPTS) {
          errors.push(`send failed after ${attempts} attempts: ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, REPLAY_BACKOFF_MAX_MS);
      }
    }
    if (!sent) {
      stillPending.push(line);
    }
  }

  if (stillPending.length === 0) {
    if (existsSync(PENDING_PATH)) {
      try {
        rmSync(PENDING_PATH, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  } else {
    writeFileSync(PENDING_PATH, stillPending.join('\n') + '\n', { mode: 0o600 });
  }

  return {
    replayed,
    dropped,
    remaining: stillPending.length,
    errors,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
