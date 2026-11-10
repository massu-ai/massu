// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * The ONE PreToolUse decision: read the payload, run every check, and DECIDE by exit code.
 *
 * Every PreToolUse entry (`pre-tool-use-gate`, and the back-compat `security-gate` and
 * `pre-delete-check` that pre-1.12 settings files still name) calls this, so no entry can
 * exist that detects a 'block' finding and still allows the call.
 *
 * 2026-11-09: the back-compat entries were advisory. They printed "BLOCKED" as context and
 * exited 0, which Claude Code reads as ALLOW. Inside a bundle the security-gate module's own
 * main() ran first and made the consolidated gate advisory too, so 2.5.2..2.5.5 denied
 * nothing. A decision that lives in one entry's main() is a decision each other entry can
 * skip; living here, every entry makes it.
 *
 * S-3: FAIL CLOSED. Exit 0 is not "no opinion", it is ALLOW. A payload the gate could not
 * read, parse or evaluate is an UNKNOWN call, not a safe one, so every such failure denies,
 * loudly, with a reason the human can act on.
 */

import { runSecurityGateFindings, type HookInput } from './security-gate-checks.ts';
import { runPreDeleteChecks } from './pre-delete-checks.ts';
import { writeHookContext, type HookEvent } from './write-hook-message.ts';
import { readStdinToEof } from './read-stdin.ts';
import { recordHookFailure } from './hook-failure-signal.ts';

/** PreToolUse protocol: exit 2 = BLOCK the tool call, stderr is shown to the model. */
export const EXIT_DENY = 2;
export const EXIT_ALLOW = 0;

function deny(reason: string, detail?: string): never {
  process.stderr.write(
    `MASSU SECURITY GATE — BLOCKED\n\n${reason}\n` +
      (detail ? `\n${detail}\n` : '') +
      `\nThe gate denies by default when it cannot verify a command is safe.\n`,
  );
  process.exit(EXIT_DENY);
}

/** Run the gate for the entry named `hookName` (used only to label failure records). */
export async function runPreToolUseDecision(hookName: string, event: HookEvent): Promise<never> {
  let hookInput: HookInput;

  // ---- Phase 1: READ + PARSE. Any failure here is fatal and denies. ----
  // `input` lives outside the try so a parse failure can record HOW MUCH arrived. Reported
  // 2026-11-09 (eko, 2.5.3, under heavy load): two ~170-char Bash calls denied with
  // "Unexpected end of JSON input" and an identical retry passed; the byte count and the
  // final character separate "cut short" from "malformed". Never the content: a tool call's
  // command can carry secrets.
  let input = '';
  try {
    input = await readStdinToEof();
    if (!input.trim()) {
      // Empty stdin is not "nothing to check" — it means the payload never arrived.
      recordHookFailure(hookName, new Error('empty stdin payload'));
      deny('The gate received an EMPTY payload and could not determine what tool call was requested.');
    }
    hookInput = JSON.parse(input) as HookInput;
  } catch (err) {
    recordHookFailure(hookName, err, {
      phase: 'read-parse',
      bytesRead: input.length,
      endsWithBrace: input.trimEnd().endsWith('}'),
    });
    deny(
      'The gate could not READ or PARSE the tool-call payload, so it cannot know what it was being asked to approve.',
      err instanceof Error ? `Cause: ${err.message}` : undefined,
    );
  }

  // ---- Phase 2: EVALUATE. A check that throws has not passed. ----
  let findings;
  try {
    const security = runSecurityGateFindings(hookInput);
    const deletes = runPreDeleteChecks(hookInput as Parameters<typeof runPreDeleteChecks>[0]).map(
      (message) => ({ severity: 'warn' as const, message }),
    );
    findings = [...security, ...deletes];
  } catch (err) {
    recordHookFailure(hookName, err, { phase: 'evaluate' });
    deny(
      'A security check CRASHED while evaluating this tool call. A check that did not run has not passed.',
      err instanceof Error ? `Cause: ${err.message}` : undefined,
    );
  }

  // ---- Phase 3: DECIDE. ----
  for (const f of findings.filter((x) => x.severity === 'warn')) {
    writeHookContext(event, f.message);
  }
  const blocking = findings.filter((f) => f.severity === 'block');
  if (blocking.length > 0) deny(blocking.map((f) => f.message).join('\n\n'));

  process.exit(EXIT_ALLOW);
}
