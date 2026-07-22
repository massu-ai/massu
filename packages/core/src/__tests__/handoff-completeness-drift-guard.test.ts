// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * CR-68 / VR-HANDOFF — a session handoff MUST be turn-key.
 *
 * Operator directive 2026-07-21: never hand back an "Operator TODO" bullet list. Every
 * `.claude/session-state/{RECAP,HANDOFF}-*.md` must carry a `## Next-Session Runbook` where
 * each `### <item>` block spells out **Vehicle** (/massu-golden-path | /massu-loop |
 * /massu-deploy | MANUAL), **Steps** (exact commands), **Stop** (the human gate), and
 * **Acceptance** (the verifiable done-check) — so the next session executes without
 * re-deriving the plan.
 *
 * This guard (a) proves the real gate script opens AND closes (its own mutation self-test),
 * and (b) asserts the handoffs written in THIS change are complete. It runs under npm test,
 * which the pre-commit gate executes — so an incomplete handoff blocks the commit.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const GATE = resolve(REPO_ROOT, 'scripts/massu-handoff-completeness.sh');
const TEMPLATE = resolve(REPO_ROOT, '.claude/templates/handoff-runbook.md');

// Internal repo only (public installs have no .claude/session-state).
const IS_INTERNAL = existsSync(GATE) && existsSync(resolve(REPO_ROOT, '.claude/session-state'));

function run(...args: string[]) {
  return spawnSync('bash', [GATE, ...args], { cwd: REPO_ROOT, encoding: 'utf-8' });
}

describe.runIf(IS_INTERNAL)('CR-68 — session handoffs are turn-key', () => {
  it('the gate script and the runbook template exist', () => {
    expect(existsSync(GATE)).toBe(true);
    expect(existsSync(TEMPLATE)).toBe(true);
  });

  it('the gate opens AND closes (its own mutation self-test passes)', () => {
    const r = run('--self-test');
    expect(r.status, `handoff self-test failed:\n${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/self-test:\s*(\d+)\/\1 passed/); // all cases passed
  });

  it('every handoff written/changed in this change carries a complete runbook', () => {
    const r = run('--changed');
    expect(r.status, `an incomplete handoff was written — fix it before commit:\n${r.stdout}${r.stderr}`).toBe(0);
  });
});
