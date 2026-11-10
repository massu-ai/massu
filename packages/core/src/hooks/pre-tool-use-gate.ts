#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PreToolUse Hook: Consolidated Gate
 *
 * P-E-019 (plan-stage-e-low-info-sweep, wave1-hooks:F-HOOK-012) — replaces
 * the previous two-spawn chain (security-gate + pre-delete-check + jq
 * postproc) with a single hook that runs BOTH check pipelines in one
 * node process. Eliminates ~200ms of per-tool-call latency from
 * cold-start spawn overhead.
 *
 * Composition: the read / evaluate / DECIDE flow lives in
 * `lib/pre-tool-use-decision.ts`. The back-compat `security-gate` and
 * `pre-delete-check` entries (still named by pre-1.12 settings files) call
 * the same function, so every PreToolUse entry denies a 'block' finding;
 * new installs (via `buildHooksConfig`) emit just this one hook.
 *
 * Stdin: same JSON shape as the individual hooks (Claude Code's
 * PreToolUse payload).
 */

import { runPreToolUseDecision } from './lib/pre-tool-use-decision.ts';
import { type HookEvent } from './lib/write-hook-message.ts';
import { isDirectInvocation } from './lib/is-direct-invocation.ts';

/** Registered on PreToolUse. Asserted against `.claude/settings.json` by
 *  `hook-context-delivery-drift-guard.test.ts`, so this constant cannot drift
 *  from the event the hook is actually wired to. */
const HOOK_EVENT: HookEvent = 'PreToolUse';

/** Read, evaluate and DECIDE: the shared decision in ./lib/pre-tool-use-decision.ts. */
async function main(): Promise<void> {
  await runPreToolUseDecision('pre-tool-use-gate', HOOK_EVENT);
}

// Run main() only when this file IS the process entry point. Written bare,
// `main()` at module scope means IMPORTING this module RUNS the hook: it reads
// stdin, does its work, and exits the host process.
if (isDirectInvocation(import.meta.url)) {
  main();
}
