// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 4: LSP server discovery.
 *
 * Per audit-iter-1 fix G4: this module's discovery is **explicit-only by
 * default**. The optional `lsof` port-scan path is GATED behind
 * `lsp.autoDetect.viaPortScan: true` and defaults to `false` (port-scanning
 * local processes is a security-sensitive default — opt-in only at v1).
 *
 * Empty-servers edge case (audit-iter-3 fix Z): when `lsp.enabled: true` AND
 * `lsp.servers` is empty AND `viaPortScan: false`, we log ONE informational
 * stderr line and return an empty list — the caller (`enrich.ts`) then
 * proceeds AST-only without throwing.
 *
 * VR-LSP-AUTODETECT-OFF-BY-DEFAULT: `viaPortScan` MUST be checked BEFORE any
 * `lsof` invocation. The grep `grep -nE 'viaPortScan' auto-detect.ts` MUST
 * show that boolean check ahead of any `lsof` call.
 */

import type { LSPConfig } from '../config.ts';
import type { LSPServerSpec } from './client.ts';

/**
 * Find LSP servers to launch / connect to. Pure config-driven by default.
 *
 * @param config - The `lsp` block from `massu.config.yaml`. May be undefined
 *   when LSP is not configured at all (returns empty list silently).
 * @returns A list of `LSPServerSpec` ready to feed `LSPClient.fromCommand()`.
 *   Empty list is a valid, non-error outcome — callers MUST proceed AST-only.
 */
export async function findRunningLSPs(
  config: LSPConfig | undefined
): Promise<LSPServerSpec[]> {
  // Disabled or absent: silently no-op (no log).
  if (!config || !config.enabled) {
    return [];
  }

  const explicit = (config.servers ?? []).map((s) => splitCommand(s));

  // VR-LSP-AUTODETECT-OFF-BY-DEFAULT: this boolean check happens BEFORE any
  // `lsof`/port-scan invocation. Default is false — explicit-only path.
  const viaPortScan = config.autoDetect?.viaPortScan === true;

  if (explicit.length === 0 && !viaPortScan) {
    // Empty-servers edge case: enabled but nothing configured AND auto-detect
    // is off. Log once, proceed AST-only.
    process.stderr.write(
      '[massu/lsp] INFO: LSP enabled but no servers configured and auto-detect off — skipping LSP enrichment.\n'
    );
    return [];
  }

  // Port-scan path is opt-in via `viaPortScan: true`. Implementation
  // intentionally minimal at v1 — emits an INFO stderr line and returns
  // explicit servers only. Plan 3d will flesh out actual `lsof` discovery
  // once the threat model is reviewed.
  if (viaPortScan) {
    process.stderr.write(
      '[massu/lsp] INFO: lsp.autoDetect.viaPortScan is enabled but port-scan auto-detect is reserved for Plan 3d — using explicit servers only.\n'
    );
    // (No `lsof` invocation yet. The viaPortScan gate exists so future
    // implementations slot in here without changing the default surface.)
  }

  return explicit;
}

/**
 * Parse a config-string `command` into an `LSPServerSpec`. Splits on
 * whitespace (no shell evaluation, no globbing). Strict path validation
 * happens later in `LSPClient.fromCommand()` — this just parses the shape.
 *
 * Note: callers passing untrusted commands MUST review the result before
 * passing it to `LSPClient.fromCommand`. The factory rejects relative paths
 * and `..`-containing argv elements.
 */
function splitCommand(server: { language: string; command: string }): LSPServerSpec {
  const cmd = (server.command ?? '').trim();
  // Whitespace split — not a full shell parser. Quoted args with spaces are
  // not supported at v1; users with such commands should run a wrapper script.
  const argv = cmd.length === 0 ? [] : cmd.split(/\s+/);
  return {
    language: server.language,
    argv,
  };
}
