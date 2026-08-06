"""G29/CR-92 — the ONE Python definition of "a git call that cannot be redirected".

`git -C <dir>` DOES NOT SCOPE GIT. `GIT_DIR` outranks `-C` exactly as it outranks `cd`
and `cwd=`. It is inherited from any CALLER that sets it — a nested git invocation, a
wrapper, a test harness, a tool. (Git does NOT hand `GIT_DIR` to the hooks it runs;
measured, `scripts/ops/probe-git-hook-env.sh`. Hooks DO inherit `GIT_INDEX_FILE`, which
redirects the index on its own.) `subprocess` inherits `os.environ` by
default, so a call like

    subprocess.run(["git", "-C", root, "ls-files"], ...)

silently answers about the REAL repository instead of `root` whenever anything upstream
set `GIT_DIR`. It does not crash. It returns
a confident, wrong answer, which is strictly worse than failing.

2026-08-04, a sibling repo on this machine: the write-side of this same class produced a
commit removing 5,540 files from tracking. Incident #166.

A MODULE, not an inlined snippet, because a Python `import` fails LOUDLY if the file is
missing — so this cannot silently fail open. (The shell harnesses deliberately inline
their `unset` instead: they run `set -uo pipefail` WITHOUT `-e`, so a failed `source`
would continue silently and leave them unprotected.)
"""
from __future__ import annotations

import os

#: Every git variable that redirects git's notion of "which repository".
#: Deliberately EXCLUDES GIT_AUTHOR_* / GIT_COMMITTER_* — those set commit metadata,
#: not the target repo, and callers legitimately pin them.
GIT_ENV_LEAKS = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_PREFIX",
)


def git_safe_env(extra: dict | None = None) -> dict:
    """A copy of os.environ with every repo-redirecting git variable REMOVED.

    `extra` is applied BEFORE the strip, so a caller cannot reintroduce a leak by accident.
    Pass the result as `env=` to every subprocess that invokes git.
    """
    env = dict(os.environ)
    if extra:
        env.update(extra)
    for key in GIT_ENV_LEAKS:
        env.pop(key, None)
    return env
