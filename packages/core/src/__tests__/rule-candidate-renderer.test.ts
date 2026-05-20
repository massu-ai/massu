// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-B-003: tests for the six-section
// rule-candidate preview renderer.

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
    destination: 'pattern-scanner',
    destination_reason: 'literal-grepable token detected: getConfig()',
    proposed_rule: {
      rule_id: 'require_get_config_over_direct_yaml',
      scope: 'packages/core/src/**',
      enforcement_mechanism: 'pattern-scanner grep against direct YAML parse calls',
      example_violation: 'const cfg = yaml.load(readFileSync(path));',
      example_fix: 'import { getConfig } from "./config.ts"; const cfg = getConfig();',
    },
    enforcement_example: 'grep -RnE "yaml\\.(load|parse)\\(readFileSync" packages/core/src/',
    conflicts: [],
    timestamp: '2026-05-20T12:00:00Z',
  };
}

describe('rule-candidate-renderer', () => {
  it('renders all six sections with section headers', () => {
    const out = renderCandidatePreview(baseCandidate());
    expect(out).toMatch(/^## Candidate abcdef0123456789/);
    expect(out).toContain('### 1. Detected correction');
    expect(out).toContain('### 2. Reacting to');
    expect(out).toContain('### 3. Proposed rule');
    expect(out).toContain('### 4. Destination + reason');
    expect(out).toContain('### 5. Example enforcement');
    expect(out).toContain('### 6. Conflict check');
  });

  it('lists every fired signal with applied weight', () => {
    const out = renderCandidatePreview(baseCandidate());
    expect(out).toContain('- strong_correction_phrase (+40)');
    expect(out).toContain('- prior_edit_or_write (+25)');
    expect(out).toContain('- bugfix_or_refactor_category (+15)');
    expect(out).toContain('- prompt_length_gt_10 (+10)');
    expect(out).toContain('Score: 90/100 (threshold 60)');
  });

  it('renders empty conflict list as "No conflicting rules found."', () => {
    const out = renderCandidatePreview(baseCandidate());
    expect(out).toContain('No conflicting rules found.');
  });

  it('renders non-empty conflicts with source:line + preview', () => {
    const c = baseCandidate();
    c.conflicts = [
      { source: 'scripts/massu-pattern-scanner.sh', line: 142, preview: 'Check 7 already covers yaml.load' },
      { source: 'scripts/hooks/pattern-feedback.sh', line: 56, preview: 'allow-list for config.ts itself' },
    ];
    const out = renderCandidatePreview(c);
    expect(out).toContain('Conflicts detected — operator must resolve before approving');
    expect(out).toContain('- scripts/massu-pattern-scanner.sh:142 — Check 7 already covers yaml.load');
    expect(out).toContain('- scripts/hooks/pattern-feedback.sh:56 — allow-list for config.ts itself');
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

  it('renders the proposed-rule schema fields', () => {
    const out = renderCandidatePreview(baseCandidate());
    expect(out).toContain('- rule_id: require_get_config_over_direct_yaml');
    expect(out).toContain('- scope: packages/core/src/**');
    expect(out).toContain('- enforcement_mechanism:');
    expect(out).toContain('- example_violation:');
    expect(out).toContain('- example_fix:');
  });

  it('renders destination_extra when present', () => {
    const c = baseCandidate();
    c.destination_extra = 'matched config-driven keyword "brand-voice"';
    const out = renderCandidatePreview(c);
    expect(out).toContain('Extra: matched config-driven keyword "brand-voice"');
  });
});
