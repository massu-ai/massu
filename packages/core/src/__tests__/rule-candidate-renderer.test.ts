// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// Tests for the `massu rule show <id>` candidate preview renderer.
// DF-1 (audit 2026-07-14): reshaped from the abandoned six-section v0.2 model
// (whose proposed_rule/enforcement_example/conflicts fields had no producer) to
// render ONLY the data the pipeline actually records — and now actually wired.

import { describe, it, expect } from 'vitest';
import { renderCandidatePreview, type RuleCandidate } from '../rule-candidate-renderer.ts';

function baseCandidate(): RuleCandidate {
  return {
    prompt_hash: 'abcdef0123456789',
    prompt: "that's wrong, use getConfig() instead of direct YAML access",
    score: 90,
    signals: [
      { name: 'strong_correction_phrase', baseWeight: 40, applied: 40, evidence: 'matched "that\'s wrong"' },
      { name: 'prior_edit_or_write', baseWeight: 25, applied: 25, evidence: 'prior assistant turn contained Edit' },
      { name: 'bugfix_or_refactor_category', baseWeight: 15, applied: 15, evidence: 'category=bugfix' },
      { name: 'prompt_length_gt_10', baseWeight: 10, applied: 10, evidence: '12 words > 10' },
    ],
    prior_turn_files: ['packages/core/src/config-loader.ts'],
    prior_turn_diff_snippet: '-  const cfg = parse(readFileSync(yamlPath))\n+  const cfg = getConfig()',
    origin: 'local',
    status: 'proposed',
    destination: null,
    timestamp: '2026-05-20T12:00:00Z',
  };
}

describe('rule-candidate-renderer', () => {
  it('renders all four sections with section headers', () => {
    const out = renderCandidatePreview(baseCandidate());
    expect(out).toMatch(/^## Candidate abcdef0123456789/);
    expect(out).toContain('### 1. Detected correction');
    expect(out).toContain('### 2. Reacting to');
    expect(out).toContain('### 3. Origin & status');
    expect(out).toContain('### 4. Next steps');
  });

  it('lists every fired signal with applied weight', () => {
    const out = renderCandidatePreview(baseCandidate());
    expect(out).toContain('- strong_correction_phrase (+40)');
    expect(out).toContain('- prior_edit_or_write (+25)');
    expect(out).toContain('- bugfix_or_refactor_category (+15)');
    expect(out).toContain('- prompt_length_gt_10 (+10)');
    expect(out).toContain('Score: 90/100 (threshold 60)');
  });

  it('renders origin, status, and an unrouted destination hint', () => {
    const out = renderCandidatePreview(baseCandidate());
    expect(out).toContain('- origin: local');
    expect(out).toContain('- status: proposed');
    expect(out).toContain('- destination: (not yet chosen — decided at approve time)');
  });

  it('renders a chosen destination and team/pack draft when present', () => {
    const c = baseCandidate();
    c.origin = 'team';
    c.status = 'proposed';
    c.destination = 'corrections-md';
    c.draft_text = 'Always verify the end state.';
    const out = renderCandidatePreview(c);
    expect(out).toContain('- origin: team');
    expect(out).toContain('- destination: corrections-md');
    expect(out).toContain('- authoritative draft (team/pack):');
    expect(out).toContain('Always verify the end state.');
  });

  it('surfaces the review/approve/dismiss next-step commands keyed to the id', () => {
    const out = renderCandidatePreview(baseCandidate());
    expect(out).toContain('massu rule review abcdef0123456789 --destination');
    expect(out).toContain('massu rule approve abcdef0123456789 --destination');
    expect(out).toContain('massu rule dismiss abcdef0123456789 --reason');
  });

  it('handles missing prior_turn_diff_snippet gracefully', () => {
    const c = baseCandidate();
    delete c.prior_turn_diff_snippet;
    const out = renderCandidatePreview(c);
    expect(out).toContain('Prior assistant turn touched:');
    expect(out).toContain('- packages/core/src/config-loader.ts');
    expect(out).not.toContain('```diff');
  });

  it('handles empty prior_turn_files with friendly message', () => {
    const c = baseCandidate();
    c.prior_turn_files = [];
    delete c.prior_turn_diff_snippet;
    const out = renderCandidatePreview(c);
    expect(out).toContain('No prior Edit/Write detected');
  });

  it('renders no signals case as "(none)"', () => {
    const c = baseCandidate();
    c.signals = [];
    c.score = 0;
    const out = renderCandidatePreview(c);
    expect(out).toContain('Signals fired:\n- (none)');
  });
});
