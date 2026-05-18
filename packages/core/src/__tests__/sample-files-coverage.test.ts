// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * STRUCTURAL gate: every TreeSitterLanguage claimed by ANY first-party
 * adapter MUST appear in `SAMPLE_EXTENSIONS` and `SAMPLE_TEST_FILE_PATTERNS`.
 * Plan 1.5.4 §0 self-attest #2 deliverable.
 *
 * Without this gate, a future contributor could add a new AST adapter
 * targeting (e.g.) PHP without extending the sampler maps. The adapter
 * would appear in `FIRST_PARTY_ADAPTERS`, the strict-grammar test would
 * still pass (because that test injects SourceFile[] directly), but the
 * production `init` flow would silently sample zero PHP files for that
 * adapter — same class of bug as the 1.5.0 sampleFiles=[] placeholder.
 */

import { describe, it, expect } from 'vitest';
import { SAMPLE_EXTENSIONS, SAMPLE_TEST_FILE_PATTERNS } from '../detect/adapters/file-sampler.ts';
// P-M-032 (plan-stage-d-medium-sweep): aspnet, phoenix, go-chi REMOVED.
import { railsAdapter } from '../detect/adapters/rails.ts';
import { springAdapter } from '../detect/adapters/spring.ts';
import { pythonFlaskAdapter } from '../detect/adapters/python-flask.ts';
import { pythonFastApiAdapter } from '../detect/adapters/python-fastapi.ts';
import { pythonDjangoAdapter } from '../detect/adapters/python-django.ts';
import { nextjsTrpcAdapter } from '../detect/adapters/nextjs-trpc.ts';
import { swiftSwiftUiAdapter } from '../detect/adapters/swift-swiftui.ts';

const ALL_ADAPTERS = [
  railsAdapter, springAdapter,
  pythonFlaskAdapter, pythonFastApiAdapter, pythonDjangoAdapter, nextjsTrpcAdapter,
  swiftSwiftUiAdapter,
];

describe('sample-files-coverage drift-guard', () => {
  it('every language declared by an adapter has a SAMPLE_EXTENSIONS entry', () => {
    const missing: { adapterId: string; language: string }[] = [];
    for (const adapter of ALL_ADAPTERS) {
      for (const lang of adapter.languages) {
        if (!SAMPLE_EXTENSIONS[lang] || SAMPLE_EXTENSIONS[lang].length === 0) {
          missing.push({ adapterId: adapter.id, language: lang });
        }
      }
    }
    expect(missing, 'adapters claim languages without SAMPLE_EXTENSIONS coverage').toEqual([]);
  });

  it('every language declared by an adapter has a SAMPLE_TEST_FILE_PATTERNS entry', () => {
    const missing: { adapterId: string; language: string }[] = [];
    for (const adapter of ALL_ADAPTERS) {
      for (const lang of adapter.languages) {
        if (!SAMPLE_TEST_FILE_PATTERNS[lang]) {
          missing.push({ adapterId: adapter.id, language: lang });
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('SAMPLE_EXTENSIONS entries are non-empty arrays of extension strings', () => {
    for (const [lang, exts] of Object.entries(SAMPLE_EXTENSIONS)) {
      expect(exts.length, `${lang}: must have at least one extension`).toBeGreaterThan(0);
      for (const ext of exts) {
        expect(ext, `${lang}: extension '${ext}' must not contain '.'`).not.toContain('.');
      }
    }
  });
});
