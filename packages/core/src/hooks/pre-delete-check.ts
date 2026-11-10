#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// Hook ENTRY for pre-delete-check: stdin in, findings out. The checks live in ./lib/pre-delete-checks.ts, so
// another hook can use them without bundling this file's main() into itself.

import { type HookEvent } from './lib/write-hook-message.ts';
import { runPreToolUseDecision } from './lib/pre-tool-use-decision.ts';
import { isDirectInvocation } from './lib/is-direct-invocation.ts';

const HOOK_EVENT: HookEvent = 'PreToolUse';
export * from './lib/pre-delete-checks.ts';

// Back-compat entry (pre-1.12 settings name it directly). It makes the SAME decision as
// pre-tool-use-gate: a 'block' finding DENIES. Until 2026-11-09 this entry only printed
// "BLOCKED" and exited 0, which Claude Code reads as ALLOW.
async function main(): Promise<void> {
  await runPreToolUseDecision('pre-delete-check', HOOK_EVENT);
}

if (isDirectInvocation(import.meta.url)) {
  main();
}
