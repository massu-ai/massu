// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Credentials resolver — the SINGLE source of truth for the Massu cloud API
 * key and endpoint (CR-59). Nothing else in the codebase reads
 * `process.env.MASSU_API_KEY`, `process.env.MASSU_CLOUD_ENDPOINT`, or the
 * user-level credentials file directly — they go through this module. That
 * invariant is what makes the "key set but tier still Free" bug class
 * structurally impossible: there is one resolver, one precedence order, one
 * reported source.
 *
 * Precedence (documented, git-safe path recommended):
 *   1. explicit `cloud.apiKey` in massu.config.yaml   (source: 'config')
 *   2. MASSU_API_KEY environment variable             (source: 'env')
 *   3. ~/.massu/credentials user-level file            (source: 'user-file')
 *   4. nothing                                         (source: 'none')  → Free
 *
 * The user-level file lives OUTSIDE every repo (in the home directory), so a
 * customer can set the key ONCE (`massu login`) without committing a secret
 * and without per-repo edits.
 */

import { homedir } from 'os';
import { resolve } from 'path';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
} from 'fs';

// ============================================================
// Constants
// ============================================================

/** The one environment variable that carries the API key. */
export const MASSU_ENV_API_KEY = 'MASSU_API_KEY';

/** Optional env override for the cloud endpoint (self-hosted / enterprise). */
export const MASSU_ENV_CLOUD_ENDPOINT = 'MASSU_CLOUD_ENDPOINT';

/**
 * The default cloud endpoint the client validates keys and syncs against.
 *
 * A dedicated, versioned, BRANDED API host — decoupled from both the
 * marketing site and the underlying implementation, independently scalable
 * and version-able. It is a `massu.ai`-family host with NO Supabase project
 * ref, so it passes the public-content leak-guard by construction
 * (`leak-patterns.sh:72` `[a-z0-9]{20}\.supabase\.co`). The actual key-check
 * function lives behind a host-scoped Vercel rewrite in the PRIVATE
 * `website/vercel.json` (`api.massu.ai/v1/* → <supabase-ref>/functions/v1/*`);
 * the ref never ships in this public package.
 *
 * Overridable per-workspace via `cloud.endpoint` (config) or
 * MASSU_CLOUD_ENDPOINT (env).
 */
export const DEFAULT_CLOUD_ENDPOINT = 'https://api.massu.ai/v1';

/** The `ms_live_` prefix every real Massu API key carries. */
export const API_KEY_PREFIX = 'ms_live_';

// ============================================================
// Types
// ============================================================

/** Where the resolved API key came from. */
export type ApiKeySource = 'config' | 'env' | 'user-file' | 'none';

/** Shape of the ~/.massu/credentials JSON file. */
interface CredentialsFile {
  apiKey?: string;
}

// ============================================================
// User-level credentials file (~/.massu/credentials)
// ============================================================

/** Directory holding user-level Massu state (`~/.massu`). */
export function credentialsDir(home: string = homedir()): string {
  return resolve(home, '.massu');
}

/** Absolute path to the user-level credentials file (`~/.massu/credentials`). */
export function credentialsPath(home: string = homedir()): string {
  return resolve(credentialsDir(home), 'credentials');
}

/**
 * Read the API key from `~/.massu/credentials`. Returns the trimmed key, or
 * `undefined` when the file is missing, unreadable, malformed, or empty.
 * NEVER throws — a broken credentials file must not crash `getConfig()`.
 */
export function readUserCredentials(home: string = homedir()): string | undefined {
  try {
    const p = credentialsPath(home);
    if (!existsSync(p)) return undefined;
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as CredentialsFile;
    const key = typeof parsed?.apiKey === 'string' ? parsed.apiKey.trim() : '';
    return key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write the API key to `~/.massu/credentials` with `0600` permissions (the
 * directory is created `0700`). Returns the absolute path written. Both the
 * directory and file permissions are enforced even when they already exist,
 * so re-running `massu login` never widens permissions.
 */
export function writeUserCredentials(apiKey: string, home: string = homedir()): string {
  const dir = credentialsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's `mode` is ignored when the dir already exists — enforce explicitly.
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort on a pre-existing dir we may not own */
  }
  const p = credentialsPath(home);
  writeFileSync(p, JSON.stringify({ apiKey: apiKey.trim() }, null, 2) + '\n', {
    mode: 0o600,
  });
  // writeFile's `mode` is ignored when the file already exists — enforce.
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best-effort */
  }
  return p;
}

/**
 * Remove `~/.massu/credentials`. Idempotent — returns `true` if a file was
 * removed, `false` if there was nothing to remove.
 */
export function removeUserCredentials(home: string = homedir()): boolean {
  const p = credentialsPath(home);
  if (!existsSync(p)) return false;
  try {
    rmSync(p);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Resolution
// ============================================================

/**
 * A committed `apiKey: ${MASSU_API_KEY}` is NOT interpolated by the YAML
 * loader (there is no `${}` expansion), so the literal string `${...}` would
 * otherwise be treated as a real key. Detect and treat it as absent.
 */
function isUnresolvedLiteral(v: string): boolean {
  return /^\$\{[^}]+\}$/.test(v);
}

/**
 * Resolve the API key + its source using the documented precedence order.
 *
 * @param opts.configApiKey  the `cloud.apiKey` value from massu.config.yaml
 *                           (may be undefined, empty, or an unresolved
 *                           `${VAR}` literal — all treated as "no config key")
 * @param opts.env           environment map (defaults to `process.env`)
 * @param opts.home          home directory (defaults to `os.homedir()`)
 */
export function resolveApiKey(
  opts: { configApiKey?: string; env?: NodeJS.ProcessEnv; home?: string } = {}
): { apiKey?: string; source: ApiKeySource } {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();

  const cfg = typeof opts.configApiKey === 'string' ? opts.configApiKey.trim() : '';
  if (cfg.length > 0 && !isUnresolvedLiteral(cfg)) {
    return { apiKey: cfg, source: 'config' };
  }

  const envRaw = env[MASSU_ENV_API_KEY];
  const envKey = typeof envRaw === 'string' ? envRaw.trim() : '';
  if (envKey.length > 0) {
    return { apiKey: envKey, source: 'env' };
  }

  const fileKey = readUserCredentials(home);
  if (fileKey) {
    return { apiKey: fileKey, source: 'user-file' };
  }

  return { source: 'none' };
}

/**
 * Resolve the cloud endpoint: `cloud.endpoint` (config) > MASSU_CLOUD_ENDPOINT
 * (env) > {@link DEFAULT_CLOUD_ENDPOINT}. Always returns a usable URL, so a
 * key alone (no per-repo endpoint config) can validate against the branded
 * default host.
 */
export function resolveEndpoint(
  opts: { configEndpoint?: string; env?: NodeJS.ProcessEnv } = {}
): string {
  const env = opts.env ?? process.env;
  const cfg = typeof opts.configEndpoint === 'string' ? opts.configEndpoint.trim() : '';
  if (cfg.length > 0) return cfg;
  const envRaw = env[MASSU_ENV_CLOUD_ENDPOINT];
  const envEp = typeof envRaw === 'string' ? envRaw.trim() : '';
  if (envEp.length > 0) return envEp;
  return DEFAULT_CLOUD_ENDPOINT;
}

/** Human-readable label for an API-key source (used by `massu doctor`). */
export function apiKeySourceLabel(source: ApiKeySource): string {
  switch (source) {
    case 'config':
      return 'explicit cloud.apiKey';
    case 'env':
      return 'MASSU_API_KEY env';
    case 'user-file':
      return '~/.massu/credentials';
    case 'none':
    default:
      return 'no source';
  }
}
