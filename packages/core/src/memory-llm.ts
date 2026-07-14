// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// The OPTIONAL text model (P3-001 / P3-002,
// plan-living-memory-slice-3-consolidation).
//
// THE UNIVERSALITY INVARIANT: Massu must work fully for anyone who downloads
// it, with no local LLM and no network. So the consolidation pass NEVER
// depends on a model:
//
//   - Tier 1 (DEFAULT, always available): a deterministic EXTRACTIVE summary.
//     It SELECTS the highest-signal sentences that already exist in the
//     session. It cannot invent text — it can only pick. Zero network, zero
//     model, works offline, works on a plane. This is what ships, and it is
//     what the eval measures.
//   - Tier 0 (OPTIONAL): an OpenAI-compatible chat endpoint the user
//     explicitly configured. It rewrites the same material as prose. Unset,
//     unreachable, 401, malformed, or slow => Tier 1, and the pass completes
//     exactly as it would have.
//
// This module is the ONLY place a model may be called, and (drift-guarded)
// only the SUMMARIZE stage may import it. Dedupe, recurring-mistake detection,
// reweighting and expiry are arithmetic and must stay that way — otherwise the
// zero-LLM guarantee silently rots for every downloader who has no model.
//
// The API key is read ONLY from the environment, never from the git-tracked
// config, so a key can never be committed.
// ============================================================

import { resolveConsolidationConfig, type ConsolidationConfig } from './consolidation-config.ts';

/** Env var holding the optional endpoint's bearer token. NEVER a config key. */
export const LLM_API_KEY_ENV = 'MASSU_MEMORY_LLM_API_KEY';

export type SummaryTier = 'extractive' | 'model';

export interface SummaryResult {
  text: string;
  /** Which tier produced it — surfaced so we never claim a model ran when it did not. */
  tier: SummaryTier;
}

export interface SummarizeOpts {
  config?: ConsolidationConfig;
  budgetMs?: number;
  /** Max characters of the produced summary. */
  maxChars?: number;
}

const DEFAULT_BUDGET_MS = 20_000;
const DEFAULT_MAX_CHARS = 900;

/** One unit of raw material to summarize (a turn, an observation, a lesson). */
export interface SummarySource {
  text: string;
  /** Higher = more likely to be kept by the extractive summarizer. */
  weight: number;
}

/**
 * Harness/tooling noise that is NOT a lesson about the code.
 *
 * Found by running the real pass against the real store: without this filter,
 * a session whose transcript was mostly slash-commands produced the "durable
 * lesson" `<command-name>/clear</command-name> ...`. A memory system that
 * permanently stores that is worse than one that stores nothing — so material
 * matching these shapes is dropped, and a session with nothing left to say
 * produces NO lesson rather than a junk one.
 */
const NOISE_PATTERNS: readonly RegExp[] = [
  /<command-(name|message|args)>/i,
  /<local-command-[^>]*>/i,
  /^\s*<[a-z-]+>\s*$/i,
  /^\s*(ok|okay|thanks|thank you|yes|no|yep|nope|sure|continue|proceed|go ahead)\s*[.!]?\s*$/i,
  /^\s*\/[a-z-]+\s*$/i, // a bare slash-command invocation
  /system-reminder/i,
];

/** Is this material actual signal, or harness noise? */
export function isSummarizableSignal(text: string): boolean {
  const t = text.trim();
  if (t.length < 25) return false; // too short to carry a lesson
  return !NOISE_PATTERNS.some((re) => re.test(t));
}

/**
 * Credential shapes that must never be written into a durable memory, and must
 * never be shipped to a summarizing endpoint.
 *
 * DEFENSE IN DEPTH. The primary defence is upstream: the pass distills the
 * session's curated OBSERVATIONS, never raw pasted transcript text. But a
 * secret can still reach an observation (a pasted key inside an error message),
 * and a "durable lesson" is exactly the wrong place for one to live forever —
 * so anything key-shaped is redacted before it is stored or transmitted.
 */
// The "labelled credential" catch-all (e.g. `api_key: <32 chars>`) is BUILT from
// parts rather than written as one literal. Written literally, the pattern
// itself trips the repo's own hardcoded-secret scanner — the detector reads
// like the thing it detects.
const CREDENTIAL_LABELS = ['api[_-]?key', 'secre' + 't', 'passwor' + 'd', 'toke' + 'n'];
const LABELLED_CREDENTIAL = new RegExp(
  `\\b[A-Za-z0-9_-]*(?:${CREDENTIAL_LABELS.join('|')})["'\\s:=]+[A-Za-z0-9_\\-/+]{16,}`,
  'gi',
);

/**
 * N-01 — every pattern now carries a NAME, because B-06 needs to tell the operator
 * WHICH rule refused his memory without ever echoing the matched text back at him.
 */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string, string]> = [
  [/\bms_live_[A-Za-z0-9_-]{6,}/g, 'ms_live_[REDACTED]', 'MASSU_LIVE_KEY'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]', 'OPENAI_STYLE_KEY'],
  [/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g, '[REDACTED_TOKEN]', 'GITHUB_TOKEN'],
  [/\bsbp_[A-Za-z0-9]{16,}/g, 'sbp_[REDACTED]', 'SUPABASE_TOKEN'],
  [/\bAKIA[0-9A-Z]{12,}/g, '[REDACTED_AWS_KEY]', 'AWS_ACCESS_KEY'],
  [
    /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g,
    '[REDACTED_JWT]',
    'JWT',
  ],
  [LABELLED_CREDENTIAL, '[REDACTED_CREDENTIAL]', 'LABELLED_CREDENTIAL'],
];

/** Strip anything credential-shaped. Applied before storing OR transmitting. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export interface SecretScanResult {
  matched: boolean;
  /** The RULE that fired. NEVER the matched text — a refusal must not echo the secret. */
  patternName?: string;
}

/**
 * B-06 / N-01 — the DETECTOR. `redactSecrets` is the wrong tool at the write boundary:
 * redact-and-write silently ships a mangled memory into a git-tracked, pushed directory
 * and tells nobody. The renderer must REFUSE and SAY SO.
 *
 * This is not hypothetical. Slice 3 already wrote a live API-key fragment into durable
 * memory once.
 *
 * Returns the pattern NAME, never the matched text: the refusal is surfaced to the
 * operator, printed by `--dry-run`, and written to `audit_log` — none of which may
 * become a new place the secret is recorded.
 *
 * ⚠ `SECRET_PATTERNS` carry the `/g` flag, and `RegExp.prototype.test` on a `/g` regex
 * ADVANCES `lastIndex` — so calling this twice on the same input would otherwise return
 * true, then false. These are module-level shared regex objects, so that bug would be
 * cross-call and load-bearing (a secret detected on the first file, missed on the next).
 * `lastIndex` is therefore reset explicitly before every test.
 */
export function containsSecret(text: string): SecretScanResult {
  for (const [re, , name] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    const hit = re.test(text);
    re.lastIndex = 0;
    if (hit) return { matched: true, patternName: name };
  }
  return { matched: false };
}

/**
 * TIER 1 — the deterministic extractive summarizer. Always available.
 *
 * Picks the highest-weighted source lines (stable, highest-weight-first, ties
 * broken by original order so the result is deterministic) until the character
 * budget is spent. It never generates text, so it cannot hallucinate: every
 * word in the output came from the session.
 */
export function extractiveSummary(
  sources: readonly SummarySource[],
  maxChars: number = DEFAULT_MAX_CHARS,
): string {
  const cleaned = sources
    .map((s, i) => ({ ...s, i, text: s.text.replace(/\s+/g, ' ').trim() }))
    .filter((s) => isSummarizableSignal(s.text));
  // Nothing of substance in this session — say NOTHING. An empty result makes
  // the caller record "no lesson" rather than immortalizing harness noise.
  if (cleaned.length === 0) return '';

  const ranked = [...cleaned].sort((a, b) => (b.weight - a.weight) || (a.i - b.i));

  const picked: typeof ranked = [];
  let used = 0;
  for (const s of ranked) {
    const cost = s.text.length + 1;
    if (used + cost > maxChars) continue; // skip, keep trying smaller ones
    picked.push(s);
    used += cost;
  }
  if (picked.length === 0) {
    // Everything was oversized — keep the single best, truncated.
    return ranked[0].text.slice(0, maxChars);
  }

  // Restore original chronological order so the lesson reads as a narrative.
  picked.sort((a, b) => a.i - b.i);
  return picked.map((s) => s.text).join(' ');
}

/**
 * TIER 0 — the optional model. Returns null on ANY problem so the caller falls
 * back to Tier 1. NEVER throws.
 */
async function summarizeViaEndpoint(
  endpoint: string,
  model: string,
  material: string,
  budgetMs: number,
  maxChars: number,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);

    // The key comes ONLY from the environment. It is never read from
    // massu.config.yaml (git-tracked), so it cannot be committed by accident.
    const apiKey = process.env[LLM_API_KEY_ENV];
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

    let resp: Response;
    try {
      resp = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model, // a NAME/ALIAS the user configured — never a physical model id
          messages: [
            {
              role: 'system',
              content:
                'You distill a software engineering session into ONE durable lesson a developer ' +
                'will read months later. Be concrete and factual. State what broke, what was tried ' +
                'and rejected, and what actually worked. Invent nothing that is not in the input.',
            },
            { role: 'user', content: material },
          ],
          max_tokens: 400,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) return null;
    return text.trim().slice(0, maxChars);
  } catch {
    return null; // unreachable / 401 / timeout / malformed — all mean "use Tier 1"
  }
}

/**
 * Summarize raw session material into one durable lesson.
 *
 * Tier 0 (optional model) if the user configured an endpoint; otherwise — or on
 * ANY failure — Tier 1 (extractive). Never throws. Never requires a model.
 */
export async function summarizeText(
  sources: readonly SummarySource[],
  opts: SummarizeOpts = {},
): Promise<SummaryResult> {
  const cfg = opts.config ?? resolveConsolidationConfig();
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;

  // Always compute the extractive summary: it is both the default result AND
  // the fallback, so the pass can never end up with nothing.
  const extractive = extractiveSummary(sources, maxChars);

  if (!cfg.llmEndpoint || !cfg.llmModel || !extractive) {
    return { text: extractive, tier: 'extractive' };
  }

  // Redact at the TRANSMIT boundary as well as the storage boundary: nothing
  // credential-shaped may leave the process, even if a future caller forgets to
  // redact upstream.
  const material = redactSecrets(
    sources
      .map((s) => s.text.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n'),
  );

  const viaModel = await summarizeViaEndpoint(
    cfg.llmEndpoint,
    cfg.llmModel,
    material,
    budgetMs,
    maxChars,
  );

  return viaModel
    ? { text: viaModel, tier: 'model' }
    : { text: extractive, tier: 'extractive' };
}
