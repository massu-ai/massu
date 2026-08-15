// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * G29/CR-92 — the ONE definition of "a child process that cannot address the real repo".
 *
 * `cwd:` scopes a child process no better than `cd` scopes a shell. Git reads `GIT_DIR`
 * from the environment and it OUTRANKS both `cwd:` and `git -C`, and it is inherited from
 * any caller that sets it. `execFileSync` / `spawnSync` inherit the ambient environment by
 * default, so a command that means "look at THIS directory" can silently address another
 * repository while every other signal still looks right.
 *
 * This list previously lived only under the test tree. Production code that shells out to
 * git needs exactly the same strip, and a second copy is how one site gets a variable added
 * and the others silently do not — so the definition lives HERE and the test helper
 * re-exports it.
 */

/**
 * The git environment variables that redirect git's notion of "which repository".
 *
 * Deliberately NOT included: `GIT_AUTHOR_DATE`, `GIT_COMMITTER_DATE`, `GIT_AUTHOR_NAME` and
 * friends. Those set commit METADATA, not the target repository, and callers legitimately
 * pin them for deterministic history.
 */
export const GIT_ENV_LEAKS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
] as const;

/**
 * A copy of the ambient environment with every repository-redirecting git variable REMOVED.
 *
 * Unset, never override: a directory named by `cwd` belongs to whatever repository contains
 * it, and git must see that plainly rather than being pointed somewhere else. `extra` is
 * applied BEFORE the strip, so a caller cannot reintroduce a leak by accident.
 */
export function gitSafeEnv(
  extra: Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...source, ...extra };
  for (const k of GIT_ENV_LEAKS) delete e[k];
  return e;
}
