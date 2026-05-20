// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-A-003: unit tests for the
// score-based rule-candidate detector. Asserts every signal weight,
// the >=60 emission threshold, and ~30 positive + ~30 negative cases.

import { describe, it, expect } from 'vitest';
import {
  scoreCorrectionPrompt,
  RULE_CANDIDATE_THRESHOLD,
  type ScoreInputs,
  type SignalName,
} from '../rule-candidate-detector.ts';

const PRIOR_EDIT = { priorAssistantTurn: { hadEditOrWrite: true } };

function score(prompt: string, overrides: Partial<ScoreInputs> = {}): ReturnType<typeof scoreCorrectionPrompt> {
  return scoreCorrectionPrompt({ prompt, ...overrides });
}

function signalNames(result: ReturnType<typeof scoreCorrectionPrompt>): SignalName[] {
  return result.signals.map(s => s.name);
}

describe('rule-candidate-detector', () => {
  describe('threshold + emit semantics', () => {
    it('threshold constant matches plan spec (>=60)', () => {
      expect(RULE_CANDIDATE_THRESHOLD).toBe(60);
    });

    it('emitCandidate=true iff score >= 60', () => {
      const r = scoreCorrectionPrompt({
        prompt: 'this is wrong, you should be using getConfig() instead of direct YAML',
        ...PRIOR_EDIT,
        category: 'bugfix',
      });
      expect(r.score).toBeGreaterThanOrEqual(60);
      expect(r.emitCandidate).toBe(true);
    });

    it('emitCandidate=false when below 60', () => {
      const r = scoreCorrectionPrompt({ prompt: 'sounds good lets keep going' });
      expect(r.score).toBeLessThan(60);
      expect(r.emitCandidate).toBe(false);
    });
  });

  describe('positive cases (>= 60 score → emitCandidate)', () => {
    it.each([
      ["that's wrong, use getConfig() instead of direct YAML access", true],
      ['this is wrong, you broke the build by removing that import', true],
      ['incorrect — the helper should be reused, not re-implemented', true],
      ["you missed adding it to tools.ts so it doesn't register", true],
      ['not what i asked — should be a 3-function pattern not 2', true],
      ['no, this should be using the ESM .ts extension on imports', true],
      ['this is wrong, change the prefix to use getConfig().toolPrefix', true],
      ['no, instead of hardcoding, read from massu.config.yaml', true],
      ["not what i wanted; should be const not let here", true],
      ["you broke the test by removing the awaited db.close() call", true],
      ['this is wrong, you should be writing through audit-trail.ts logger', true],
      ['that is wrong because the snapshot has to track absent files always', true],
      ['no, use the canonical helper from memory-path.ts not a literal', true],
      ['incorrect, please use the existing redactSensitiveContent function', true],
      ["that's wrong because the path resolver already handles encoding", true],
    ] as const)('positive case "%s" emits candidate', (prompt) => {
      const r = scoreCorrectionPrompt({ prompt, ...PRIOR_EDIT, category: 'bugfix' });
      expect(r.emitCandidate).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(60);
    });
  });

  describe('negative cases (< 60 score → no candidate)', () => {
    it.each([
      'no problem',
      'no thanks',
      'no need to undo that',
      'ok',
      'sounds good',
      'thanks',
      'cool',
      'continue',
      'go ahead',
      'fine by me',
      '/massu-loop docs/plans/some.md',
      '/clear',
      '/help',
      'nevermind, forget it',
      "let's move on to something different",
      'skip',
      'actually you were right, ignore that',
      'no, you were right the first time',
    ])('negative case "%s" does NOT emit', (prompt) => {
      const r = scoreCorrectionPrompt({ prompt, ...PRIOR_EDIT, category: 'bugfix' });
      expect(r.emitCandidate).toBe(false);
    });
  });

  describe('individual signals', () => {
    it('strong_correction_phrase contributes +40', () => {
      const r = score("that's wrong");
      expect(signalNames(r)).toContain('strong_correction_phrase');
      const hit = r.signals.find(s => s.name === 'strong_correction_phrase')!;
      expect(hit.baseWeight).toBe(40);
      expect(hit.applied).toBe(40);
    });

    it('negation_plus_instruction contributes +30 within 8-word window', () => {
      const r = score('no, instead use the existing helper');
      expect(signalNames(r)).toContain('negation_plus_instruction');
    });

    it('prior_edit_or_write contributes +25', () => {
      const r = score('add another fix in there', PRIOR_EDIT);
      const hit = r.signals.find(s => s.name === 'prior_edit_or_write');
      expect(hit?.applied).toBe(25);
    });

    it('bugfix category contributes +15', () => {
      const r = score('the previous attempt broke production', { category: 'bugfix' });
      const hit = r.signals.find(s => s.name === 'bugfix_or_refactor_category');
      expect(hit?.applied).toBe(15);
    });

    it('refactor category also contributes +15', () => {
      const r = score('rename the field across all files', { category: 'refactor' });
      const hit = r.signals.find(s => s.name === 'bugfix_or_refactor_category');
      expect(hit?.applied).toBe(15);
    });

    it('prompt_length_gt_10 contributes +10', () => {
      const r = score('this is a much longer sentence that crosses the ten word threshold easily');
      const hit = r.signals.find(s => s.name === 'prompt_length_gt_10');
      expect(hit?.applied).toBe(10);
    });

    it('running_correction_streak contributes +15', () => {
      const r = score('still wrong, try again', {
        priorOutcomes: { lastCorrectionsNeeded: 2 },
      });
      const hit = r.signals.find(s => s.name === 'running_correction_streak');
      expect(hit?.applied).toBe(15);
    });

    it('short_length_floor contributes -50 for <4 words', () => {
      const r = score('no');
      const hit = r.signals.find(s => s.name === 'short_length_floor');
      expect(hit?.applied).toBe(-50);
    });

    it('slash_command_excluded short-circuits to -100', () => {
      const r = score('/some-command arg');
      expect(r.score).toBe(-100);
      expect(signalNames(r)).toEqual(['slash_command_excluded']);
    });

    it('dismissal_phrase_excluded short-circuits to -100', () => {
      const r = score("nevermind, let's move on instead");
      expect(r.score).toBe(-100);
      expect(signalNames(r)).toContain('dismissal_phrase_excluded');
    });
  });

  describe('blacklist downweighting', () => {
    it('dismissal count >= 5 zeroes the signal contribution', () => {
      const blacklist = new Map<string, number>([['strong_correction_phrase', 7]]);
      const r = score("that's wrong, you missed the helper everywhere", { blacklist });
      const hit = r.signals.find(s => s.name === 'strong_correction_phrase');
      expect(hit?.applied).toBe(0);
    });

    it('dismissal count in 1..4 reduces by 10 per count', () => {
      const blacklist = new Map<string, number>([['strong_correction_phrase', 2]]);
      const r = score("that's wrong everywhere", { blacklist });
      const hit = r.signals.find(s => s.name === 'strong_correction_phrase');
      expect(hit?.applied).toBe(20);
    });
  });

  describe('result shape', () => {
    it('returns signals array with SignalHit objects', () => {
      const r = score("that's wrong, the helper should be used instead", { ...PRIOR_EDIT, category: 'bugfix' });
      for (const s of r.signals) {
        expect(typeof s.name).toBe('string');
        expect(typeof s.baseWeight).toBe('number');
        expect(typeof s.applied).toBe('number');
      }
    });
  });
});
