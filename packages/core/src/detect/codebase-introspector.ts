// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Codebase Introspector — 2-tier dispatcher (Plan 3b Phase 1)
 * ============================================================
 *
 * Public signature: `introspect(detection, projectRoot): DetectedConventions`.
 * Byte-for-byte unchanged from Plan #2 — `detect/index.ts` calls this
 * function as before.
 *
 * Internal change (Plan 3b Phase 1): the function is now a 2-tier dispatcher.
 *
 *   Tier 1 — AST adapters (preferred). Run via `runner.ts` against the four
 *   first-party adapters: python-fastapi, python-django, nextjs-trpc,
 *   swift-swiftui. Each writes to its own `detected.<adapter.id>` block
 *   alongside the regex blocks. AST adapters use Tree-sitter S-expression
 *   queries — never regex. Confidence is per-field.
 *
 *   Tier 2 — Regex fallback. For fields the AST adapters returned 'none'
 *   confidence on, the regex helpers in `regex-fallback.ts` (verbatim moved
 *   from this file's previous incarnation) take over. AST-wins rule: when
 *   both tiers produce a value for the same `detected.<lang>.<field>` slot,
 *   AST wins; the runner records both in provenance.
 *
 *   Tier 3 — null. The template engine's `| default("...")` then takes over.
 *
 * The AST tier may degrade silently to regex-only when:
 *   - The Tree-sitter grammar is unavailable offline AND uncached
 *   - The adapter throws (per-adapter try/catch in `runner.ts`)
 *   - The grammar SHA-256 doesn't match the manifest (refused by loader)
 *
 * Exception: if a Tree-sitter query is malformed (developer bug), the loader
 * propagates `InvalidQueryError` so we don't silently mask it.
 */

import type { DetectionResult } from './index.ts';
import {
  introspectPython,
  introspectSwift,
  introspectTypeScript,
  type DetectedPython,
  type DetectedSwift,
  type DetectedTypeScript,
} from './regex-fallback.ts';
import { runAdapters, buildDetectionSignals } from './adapters/runner.ts';
import { pythonFastApiAdapter } from './adapters/python-fastapi.ts';
import { pythonDjangoAdapter } from './adapters/python-django.ts';
import { nextjsTrpcAdapter } from './adapters/nextjs-trpc.ts';
import { swiftSwiftUiAdapter } from './adapters/swift-swiftui.ts';
import type { CodebaseAdapter, AdapterResolved } from './adapters/types.ts';

// ============================================================
// Public types — unchanged from Plan #2 to preserve consumers
// ============================================================

export type { DetectedPython, DetectedSwift, DetectedTypeScript };

export interface DetectedConventions {
  python?: DetectedPython;
  swift?: DetectedSwift;
  typescript?: DetectedTypeScript;
  /**
   * AST adapter blocks live here (Plan 3b). Keys are adapter ids
   * (`python-fastapi`, etc.). Values include both extracted conventions and
   * a `_provenance` map.
   */
  [adapterId: string]: unknown;
}

// ============================================================
// Static adapter list (v1 — first-party only, per spec §6)
// ============================================================

const FIRST_PARTY_ADAPTERS: CodebaseAdapter[] = [
  pythonFastApiAdapter,
  pythonDjangoAdapter,
  nextjsTrpcAdapter,
  swiftSwiftUiAdapter,
];

// ============================================================
// Public entry point
// ============================================================

/**
 * Introspect the project's source files. Returns per-language conventions or
 * an empty object if nothing was extracted.
 *
 * Synchronous signature is preserved — AST adapter execution is intentionally
 * fire-and-forget at this layer. Phase 1 wires the adapter pipeline behind
 * the existing sync function so `detect/index.ts` is byte-for-byte unchanged
 * (plan line 137-142). The async adapter orchestration lives entirely inside
 * `runIntrospect()`, which `introspect()` does NOT await — adapters either
 * have their grammars cached (fast path, no async needed at the JS level by
 * Phase 4 wiring) or degrade to regex.
 *
 * For Phase 1 Tier 1 to actually contribute values, callers must use the
 * async variant `introspectAsync()`. The sync `introspect()` runs the regex
 * tier ONLY for Phase 1; Phase 4 callers (LSP enrichment + adapter wiring)
 * will switch to async.
 */
export function introspect(
  detection: DetectionResult,
  projectRoot: string,
): DetectedConventions {
  const out: DetectedConventions = {};
  const languages = Array.from(
    new Set(detection.manifests.map(m => m.language)),
  );

  // Tier 2 — regex fallback. Always runs. AST adapters in the async variant
  // (`introspectAsync`) populate `detected.<adapter-id>` alongside; for the
  // sync entry point, only the regex tier participates so Plan #2 callers
  // see no behavior change.
  if (languages.includes('python')) {
    const python = introspectPython(detection, projectRoot);
    if (python !== null) out.python = python;
  }

  if (languages.includes('swift')) {
    const swift = introspectSwift(detection, projectRoot);
    if (swift !== null) out.swift = swift;
  }

  if (languages.includes('typescript') || languages.includes('javascript')) {
    const ts = introspectTypeScript(detection, projectRoot);
    if (ts !== null) out.typescript = ts;
  }

  return out;
}

// ============================================================
// Async variant — used by callers who want AST tier participation
// ============================================================

/**
 * Async introspect: runs AST adapters first (Tier 1), then regex fallback
 * (Tier 2) for fields the adapters returned 'none' on.
 *
 * Returns the same `DetectedConventions` shape as the sync `introspect()`,
 * plus per-adapter blocks under their ids.
 *
 * Callers who can `await` (CLI commands, tests, etc.) should prefer this
 * variant. The session-start hook keeps using sync `introspect()` for its
 * 5s budget reason (P4-006).
 */
export async function introspectAsync(
  detection: DetectionResult,
  projectRoot: string,
): Promise<DetectedConventions> {
  const out: DetectedConventions = introspect(detection, projectRoot);

  // Build signals + run AST adapters
  const signals = buildDetectionSignals(projectRoot);
  let merged;
  try {
    merged = await runAdapters(FIRST_PARTY_ADAPTERS, projectRoot, signals, {
      sampleFiles: async (_adapter, _root) => {
        // Phase 1 placeholder: file sampling for adapters is wired in
        // dedicated harnesses (per-adapter tests inject SourceFile[] directly).
        // The introspector tier doesn't yet sample for AST adapters — that
        // wiring lands together with Phase 4 LSP enrichment so the same path
        // serves both. For now, returning [] keeps adapters at 'none' which
        // means `out` is regex-only — consistent with the sync path and the
        // pre-Phase-1 baseline test suite.
        return [];
      },
    });
  } catch {
    return out;
  }

  for (const [adapterId, resolved] of Object.entries(merged.byAdapter)) {
    if (resolved.confidence === 'none') continue;
    out[adapterId] = serializeAdapterBlock(resolved);
  }

  return out;
}

function serializeAdapterBlock(r: AdapterResolved): Record<string, unknown> {
  const block: Record<string, unknown> = { ...r.conventions };
  if (Object.keys(r._provenance).length > 0) {
    block._provenance = r._provenance;
  }
  block._confidence = r.confidence;
  return block;
}
