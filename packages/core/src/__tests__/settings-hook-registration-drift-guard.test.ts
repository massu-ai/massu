// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * CR-62 DRIFT-GUARD — a massu hook must be registered in EXACTLY ONE settings layer.
 *
 * 2026-07-21: `.claude/settings.json` (dev-build path
 * `$CLAUDE_PROJECT_DIR/packages/core/dist/hooks/…`) and `.claude/settings.local.json`
 * (installed `node_modules/@massu/core/dist/hooks/…` path) BOTH registered 11 overlapping
 * hooks. Claude Code MERGES hook layers without deduping, so every shared hook fired TWICE
 * per event — silently double-inserting every memory observation (5,018 rows, ~50% dupes)
 * and double-running security-gate / incident-pipeline / auto-learning-pipeline for a long
 * time. It surfaced only when the WS3 render dry-run exposed the polluted memory corpus.
 *
 * This guard makes the class impossible: a hook script registered in more than one settings
 * layer, or more than once within a layer, fails the suite (which the pre-commit gate runs).
 *
 * Regression origin: a 2026-07-21 memory-ingestion decision-noise incident.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const CLAUDE_DIR = resolve(REPO_ROOT, '.claude');

const LAYERS = ['settings.json', 'settings.local.json']
  .map((f) => resolve(CLAUDE_DIR, f))
  .filter((p) => existsSync(p));

// Meaningful only where a committed .claude/settings.json exists (the internal repo).
const IS_INTERNAL = existsSync(resolve(CLAUDE_DIR, 'settings.json'));

/** Every reference to a built massu node hook `.../dist/hooks/<name>.js`, by base name. */
function hookScripts(file: string): string[] {
  const text = readFileSync(file, 'utf-8');
  const out: string[] = [];
  const re = /dist\/hooks\/([a-z0-9-]+)\.js/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

describe.runIf(IS_INTERNAL)('CR-62 — massu hooks registered in exactly one settings layer', () => {
  it('no hook script is registered in more than one settings layer (the double-fire class)', () => {
    const perLayer = LAYERS.map((p) => ({ file: p, scripts: new Set(hookScripts(p)) }));
    const collisions: string[] = [];
    for (let i = 0; i < perLayer.length; i++) {
      for (let j = i + 1; j < perLayer.length; j++) {
        for (const s of perLayer[i].scripts) {
          if (perLayer[j].scripts.has(s)) collisions.push(s);
        }
      }
    }
    expect(
      collisions,
      `hook(s) registered in >1 settings layer → they fire twice per event: ${collisions.join(', ')}. ` +
        `Register each massu hook in exactly one layer (canonical: .claude/settings.json, dev-build path).`,
    ).toEqual([]);
  });

  it('no hook script is registered more than once within a single settings layer', () => {
    for (const file of LAYERS) {
      const all = hookScripts(file);
      const dupes = all.filter((s, i) => all.indexOf(s) !== i);
      expect([...new Set(dupes)], `duplicate hook registration within ${file}`).toEqual([]);
    }
  });

  it('every security-critical + core hook is present in the canonical layer (no silent drop)', () => {
    // CR-52 security LOW-B: the collision check catches DOUBLE registration; this catches
    // the opposite failure — a future edit silently DROPPING a hook. A missing security-gate
    // or pre-delete-check would disable a defensive gate with the suite still green.
    const present = new Set(hookScripts(resolve(CLAUDE_DIR, 'settings.json')));
    const REQUIRED = [
      'security-gate',
      'pre-delete-check',
      'post-tool-use',
      'session-start',
      'session-end',
      'user-prompt',
      'memory-recall',
      'pre-compact',
    ];
    const missing = REQUIRED.filter((h) => !present.has(h));
    expect(missing, `security-critical/core hook(s) missing from settings.json: ${missing.join(', ')}`).toEqual([]);
  });

  it('the canonical layer uses the dev-build path, not an installed node_modules path', () => {
    const text = readFileSync(resolve(CLAUDE_DIR, 'settings.json'), 'utf-8');
    // The committed dev config must run the code being edited, not the published package.
    expect(text.includes('node_modules/@massu/core/dist/hooks'), 'settings.json must not register node_modules hooks').toBe(false);
    expect(/packages\/core\/dist\/hooks/.test(text), 'settings.json must use the dev-build hook path').toBe(true);
  });
});
