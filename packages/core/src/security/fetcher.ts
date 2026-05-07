/**
 * HTTPS fetch helper with strict host allowlist + bounded timeout.
 *
 * Plan 3c Phase 5 deliverable (gap-3 / Phase 5 deps line 114). The Phase 5
 * adapter-verifier is the only consumer; fetching from arbitrary URLs is
 * forbidden. Allowlist:
 *   - registry.massu.ai (manifest fetch)
 *   - telemetry.massu.ai (adapter-discovery telemetry)
 *
 * Why an allowlist: an unrestricted fetch primitive in @massu/core would
 * be a supply-chain liability — a future bug or compromised adapter could
 * exfiltrate data to attacker-controlled hosts. The allowlist lives in
 * THIS module's source code (single source of truth), not in
 * massu.config.yaml — operators cannot widen it without auditing this
 * file.
 *
 * Why this module instead of a third-party http lib: Node 18+ has a built-in
 * fetch (per Plan 3c gap-3 audit-fact line 46 — "no deps for `node-fetch`").
 * This module wraps it with the allowlist + timeout + JSON parsing in a
 * single typed surface. The verifier doesn't need redirects, retry, or
 * streaming — those features are attack surface we don't want.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * CR-9 audit H3 fix: hard cap on response body size. Without this, a
 * compromised CDN (or TLS-MITM) could serve a multi-GB body that exceeds
 * available heap before the timeout fires. The manifest is on the order
 * of KB; even with 1000 adapter entries it should fit comfortably under
 * 1 MB. The 10 MB ceiling here is generous enough to never affect
 * legitimate manifests AND tight enough to bound damage from a malicious
 * upstream.
 */
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Allowlist of hosts the fetcher will GET from. Exported for unit testing
 * but intentionally read-only (`as const`) — runtime mutation is impossible.
 * To widen the allowlist for a new use case, edit this constant in source
 * and ship a `@massu/core` minor release.
 */
export const ALLOWED_HOSTS = [
  'registry.massu.ai',
  'telemetry.massu.ai',
] as const;

export interface FetchUrlOptions {
  /** Maximum time the request may take, in milliseconds. Defaults to 10s. */
  timeoutMs?: number;
  /**
   * Override the allowlist for tests. Production code MUST NOT pass this —
   * the default ALLOWED_HOSTS is the production contract. Test-only.
   */
  allowedHosts?: readonly string[];
  /**
   * Override the response body size cap (test-only). Defaults to 10 MB.
   * CR-9 audit H3 fix: bounds OOM exposure from a malicious upstream.
   */
  maxBodyBytes?: number;
}

export interface FetchUrlResult {
  status: number;
  /** Response body as UTF-8 string. */
  body: string;
}

export class FetchAllowlistError extends Error {
  constructor(public readonly url: string, public readonly host: string) {
    super(
      `Refusing to fetch ${url}: host '${host}' is not in the @massu/core ` +
      `fetcher allowlist. Allowed hosts: ${ALLOWED_HOSTS.join(', ')}. ` +
      `Widening the allowlist requires editing packages/core/src/security/fetcher.ts ` +
      `at the source level.`,
    );
    this.name = 'FetchAllowlistError';
  }
}

export class FetchTimeoutError extends Error {
  constructor(public readonly url: string, public readonly timeoutMs: number) {
    super(`Fetch of ${url} timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
  }
}

export class FetchBodySizeError extends Error {
  constructor(public readonly url: string, public readonly maxBodyBytes: number) {
    super(
      `Fetch of ${url} exceeded body size cap of ${maxBodyBytes} bytes. ` +
      `This indicates either a malicious upstream OR an unexpectedly large ` +
      `legitimate response. Refusing to load.`,
    );
    this.name = 'FetchBodySizeError';
  }
}

/**
 * GET an HTTPS URL with allowlist enforcement + timeout. Returns the response
 * body as a string (caller is responsible for JSON.parse + schema validation).
 *
 * Throws:
 * - FetchAllowlistError if the URL's host is not in ALLOWED_HOSTS (or the
 *   test override). Includes the host name in the error so operators can
 *   debug misconfigurations.
 * - FetchTimeoutError if the request exceeds the timeout.
 * - TypeError if the URL does not parse as a valid URL.
 * - Error (with .cause set to the underlying network error) for other failures.
 */
export async function fetchUrl(url: string, opts: FetchUrlOptions = {}): Promise<FetchUrlResult> {
  const allowedHosts = opts.allowedHosts ?? ALLOWED_HOSTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new TypeError(`fetchUrl: invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new FetchAllowlistError(url, parsed.host);
  }

  if (!allowedHosts.includes(parsed.host as (typeof ALLOWED_HOSTS)[number])) {
    throw new FetchAllowlistError(url, parsed.host);
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'error', // refuse redirects — would defeat the allowlist
    });

    // CR-9 audit H3 fix: stream the body with a hard byte cap. Without this,
    // a malicious upstream could OOM the host with a multi-GB response
    // before the wall-clock timeout fires. content-length header check is
    // a fast pre-filter; the streaming reader is the actual enforcement.
    // Headers can be absent in test mocks; treat missing as "no pre-filter".
    if (response.headers && typeof response.headers.get === 'function') {
      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader !== null && contentLengthHeader !== undefined) {
        const declared = Number.parseInt(contentLengthHeader, 10);
        if (Number.isFinite(declared) && declared > maxBodyBytes) {
          throw new FetchBodySizeError(url, maxBodyBytes);
        }
      }
    }

    const body = response.body;
    if (body && typeof body.getReader === 'function') {
      // Streaming path: bound the read by maxBodyBytes. Used in production
      // (Node 18+ fetch returns a ReadableStream).
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          if (received > maxBodyBytes) {
            try { await reader.cancel(); } catch { /* best effort */ }
            throw new FetchBodySizeError(url, maxBodyBytes);
          }
          chunks.push(value);
        }
      }
      const merged = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { status: response.status, body: new TextDecoder().decode(merged) };
    }

    // Fallback when response.body is not a ReadableStream (e.g. test
    // mocks that only stub `text()`). The size cap is still enforced
    // post-read because the text length is the byte length for ASCII +
    // a strict upper bound for UTF-8 content.
    const text = await response.text();
    if (text.length > maxBodyBytes) {
      throw new FetchBodySizeError(url, maxBodyBytes);
    }
    return { status: response.status, body: text };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new FetchTimeoutError(url, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
