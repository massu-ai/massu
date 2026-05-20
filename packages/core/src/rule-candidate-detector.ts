// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// Rule-candidate detection scoring model (plan-v0.2-interactive-rule-approval P-A-001).
// Score-based threshold (>=60) replaces the binary correctionPatterns regex from
// prompt-analyzer.ts:59. Importable by the UserPromptSubmit hook (esbuild-bundled)
// and vitest tests.
//
// Signal semantics + weights documented in plan section 2.

// NOTE: we deliberately do NOT reuse DEFAULT_ABANDON_PATTERNS from
// prompt-analyzer.ts:22 — that regex matches "instead" and "different",
// both of which are routine CORRECTION tokens ("use X instead of Y").
// Reusing it would silently exclude the most common correction shape in
// the corpus. The detector uses a tighter, correction-specific list of
// phrases that mean "drop the previous instruction" — never substrings
// like "instead".
const CORRECTION_DISMISSAL_PATTERN =
  /\b(nevermind|never\s+mind|forget\s+it|ignore\s+(that|it)|actually\s+you('?re|\s+were)\s+right|on\s+second\s+thought|no\s+wait|scratch\s+that|disregard|abandon\s+(that|it))\b/i;

export type SignalName =
  | 'strong_correction_phrase'
  | 'negation_plus_instruction'
  | 'prior_edit_or_write'
  | 'bugfix_or_refactor_category'
  | 'prompt_length_gt_10'
  | 'running_correction_streak'
  | 'short_length_floor'
  | 'slash_command_excluded'
  | 'dismissal_phrase_excluded';

export interface SignalHit {
  name: SignalName;
  baseWeight: number;
  applied: number;
  evidence?: string;
}

export interface ScoreInputs {
  prompt: string;
  priorAssistantTurn?: { hadEditOrWrite: boolean };
  priorOutcomes?: { lastCorrectionsNeeded: number };
  category?: string;
  blacklist?: ReadonlyMap<string, number>;
}

export interface ScoreResult {
  score: number;
  signals: SignalHit[];
  emitCandidate: boolean;
}

export const RULE_CANDIDATE_THRESHOLD = 60;

const STRONG_CORRECTION_PHRASES: readonly string[] = [
  "that's wrong",
  "thats wrong",
  "that is wrong",
  "incorrect",
  "you broke",
  "you missed",
  "this is wrong",
  "should be",
  "not what i asked",
  "not what i wanted",
];

const NEGATION_TOKENS = /\b(no|not|never|don't|dont|wrong|incorrect)\b/i;
const INSTRUCTION_TOKENS = /\b(instead|use\s+\w+|make\s+it|should\s+be|actually|change\s+\w+)\b/i;

const SIGNAL_BASE_WEIGHTS: Record<SignalName, number> = {
  strong_correction_phrase: 40,
  negation_plus_instruction: 30,
  prior_edit_or_write: 25,
  bugfix_or_refactor_category: 15,
  prompt_length_gt_10: 10,
  running_correction_streak: 15,
  short_length_floor: -50,
  slash_command_excluded: -100,
  dismissal_phrase_excluded: -100,
};

function hasNegationPlusInstructionWithinWindow(prompt: string, windowWords: number): boolean {
  const words = prompt.split(/\s+/);
  const negIdx: number[] = [];
  const instIdx: number[] = [];
  for (let i = 0; i < words.length; i++) {
    if (NEGATION_TOKENS.test(words[i])) negIdx.push(i);
    const slice = words.slice(i, i + 3).join(' ');
    if (INSTRUCTION_TOKENS.test(slice)) instIdx.push(i);
  }
  for (const n of negIdx) {
    for (const inst of instIdx) {
      if (Math.abs(n - inst) <= windowWords) return true;
    }
  }
  return false;
}

function applyDismissal(base: number, dismissalCount: number): number {
  if (dismissalCount >= 5) return 0;
  if (dismissalCount > 0 && base > 0) return Math.max(0, base - dismissalCount * 10);
  return base;
}

export function scoreCorrectionPrompt(inputs: ScoreInputs): ScoreResult {
  const { prompt, priorAssistantTurn, priorOutcomes, category, blacklist } = inputs;
  const promptLower = prompt.toLowerCase();
  const trimmed = prompt.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const signals: SignalHit[] = [];

  const addSignal = (name: SignalName, evidence?: string): void => {
    const baseWeight = SIGNAL_BASE_WEIGHTS[name];
    const applied = applyDismissal(baseWeight, blacklist?.get(name) ?? 0);
    signals.push({ name, baseWeight, applied, evidence });
  };

  if (/^\/\w+/.test(trimmed)) {
    addSignal('slash_command_excluded', 'starts with /');
    return { score: SIGNAL_BASE_WEIGHTS.slash_command_excluded, signals, emitCandidate: false };
  }
  if (CORRECTION_DISMISSAL_PATTERN.test(prompt)) {
    addSignal('dismissal_phrase_excluded', 'matched CORRECTION_DISMISSAL_PATTERN');
    return { score: SIGNAL_BASE_WEIGHTS.dismissal_phrase_excluded, signals, emitCandidate: false };
  }

  if (words.length < 4) {
    addSignal('short_length_floor', `${words.length} words < 4`);
  }

  for (const phrase of STRONG_CORRECTION_PHRASES) {
    if (promptLower.includes(phrase)) {
      addSignal('strong_correction_phrase', `matched "${phrase}"`);
      break;
    }
  }

  if (hasNegationPlusInstructionWithinWindow(prompt, 8)) {
    addSignal('negation_plus_instruction', 'negation + instructional token within 8-word window');
  }

  if (priorAssistantTurn?.hadEditOrWrite) {
    addSignal('prior_edit_or_write', 'prior assistant turn contained Edit/Write/Bash');
  }

  if (category === 'bugfix' || category === 'refactor') {
    addSignal('bugfix_or_refactor_category', `category=${category}`);
  }

  if (words.length > 10) {
    addSignal('prompt_length_gt_10', `${words.length} words > 10`);
  }

  if (priorOutcomes && priorOutcomes.lastCorrectionsNeeded >= 1) {
    addSignal('running_correction_streak', `lastCorrectionsNeeded=${priorOutcomes.lastCorrectionsNeeded}`);
  }

  const score = signals.reduce((sum, s) => sum + s.applied, 0);
  return {
    score,
    signals,
    emitCandidate: score >= RULE_CANDIDATE_THRESHOLD,
  };
}
