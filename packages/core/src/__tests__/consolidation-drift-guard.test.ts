// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// Structural drift-guards for the consolidation slice (P8-001).
//
// These convert the slice's PROMISES into properties of the codebase. A
// promise in a doc rots; a failing test does not. Each guard below closes a
// bug class that would otherwise reappear quietly:
//
//   1. "The model is optional"  -> only the summarize stage may import it.
//   2. "We never auto-enable"   -> the advisor cannot write the endpoint config.
//   3. "No key in git"          -> no key field may exist in the config schema.
//   4. "We never block a hook"  -> no await inside a write transaction.
//   5. "No SQL injection"       -> config-driven lists must be bound, not interpolated.
//   6. "One retention policy"   -> no hardcoded retention number at the callsite.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf-8');

describe('consolidation drift-guards', () => {
  it('GUARD 1: ONLY the summarize path may import the optional model (memory-llm)', () => {
    // The zero-LLM guarantee for every downloader depends on dedupe, promote,
    // reweight and expire being pure arithmetic. If a future change quietly
    // makes one of them call a model, Massu silently stops working for anyone
    // without one. The engine may import memory-llm (its summarize stage lives
    // there); nothing else in the consolidation path may.
    const ALLOWED_IMPORTERS = new Set([
      'memory-consolidate.ts', // the engine — its stage B summarizes
      'memory-llm.ts',         // itself
    ]);

    const consolidationModules = [
      'memory-db.ts',
      'memory-supersede.ts',
      'memory-hybrid-search.ts',
      'memory-embed-sweep.ts',
      'memory-recall-format.ts',
      'consolidation-config.ts',
      'capability-advisor.ts',
    ];

    for (const mod of consolidationModules) {
      expect(
        ALLOWED_IMPORTERS.has(mod) || !read(mod).includes("from './memory-llm.ts'"),
        `${mod} must NOT import memory-llm.ts — the optional model may only be used by the ` +
          `summarize stage. Every other stage must work with zero LLM and zero network.`,
      ).toBe(true);
    }
  });

  it('GUARD 2: the advisor detects a local model but can NEVER enable it', () => {
    // Sending session text to a server — even one on localhost — is the user's
    // consent to give. Detection informs; the config line is consent.
    const advisor = read('advisors/local-model-advisor.ts');
    const framework = read('capability-advisor.ts');

    for (const [name, src] of [['local-model-advisor.ts', advisor], ['capability-advisor.ts', framework]]) {
      expect(
        /writeFileSync\s*\([^)]*massu\.config\.yaml/i.test(src),
        `${name} must not write massu.config.yaml — detecting a model must never enable it.`,
      ).toBe(false);
      expect(
        /llmEndpoint\s*[:=]\s*['"]http/i.test(src),
        `${name} must not assign an llmEndpoint value — that would auto-enable egress.`,
      ).toBe(false);
    }
  });

  it('GUARD 3: no API-key field may exist in the consolidation config schema', () => {
    // massu.config.yaml is git-tracked. A key field there is a committed secret
    // waiting to happen. The key comes only from the environment.
    const config = read('config.ts');
    const block = config.slice(config.indexOf('consolidation: z.object('));
    const schema = block
      .slice(0, block.indexOf('}).default({})'))
      // Strip comments: the guard must judge the SCHEMA FIELDS, not the prose.
      // (The comment legitimately names the env var the key comes from.)
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');

    // A DECLARED FIELD whose name looks like a credential is the failure.
    const keyField = /^\s*[A-Za-z_]*(apiKey|api_key|key|secret|token|password)[A-Za-z_]*\s*:/im;
    expect(
      keyField.test(schema),
      'The consolidation config schema must declare NO key/secret/token field — ' +
        'massu.config.yaml is git-tracked, so a key field there is a committed secret waiting to happen.',
    ).toBe(false);

    const llm = read('memory-llm.ts');
    expect(llm).toContain("process.env[LLM_API_KEY_ENV]"); // env is the ONLY source
  });

  it('GUARD 4: no await inside a write transaction (WAL has ONE writer; hooks would block)', () => {
    // A transaction held across an await blocks a live session's hooks for the
    // 5s busy_timeout and then throws SQLITE_BUSY — the user-visible symptom
    // being a silently blank recall block.
    const engine = read('memory-consolidate.ts');
    const txBlocks = engine.match(/db\.transaction\(\(\)\s*=>\s*\{[\s\S]*?\n\s*\}\);/g) ?? [];
    for (const block of txBlocks) {
      expect(
        /\bawait\b/.test(block),
        'A db.transaction() in memory-consolidate.ts encloses an await. Slow work ' +
          '(embedding, the optional model) must happen OUTSIDE any transaction.',
      ).toBe(false);
    }
    expect(txBlocks.length).toBeGreaterThan(0); // the guard must actually be watching something
  });

  it('GUARD 5: operator-supplied config lists are BOUND, never interpolated into SQL', () => {
    const memdb = read('memory-db.ts');
    const expireFn = memdb.slice(memdb.indexOf('export function expireOldLowValueObservations'));
    const body = expireFn.slice(0, expireFn.indexOf('\n}'));

    // protectedTypes comes from massu.config.yaml. It must reach SQL as ?-placeholders.
    expect(body).toContain('typePlaceholders');
    expect(
      /\$\{opts\.protectedTypes/.test(body),
      'protectedTypes must never be string-interpolated into SQL',
    ).toBe(false);
  });

  it('GUARD 6: the startup retention callsite reads config — no hardcoded number', () => {
    // Two copies of "90" in two files = the startup path and the scheduled pass
    // silently retiring memories on different policies.
    const server = read('server.ts');
    const call = server.slice(server.indexOf('pruneOldObservations(memDb'), server.indexOf('pruneOldObservations(memDb') + 400);
    expect(call).toContain('cfg.retentionDays');
    expect(/pruneOldObservations\(memDb,\s*\d+\s*\)/.test(server), 'no numeric retention literal').toBe(false);
  });

  it('GUARD 7: the advisor state is USER-level, not per-repo', () => {
    // A per-repo marker would re-pitch the same upgrade once per project — an
    // operator with ten repos would be told ten times.
    const framework = read('capability-advisor.ts');
    expect(framework).toContain('homedir()');
    expect(framework).toContain(".massu'");
    expect(
      /process\.cwd\(\)/.test(framework),
      'advisor state must not be stored relative to the current repo',
    ).toBe(false);
  });
});
