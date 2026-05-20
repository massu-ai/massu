// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-D-002: classifier for rule
// candidates. Encodes the §3 rubric — evaluated in order, first match
// wins. Pure function; no I/O.

import type { RuleDestination } from './rule-candidate-applier.ts';

export interface CustomDestinationConfig {
  name: string;
  path: string;
  triggerKeywords: string[];
  template: string;
}

export interface ClassifierConfig {
  customDestinations?: CustomDestinationConfig[];
}

export interface ClassifyInputs {
  prompt: string;
  /** Files touched in the prior assistant turn — informs rubric rule 1. */
  prior_turn_files?: string[];
}

export interface ClassifyResult {
  destination: RuleDestination;
  reason: string;
  /** Set for `custom-destination` — the matched config entry. */
  destination_extra?: CustomDestinationConfig;
}

// Rubric rule 1 patterns — literal-grepable tokens.
// Matches any quoted string of 2-80 non-quote non-newline chars. Broad on
// purpose: a quoted token in a correction prompt is the strongest signal
// that the rule belongs in a grep-based scanner check.
const QUOTED_LITERAL = /(['"`])[^'"`\n]{2,80}\1/;
const IMPORT_STATEMENT = /\bimport\s+\w/;
const SHELL_TS_FILENAME = /\b[\w.-]+\.(sh|ts|tsx|js|jsx|mjs|cjs|md|yaml|yml|json)\b/;
const REGEX_LITERAL = /\/(?:[^\/\\]|\\.){2,}\//;

// Rubric rule 2 patterns — process / protocol wording.
const PROCESS_PROTOCOL = /\b(always|never|must|should always|before .+? you|always run .+? before|protocol|process|workflow|each time|every time|whenever)\b/i;

/**
 * Classify a rule candidate to a destination per §3 rubric.
 *
 * Order: (1) pattern-scanner if literal-grepable; (2) claude-md-cr if process
 * wording; (3) custom-destination if config matches; (4) corrections-md default.
 *
 * NOTE: order intentionally tries pattern-scanner first because grep-able
 * patterns are the most mechanical destination. Custom-destination runs
 * AFTER the framework destinations have had a chance to match — config
 * keywords should only win when the prompt is NOT a candidate for the
 * generic destinations.
 */
export function classifyCandidate(
  inputs: ClassifyInputs,
  config: ClassifierConfig = {}
): ClassifyResult {
  const { prompt } = inputs;

  // Rubric rule 1: pattern-scanner if literal-grepable token.
  if (QUOTED_LITERAL.test(prompt)) {
    const match = prompt.match(QUOTED_LITERAL)?.[0] ?? '';
    return {
      destination: 'pattern-scanner',
      reason: `literal-grepable quoted token detected: ${match}`,
    };
  }
  if (IMPORT_STATEMENT.test(prompt)) {
    return {
      destination: 'pattern-scanner',
      reason: `import statement detected in correction text`,
    };
  }
  if (SHELL_TS_FILENAME.test(prompt)) {
    const match = prompt.match(SHELL_TS_FILENAME)?.[0] ?? '';
    return {
      destination: 'pattern-scanner',
      reason: `filename token detected: ${match}`,
    };
  }
  if (REGEX_LITERAL.test(prompt)) {
    return {
      destination: 'pattern-scanner',
      reason: `regex literal detected in correction text`,
    };
  }

  // Rubric rule 2: claude-md-cr if process wording.
  if (PROCESS_PROTOCOL.test(prompt)) {
    const match = prompt.match(PROCESS_PROTOCOL)?.[0] ?? '';
    return {
      destination: 'claude-md-cr',
      reason: `process/protocol wording: "${match}"`,
    };
  }

  // Rubric rule 4: custom-destination if config triggerKeywords match.
  for (const dest of config.customDestinations ?? []) {
    for (const kw of dest.triggerKeywords ?? []) {
      if (!kw) continue;
      const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i');
      if (re.test(prompt)) {
        return {
          destination: 'custom-destination',
          reason: `matched custom destination "${dest.name}" via keyword "${kw}"`,
          destination_extra: dest,
        };
      }
    }
  }

  // Rubric rule 3: corrections-md (default catchall).
  return {
    destination: 'corrections-md',
    reason: 'no scanner / CR / custom-destination signal — default catchall',
  };
}

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
