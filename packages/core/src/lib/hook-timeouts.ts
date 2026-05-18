// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-E-021 (plan-stage-e-low-info-sweep) — single source of truth for hook
 * timeouts.
 *
 * Previously `.claude/settings.json` (operator's local config) and
 * `init.ts:buildHooksConfig` (the values written to NEW customer
 * installs) had drifting values for the same hook. This module is the
 * authoritative source; both consumers import from here.
 *
 * Drift-guard: `__tests__/hook-timeouts-sot.test.ts` walks the local
 * `.claude/settings.json` and asserts every `timeout` value matches
 * the corresponding `HOOK_TIMEOUTS[name]` entry.
 *
 * Values in SECONDS (Claude Code's hook timeout field unit).
 */

export const HOOK_TIMEOUTS: Record<string, number> = {
  // Session lifecycle
  'session-start': 10,
  'session-end': 15,
  'pre-compact': 10,

  // PreToolUse hooks
  // P-E-019: `pre-tool-use-gate` is the consolidated PreToolUse hook
  // (combines security-gate + pre-delete-check into one spawn). The
  // individual entries below are kept for back-compat with operator
  // settings.json files that still reference them directly.
  'pre-tool-use-gate': 5,
  'security-gate': 5,
  'pre-delete-check': 5,

  // PostToolUse hooks
  'post-tool-use': 10,
  'quality-event': 5,
  'cost-tracker': 5,
  'post-edit-context': 5,

  // Failure-handling hooks
  'fix-detector': 5,
  'classify-failure': 5,
  'incident-pipeline': 5,
  'rule-enforcement-pipeline': 5,

  // Auto-learning
  'auto-learning-pipeline': 10,
} as const;

export type HookName = keyof typeof HOOK_TIMEOUTS;

export function getHookTimeout(name: string): number {
  return HOOK_TIMEOUTS[name] ?? 5;
}
