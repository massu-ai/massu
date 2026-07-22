// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * cross-repo-share-advisor.ts — announce cross-repo memory surfacing in chat
 * (Living Memory Slice 5, B-11).
 *
 * An optional capability nobody can FIND does not exist. So Massu tells the
 * operator, in chat, that a decision from one of their repos can surface in
 * another — and how to turn it on. It NEVER auto-enables: detection informs, the
 * config line is consent (the same posture as the local-model advisor).
 *
 * ⛔ The trigger is REGISTRY-based, not a filesystem scan. The founding law (A-03)
 * forbids scanning `~` for repos — "no `~/repos` assumption, no hardcoded machine
 * layout." The only lawful user-level signal of "this operator has more than one
 * Massu repo" is `~/.massu/repos.json`, which fills in only as repos self-register
 * on share-enable. So a truly dormant machine (no repo ever opted in) stays SILENT,
 * preserving dormancy; once ≥1 repo has enabled sharing, other un-configured repos
 * are told they can subscribe. This module writes NO config value — a drift-guard
 * asserts it contains no writer for `memory.share.enabled`/`subscribe`.
 */

import { homedir } from 'os';
import { getConfig } from '../config.ts';
import { fingerprintOf, type Advisor, type Detection } from '../capability-advisor.ts';
import { readReposRegistry } from '../memory-repos-registry.ts';

export const CROSS_REPO_SHARE_ADVISOR_ID = 'cross-repo-sharing';
/** The two consent keys the advice points at (both default OFF). Display only. */
export const CROSS_REPO_SHARE_REMEDY_KEYS = ['memory.share.enabled', 'memory.share.subscribe'] as const;

/**
 * The testable detection core (home injected). Registry-only, no scan. Returns null
 * (silence) when no repo has enabled sharing on this machine.
 */
export function detectShareableRepos(home: string): Detection | null {
  const repos = readReposRegistry(home).repos.filter((r) => r.share_enabled);
  if (repos.length === 0) return null;
  const labels = repos.map((r) => r.label);
  return {
    // Fingerprint covers the set of shareable repos, so registering a NEW repo
    // re-triggers the offer (the operator's setup changed).
    fingerprint: fingerprintOf(repos.map((r) => r.repo_id)),
    render: () => renderOffer(labels),
  };
}

function renderOffer(repoLabels: string[]): string {
  const others = repoLabels.length === 1 ? `\`${repoLabels[0]}\`` : `${repoLabels.length} of your repos`;
  return [
    '💡 Massu can surface a decision from one of your repos in another — off by default, local-only, zero-network.',
    `   ${others} already share memory on this machine. To let THIS repo see their accepted decisions:`,
    '     1. add the repo label(s) to `memory.share.subscribe` in massu.config.yaml',
    '     2. run `massu memory review` at your next session — you accept each decision explicitly.',
    '   Nothing crosses without you accepting it, and nothing is ever an instruction. `massu memory share --help`.',
  ].join('\n');
}

export const crossRepoShareAdvisor: Advisor = {
  id: CROSS_REPO_SHARE_ADVISOR_ID,
  remedyKeys: CROSS_REPO_SHARE_REMEDY_KEYS,

  isConfigured(): boolean {
    // This repo has already opted into EITHER direction ⇒ stop advising.
    const share = getConfig().memory?.share;
    return Boolean(share?.enabled) || (Array.isArray(share?.subscribe) && share!.subscribe.length > 0);
  },

  async detect(): Promise<Detection | null> {
    return detectShareableRepos(homedir());
  },
};
