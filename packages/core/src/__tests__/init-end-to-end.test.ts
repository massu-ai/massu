// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * STRUCTURAL gate: `npx massu init` end-to-end across all 6 Phase 7
 * framework fixtures. Plan 1.5.1 §3 deliverable.
 *
 * 1.5.0 shipped with 3 latent gaps that this gate now catches:
 *   1. CR-39 violation: phoenix + aspnet manifests unrecognized
 *      → init exited with "no languages detected"
 *   2. Variant templates dead-lettered: rails/spring/go-chi/python-flask
 *      configs lacked framework.router, correct paths.source,
 *      verification.<lang>.lint
 *   3. (deferred to a follow-on) AST adapter introspect output
 *      surfaced under detected.<adapter-id>:
 *
 * This test runs `runInit` against minimal-shape projects for each of the
 * 6 frameworks in tmpdir(), then asserts the emitted massu.config.yaml
 * carries the variant-template-defined fields. ANY future regression in
 * detection, framework-name mapping, variant-template merge, or YAML
 * emission flips this gate red.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as yamlParse } from 'yaml';
import { runInit } from '../commands/init.ts';
import { PHASE7_INIT_FIXTURES, type Phase7InitFixture as Fixture } from './fixtures/phase7-init-fixtures.ts';

const FIXTURES: Fixture[] = PHASE7_INIT_FIXTURES;

describe('init end-to-end (all 6 Phase 7 framework fixtures)', () => {
  for (const fx of FIXTURES) {
    it(`fixture=${fx.id}: produces variant-template-merged config`, async () => {
      const root = mkdtempSync(join(tmpdir(), `massu-init-e2e-${fx.id}-`));
      try {
        for (const f of fx.files) {
          const fullPath = join(root, f.path);
          mkdirSync(join(fullPath, '..'), { recursive: true });
          writeFileSync(fullPath, f.content, 'utf-8');
        }

        await runInit([], {
          cwd: root,
          ci: true,
          force: true,
          silent: true,
          skipSideEffects: true,
        });

        const configPath = join(root, 'massu.config.yaml');
        const content = readFileSync(configPath, 'utf-8');
        const config = yamlParse(content) as Record<string, unknown>;

        // Assert detection identified the language correctly.
        const fw = config.framework as Record<string, unknown>;
        expect(fw.type, `framework.type should be ${fx.expect['framework.type']}`).toBe(fx.expect['framework.type']);

        // Assert variant template populated the router (the key gap 1.5.0 had).
        expect(fw.router, `framework.router should be ${fx.expect['framework.router']} (from variant template)`).toBe(fx.expect['framework.router']);

        // Assert per-language framework hint is populated.
        const langs = fw.languages as Record<string, unknown>;
        for (const [lang, expected] of Object.entries(fx.expect['framework.languages'])) {
          const langEntry = langs[lang] as Record<string, unknown>;
          expect(langEntry, `framework.languages.${lang} should exist`).toBeDefined();
          expect(langEntry.framework, `framework.languages.${lang}.framework`).toBe(expected.framework);
        }

        // Assert paths.source matches variant template.
        const paths = config.paths as Record<string, unknown>;
        expect(paths.source, `paths.source should be ${fx.expect['paths.source']}`).toBe(fx.expect['paths.source']);

        // Assert verification.<lang>.lint is set (variant-template-supplied).
        const lang = Object.keys(fx.expect['framework.languages'])[0];
        const verification = config.verification as Record<string, Record<string, unknown>> | undefined;
        const langVerify = verification?.[lang];
        expect(langVerify?.lint, `verification.${lang}.lint should be set from variant template`).toBeTruthy();

        // Plan 1.5.4 §3: assert AST adapter introspect output piped into
        // emitted config under `detected.<adapter-id>:`. The fixture id
        // matches the adapter id (rails/phoenix/aspnet/spring/go-chi).
        const detected = config.detected as Record<string, unknown> | undefined;
        const detectedBlock = detected?.[fx.id] as Record<string, unknown> | undefined;
        // Lenient on presence (grammar load can fail in offline CI), but
        // strict on shape if present: must carry _confidence + at least
        // one extracted convention key. Failure would mean the adapter
        // ran but its output was lost in the emission pipeline.
        if (detectedBlock) {
          expect(detectedBlock._confidence, `detected.${fx.id}._confidence must be set`).toBeDefined();
          expect(detectedBlock._confidence).not.toBe('none');
          // At least one non-meta key (excluding _confidence + _provenance).
          const conventionKeys = Object.keys(detectedBlock).filter((k) => !k.startsWith('_'));
          expect(conventionKeys.length, `detected.${fx.id} must carry at least one extracted convention`).toBeGreaterThan(0);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
