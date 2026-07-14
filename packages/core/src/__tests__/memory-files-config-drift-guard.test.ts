// A-20 — `renderEnabled` DEFAULTS TO FALSE, and that is a LAW, not a preference.
//
// 4B is the first capability in Massu's history that WRITES FILES INTO THE USER'S MEMORY
// DIRECTORY — the place they keep their own hand-written prose, which on many machines is
// git-tracked and pushed. `@massu/core` is a public package: a brand-new write capability
// that arrives switched-ON in an `npm update` is a capability nobody consented to.
//
// The operator's standing law (`feedback_universal_product_never_one_off`) is explicit:
// optional capabilities are surfaced IN CHAT, re-offered when the user's setup changes,
// and NEVER auto-enabled. Flipping this default is not a config tweak — it is a decision
// to write to strangers' files by default. So it is pinned by a test, in the code AND in
// the shipped config schema, and it fails CLOSED on any config error.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  DEFAULT_MEMORY_FILES_CONFIG,
  resolveMemoryFilesConfig,
} from '../memory-files-config.ts';

const SRC = join(__dirname, '..');
const REPO = join(SRC, '..', '..', '..');

describe('memory.files config (A-20 drift-guard)', () => {
  it('renderEnabled defaults to FALSE — Massu may not write to your files uninvited', () => {
    expect(
      DEFAULT_MEMORY_FILES_CONFIG.renderEnabled,
      'A new write capability must never arrive switched on in an npm update.',
    ).toBe(false);
  });

  it('the SHIPPED config schema also defaults it to false (the code default is not enough)', () => {
    // A user's resolved config comes from the zod schema, so a `true` there would enable
    // writing regardless of the module default. The schema lives in its own module
    // (extracted from config.ts under the 1000-LOC cap) — this guard follows it, and
    // caught the extraction itself, which is precisely its job.
    const cfg = readFileSync(join(SRC, 'config-memory-schema.ts'), 'utf-8');
    expect(
      /renderEnabled:\s*z\.boolean\(\)\.default\(false\)/.test(cfg),
      'config.ts must declare renderEnabled default false',
    ).toBe(true);
    expect(
      /renderEnabled:\s*z\.boolean\(\)\.default\(true\)/.test(cfg),
      'renderEnabled must NOT default to true anywhere',
    ).toBe(false);
  });

  it('the mirror (read-only) is on; only the WRITE is off', () => {
    // The lossless mirror writes nothing to disk — it is safe and useful by default.
    // Withholding it would punish users for a risk that lives entirely in the renderer.
    expect(DEFAULT_MEMORY_FILES_CONFIG.enabled).toBe(true);
  });

  it('the renderer is BOUNDED by default (anti-spam + a finite MEMORY.md region)', () => {
    expect(DEFAULT_MEMORY_FILES_CONFIG.renderMaxFilesPerSession).toBeGreaterThan(0);
    expect(DEFAULT_MEMORY_FILES_CONFIG.renderMaxFilesPerSession).toBeLessThanOrEqual(10);
    // MEMORY.md is auto-loaded into EVERY turn of EVERY session. The per-session cap
    // bounds the RATE; only this bounds the TOTAL.
    expect(DEFAULT_MEMORY_FILES_CONFIG.indexMaxLines).toBeGreaterThan(0);
    expect(DEFAULT_MEMORY_FILES_CONFIG.indexMaxLines).toBeLessThanOrEqual(200);
  });

  it('resolve() FAILS CLOSED with respect to writing', () => {
    // Any config error, any missing block, any surprise: renderEnabled stays false.
    const cfg = resolveMemoryFilesConfig();
    expect(cfg.renderEnabled).toBe(false);
  });

  it('massu.config.yaml does not turn rendering on', () => {
    // The repo dogfoods massu. If OUR OWN config enabled it, the default would be a lie.
    const yaml = readFileSync(join(REPO, 'massu.config.yaml'), 'utf-8');
    expect(
      /renderEnabled:\s*true/.test(yaml),
      'massu.config.yaml must not enable the renderer',
    ).toBe(false);
  });
});
