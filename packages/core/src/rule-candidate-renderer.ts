// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-B-003: pure renderer for the
// `/massu-rule show <id>` six-section preview. No I/O, no DB access —
// caller materializes a RuleCandidate object from the sidecar JSON +
// classifier output and hands it in.

import type { SignalHit } from './rule-candidate-detector.ts';

export interface ProposedRuleDraft {
  rule_id: string;
  scope: string;
  enforcement_mechanism: string;
  example_violation: string;
  example_fix: string;
}

export interface ConflictHit {
  source: string;
  line: number;
  preview: string;
}

export interface RuleCandidate {
  prompt_hash: string;
  prompt: string;
  score: number;
  signals: SignalHit[];
  prior_turn_files: string[];
  prior_turn_diff_snippet?: string;
  destination: 'pattern-scanner' | 'claude-md-cr' | 'corrections-md' | 'custom-destination';
  destination_reason: string;
  destination_extra?: string;
  proposed_rule: ProposedRuleDraft;
  enforcement_example: string;
  conflicts: ConflictHit[];
  timestamp: string;
}

const THRESHOLD = 60;

function renderSignalLine(s: SignalHit): string {
  const sign = s.applied >= 0 ? '+' : '';
  const evidence = s.evidence ? `: ${s.evidence}` : '';
  return `- ${s.name} (${sign}${s.applied})${evidence}`;
}

function fenced(language: string, body: string): string {
  return ['```' + language, body, '```'].join('\n');
}

export function renderCandidatePreview(candidate: RuleCandidate): string {
  const lines: string[] = [];

  lines.push(`## Candidate ${candidate.prompt_hash}`);
  lines.push('');
  lines.push(`Timestamp: ${candidate.timestamp}`);
  lines.push('');

  // Section 1: detected correction
  lines.push('### 1. Detected correction');
  lines.push(`> ${candidate.prompt.replace(/\n+/g, ' ').trim()}`);
  lines.push('');
  lines.push(`Score: ${candidate.score}/100 (threshold ${THRESHOLD})`);
  lines.push('Signals fired:');
  if (candidate.signals.length === 0) {
    lines.push('- (none)');
  } else {
    for (const s of candidate.signals) lines.push(renderSignalLine(s));
  }
  lines.push('');

  // Section 2: reacting-to
  lines.push('### 2. Reacting to');
  if (candidate.prior_turn_files.length === 0) {
    lines.push('No prior Edit/Write detected in the previous assistant turn (the correction may target a free-text answer).');
  } else {
    lines.push('Prior assistant turn touched:');
    for (const f of candidate.prior_turn_files) lines.push(`- ${f}`);
  }
  if (candidate.prior_turn_diff_snippet) {
    lines.push('');
    lines.push(fenced('diff', candidate.prior_turn_diff_snippet.trim()));
  }
  lines.push('');

  // Section 3: proposed rule
  lines.push('### 3. Proposed rule');
  lines.push(`- rule_id: ${candidate.proposed_rule.rule_id}`);
  lines.push(`- scope: ${candidate.proposed_rule.scope}`);
  lines.push(`- enforcement_mechanism: ${candidate.proposed_rule.enforcement_mechanism}`);
  lines.push('- example_violation:');
  lines.push(fenced('', candidate.proposed_rule.example_violation));
  lines.push('- example_fix:');
  lines.push(fenced('', candidate.proposed_rule.example_fix));
  lines.push('');

  // Section 4: destination + reason
  lines.push('### 4. Destination + reason');
  lines.push(`**Destination**: ${candidate.destination}`);
  lines.push(`**Reason**: ${candidate.destination_reason}`);
  if (candidate.destination_extra) {
    lines.push(`Extra: ${candidate.destination_extra}`);
  }
  lines.push('');

  // Section 5: enforcement example
  lines.push('### 5. Example enforcement');
  lines.push(fenced('bash', candidate.enforcement_example));
  lines.push('');

  // Section 6: conflict check
  lines.push('### 6. Conflict check');
  if (candidate.conflicts.length === 0) {
    lines.push('No conflicting rules found.');
  } else {
    lines.push('Conflicts detected — operator must resolve before approving:');
    for (const c of candidate.conflicts) {
      lines.push(`- ${c.source}:${c.line} — ${c.preview}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
