// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { pathToFileURL } from 'url';

/**
 * True when THIS module is the process entry point — i.e. the file was executed,
 * not imported.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * Every hook in `packages/core/src/hooks/` ends by calling `main()`. Written at
 * module scope with no guard, that means **importing the module RUNS the hook**:
 * it reads stdin (blocking until the stream closes), does its work, and calls
 * `process.exit`. A test that imports one constant from a hook executes it.
 *
 * Measured 2026-08-10: 18 hook entry points, **15 with no guard at all** and 2
 * more guarded by a filename suffix (below). One of them, `auto-learning-pipeline`,
 * was found the hard way — a test importing a single constant ran the hook, and
 * the suite reported `3704 passed` with `exit 1`.
 *
 * WHY NOT `process.argv[1].endsWith('my-hook.js')`
 * ------------------------------------------------
 * That form shipped in `pre-delete-check.ts` and `security-gate.ts`, and it works
 * — until someone renames the file. The filename is then duplicated inside its own
 * module, and a rename leaves a guard keyed on a name nothing produces: the
 * conditional stops matching, `main()` stops running, and NOTHING goes red,
 * because a hook that does not run and a hook that runs and exits 0 are the same
 * observation. It also matches any other entry point that happens to end with the
 * same basename.
 *
 * `import.meta.url` carries no name to drift from. It is the module's own identity,
 * supplied by the runtime.
 *
 * WHY THE ARGUMENT CANNOT BE DEFAULTED
 * ------------------------------------
 * `import.meta.url` is per-module: read inside THIS file it would always be this
 * helper's own path and the answer would always be `false`. Each caller must pass
 * its own. That is irreducible; what is centralised is the LOGIC, so there is one
 * place to get it right and one place to test it.
 *
 * BUNDLING
 * --------
 * The hooks are bundled by esbuild with `format: 'esm'`, one bundle per entry
 * point, so at runtime `import.meta.url` is `…/dist/hooks/<name>.js` — exactly what
 * `process.argv[1]` is when the shim executes it.
 *
 * @param moduleUrl the CALLER's `import.meta.url`. Never omit it.
 */
export function isDirectInvocation(moduleUrl: string): boolean {
  const entry = process.argv[1];
  // Fail CLOSED for a hook: no argv[1] means we are not a script being executed
  // (an embedder, a REPL, a worker). Running the hook there is the harmful
  // direction — it would consume stdin and exit the host process.
  if (!entry) return false;
  try {
    return moduleUrl === pathToFileURL(entry).href;
  } catch {
    // An unresolvable argv[1] is not a match. Same reasoning: refuse to run.
    return false;
  }
}
