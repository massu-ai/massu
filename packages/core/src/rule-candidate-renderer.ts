// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// Pure renderer for the `massu rule show <id>` candidate preview. No I/O, no DB
// access — the caller materializes a RuleCandidate from the sidecar payload
// (readCandidate) + the DB row (getCandidate) and hands it in.
//
// DF-1 (codebase audit 2026-07-14): this renderer had ZERO production callers
// and its interface carried fields (proposed_rule, enforcement_example,
// conflicts) that NO code path in the pipeline ever produces — an abandoned
// v0.2 data model. Rendering those would be placeholder data (CR-39). It is
// reshaped here to render ONLY what the candidate pipeline actually records,
// and wired into `massu rule show <id>` so it is a real, used surface.

/** A signal as recorded in the sidecar. Looser than the detector's SignalHit
 *  (whose `name` is a fixed union) because the persisted candidate stores an
 *  arbitrary signal-name string — the renderer only reads name/applied/evidence. */
export interface PreviewSignal {
  name: string;
  applied: number;
  evidence?: string;
  baseWeight?: number;
}

/** Everything a `massu rule show` preview can truthfully display. Every field
 *  has a real producer: the sidecar payload (readCandidate) and/or the DB row
 *  (getCandidate). No field here is fabricated. */
export interface RuleCandidate {
  prompt_hash: string;
  prompt: string;
  score: number;
  signals: PreviewSignal[];
  prior_turn_files: string[];
  prior_turn_diff_snippet?: string;
  timestamp: string;
  /** DB row: 'local' | 'team' | 'pack'. */
  origin?: string;
  /** DB row: 'proposed' | 'approved' | 'dismissed' | ... */
  status?: string;
  /** Authoritative destination — set for team/pack candidates, or after a local
   *  candidate is classified. Null/undefined while a local candidate is unrouted. */
  destination?: string | null;
  /** team/pack candidates carry the authoritative draft body the publisher authored. */
  draft_text?: string;
}

const THRESHOLD = 60;

function renderSignalLine(s: PreviewSignal): string {
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

  // Section 3: origin, status, destination
  lines.push('### 3. Origin & status');
  lines.push(`- origin: ${candidate.origin ?? 'local'}`);
  lines.push(`- status: ${candidate.status ?? 'proposed'}`);
  lines.push(`- destination: ${candidate.destination ?? '(not yet chosen — decided at approve time)'}`);
  if (candidate.draft_text) {
    lines.push('- authoritative draft (team/pack):');
    lines.push(fenced('', candidate.draft_text));
  }
  lines.push('');

  // Section 4: next steps — the honest guidance a human needs to act.
  lines.push('### 4. Next steps');
  lines.push('Review the exact text that would be applied, then approve or dismiss:');
  lines.push(
    fenced(
      'bash',
      `massu rule review ${candidate.prompt_hash} --destination <dest> --draft '<text>'\n` +
        `massu rule approve ${candidate.prompt_hash} --destination <dest> --draft '<text>'\n` +
        `massu rule dismiss ${candidate.prompt_hash} --reason '<why>'`,
    ),
  );
  lines.push('');

  return lines.join('\n');
}
