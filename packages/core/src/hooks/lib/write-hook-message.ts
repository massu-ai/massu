// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * The ONE place a hook emits text intended to reach Claude's context.
 *
 * WHY THIS FILE WAS REWRITTEN 2026-08-08 — read before "simplifying" it back.
 * --------------------------------------------------------------------------
 * It used to be nine lines emitting `{"message": …}`, with a docstring asserting
 * "the message is rendered to the user as advisory text". That was an unprobed
 * capability claim and it was FALSE. Measured across two repos:
 *
 *     UserPromptSubmit + plain text       ARRIVES
 *     UserPromptSubmit + {"message": …}   does NOT
 *     PreToolUse       + plain text       does NOT
 *
 * The authoritative spec (https://code.claude.com/docs/en/hooks, read 2026-08-08)
 * explains all three exactly:
 *
 *   "For most events, stdout is written to the debug log but not shown in the
 *    transcript. The exceptions are UserPromptSubmit, UserPromptExpansion, and
 *    SessionStart, where stdout is added as context that Claude can see and act on."
 *
 * `message` IS NOT A DOCUMENTED OUTPUT FIELD AT ALL. The output schema carries
 * `additionalContext`, `systemMessage`, `terminalSequence`, `decision`,
 * `permissionDecision`, `updatedInput`; `message` appears only in Notification and
 * FileChanged INPUT. And the failure was self-inflicted in an exact way: because
 * `{"message": …}` is VALID JSON, UserPromptSubmit parsed it as JSON instead of
 * treating it as plain text — so the one event that would have delivered it as
 * stdout is precisely the event that discarded it.
 *
 * THE EVENT NAME IS PART OF THE PAYLOAD (`hookEventName` is required), so a helper
 * that does not know which event it serves CANNOT produce a valid payload. That is
 * why this takes the event as a required argument rather than being a drop-in
 * replacement, and why the old one-argument form is DELETED rather than deprecated:
 * a regression to the silent shape is now a COMPILE error, not a silent no-op.
 *
 * NOT COVERED HERE, deliberately: `session-start.ts` writes plain text straight to
 * stdout and it WORKS (the spec permits it for SessionStart). It is the control
 * that proved the diagnosis, and it is left alone. A consistency sweep toward the
 * uniform branch is what created this defect in the first place — P-M-004 unified
 * 7 plain / 3 JSON toward the silent one.
 */

/**
 * Events this package registers hooks on, plus the two other context-injecting
 * events the spec names. CLOSED vocabulary: a value outside it is an ERROR, never
 * a silently-accepted unknown — that is how this class recurs.
 */
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'PreCompact',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Hard cap from the spec: beyond this, `additionalContext` / `systemMessage` /
 * plain stdout are written to a file and REPLACED with a preview plus a path.
 *
 * We truncate ourselves rather than let that happen, because a preview chosen by
 * the runtime is not the part we would have chosen — and recall output grows with
 * the corpus, so this WILL be reached eventually. CR-68: the constant is asserted
 * by a test, not assumed.
 */
export const ADDITIONAL_CONTEXT_MAX_CHARS = 10_000;

/** Runtime guard for the JS boundary; TypeScript callers are checked by the union. */
export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value);
}

/*
 * A `hookEventFrom(payload)` reader was drafted here — Claude Code does supply
 * `hook_event_name` on stdin, which would make the RUNTIME the source of truth.
 * It was REMOVED before shipping: only 2 of the 11 callers parse that field, so it
 * would have created a second pattern used by a minority while the other nine used
 * a constant, and it would have shipped with effectively zero callers (CR-71).
 *
 * Each hook declares its own event instead, and `hook-context-delivery-drift-guard`
 * derives the truth from `.claude/settings.json` and fails if a declaration and its
 * registration disagree. ONE enforcement path, covering all of them uniformly.
 */

/**
 * Emit `message` so it reaches Claude's context at `hookEventName`.
 *
 * Shape per the spec:
 *   { "hookSpecificOutput": { "hookEventName": "<event>", "additionalContext": "…" } }
 *
 * FAILS CLOSED AND LOUD, never silently: an unrecognised event emits NOTHING on
 * stdout (a malformed payload is worse than none) and says why on stderr. It never
 * throws — three of its callers are PreToolUse safety hooks whose blocking must not
 * be disturbed by an advisory path.
 */
export function writeHookContext(hookEventName: HookEvent, message: string): void {
  if (!isHookEvent(hookEventName)) {
    process.stderr.write(
      `[massu] writeHookContext: refusing to emit — unrecognised hook event ` +
        `${JSON.stringify(hookEventName)}. Known: ${HOOK_EVENTS.join(', ')}.\n`,
    );
    return;
  }
  if (typeof message !== 'string' || message.length === 0) return;

  let additionalContext = message;
  if (additionalContext.length > ADDITIONAL_CONTEXT_MAX_CHARS) {
    const marker = `\n[massu] …truncated at ${ADDITIONAL_CONTEXT_MAX_CHARS} chars (spec cap).`;
    additionalContext =
      additionalContext.slice(0, ADDITIONAL_CONTEXT_MAX_CHARS - marker.length) + marker;
  }

  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }) + '\n',
  );
}
