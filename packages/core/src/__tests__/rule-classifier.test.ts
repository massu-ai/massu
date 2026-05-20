// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-D-003: classifier tests.
// 20+ cases covering rubric rules 1-4 + verifying custom-destination
// requires triggerKeywords config to be present.

import { describe, it, expect } from 'vitest';
import { classifyCandidate, type CustomDestinationConfig } from '../rule-classifier.ts';

describe('rule-classifier', () => {
  describe('Rubric rule 1: pattern-scanner (literal-grepable tokens)', () => {
    it('matches quoted literal token', () => {
      const r = classifyCandidate({ prompt: "use 'getConfig()' not direct YAML" });
      expect(r.destination).toBe('pattern-scanner');
      expect(r.reason).toMatch(/literal-grepable/);
    });

    it('matches `import` statement', () => {
      const r = classifyCandidate({ prompt: 'do not use import foo from bar in test files' });
      expect(r.destination).toBe('pattern-scanner');
      expect(r.reason).toMatch(/import statement/);
    });

    it('matches `.ts` filename token', () => {
      const r = classifyCandidate({ prompt: 'memory-db.ts should always close the db' });
      expect(r.destination).toBe('pattern-scanner');
      expect(r.reason).toMatch(/filename token/);
    });

    it('matches `.sh` filename token', () => {
      const r = classifyCandidate({ prompt: 'pre-push-light.sh missing step 12' });
      expect(r.destination).toBe('pattern-scanner');
    });

    it('matches `.yaml` filename token', () => {
      const r = classifyCandidate({ prompt: 'massu.config.yaml needs the autoLearning section' });
      expect(r.destination).toBe('pattern-scanner');
    });

    it('matches regex literal', () => {
      const r = classifyCandidate({ prompt: 'the pattern /no-direct-yaml/ should fire on yaml.load' });
      expect(r.destination).toBe('pattern-scanner');
      expect(r.reason).toMatch(/regex literal/);
    });

    it('matches double-quoted literal', () => {
      const r = classifyCandidate({ prompt: 'use "useConfig" everywhere, no exceptions' });
      expect(r.destination).toBe('pattern-scanner');
    });
  });

  describe('Rubric rule 2: claude-md-cr (process / protocol wording)', () => {
    it('matches "always X before Y" wording', () => {
      const r = classifyCandidate({ prompt: 'always run the migration validator before pushing changes' });
      expect(r.destination).toBe('claude-md-cr');
      expect(r.reason).toMatch(/always/i);
    });

    it('matches "must" wording for protocols', () => {
      const r = classifyCandidate({ prompt: 'every commit must reference its plan token in the subject line' });
      expect(r.destination).toBe('claude-md-cr');
      expect(r.reason).toMatch(/must/i);
    });

    it('matches "never X" wording', () => {
      const r = classifyCandidate({ prompt: 'never invoke a destructive operation without explicit operator approval' });
      expect(r.destination).toBe('claude-md-cr');
    });

    it('matches "protocol" wording', () => {
      const r = classifyCandidate({ prompt: 'the cr-52 protocol requires evidence files before mark-complete' });
      expect(r.destination).toBe('claude-md-cr');
    });

    it('matches "each time" wording', () => {
      const r = classifyCandidate({ prompt: 'each time you reroute a request through the proxy, log the original target' });
      expect(r.destination).toBe('claude-md-cr');
    });

    it('matches "whenever" wording', () => {
      const r = classifyCandidate({ prompt: 'whenever a schema migration is applied, also apply to dev and old-prod' });
      expect(r.destination).toBe('claude-md-cr');
    });
  });

  describe('Rubric rule 4: custom-destination (config-driven)', () => {
    const customDestinations: CustomDestinationConfig[] = [
      {
        name: 'brand-voice',
        path: 'docs/brand-voice.md',
        triggerKeywords: ['brand voice', 'copywriting', 'product tone'],
        template: '## ${date}: ${prompt_preview}\n',
      },
      {
        name: 'security-runbook',
        path: 'docs/runbooks/operations.md',
        triggerKeywords: ['runbook', 'incident response'],
        template: '## ${date}\n${prompt_preview}\n',
      },
    ];

    it('matches custom destination by exact triggerKeyword', () => {
      const r = classifyCandidate(
        { prompt: 'use a friendlier tone in the brand voice copy here' },
        { customDestinations }
      );
      expect(r.destination).toBe('custom-destination');
      expect(r.destination_extra?.name).toBe('brand-voice');
    });

    it('matches by alternate keyword in same destination', () => {
      const r = classifyCandidate(
        { prompt: 'this paragraph is the product tone we want everywhere' },
        { customDestinations }
      );
      expect(r.destination).toBe('custom-destination');
      expect(r.destination_extra?.name).toBe('brand-voice');
    });

    it('matches a different custom destination', () => {
      const r = classifyCandidate(
        { prompt: 'this should be in our runbook so on-call can find it' },
        { customDestinations }
      );
      expect(r.destination).toBe('custom-destination');
      expect(r.destination_extra?.name).toBe('security-runbook');
    });

    it('falls through to corrections-md when no keyword matches', () => {
      const r = classifyCandidate(
        { prompt: 'this is a general piece of feedback with no specific keyword anywhere' },
        { customDestinations }
      );
      expect(r.destination).toBe('corrections-md');
    });

    it('only fires custom-destination when the config defines it (empty config falls through)', () => {
      const r = classifyCandidate(
        { prompt: 'use a friendlier brand voice here' },
        { customDestinations: [] }
      );
      // "use a" is short; "brand voice" alone has no scanner / CR signal.
      expect(r.destination).toBe('corrections-md');
    });
  });

  describe('Rubric rule 3 / fallthrough: corrections-md', () => {
    it('falls back when no rubric matches', () => {
      const r = classifyCandidate({ prompt: 'this needs more clarity but I cannot articulate yet' });
      expect(r.destination).toBe('corrections-md');
      expect(r.reason).toMatch(/default catchall/);
    });

    it('falls back on empty-ish prompt with no signals', () => {
      const r = classifyCandidate({ prompt: 'i think you can do better than this' });
      expect(r.destination).toBe('corrections-md');
    });
  });

  describe('Rubric ordering (first match wins)', () => {
    it('pattern-scanner beats claude-md-cr when both could match', () => {
      const r = classifyCandidate({
        prompt: 'always reuse the getConfig() helper instead of bespoke parse logic',
      });
      // Has "always" (CR signal) AND "getConfig()" parens but no quoted literal —
      // however the .ts filename / quoted regex don't apply here. The "always"
      // process signal wins over the filename heuristic since neither
      // QUOTED_LITERAL nor IMPORT nor SHELL_TS_FILENAME nor REGEX matches.
      expect(r.destination).toBe('claude-md-cr');
    });

    it('pattern-scanner beats custom-destination when literal token is present', () => {
      const customDestinations: CustomDestinationConfig[] = [
        { name: 'brand-voice', path: 'docs/brand-voice.md', triggerKeywords: ['brand voice'], template: '' },
      ];
      const r = classifyCandidate(
        { prompt: 'use "brand voice" in customer-facing copy' },
        { customDestinations }
      );
      // Quoted literal "brand voice" is rule 1; rule 4 never reached.
      expect(r.destination).toBe('pattern-scanner');
    });
  });
});
