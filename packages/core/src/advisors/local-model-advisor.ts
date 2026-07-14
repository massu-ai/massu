// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// The local-model advisor (P6-005, plan-living-memory-slice-3-consolidation).
//
// Detects an OpenAI-compatible / Ollama model server on THIS machine and, if
// the user has not configured one, explains — in chat, in plain English — what
// it would improve, what it costs them, and exactly how to switch it on.
//
// PRIVACY, non-negotiable:
//   * The probe is LOCALHOST-ONLY and asks a single question: "what models do
//     you have?" (`/api/tags`, `/v1/models`). No memory, no prompt, no session
//     text is ever sent by the probe.
//   * Detecting a model NEVER enables it. Sending session text to a server —
//     even one on the user's own machine — is a decision only the user can
//     make. This module contains no writer for llmEndpoint/llmModel, and a
//     drift-guard enforces that.
// ============================================================

import {
  fingerprintOf,
  type Advisor,
  type Detection,
} from '../capability-advisor.ts';
import { resolveConsolidationConfig } from '../consolidation-config.ts';

export const LOCAL_MODEL_ADVISOR_ID = 'local-model-summaries';

/** Config keys the advice tells the user to set (drift-guarded to exist). */
export const LOCAL_MODEL_REMEDY_KEYS = ['llmEndpoint', 'llmModel'] as const;

/** Where local model servers conventionally listen. Localhost only. */
const CANDIDATE_ENDPOINTS: ReadonlyArray<{ url: string; label: string }> = [
  { url: 'http://localhost:11434', label: 'Ollama' },
  { url: 'http://localhost:1234', label: 'LM Studio' },
  { url: 'http://localhost:8300', label: 'local OpenAI-compatible server' },
  { url: 'http://localhost:8080', label: 'local OpenAI-compatible server' },
];

const PROBE_BUDGET_MS = 800;

export interface LocalModelFinding {
  endpoint: string;
  label: string;
  models: string[];
}

async function fetchJson(url: string, budgetMs: number): Promise<unknown | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) return null;
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null; // nothing listening / not JSON / slow — treat as "not found"
  }
}

/**
 * Probe localhost for a model server. Returns the first one found, with its
 * model names. Never throws; a dead port is simply "not detected".
 */
export async function detectLocalModel(
  endpoints: ReadonlyArray<{ url: string; label: string }> = CANDIDATE_ENDPOINTS,
  budgetMs: number = PROBE_BUDGET_MS,
): Promise<LocalModelFinding | null> {
  for (const cand of endpoints) {
    // Ollama's native listing.
    const tags = (await fetchJson(`${cand.url}/api/tags`, budgetMs)) as
      | { models?: Array<{ name?: string }> }
      | null;
    const ollamaModels = (tags?.models ?? [])
      .map((m) => m?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (ollamaModels.length > 0) {
      return { endpoint: cand.url, label: cand.label, models: ollamaModels };
    }

    // OpenAI-compatible listing.
    const v1 = (await fetchJson(`${cand.url}/v1/models`, budgetMs)) as
      | { data?: Array<{ id?: string }> }
      | null;
    const v1Models = (v1?.data ?? [])
      .map((m) => m?.id)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (v1Models.length > 0) {
      return { endpoint: cand.url, label: cand.label, models: v1Models };
    }
  }
  return null;
}

/**
 * The message the user actually reads, in their chat, unprompted.
 *
 * It has to stand on its own: what was found, what Massu does today without
 * it, what changes, why they'd care, the honest downsides, and the exact
 * steps — including simply asking Massu to do it for them.
 */
export function renderLocalModelOffer(finding: LocalModelFinding): string {
  const model = finding.models[0];
  const more = finding.models.length > 1 ? ` (and ${finding.models.length - 1} more)` : '';

  return [
    '💡 **Massu found a local AI model on your machine — you can make your memory noticeably better, for free.**',
    '',
    `**What I found:** ${finding.label} at \`${finding.endpoint}\`, running \`${model}\`${more}.`,
    '',
    "**What Massu does today (without it):** every few days, just before your raw chat transcripts are deleted, Massu distills each session into one permanent lesson. Right now it builds that lesson by *selecting* the most important lines that already exist. Nothing is invented, but it reads like clipped notes:",
    '',
    '> *"Login hangs with no terminal. Failed attempt: fail-fast on non-TTY — broke `echo key | massu login`. Fix: bounded 2s read."*',
    '',
    '**What changes if you turn this on:** the same facts get written as an explanation you will actually understand in six months:',
    '',
    '> *"`massu login` hung forever when run without a terminal, because it waited on input that never arrived. The first fix — refusing to run without a terminal — was wrong; it broke piping a key in. The working fix bounds the read to 2 seconds."*',
    '',
    '**Why it matters:** these lessons are what Massu hands back to you months later when you hit the same problem. Clearer lessons mean better recall. It affects **only** these summaries — finding duplicates, spotting mistakes you keep repeating, and deciding what to forget are all arithmetic, and are already at full strength.',
    '',
    '**Pros:** better-written memory; everything stays on your machine; free; no extra memory used while idle.',
    '**Cons:** your session text is sent to that local server while it writes the summary (it never leaves your machine, but it is a program you are choosing to trust); summarizing adds a few seconds at session end; a model can occasionally word a lesson imprecisely — which is why Massu never lets a generated summary override something *you* wrote, only sit alongside it.',
    '',
    '**To turn it on — just say "enable local summaries" and I will do it for you.** Or add this to `massu.config.yaml`:',
    '',
    '```yaml',
    'memory:',
    '  consolidation:',
    `    llmEndpoint: "${finding.endpoint}"`,
    `    llmModel: "${model}"`,
    '```',
    '',
    '**Not interested?** Say "don\'t suggest this again" (or set `memory.consolidation.suggestUpgrades: false`). Massu works completely without it.',
  ].join('\n');
}

export const localModelAdvisor: Advisor = {
  id: LOCAL_MODEL_ADVISOR_ID,
  remedyKeys: LOCAL_MODEL_REMEDY_KEYS,

  isConfigured(): boolean {
    const cfg = resolveConsolidationConfig();
    return Boolean(cfg.llmEndpoint && cfg.llmModel);
  },

  async detect(): Promise<Detection | null> {
    const finding = await detectLocalModel();
    if (!finding) return null;
    return {
      // The fingerprint covers the endpoint AND the model list, so installing a
      // model later — or swapping an 8B for a 70B — re-triggers the offer.
      fingerprint: fingerprintOf([finding.endpoint, ...finding.models]),
      render: () => renderLocalModelOffer(finding),
    };
  },
};
