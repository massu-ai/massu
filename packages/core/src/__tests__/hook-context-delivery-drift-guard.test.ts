// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P6-005 — GIVE DELIVERY A PREDICATE.
 *
 * WHY THIS EXISTS
 * ---------------
 * `settings-hook-registration-drift-guard.test.ts` proves a hook is REGISTERED.
 * Registration is PRESENCE; delivery is CAPABILITY, and for months nothing held the
 * second predicate: `memory-recall` was registered, exited 0, computed a perfect
 * answer, emitted it as `{"message": …}` — a shape that is not in the output schema
 * at all — and no session ever received a byte of it.
 *
 * The one thing that CAN be checked mechanically is the shape, per event. Claude
 * Code's contract (https://code.claude.com/docs/en/hooks, read 2026-08-08) is:
 *
 *   { "hookSpecificOutput": { "hookEventName": "<event>", "additionalContext": "…" } }
 *
 * and `hookEventName` is REQUIRED — so a hook's declared event must match the event
 * it is actually registered on, or it emits a valid-looking payload addressed to the
 * wrong event. That is the drift this guard exists to make impossible to ship.
 *
 * THE CANDIDATE SET IS DERIVED, NOT LISTED (Rule 25 / G18). The hook→event mapping
 * comes from `.claude/settings.json` — the same file Claude Code reads — so a hook
 * added or re-registered next month is covered on its first commit rather than when
 * somebody remembers to extend a roster.
 *
 * WHAT THIS CANNOT DO, stated rather than buried (G20): it cannot prove ARRIVAL.
 * Only a real session shows that, which is why every fix against this matrix closes
 * with a positive observation AND a negative control. This guard proves the SHAPE is
 * right and the EVENT is right; it does not prove Claude received it.
 *
 * BLIND-GATE POSTURE
 *   M1 denominator asserted — zero hooks discovered is a LOUD ERROR, never a pass.
 *   M2 fail closed — an unreadable settings file or hook source is an ERROR.
 *   M4 fixtures for both directions live in hooks-stdout-convention.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { HOOK_EVENTS } from '../hooks/lib/write-hook-message.ts';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SETTINGS = join(REPO_ROOT, '.claude', 'settings.json');
const HOOKS_SRC = resolve(__dirname, '..', 'hooks');

interface SettingsShape {
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
}

/** hook basename -> set of events it is registered on, derived from settings.json. */
function registeredEvents(): Map<string, Set<string>> {
  let raw: string;
  try {
    raw = readFileSync(SETTINGS, 'utf-8');
  } catch (e) {
    throw new Error(`cannot look: ${SETTINGS} unreadable (${(e as Error).message}) — M2.`);
  }
  const parsed = JSON.parse(raw) as SettingsShape;
  const hooks = parsed.hooks;
  if (!hooks || Object.keys(hooks).length === 0) {
    throw new Error('cannot look: settings.json declares no hooks — an empty candidate set is an ERROR.');
  }
  const out = new Map<string, Set<string>>();
  for (const [event, matchers] of Object.entries(hooks)) {
    for (const m of matchers) {
      for (const h of m.hooks ?? []) {
        const cmd = h.command ?? '';
        // Only this package's compiled hooks carry a declared event.
        const match = cmd.match(/packages\/core\/dist\/hooks\/([A-Za-z0-9-]+)\.js/);
        if (!match) continue;
        if (!out.has(match[1])) out.set(match[1], new Set());
        out.get(match[1])!.add(event);
      }
    }
  }
  return out;
}

/** The event a hook DECLARES for itself, or null if it emits no context. */
function declaredEvent(basename: string): { declares: string | null; emits: boolean } {
  const path = join(HOOKS_SRC, `${basename}.ts`);
  if (!existsSync(path)) return { declares: null, emits: false };
  let src: string;
  try {
    src = readFileSync(path, 'utf-8');
  } catch (e) {
    throw new Error(`cannot look: ${path} unreadable (${(e as Error).message}) — M2.`);
  }
  const emits = /writeHookContext\(/.test(src);
  const m = src.match(/const HOOK_EVENT:\s*HookEvent\s*=\s*'([^']+)'/);
  return { declares: m ? m[1] : null, emits };
}

describe('P6-005 — hook context delivery: declared event must match registration', () => {
  it('reports a real denominator (M1)', () => {
    const reg = registeredEvents();
    expect(reg.size, 'compiled hooks discovered in settings.json — 0 means the detector is dead').toBeGreaterThan(
      10,
    );
    const emitters = [...reg.keys()].filter((h) => declaredEvent(h).emits);
    expect(
      emitters.length,
      'registered hooks that emit context — 0 means this guard checks nothing',
    ).toBeGreaterThan(5);
  });

  it('every context-emitting hook declares the event it is REGISTERED on', () => {
    const reg = registeredEvents();
    const problems: string[] = [];
    let checked = 0;
    for (const [hook, events] of [...reg.entries()].sort()) {
      const { declares, emits } = declaredEvent(hook);
      if (!emits) continue;
      checked += 1;
      if (declares === null) {
        problems.push(`${hook}: calls writeHookContext but declares no HOOK_EVENT`);
        continue;
      }
      if (!HOOK_EVENTS.includes(declares as (typeof HOOK_EVENTS)[number])) {
        problems.push(`${hook}: declares '${declares}', outside the closed vocabulary`);
        continue;
      }
      if (!events.has(declares)) {
        problems.push(
          `${hook}: declares '${declares}' but settings.json registers it on ` +
            `${[...events].sort().join(', ')} — the payload would name the wrong event`,
        );
      }
    }
    expect(checked, 'hooks actually compared — 0 would be a silent pass').toBeGreaterThan(5);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('a hook registered on a context-injecting event does not rely on bare stdout', () => {
    // UserPromptSubmit and SessionStart deliver plain stdout per the spec; every
    // other event sends it to the debug log only. session-start.ts is the
    // deliberate, WORKING plain-text case and is the control that proved the
    // diagnosis — it is exempt by name, with that reason.
    const PLAIN_STDOUT_OK = new Set(['session-start']);
    const reg = registeredEvents();
    const problems: string[] = [];
    for (const [hook, events] of [...reg.entries()].sort()) {
      if (PLAIN_STDOUT_OK.has(hook)) continue;
      const path = join(HOOKS_SRC, `${hook}.ts`);
      if (!existsSync(path)) continue;
      const src = readFileSync(path, 'utf-8');
      if (!/process\.stdout\.write\s*\(/.test(src)) continue;
      const debugLogOnly = [...events].filter(
        (e) => e !== 'UserPromptSubmit' && e !== 'SessionStart' && e !== 'UserPromptExpansion',
      );
      if (debugLogOnly.length > 0) {
        problems.push(
          `${hook}: writes stdout directly while registered on ${debugLogOnly.sort().join(', ')}, ` +
            `where the spec sends stdout to the debug log only`,
        );
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
