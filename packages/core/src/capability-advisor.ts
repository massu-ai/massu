// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// Capability Advisor (P6-004 / P6-005,
// plan-living-memory-slice-3-consolidation).
//
// Operator directive (2026-07-12): "most people will not run the doctor at
// all, this needs to be surfaced in their chat sessions automatically with
// full explanations and step-by-step instructions ... you must show it if the
// user's overall setup changes over time, i.e. they install a local llm at a
// later date."
//
// An optional capability nobody can FIND does not exist. So Massu tells the
// user, in chat, unprompted — and keeps watching, because their machine
// changes over time.
//
// THREE TRIGGERS:
//   1. Setup (`massu init`) — they are already in a configuring mindset.
//   2. The environment FINGERPRINT changes — they installed a local model
//      three months after downloading Massu, or upgraded an 8B to a 70B. A
//      "show once at install" design misses this case FOREVER.
//   3. Periodically — the capability is sitting there unused and they never
//      acted (default: every 30 days). Not every session: a nag teaches people
//      to ignore ALL of Massu's injected blocks, including the memory recall
//      block that shares the same channel.
//
// SILENT when: configured, permanently dismissed, or nothing detected.
//
// STATE IS USER-LEVEL (~/.massu/advisor-state.json), NOT per-repo. A per-repo
// marker would re-pitch the same upgrade once per project — an operator with
// ten repos would be told ten times.
//
// NEVER AUTO-ENABLES. Even with a model sitting right there, Massu does not
// start using it: sending session text to a server — even one on localhost —
// is the user's consent to give, and the shipped default is zero egress.
// Detection informs; the config line is consent. (Drift-guarded: this module
// contains no writer for llmEndpoint/llmModel.)
// ============================================================

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export interface AdvisorState {
  [advisorId: string]: {
    last_shown_epoch?: number;
    last_fingerprint?: string;
    dismissed?: boolean;
    configured_at?: number;
    /**
     * B-12 / F-17 — set by a SUCCESSFUL `massu memory render --dry-run`.
     *
     * The renderer writes into the operator's irreplaceable memory directory. We do not
     * offer to turn that on until he has SEEN, on his own corpus, exactly what it would
     * write — and a dry run provably writes 0 bytes. An offer made before that is an
     * offer to trust code he has not watched run.
     */
    dry_run_ok_at?: number;
  };
}

/** A detected, actionable capability the user is not yet using. */
export interface Detection {
  /** Stable hash of what we found — a CHANGE here re-triggers the offer. */
  fingerprint: string;
  /** Rendered, self-contained explanation shown in chat. */
  render: () => string;
}

export interface Advisor {
  id: string;
  /** Null when there is nothing to offer (=> total silence). */
  detect: () => Promise<Detection | null>;
  /** True when the user has already enabled it (=> total silence). */
  isConfigured: () => boolean;
  /** Config keys the advice tells the user to set (drift-guarded to exist). */
  remedyKeys: readonly string[];
}

export function advisorStatePath(home: string = homedir()): string {
  return join(home, '.massu', 'advisor-state.json');
}

export function readAdvisorState(home?: string): AdvisorState {
  try {
    const p = advisorStatePath(home);
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf-8')) as AdvisorState;
  } catch {
    return {}; // unreadable state must never break a session
  }
}

export function writeAdvisorState(state: AdvisorState, home?: string): void {
  try {
    const p = advisorStatePath(home);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // Best-effort: worst case we re-offer later.
  }
}

export function fingerprintOf(parts: readonly string[]): string {
  return createHash('sha256').update([...parts].sort().join('|')).digest('hex').slice(0, 16);
}

export interface ShouldShowInput {
  state: AdvisorState;
  advisorId: string;
  fingerprint: string;
  nowEpochSec: number;
  suggestIntervalDays: number;
}

/**
 * The trigger rule. Pure + exported so the whole policy is directly testable
 * (including "they installed a model three months later").
 */
export function shouldShow(input: ShouldShowInput): boolean {
  const entry = input.state[input.advisorId];
  if (!entry) return true;                         // never offered
  if (entry.dismissed) return false;               // "don't suggest this again"
  if (entry.configured_at) return false;           // they took it — stop talking
  if (entry.last_fingerprint !== input.fingerprint) return true; // their machine CHANGED
  if (!entry.last_shown_epoch) return true;
  const elapsedDays = (input.nowEpochSec - entry.last_shown_epoch) / 86400;
  return elapsedDays >= input.suggestIntervalDays; // still unused after a while
}

export function markShown(
  state: AdvisorState,
  advisorId: string,
  fingerprint: string,
  nowEpochSec: number,
): AdvisorState {
  return {
    ...state,
    [advisorId]: {
      ...(state[advisorId] ?? {}),
      last_shown_epoch: nowEpochSec,
      last_fingerprint: fingerprint,
    },
  };
}

export function markDismissed(state: AdvisorState, advisorId: string): AdvisorState {
  return { ...state, [advisorId]: { ...(state[advisorId] ?? {}), dismissed: true } };
}

/**
 * B-12 / F-17 — record that the operator has run a successful `--dry-run` for this
 * capability. Until then, the offer to enable it is NOT made.
 */
export function setAdvisorDryRunOk(advisorId: string, home?: string, nowEpochSec?: number): void {
  try {
    const state = readAdvisorState(home);
    const now = nowEpochSec ?? Math.floor(Date.now() / 1000);
    writeAdvisorState(
      { ...state, [advisorId]: { ...(state[advisorId] ?? {}), dry_run_ok_at: now } },
      home
    );
  } catch {
    // Fail-open: an advisor bookkeeping failure must never break a CLI command that
    // otherwise succeeded, and must never be the reason a write happens.
  }
}

/** Has a successful dry run been recorded for this advisor? */
export function hasDryRunOk(state: AdvisorState, advisorId: string): boolean {
  return typeof state[advisorId]?.dry_run_ok_at === 'number';
}

/**
 * Run the advisors and return the block to inject into chat (empty = silence).
 * Fail-open: an advisor that throws is skipped, never surfaced as an error.
 */
export async function runAdvisors(
  advisors: readonly Advisor[],
  opts: {
    enabled: boolean;
    suggestIntervalDays: number;
    nowEpochSec?: number;
    home?: string;
  },
): Promise<string> {
  if (!opts.enabled) return '';
  const now = opts.nowEpochSec ?? Math.floor(Date.now() / 1000);
  let state = readAdvisorState(opts.home);
  const blocks: string[] = [];

  for (const advisor of advisors) {
    try {
      if (advisor.isConfigured()) continue;
      const detection = await advisor.detect();
      if (!detection) continue; // nothing there — say nothing
      if (
        !shouldShow({
          state,
          advisorId: advisor.id,
          fingerprint: detection.fingerprint,
          nowEpochSec: now,
          suggestIntervalDays: opts.suggestIntervalDays,
        })
      ) {
        continue;
      }
      blocks.push(detection.render());
      state = markShown(state, advisor.id, detection.fingerprint, now);
    } catch {
      // An advisor is a nicety. It must never cost the user a session.
    }
  }

  if (blocks.length === 0) return '';
  writeAdvisorState(state, opts.home);
  return blocks.join('\n\n');
}
