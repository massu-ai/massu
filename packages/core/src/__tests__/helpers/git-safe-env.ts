/**
 * G29/CR-92 — the ONE definition of "a child process that cannot address the real repo".
 *
 * `cwd:` scopes a child process no better than `cd` scopes a shell. Git reads `GIT_DIR`
 * from the environment and it OUTRANKS both `cwd:` and `git -C`. It is inherited from any
 * CALLER that sets it — a nested git invocation, a wrapper, a test harness, a tool.
 * (Git does NOT hand `GIT_DIR` to the hooks it runs; measured, `scripts/ops/probe-git-hook-env.sh`.
 * Hooks do inherit `GIT_INDEX_FILE`, which redirects the index by itself — so a sandbox
 * `git add` under a pre-commit hook writes the REAL index with no `GIT_DIR` anywhere.)
 * `execSync` / `execFileSync` / `spawnSync` inherit `process.env` by default, so a test
 * that builds a sandbox repo and runs `git init` / `git add` / `git commit` against it
 * silently addresses the REAL repository instead — staging the sandbox's handful of
 * files into the real index and recording every other tracked file as DELETED.
 *
 * 2026-08-04, a sibling repo on this machine: exactly that produced a commit removing
 * 5,540 files from tracking, and flipped core.bare. Incident #166.
 *
 * This module exists so the strip list has ONE definition. It was previously copied
 * into individual test files; a per-file copy is how one site gets a var added and the
 * others silently do not (CR-74).
 *
 * NOTE the deliberate asymmetry with the shell harnesses, which inline the equivalent
 * `unset` rather than sourcing a shared lib: those run `set -uo pipefail` WITHOUT `-e`,
 * so a failed `source` would continue silently and leave them unprotected while looking
 * identical to a protected script. A TypeScript `import` cannot fail that way.
 */

/**
 * The git environment variables that redirect git's notion of "which repository".
 *
 * Deliberately NOT included: `GIT_AUTHOR_DATE`, `GIT_COMMITTER_DATE`, `GIT_AUTHOR_NAME`
 * and friends. Those set commit METADATA, not the target repository, and tests legitimately
 * pin them for deterministic history. Stripping them would silently break those tests.
 */
export const GIT_ENV_LEAKS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
] as const

/**
 * A copy of `process.env` with every repository-redirecting git variable REMOVED.
 *
 * Unset, never override: a temp sandbox belongs to no repository, and git must see that
 * plainly rather than being pointed somewhere else. `extra` is applied BEFORE the strip,
 * so a caller can add its own vars without being able to reintroduce a leak by accident.
 */
export function gitSafeEnv(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const k of GIT_ENV_LEAKS) delete e[k]
  return e
}
