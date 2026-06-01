// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PB3-002 (plan-2026-06-01-team-shared-promotion-phase-3): structural guard that
 * session-start ALSO performs the cache-gated team-promotion pull, and that it does
 * so AFTER the context/banner stdout writes (so it never delays the visible context)
 * and inside a best-effort try/catch (so a pull failure never blocks session start).
 * The pull's tier/cloud gating + 2s bound live in `pullTeamPromotions` itself
 * (exercised by team-rule-sync.test.ts) — this guard pins the wiring.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, '../hooks/session-start.ts');

describe('session-start team-promotion pull wiring (PB3-002)', () => {
  const src = readFileSync(SRC, 'utf-8');

  it('imports pullTeamPromotions from team-rule-sync', () => {
    expect(src).toMatch(/import\s*\{\s*pullTeamPromotions\s*\}\s*from\s*'\.\.\/team-rule-sync\.ts'/);
  });

  it('calls pullTeamPromotions(db)', () => {
    expect(src).toMatch(/await\s+pullTeamPromotions\(db\)/);
  });

  it('the pull is placed AFTER the context stdout write (no context delay)', () => {
    const contextWriteIdx = src.indexOf('process.stdout.write(context)');
    const pullIdx = src.indexOf('pullTeamPromotions(db)');
    expect(contextWriteIdx).toBeGreaterThan(-1);
    expect(pullIdx).toBeGreaterThan(contextWriteIdx);
  });

  it('the pull is wrapped in a try/catch (best-effort, never blocks start)', () => {
    // The call sits in a try block whose catch swallows pull errors.
    expect(src).toMatch(/try\s*\{\s*\n\s*await\s+pullTeamPromotions\(db\);\s*\n\s*\}\s*catch/);
  });
});
