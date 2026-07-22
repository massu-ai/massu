// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * memory-repos-registry.ts — the user-level registry of the operator's shareable
 * repos (Living Memory Slice 5, A-03): `~/.massu/repos.json`, mode 0600.
 *
 * This is the SET of repos the operator has opted into sharing — the same
 * user-level, outside-every-repo home as `~/.massu/credentials` (CR-59) and
 * `~/.massu/advisor-state.json`. It is created LAZILY, on the first share-enable
 * only (mirroring `writeAdvisorState`), and NEVER on a dormant install or a plain
 * read. A repo appears here ONLY by self-registering, and it self-registers ONLY
 * when the human enables sharing in it.
 *
 * There is NO filesystem scan, NO `~/repos` assumption, NO hardcoded machine
 * layout. An absent / unreadable / corrupt registry is treated as EMPTY (dormant)
 * — never a throw. The store and every hook stay fail-open.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

/** Schema version of `repos.json` (bump only on a breaking shape change). */
export const REPOS_REGISTRY_VERSION = 1;

/** One registered repo. `pubkey_fingerprint` is the TOFU-pinned local-share key. */
export interface RepoRegistryEntry {
  repo_id: string;
  /** Display slug (`deriveSlug(project.name)`), `[a-z0-9_]` only. */
  label: string;
  /** Hex sha256 of the machine-local share pubkey trusted for this repo. */
  pubkey_fingerprint: string;
  /** Most-recent absolute path this repo was seen at (diagnostic only). */
  last_seen_path: string;
  /** Whether EXPORT is enabled for this repo (opt-in #1). */
  share_enabled: boolean;
}

/** The whole registry file. */
export interface ReposRegistry {
  version: number;
  repos: RepoRegistryEntry[];
}

/** `~/.massu/repos.json`. */
export function reposRegistryPath(home: string = homedir()): string {
  return join(home, '.massu', 'repos.json');
}

/** A fresh, empty (dormant) registry — the value every fail path returns. */
function emptyRegistry(): ReposRegistry {
  return { version: REPOS_REGISTRY_VERSION, repos: [] };
}

/**
 * Read the registry. Returns an EMPTY dormant registry if the file is absent,
 * unreadable, malformed, or structurally wrong — never throws, NEVER creates the
 * file. Reading is side-effect-free: a dormant install stays dormant.
 */
export function readReposRegistry(home: string = homedir()): ReposRegistry {
  const p = reposRegistryPath(home);
  if (!existsSync(p)) return emptyRegistry();
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyRegistry();
    const r = parsed as Partial<ReposRegistry>;
    if (!Array.isArray(r.repos)) return emptyRegistry();
    // Keep only structurally-valid entries — a corrupt row is dropped, not fatal.
    const repos = r.repos.filter(
      (e): e is RepoRegistryEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as RepoRegistryEntry).repo_id === 'string' &&
        typeof (e as RepoRegistryEntry).label === 'string',
    );
    return { version: typeof r.version === 'number' ? r.version : REPOS_REGISTRY_VERSION, repos };
  } catch {
    return emptyRegistry();
  }
}

/** Look up a registered repo by its `repo_id`, or `null` if not registered. */
export function findRepoById(home: string, repoId: string): RepoRegistryEntry | null {
  return readReposRegistry(home).repos.find((e) => e.repo_id === repoId) ?? null;
}

/** Look up a registered repo by its display label, or `null`. */
export function findRepoByLabel(home: string, label: string): RepoRegistryEntry | null {
  return readReposRegistry(home).repos.find((e) => e.label === label) ?? null;
}

/**
 * Register (or update) a repo, writing `~/.massu/repos.json` LAZILY with mode
 * 0600. Call ONLY from the share-enable path — this is the FIRST filesystem write
 * a repo makes when the operator opts it in. Idempotent by `repo_id` (a second
 * call for the same id replaces that entry, leaving the others untouched).
 */
export function upsertRepoRegistration(entry: RepoRegistryEntry, home: string = homedir()): void {
  const registry = readReposRegistry(home);
  const next = registry.repos.filter((e) => e.repo_id !== entry.repo_id);
  next.push(entry);
  const out: ReposRegistry = { version: REPOS_REGISTRY_VERSION, repos: next };

  const p = reposRegistryPath(home);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(out, null, 2), { mode: 0o600 });
  // mkdir/write modes are umask-masked; a registry naming the operator's repos is
  // 0600, full stop.
  chmodSync(p, 0o600);
}
