// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 1: AST Adapter contract types.
 *
 * Lives at `packages/core/src/detect/adapters/types.ts` per the spec doc
 * (`docs/internal/2026-04-26-ast-lsp-spec.md` §2). All types are local —
 * NONE re-exported from `web-tree-sitter`.
 *
 * Adapter authors import from this module only; the runner (`runner.ts`)
 * orchestrates execution and the loader (`tree-sitter-loader.ts`) handles
 * grammar acquisition.
 *
 * Per-field confidence is enforced (NOT per-adapter): a single weak field
 * MUST NOT poison the rest. The runner consumes `confidence` per-adapter for
 * the moment, but the merge rule reads each `conventions[field]` against the
 * provenance trail to decide what survives.
 */

// ============================================================
// Languages enumerated for the AST adapter set (Phase 1 + 3c)
// ============================================================

/**
 * Closed-set of Tree-sitter grammars massu ships first-party adapters for.
 *
 * Note: this is a string-literal union, NOT re-exported from `web-tree-sitter`
 * (which exposes `Language` as a class, not a name list). Phase 1 ships
 * adapters for python/typescript/javascript/swift only — the remaining
 * languages are reserved for Plan 3c.
 */
export type TreeSitterLanguage =
  | 'python'
  | 'typescript'
  | 'javascript'
  | 'swift'
  | 'rust'
  | 'go'
  | 'ruby'
  | 'php'
  | 'java'
  | 'kotlin'
  | 'elixir'
  | 'erlang'
  | 'csharp'
  | 'cpp'
  | 'haskell'
  | 'ocaml';

// ============================================================
// Inputs to adapter dispatch
// ============================================================

/**
 * Read-only signal bundle the runner builds BEFORE adapter dispatch.
 *
 * Adapters consume signals to answer `matches()` cheaply (no file IO inside
 * `matches()` — that's why the bundle is built up-front).
 */
export interface DetectionSignals {
  /** Parsed `package.json` (root or first workspace) — undefined if absent. */
  packageJson?: Record<string, unknown>;
  /** Parsed `pyproject.toml` — undefined if absent. */
  pyprojectToml?: Record<string, unknown>;
  /** Raw `Gemfile` text — undefined if absent. */
  gemfile?: string;
  /** Parsed `Cargo.toml` — undefined if absent. */
  cargoToml?: Record<string, unknown>;
  /** Raw `go.mod` text — undefined if absent. */
  goMod?: string;
  /** Set of present directory names directly under the project root (one level). */
  presentDirs: Set<string>;
  /** Set of present file basenames directly under the project root (one level). */
  presentFiles: Set<string>;
}

/**
 * A sampled source file the runner hands to the adapter.
 *
 * `content` is pre-read; adapters MUST NOT re-read from disk inside
 * `introspect()`. `size` is in bytes (pre-read length).
 */
export interface SourceFile {
  path: string;
  content: string;
  language: TreeSitterLanguage;
  size: number;
}

// ============================================================
// Adapter contract
// ============================================================

/**
 * Trail entry produced for every captured field — the user can audit
 * `detected.<adapter>._provenance` to see exactly which file/line/query
 * produced a value.
 */
export interface Provenance {
  field: string;
  sourceFile: string;
  line: number;
  query: string;
}

export interface AdapterResult {
  /**
   * Becomes `detected.<adapter.id>` in `massu.config.yaml`. Field names are
   * adapter-defined; values are `unknown` so adapters can return strings,
   * arrays, or nested records as needed.
   */
  conventions: Record<string, unknown>;
  /**
   * Per-field provenance trail. The runner writes this to
   * `detected.<adapter.id>._provenance` so a downstream auditor can verify
   * any extracted value.
   */
  provenance: Provenance[];
  /**
   * 'high'  : single canonical match, query produced exactly one result
   * 'medium': multiple matches, all agree
   * 'low'   : multiple matches with disagreement (still emitted, with warning)
   * 'none'  : no matches, timed out, or threw — fields are dropped
   */
  confidence: 'high' | 'medium' | 'low' | 'none';
}

export interface CodebaseAdapter {
  /** Stable adapter id, e.g. "python-fastapi". Becomes `detected.<id>` block. */
  id: string;
  /** Languages this adapter consumes. Used by the runner to skip work. */
  languages: TreeSitterLanguage[];
  /**
   * Cheap signal check — must NOT do file IO. Returns true if any signal
   * suggests this adapter should run.
   */
  matches(signals: DetectionSignals): boolean;
  /**
   * Sample N files (already read by the runner), run AST queries, return
   * extracted conventions. May throw — the runner isolates failures.
   */
  introspect(files: SourceFile[], rootDir: string): Promise<AdapterResult>;
}

// ============================================================
// Runner output
// ============================================================

/**
 * The runner's output: per-adapter id → its conventions block (with the
 * `_provenance` map merged in). The introspector then folds this into the
 * `detected.<adapter.id>` namespace alongside the existing
 * `detected.python` / `detected.swift` / `detected.typescript` regex blocks.
 */
export interface MergedAdapterOutput {
  /** Per-adapter id → resolved conventions. */
  byAdapter: Record<string, AdapterResolved>;
  /** Adapters that were skipped (didn't match) for diagnostic logging. */
  skipped: string[];
  /** Adapters that threw during introspect — runner isolates these. */
  errored: Array<{ adapterId: string; error: string }>;
}

/**
 * Resolved-and-merged form of an `AdapterResult`. Provenance is folded into
 * `_provenance` (key per field, value = `path:line :: query`).
 */
export interface AdapterResolved {
  conventions: Record<string, unknown>;
  /** field-name -> "relativePath:line :: queryName". Empty when no fields. */
  _provenance: Record<string, string>;
  confidence: 'high' | 'medium' | 'low' | 'none';
}
