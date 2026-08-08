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

import { runSecurityGateFindings } from './security-gate.ts';
import { runPreDeleteChecks } from './pre-delete-check.ts';
import { writeHookContext, type HookEvent } from './lib/write-hook-message.ts';

/** Registered on PreToolUse. Asserted against `.claude/settings.json` by
 *  `hook-context-delivery-drift-guard.test.ts`, so this constant cannot drift
 *  from the event the hook is actually wired to. */
const HOOK_EVENT: HookEvent = 'PreToolUse';
import { readStdinToEof } from './lib/read-stdin.ts';
import { recordHookFailure } from './lib/hook-failure-signal.ts';

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

/** PreToolUse protocol: exit 2 = BLOCK the tool call, stderr is shown to the model. */
const EXIT_DENY = 2;
const EXIT_ALLOW = 0;

/**
 * S-3: FAIL CLOSED.
 *
 * This is the one hook that must NOT use `runHookSafely`. Every other hook swallows
 * its errors and exits 0, because a Massu bug must not block the user's session.
 * For a SECURITY gate, that reasoning inverts: exit 0 is not "no opinion", it is
 * "ALLOW". A gate that cannot evaluate a command has not approved it — and a command
 * the gate never managed to READ is an UNKNOWN command, not a safe one.
 *
 * So: any failure to read, parse, or evaluate the payload denies the call, loudly,
 * with a reason the human can act on.
 */
function deny(reason: string, detail?: string): never {
  process.stderr.write(
    `MASSU SECURITY GATE — BLOCKED\n\n${reason}\n` +
      (detail ? `\n${detail}\n` : '') +
      `\nThe gate denies by default when it cannot verify a command is safe.\n`,
  );
  process.exit(EXIT_DENY);
}

async function main(): Promise<void> {
  let hookInput: HookInput;

  // ---- Phase 1: READ + PARSE. Any failure here is fatal and denies. ----
  try {
    const input = await readStdinToEof();
    if (!input.trim()) {
      // Empty stdin is not "nothing to check" — it means the payload never arrived.
      recordHookFailure('pre-tool-use-gate', new Error('empty stdin payload'));
      deny(
        'The gate received an EMPTY payload and could not determine what tool call was requested.',
      );
    }
    hookInput = JSON.parse(input) as HookInput;
  } catch (err) {
    // Was: `catch {}` → exit 0 → ALLOW. A truncated payload (the old 400ms partial
    // read) silently permitted whatever it was that took too long to arrive.
    recordHookFailure('pre-tool-use-gate', err, { phase: 'read-parse' });
    deny(
      'The gate could not READ or PARSE the tool-call payload, so it cannot know what it was being asked to approve.',
      err instanceof Error ? `Cause: ${err.message}` : undefined,
    );
  }

  // ---- Phase 2: EVALUATE. A check that throws has not passed. ----
  let findings;
  try {
    const security = runSecurityGateFindings(hookInput);
    // NOTE: runPreDeleteChecks' HookInput shape is structurally compatible
    // with the consolidated HookInput here (both extend Claude Code's
    // PreToolUse payload schema).
    const deletes = runPreDeleteChecks(
      hookInput as Parameters<typeof runPreDeleteChecks>[0],
    ).map((message) => ({ severity: 'warn' as const, message }));
    findings = [...security, ...deletes];
  } catch (err) {
    recordHookFailure('pre-tool-use-gate', err, { phase: 'evaluate' });
    deny(
      'A security check CRASHED while evaluating this tool call. A check that did not run has not passed.',
      err instanceof Error ? `Cause: ${err.message}` : undefined,
    );
  }

  // ---- Phase 3: DECIDE. ----
  const blocking = findings.filter((f) => f.severity === 'block');

  // Advisory findings still surface to the user, exactly as before.
  for (const f of findings.filter((x) => x.severity === 'warn')) {
    writeHookContext(HOOK_EVENT, f.message);
  }

  if (blocking.length > 0) {
    // Previously: this printed "Review carefully before proceeding" and exited 0.
    // The command then ran. Verified 2026-07-13: `curl … | bash` was ALLOWED.
    deny(blocking.map((f) => f.message).join('\n\n'));
  }

  process.exit(EXIT_ALLOW);
}

main();
