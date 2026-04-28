// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 1: AST adapter runner.
 *
 * Orchestrates: filter adapters via `matches()`, run them, isolate failures
 * via per-adapter try/catch (audit-iter-5 fix HH test (d)), and merge their
 * results.
 *
 * Confidence merge rule (spec §5):
 *   - 'high' / 'medium' / 'low' → field is written, with per-field provenance.
 *   - 'none' → field DROPPED (introspect's regex fallback may then emit it).
 *
 * AST-wins rule:
 *   - When the same conventions key appears in two adapters that BOTH return
 *     non-'none', the FIRST adapter (by source-list order) wins. This is
 *     deterministic — adapters are listed in `runner.ts`'s static array,
 *     never user-provided.
 */

import { basename, relative } from 'path';
import type {
  AdapterResolved,
  CodebaseAdapter,
  DetectionSignals,
  MergedAdapterOutput,
  Provenance,
  SourceFile,
} from './types.ts';
import { isParsableSource, MAX_AST_FILE_BYTES } from './parse-guard.ts';

export interface RunAdaptersOptions {
  /**
   * Optional file sampler — given an adapter and the project root, returns
   * the SourceFile[] the adapter should consume. If omitted, the runner
   * passes an empty file list (useful in unit tests where the caller has
   * already constructed adapters that don't need files).
   */
  sampleFiles?: (adapter: CodebaseAdapter, rootDir: string) => Promise<SourceFile[]> | SourceFile[];
}

/**
 * Run a static list of adapters against a project root.
 *
 * Per-adapter try/catch isolation: a single adapter throwing MUST NOT crash
 * the runner. The error is captured in `errored[]` and the runner continues.
 *
 * @param adapters - Static list of first-party adapters (no user-authored
 *   adapters at v1 — Plan 3c will add discovery).
 * @param rootDir - Absolute project root.
 * @param signals - Pre-built `DetectionSignals` (manifest reads, present
 *   dirs/files). Adapters consume these read-only.
 * @param options - Hooks for testing.
 */
export async function runAdapters(
  adapters: CodebaseAdapter[],
  rootDir: string,
  signals: DetectionSignals,
  options: RunAdaptersOptions = {},
): Promise<MergedAdapterOutput> {
  const out: MergedAdapterOutput = {
    byAdapter: {},
    skipped: [],
    errored: [],
  };

  // AST-wins / per-adapter merge:
  // Each adapter writes to its own `detected.<adapter.id>` namespace, so
  // global field collisions across adapters can't happen at the conventions
  // level. The "AST-wins" rule in the spec applies at the introspector tier
  // (regex fallback only fills fields the adapter returned 'none' for).
  // Within a single adapter, if `conventions` repeats a key (shouldn't, but
  // defensively), the first occurrence wins. For multiple adapters with the
  // same id (shouldn't, but defensively), the first wins.

  for (const adapter of adapters) {
    if (out.byAdapter[adapter.id] || out.skipped.includes(adapter.id)) {
      // Duplicate adapter id → skip the second one to preserve first-wins.
      continue;
    }
    let matches: boolean;
    try {
      matches = adapter.matches(signals);
    } catch (e) {
      out.errored.push({
        adapterId: adapter.id,
        error: `matches() threw: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    if (!matches) {
      out.skipped.push(adapter.id);
      continue;
    }

    let files: SourceFile[];
    try {
      files = options.sampleFiles
        ? await options.sampleFiles(adapter, rootDir)
        : [];
    } catch (e) {
      out.errored.push({
        adapterId: adapter.id,
        error: `sampleFiles threw: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    // Phase 3.5 fix: size + depth + control-byte gate. Drop adversarial
    // inputs BEFORE the adapter sees them — adapters trust this layer.
    // Files dropped here are logged once per drop so operators see the
    // signal; the adapter then runs against the surviving subset.
    const safeFiles: SourceFile[] = [];
    for (const f of files) {
      const skip = isParsableSource(f.content, f.size);
      if (skip) {
        process.stderr.write(
          `[massu/ast] WARN: skipping ${f.path} for adapter ${adapter.id}: ${skip.reason} (${skip.detail}). Cap=${MAX_AST_FILE_BYTES} bytes. (Phase 3.5 mitigation)\n`,
        );
        continue;
      }
      safeFiles.push(f);
    }
    files = safeFiles;

    let result;
    try {
      result = await adapter.introspect(files, rootDir);
    } catch (e) {
      out.errored.push({
        adapterId: adapter.id,
        error: `introspect() threw: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    // 'none' confidence drops the entire adapter result. The runner records
    // that the adapter was attempted (in `byAdapter`) so callers can see it
    // ran, but with empty conventions. introspect()'s regex fallback then
    // takes over for the field.
    if (result.confidence === 'none') {
      out.byAdapter[adapter.id] = {
        conventions: {},
        _provenance: {},
        confidence: 'none',
      };
      continue;
    }

    // Merge: keep first occurrence of each field (defensive against an
    // adapter accidentally writing the same field twice).
    const conventions: Record<string, unknown> = {};
    const provenanceMap: Record<string, string> = {};
    for (const [field, value] of Object.entries(result.conventions)) {
      if (value === null || value === undefined) continue;
      if (field in conventions) continue;
      conventions[field] = value;
    }
    for (const p of result.provenance) {
      if (p.field in provenanceMap) continue;
      provenanceMap[p.field] = formatProvenance(p, rootDir);
    }

    const resolved: AdapterResolved = {
      conventions,
      _provenance: provenanceMap,
      confidence: result.confidence,
    };
    out.byAdapter[adapter.id] = resolved;
  }

  return out;
}

function formatProvenance(p: Provenance, rootDir: string): string {
  const rel = p.sourceFile.startsWith(rootDir + '/')
    ? relative(rootDir, p.sourceFile)
    : basename(p.sourceFile);
  return `${rel}:${p.line} :: ${p.query}`;
}

// ============================================================
// Signal builder — used by codebase-introspector to feed the runner
// ============================================================

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Build a `DetectionSignals` bundle by reading manifest files at the project
 * root. Cheap (one-level dir scan + a handful of file reads). Failures
 * degrade gracefully — a missing manifest just means that field is undefined.
 */
export function buildDetectionSignals(rootDir: string): DetectionSignals {
  const presentDirs = new Set<string>();
  const presentFiles = new Set<string>();
  try {
    for (const entry of readdirSync(rootDir)) {
      if (entry.startsWith('.')) continue;
      try {
        const st = statSync(join(rootDir, entry));
        if (st.isDirectory()) presentDirs.add(entry);
        else if (st.isFile()) presentFiles.add(entry);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* unreadable root → empty signals */
  }

  return {
    packageJson: tryReadJson(join(rootDir, 'package.json')),
    pyprojectToml: tryReadToml(join(rootDir, 'pyproject.toml')),
    gemfile: tryReadString(join(rootDir, 'Gemfile')),
    cargoToml: tryReadToml(join(rootDir, 'Cargo.toml')),
    goMod: tryReadString(join(rootDir, 'go.mod')),
    presentDirs,
    presentFiles,
  };
}

function tryReadString(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

function tryReadJson(path: string): Record<string, unknown> | undefined {
  const txt = tryReadString(path);
  if (!txt) return undefined;
  try {
    const parsed = JSON.parse(txt);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function tryReadToml(path: string): Record<string, unknown> | undefined {
  const txt = tryReadString(path);
  if (!txt) return undefined;
  // Cheap signal-only parse: we just need top-level table presence + keys.
  // Avoid pulling the full toml parser for this; check `[project]`/`[tool.x]`
  // headers and treat `tool.poetry.dependencies` etc. as opaque text-search.
  // Adapters that need structured data can grep `txt` themselves.
  return { __raw: txt };
}
