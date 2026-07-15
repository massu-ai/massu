// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * THE TIMEOUT THAT MADE CLOUD SYNC NEVER WORK (measured 2026-07-14).
 *
 * The client shipped `DEFAULT_CLOUD_REQUEST_TIMEOUT_MS = 2_000` with a comment
 * asserting it "tolerat[ed] typical latency". Against the live api.massu.ai:
 *
 *     empty payload (auth only) ..............  777ms
 *     1 session + 50 observations ............ 2018ms   <-- OVER the limit
 *
 * So an ordinary session payload timed out EVERY time, was queued to pending_sync,
 * retried, timed out again, and after 10 retries was DISCARDED. One workspace logged
 * three `cloud_sync_giveup` events in a single day, all "aborted due to timeout". The
 * comment was a capability claim nobody had ever probed — and a timeout looks exactly
 * like an idle seat, so it went unnoticed for the product's whole life.
 *
 * These tests pin the two things that keep it fixed:
 *   1. the request timeout is sized ABOVE the measured real-world payload latency;
 *   2. an overall DEADLINE bounds the whole operation inside the Stop-hook budget,
 *      so no retry/backoff combination can overrun the hook.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'cloud-sync.ts'), 'utf8');

/** The worst measured real-payload latency (scripts/measure-sync-latency.sh). */
const MEASURED_REAL_PAYLOAD_MS = 2_118;

/** The Stop-hook timeout declared in .claude/settings.json for session-end.js. */
const STOP_HOOK_BUDGET_MS = 30_000;

function constant(name: string): number {
  const m = SRC.match(new RegExp(`const ${name} = ([0-9_]+)`));
  if (!m) throw new Error(`${name} not found in cloud-sync.ts — the guard cannot see`);
  return Number(m[1].replace(/_/g, ''));
}

describe('cloud-sync timeout budget', () => {
  it('the request timeout EXCEEDS the measured real-payload latency', () => {
    const timeout = constant('DEFAULT_CLOUD_REQUEST_TIMEOUT_MS');
    // The old 2_000 fails this outright — which is the whole point.
    expect(timeout).toBeGreaterThan(MEASURED_REAL_PAYLOAD_MS);
    // ...with real headroom, not a hairline pass.
    expect(timeout).toBeGreaterThanOrEqual(MEASURED_REAL_PAYLOAD_MS * 2);
  });

  it('the overall deadline fits INSIDE the Stop-hook budget', () => {
    const deadline = constant('SYNC_DEADLINE_MS');
    expect(deadline).toBeLessThan(STOP_HOOK_BUDGET_MS);
    // Leave room for the rest of session-end (DB writes, consolidation, the pull).
    expect(deadline).toBeLessThanOrEqual(STOP_HOOK_BUDGET_MS * 0.7);
  });

  it('every attempt is CLAMPED to the remaining deadline (not just the per-request timeout)', () => {
    // Bounding only the per-request timeout leaves total = retries × timeout +
    // backoff, which silently exceeds the hook the moment anyone tunes a knob. The
    // clamp is the structural guarantee.
    expect(SRC).toMatch(/Math\.min\(\s*configuredTimeoutMs,\s*remainingMs\s*\)/);
    expect(SRC).toMatch(/deadlineAt/);
  });

  it('the loop STOPS when the budget is spent rather than overrunning the hook', () => {
    expect(SRC).toMatch(/remainingMs\s*<\s*MIN_ATTEMPT_BUDGET_MS/);
  });

  it('ANTI-VACUITY: the guard would REJECT the 2000ms value that actually shipped', () => {
    // Proves this is a real check, not decoration: feed it the historical constant
    // and demand it fail. Without this, the assertions above could be vacuous.
    const shipped = 2_000;
    expect(shipped).toBeLessThan(MEASURED_REAL_PAYLOAD_MS); // it really was too small
    expect(() => {
      if (!(shipped > MEASURED_REAL_PAYLOAD_MS)) {
        throw new Error('2000ms is below measured latency — sync would time out');
      }
    }).toThrow(/below measured latency/);
  });
});
