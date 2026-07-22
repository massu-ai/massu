// Slice 5 — C-01 + C-04 structural drift-guards for the recall arm.
//
//  C-01: the pending pointer is built from a COUNT and the origin LABEL only — it
//        NEVER selects a pending record's title/detail/record_json/envelope_raw, so
//        no candidate-derived byte can ever reach the model's context. (The behavioral
//        proof — an injection-title record contributing zero bytes — is in
//        shared-memory-recall-5c.test.ts.)
//  C-04: the recall hook gates the ENTIRE cross-repo arm behind crossRepoRecallEnabled
//        (memory.share.recall.enabled AND a non-empty subscribe list), so a dormant
//        install's recall output is byte-identical to the pre-Slice-5 behavior.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');
const RECALL_ARM = readFileSync(join(SRC, 'shared-memory-recall.ts'), 'utf-8');
const HOOK = readFileSync(join(SRC, 'hooks', 'memory-recall.ts'), 'utf-8');

describe('Slice 5 C-01 — pending pointer reads no candidate content', () => {
  it('pendingPointer selects only origin_repo_label + COUNT from shared_memory_pending', () => {
    // Isolate the pendingPointer function body.
    const start = RECALL_ARM.indexOf('export function pendingPointer');
    expect(start).toBeGreaterThan(-1);
    const body = RECALL_ARM.slice(start);
    // The only columns it may read from the pending table are the label and the count.
    expect(body).toMatch(/SELECT origin_repo_label, COUNT\(\*\)/);
    // It must NOT read any content-bearing column.
    for (const col of ['record_json', 'envelope_raw', 'title', 'detail', 'record_hash']) {
      expect(body.includes(col), `pendingPointer must not read ${col}`).toBe(false);
    }
  });
});

describe('Slice 5 C-04 — the cross-repo recall arm is gated (dormant by default)', () => {
  it('the hook calls enrichAndCapCrossRepo / pendingPointer only under crossRepoRecallEnabled', () => {
    expect(HOOK).toMatch(/crossRepoRecallEnabled\(/);
    // Both cross-repo calls appear AFTER the gate check in source order.
    const gateAt = HOOK.indexOf('crossRepoRecallEnabled(');
    expect(HOOK.indexOf('enrichAndCapCrossRepo(')).toBeGreaterThan(gateAt);
    expect(HOOK.indexOf('pendingPointer(')).toBeGreaterThan(gateAt);
    // The gate is inside a try that degrades to classic recall (fail-open).
    expect(HOOK).toMatch(/ranked = results/);
  });
});
