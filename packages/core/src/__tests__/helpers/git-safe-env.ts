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
/**
 * RE-EXPORT ONLY. The list and the strip now live in `src/hooks/lib/git-safe-env.ts` so
 * production code that shells out to git shares this exact definition rather than carrying
 * a second copy — which is the drift this module was created to prevent in the first place.
 */
export { GIT_ENV_LEAKS, gitSafeEnv } from '../../hooks/lib/git-safe-env.ts'
