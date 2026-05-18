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
 * Composition: this hook imports the pure check functions from
 * `security-gate.ts` (runSecurityGateChecks) and `pre-delete-check.ts`
 * (runPreDeleteChecks). Both source files preserve their standalone
 * `main()` for backward compatibility with operator-installed
 * `.claude/settings.json` files that still reference the old hooks
 * directly; new installs (via `buildHooksConfig`) emit just this one
 * consolidated hook.
 *
 * Stdin: same JSON shape as the individual hooks (Claude Code's
 * PreToolUse payload).
 */

import { runSecurityGateChecks } from './security-gate.ts';
import { runPreDeleteChecks } from './pre-delete-check.ts';
import { writeHookMessage } from './lib/write-hook-message.ts';

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: {
    command?: string;
    file_path?: string;
    content?: string;
    new_string?: string;
  };
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;

    const securityMessages = runSecurityGateChecks(hookInput);
    // NOTE: runPreDeleteChecks' HookInput shape is structurally compatible
    // with the consolidated HookInput here (both extend Claude Code's
    // PreToolUse payload schema).
    const deleteMessages = runPreDeleteChecks(hookInput as Parameters<typeof runPreDeleteChecks>[0]);

    for (const msg of [...securityMessages, ...deleteMessages]) {
      writeHookMessage(msg);
    }
  } catch {
    // Hooks must never crash
  }

  process.exit(0);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // Timeout to prevent hanging
    setTimeout(() => resolve(data), 400);
  });
}

main();
