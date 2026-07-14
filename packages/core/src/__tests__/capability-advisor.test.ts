// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// Capability advisor tests (P6-004/005).
//
// The operator's requirement, verbatim: surface the upgrade IN CHAT — "most
// people will not run the doctor at all" — and "you must show it if the user's
// overall setup changes over time, i.e. they install a local llm at a later
// date."
//
// So the trigger policy is the product, and it is tested as such.
// ============================================================

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  shouldShow,
  markShown,
  markDismissed,
  runAdvisors,
  readAdvisorState,
  advisorStatePath,
  fingerprintOf,
  type Advisor,
  type AdvisorState,
} from '../capability-advisor.ts';
import { renderLocalModelOffer, detectLocalModel } from '../advisors/local-model-advisor.ts';

const NOW = 1_770_000_000;
const DAY = 86400;
const FP_OLLAMA = fingerprintOf(['http://localhost:11434', 'llama3.1:8b']);

describe('advisor trigger policy', () => {
  const base = { advisorId: 'local-model-summaries', fingerprint: FP_OLLAMA, nowEpochSec: NOW, suggestIntervalDays: 30 };

  it('offers when it has never been offered', () => {
    expect(shouldShow({ ...base, state: {} })).toBe(true);
  });

  it('does NOT nag: silent immediately after being shown', () => {
    const state = markShown({}, base.advisorId, FP_OLLAMA, NOW);
    expect(shouldShow({ ...base, state, nowEpochSec: NOW + 60 })).toBe(false);
    expect(shouldShow({ ...base, state, nowEpochSec: NOW + 5 * DAY })).toBe(false);
  });

  it('THE KEY CASE: re-offers when the user installs a model LATER (fingerprint changed)', () => {
    // They saw the offer months ago when they had nothing (or a different
    // model). Their machine has since changed. A show-once design would stay
    // silent forever and the capability would never be discovered.
    const state = markShown({}, base.advisorId, fingerprintOf(['http://localhost:11434', 'old-model:3b']), NOW);
    const afterTheyInstallSomethingNew = { ...base, state, fingerprint: FP_OLLAMA, nowEpochSec: NOW + DAY };
    expect(shouldShow(afterTheyInstallSomethingNew)).toBe(true);
  });

  it('re-offers periodically when the capability sits unused', () => {
    const state = markShown({}, base.advisorId, FP_OLLAMA, NOW);
    expect(shouldShow({ ...base, state, nowEpochSec: NOW + 29 * DAY })).toBe(false);
    expect(shouldShow({ ...base, state, nowEpochSec: NOW + 31 * DAY })).toBe(true);
  });

  it('goes silent FOREVER once dismissed', () => {
    const state = markDismissed(markShown({}, base.advisorId, FP_OLLAMA, NOW), base.advisorId);
    expect(shouldShow({ ...base, state, nowEpochSec: NOW + 999 * DAY })).toBe(false);
    // Even if they then install a different model.
    expect(shouldShow({ ...base, state, fingerprint: 'something-else', nowEpochSec: NOW + 999 * DAY })).toBe(false);
  });

  it('goes silent once they take the offer', () => {
    const state: AdvisorState = { [base.advisorId]: { configured_at: NOW } };
    expect(shouldShow({ ...base, state, nowEpochSec: NOW + 999 * DAY })).toBe(false);
  });
});

describe('advisor state is USER-level, not per-repo', () => {
  it('one machine = one offer, even across ten repos', async () => {
    const home = mkdtempSync(join(tmpdir(), 'massu-home-'));
    try {
      let detects = 0;
      const advisor: Advisor = {
        id: 'local-model-summaries',
        remedyKeys: ['llmEndpoint', 'llmModel'],
        isConfigured: () => false,
        detect: async () => {
          detects++;
          return { fingerprint: FP_OLLAMA, render: () => 'OFFER' };
        },
      };

      // The operator runs ten repos. A per-repo marker would pitch them ten times.
      const shown: string[] = [];
      for (let repo = 0; repo < 10; repo++) {
        const out = await runAdvisors([advisor], {
          enabled: true,
          suggestIntervalDays: 30,
          nowEpochSec: NOW + repo * 60,
          home,
        });
        if (out) shown.push(out);
      }

      expect(detects).toBe(10);  // it looked every time...
      expect(shown.length).toBe(1); // ...but only spoke ONCE.
      expect(existsSync(advisorStatePath(home))).toBe(true);
      expect(readAdvisorState(home)['local-model-summaries'].last_fingerprint).toBe(FP_OLLAMA);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('says nothing at all when there is no model to find', async () => {
    const home = mkdtempSync(join(tmpdir(), 'massu-home-'));
    try {
      const advisor: Advisor = {
        id: 'local-model-summaries',
        remedyKeys: [],
        isConfigured: () => false,
        detect: async () => null, // nothing detected
      };
      const out = await runAdvisors([advisor], { enabled: true, suggestIntervalDays: 30, nowEpochSec: NOW, home });
      expect(out).toBe('');
      expect(existsSync(advisorStatePath(home))).toBe(false); // no state written for a non-event
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a throwing advisor never costs the user their session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'massu-home-'));
    try {
      const boom: Advisor = {
        id: 'boom',
        remedyKeys: [],
        isConfigured: () => false,
        detect: async () => { throw new Error('probe exploded'); },
      };
      await expect(
        runAdvisors([boom], { enabled: true, suggestIntervalDays: 30, nowEpochSec: NOW, home }),
      ).resolves.toBe('');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the message the user actually reads', () => {
  const offer = renderLocalModelOffer({
    endpoint: 'http://localhost:11434',
    label: 'Ollama',
    models: ['llama3.1:8b'],
  });

  it('names what was found, both worked examples, the pros AND the cons, and the exact steps', () => {
    expect(offer).toContain('http://localhost:11434');
    expect(offer).toContain('llama3.1:8b');
    expect(offer).toContain('**Pros:**');
    expect(offer).toContain('**Cons:**'); // honest downsides are mandatory
    expect(offer).toContain('llmEndpoint');
    expect(offer).toContain('llmModel');
    expect(offer).toContain('enable local summaries');   // conversational activation
    expect(offer).toContain("don't suggest this again"); // and a way out
  });

  it('is honest that this affects ONLY the summaries and that Massu works without it', () => {
    expect(offer).toContain('arithmetic');
    expect(offer).toContain('Massu works completely without it');
  });
});

describe('local model detection', () => {
  it('a dead port degrades silently to "not detected" — never an error', async () => {
    const found = await detectLocalModel(
      [{ url: 'http://127.0.0.1:9', label: 'nothing' }], // discard port: nothing listens
      200,
    );
    expect(found).toBeNull();
  });
});
