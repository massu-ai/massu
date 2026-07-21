// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * CR-66 drift-guard: a config-template's shipped `verification.<lang>` command
 * block MUST equal the canonical `vr-command-map.ts` output for that language
 * (dir-normalized, null-stripped) — `vr-command-map.ts:getVRCommands()` is the
 * single source of truth. Any intentional divergence lives in the single
 * exported `TEMPLATE_VERIFICATION_MAP_EXEMPT` allowlist AND must actually
 * diverge (a stale exemption FAILS).
 *
 * This gate is FILESYSTEM-DERIVED: it enumerates every real
 * `packages/core/templates/<id>/massu.config.yaml`, so a NEW template is
 * auto-covered and cannot silently reintroduce the two-authoring-site drift
 * class (incident 2026-07-18). Plan: plan-swift-ios-config-template-drift.
 *
 * Mutation checks this gate catches:
 *   - deleting/editing a LOCKED template's `verification.<lang>` line -> RED
 *   - a template drifting from the map without an allowlist entry -> RED
 *   - a stale exemption (exempt template that now matches the map) -> RED
 *   - `swift-ios` sneaking into the allowlist -> RED
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse } from 'yaml';
import {
  getVRCommands,
  TEMPLATE_VERIFICATION_MAP_EXEMPT,
  type VRCommandSet,
} from '../detect/vr-command-map.ts';
import type { SupportedLanguage } from '../detect/package-detector.ts';
import type { FrameworkInfo } from '../detect/framework-detector.ts';

const TEMPLATES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'templates'
);

/** Strip a leading `cd <dir> && ` prefix so per-app blocks normalize to dir=''. */
function stripCdPrefix(cmd: string): string {
  return cmd.replace(/^cd\s+\S+\s+&&\s+/, '');
}

/** Build a FrameworkInfo from a template's `framework.languages.<lang>` node. */
function fwInfoFrom(langNode: Record<string, unknown> | undefined): FrameworkInfo {
  return {
    framework: (langNode?.framework as string | undefined) ?? null,
    version: null,
    test_framework: (langNode?.test_framework as string | undefined) ?? null,
    orm: (langNode?.orm as string | undefined) ?? null,
    ui_library: null,
    router: null,
  };
}

/** Map output with null keys dropped — the canonical block a template must match. */
function nullStrippedMap(
  lang: SupportedLanguage,
  fw: FrameworkInfo
): Record<string, string> {
  const cmds: VRCommandSet = getVRCommands(lang, fw, '');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cmds)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/** A template's shipped `verification.<lang>` block, cd-normalized. */
function normalizedTemplateBlock(
  block: Record<string, unknown>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(block)) {
    if (typeof v === 'string') out[k] = stripCdPrefix(v);
  }
  return out;
}

interface TemplateModel {
  id: string;
  languages: Record<string, Record<string, unknown>>;
  verification: Record<string, Record<string, unknown>>;
}

function loadTemplates(): TemplateModel[] {
  const ids = readdirSync(TEMPLATES_DIR).filter((name) =>
    statSync(join(TEMPLATES_DIR, name)).isDirectory()
  );
  return ids.map((id) => {
    const configPath = join(TEMPLATES_DIR, id, 'massu.config.yaml');
    const parsed = yamlParse(readFileSync(configPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const framework = (parsed.framework ?? {}) as Record<string, unknown>;
    const languages = (framework.languages ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const verification = (parsed.verification ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    return { id, languages, verification };
  });
}

/** True when the template's verification block equals the map for EVERY language. */
function matchesMapForAllLangs(t: TemplateModel): boolean {
  const langs = Object.keys(t.verification);
  if (langs.length === 0) return false;
  return langs.every((lang) => {
    const expected = nullStrippedMap(
      lang as SupportedLanguage,
      fwInfoFrom(t.languages[lang])
    );
    const actual = normalizedTemplateBlock(t.verification[lang]);
    try {
      expect(actual).toEqual(expected);
      return true;
    } catch {
      return false;
    }
  });
}

describe('CR-66: template verification blocks bind to the vr-command-map SoT', () => {
  const templates = loadTemplates();

  it('finds template configs on disk (filesystem-derived, not static)', () => {
    expect(templates.length).toBeGreaterThan(0);
    // Every template must carry a verification block (nothing ships without one).
    for (const t of templates) {
      expect(
        Object.keys(t.verification).length,
        `${t.id}: massu.config.yaml has no verification block`
      ).toBeGreaterThan(0);
    }
  });

  for (const t of loadTemplates()) {
    const exemptReason = TEMPLATE_VERIFICATION_MAP_EXEMPT[t.id];
    if (exemptReason) {
      it(`${t.id}: EXEMPT — actually diverges from the map (no stale exemption)`, () => {
        expect(
          matchesMapForAllLangs(t),
          `${t.id} is in TEMPLATE_VERIFICATION_MAP_EXEMPT but now MATCHES the map — remove the stale exemption`
        ).toBe(false);
      });
    } else {
      it(`${t.id}: LOCKED — verification block equals the vr-command-map output`, () => {
        for (const lang of Object.keys(t.verification)) {
          const expected = nullStrippedMap(
            lang as SupportedLanguage,
            fwInfoFrom(t.languages[lang])
          );
          const actual = normalizedTemplateBlock(t.verification[lang]);
          expect(
            actual,
            `${t.id}.verification.${lang} drifted from vr-command-map.ts:getVRCommands('${lang}') — the map is the SoT (CR-66)`
          ).toEqual(expected);
        }
      });
    }
  }

  it('every exemption names a real template that still diverges', () => {
    for (const id of Object.keys(TEMPLATE_VERIFICATION_MAP_EXEMPT)) {
      const dir = join(TEMPLATES_DIR, id);
      expect(existsSync(dir), `exemption '${id}' names a non-existent template`).toBe(
        true
      );
      const t = templates.find((x) => x.id === id)!;
      expect(
        matchesMapForAllLangs(t),
        `exemption '${id}' no longer diverges from the map — remove it`
      ).toBe(false);
    }
  });

  it('swift-ios is present, NOT exempt, and locked to the map', () => {
    const swift = templates.find((t) => t.id === 'swift-ios');
    expect(swift, 'swift-ios template missing from disk').toBeDefined();
    expect(
      TEMPLATE_VERIFICATION_MAP_EXEMPT['swift-ios'],
      'swift-ios must never be exempt — it agrees with the map and is LOCKED'
    ).toBeUndefined();
    const expected = nullStrippedMap('swift', fwInfoFrom(swift!.languages.swift));
    const actual = normalizedTemplateBlock(swift!.verification.swift);
    expect(actual).toEqual(expected);
    expect(actual).toEqual({
      test: 'swift test',
      type: 'swift build',
      build: 'xcodebuild build',
      lint: 'swiftlint',
    });
  });
});
