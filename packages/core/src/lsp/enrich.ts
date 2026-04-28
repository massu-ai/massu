// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 4: LSP enrichment of AST adapter results.
 *
 * For each field in `result.conventions`, optionally enrich via LSP responses
 * (e.g., resolve `Depends` → `fastapi.Depends` via `textDocument/definition`).
 *
 * Authority rule (per spec §4 / plan line 173-175):
 *   - AST is AUTHORITATIVE. LSP only refines (e.g., resolves alias → fully
 *     qualified import).
 *   - LSP unavailable / timeout / Zod-fail / version-mismatch → keep AST,
 *     log warning at field granularity, do NOT crash.
 *
 * Failure modes:
 *   - `lspClient === null` → return original result unchanged (no log; the
 *     "LSP not configured" path is the common case).
 *   - LSP method returns null (capability missing, timeout, Zod fail) →
 *     keep AST value, append a `_lsp_skipped: <reason>` note to provenance.
 *   - Per-field error → ignore that single field, keep others (per plan).
 */

import type { AdapterResult, SourceFile } from '../detect/adapters/types.ts';
import { pathToFileURL } from 'url';
import type { LSPClient } from './client.ts';

/**
 * Enrich an `AdapterResult` with LSP data when the client is available.
 *
 * The current v1 implementation is intentionally minimal: it walks each
 * source file and asks the LSP for `textDocument/documentSymbol`. When the
 * LSP returns a populated symbol list AND a convention field's value matches
 * a symbol name, the convention's provenance is annotated with the LSP-
 * provided detail (e.g., the canonical import path).
 *
 * AST values are NEVER overwritten — provenance is the only field touched.
 */
export async function enrichAdapterResult(
  result: AdapterResult,
  lspClient: LSPClient | null,
  sourceFiles: SourceFile[]
): Promise<AdapterResult> {
  if (!lspClient) return result;
  if (sourceFiles.length === 0) return result;

  // Build a map of convention-value → field-name(s) so we can match symbols.
  const valueToFields = new Map<string, string[]>();
  for (const [field, value] of Object.entries(result.conventions)) {
    if (typeof value !== 'string') continue;
    const arr = valueToFields.get(value) ?? [];
    arr.push(field);
    valueToFields.set(value, arr);
  }
  if (valueToFields.size === 0) return result;

  const enrichedProvenance = [...result.provenance];

  for (const file of sourceFiles) {
    let symbols;
    try {
      const uri = pathToFileURL(file.path).toString();
      symbols = await lspClient.documentSymbol(uri);
    } catch (e) {
      process.stderr.write(
        `[massu/lsp] WARN: documentSymbol threw on ${file.path} — skipping enrichment for this file. (${e instanceof Error ? e.message : String(e)})\n`
      );
      continue;
    }
    if (!symbols || !Array.isArray(symbols)) continue;

    for (const sym of symbols) {
      if (!sym || typeof sym !== 'object') continue;
      const symObj = sym as Record<string, unknown>;
      const name = typeof symObj.name === 'string' ? symObj.name : null;
      if (!name) continue;
      const matchedFields = valueToFields.get(name);
      if (!matchedFields) continue;

      // Append an LSP-sourced provenance entry for each matched field. The
      // AST entry stays in place — LSP is enrichment-only.
      const detail = typeof symObj.detail === 'string' ? symObj.detail : null;
      const line = extractStartLine(symObj);
      for (const field of matchedFields) {
        enrichedProvenance.push({
          field,
          sourceFile: file.path,
          line: line ?? 0,
          query: detail ? `lsp:documentSymbol(${detail})` : 'lsp:documentSymbol',
        });
      }
    }
  }

  return {
    ...result,
    provenance: enrichedProvenance,
  };
}

/**
 * Pluck the start line from either DocumentSymbol shape (range.start.line) or
 * SymbolInformation shape (location.range.start.line). Returns null if
 * neither shape matches.
 */
function extractStartLine(sym: Record<string, unknown>): number | null {
  // DocumentSymbol shape
  const range = sym.range as Record<string, unknown> | undefined;
  if (range && typeof range === 'object') {
    const start = range.start as Record<string, unknown> | undefined;
    if (start && typeof start.line === 'number') {
      return start.line + 1; // convert 0-indexed to 1-indexed
    }
  }
  // SymbolInformation shape
  const loc = sym.location as Record<string, unknown> | undefined;
  if (loc && typeof loc === 'object') {
    const locRange = loc.range as Record<string, unknown> | undefined;
    if (locRange && typeof locRange === 'object') {
      const start = locRange.start as Record<string, unknown> | undefined;
      if (start && typeof start.line === 'number') {
        return start.line + 1;
      }
    }
  }
  return null;
}
