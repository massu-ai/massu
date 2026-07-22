// Slice 5 — B-11: the capability advisor announces cross-repo sharing in chat and
// NEVER auto-enables it. Detection is registry-only (no filesystem scan, A-03 law).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { detectShareableRepos, crossRepoShareAdvisor } from '../advisors/cross-repo-share-advisor.ts';
import { runAdvisors } from '../capability-advisor.ts';
import { upsertRepoRegistration } from '../memory-repos-registry.ts';
import { getConfig } from '../config.ts';

describe('Slice 5 B-11 — cross-repo share advisor', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'massu-adv-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('dormant machine (empty registry) ⇒ silence', () => {
    expect(detectShareableRepos(home)).toBeNull();
  });

  it('≥1 shareable repo ⇒ an offer that names the repo and points at the consent keys', () => {
    upsertRepoRegistration(
      { repo_id: '11111111-1111-1111-1111-111111111111', label: 'massu', pubkey_fingerprint: 'f', last_seen_path: '/x', share_enabled: true },
      home,
    );
    const d = detectShareableRepos(home);
    expect(d).not.toBeNull();
    const rendered = d!.render();
    expect(rendered).toContain('massu');
    expect(rendered).toContain('memory.share.subscribe');
    expect(rendered).toMatch(/off by default/i);
  });

  it('a NEW registered repo changes the fingerprint (re-triggers the offer)', () => {
    upsertRepoRegistration(
      { repo_id: '11111111-1111-1111-1111-111111111111', label: 'a', pubkey_fingerprint: 'f', last_seen_path: '/x', share_enabled: true },
      home,
    );
    const fp1 = detectShareableRepos(home)!.fingerprint;
    upsertRepoRegistration(
      { repo_id: '22222222-2222-2222-2222-222222222222', label: 'b', pubkey_fingerprint: 'f', last_seen_path: '/y', share_enabled: true },
      home,
    );
    expect(detectShareableRepos(home)!.fingerprint).not.toBe(fp1);
  });

  it('isConfigured reflects THIS repo\'s opt-in (real config: sharing OFF ⇒ not configured)', () => {
    expect(crossRepoShareAdvisor.isConfigured()).toBe(false);
  });

  it('the advisor NEVER writes a config value — memory.share.enabled stays false', async () => {
    upsertRepoRegistration(
      { repo_id: '33333333-3333-3333-3333-333333333333', label: 'c', pubkey_fingerprint: 'f', last_seen_path: '/z', share_enabled: true },
      home,
    );
    await runAdvisors([crossRepoShareAdvisor], { enabled: true, suggestIntervalDays: 30, home });
    // The advisor emits chat text only; it touches no config.
    expect(getConfig().memory?.share?.enabled ?? false).toBe(false);
  });
});

describe('Slice 5 B-11 — advisor writes no config (structural)', () => {
  it('the advisor module contains no writer for the share consent keys', () => {
    const src = readFileSync(join(__dirname, '..', 'advisors', 'cross-repo-share-advisor.ts'), 'utf-8');
    // No WRITE of a share config key, no file write. (Naming massu.config.yaml in the
    // offer TEXT is advice, not a write — that is the whole point of the advisor.)
    expect(src).not.toMatch(/\.enabled\s*=\s*(true|false)/);
    expect(src).not.toMatch(/subscribe\s*=\s*\[/);
    expect(src).not.toMatch(/writeFileSync|setConfig\b|writeConfig/);
  });
});
