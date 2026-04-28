// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 4: LSP message TypeScript interfaces + Zod runtime schemas.
 *
 * Per audit-iter-4 fix DD: every `*Request` / `*Response` / `*Params` /
 * `ServerCapabilities` type is paired with a co-located `*ResponseSchema` for
 * runtime validation. `client.ts` imports from here only — no inline Zod
 * definitions in `client.ts`.
 *
 * The schemas validate the LSP `result` payloads we consume (NOT the
 * full envelope) — `LSPMessageEnvelopeSchema` covers the wire envelope.
 *
 * VR check (per plan): `grep -nE 'export (interface|type|const) .*(Schema|
 * Request|Response|Params|Capabilities)' packages/core/src/lsp/types.ts` MUST
 * return ≥8 hits after Phase 4.
 */

import { z } from 'zod';

// ============================================================
// LSP error codes (subset we reference)
// ============================================================

/**
 * JSON-RPC + LSP error codes used by the client. Numeric values match the
 * LSP 3.17 spec — `MethodNotFound = -32601` is the gatekeeper for the
 * graceful-degrade path (per plan line 160).
 */
export const LSPErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  RequestFailed: -32803,
  ServerCancelled: -32802,
} as const;
export type LSPErrorCodeValue = typeof LSPErrorCode[keyof typeof LSPErrorCode];

// ============================================================
// Wire envelope (every LSP/JSON-RPC message)
// ============================================================

/**
 * JSON-RPC 2.0 / LSP envelope. `id` is required for request/response, absent
 * for notifications. `method` is present on requests/notifications, absent on
 * responses. `result` xor `error` on responses.
 */
export const LSPMessageEnvelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
}).passthrough();
export type LSPMessageEnvelope = z.infer<typeof LSPMessageEnvelopeSchema>;

// ============================================================
// Initialize
// ============================================================

export interface InitializeRequest {
  processId: number | null;
  rootUri: string | null;
  capabilities: Record<string, unknown>;
  workspaceFolders?: Array<{ uri: string; name: string }> | null;
}

/**
 * Subset of LSP `ServerCapabilities` we consume. Everything else is ignored.
 * Each `*Provider` flag may be absent (treat as false), `true`, or an object
 * (treat as true — server supports the method but with options we don't use).
 */
export interface ServerCapabilities {
  documentSymbolProvider?: boolean | Record<string, unknown>;
  workspaceSymbolProvider?: boolean | Record<string, unknown>;
  definitionProvider?: boolean | Record<string, unknown>;
}

export const ServerCapabilitiesSchema = z
  .object({
    documentSymbolProvider: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
    workspaceSymbolProvider: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
    definitionProvider: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
  })
  .passthrough();

export interface InitializeResponse {
  capabilities: ServerCapabilities;
  serverInfo?: { name: string; version?: string };
}

export const InitializeResponseSchema = z
  .object({
    capabilities: ServerCapabilitiesSchema,
    serverInfo: z
      .object({
        name: z.string(),
        version: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

// ============================================================
// Position / Range / Location (shared)
// ============================================================

export const PositionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});
export type Position = z.infer<typeof PositionSchema>;

export const RangeSchema = z.object({
  start: PositionSchema,
  end: PositionSchema,
});
export type Range = z.infer<typeof RangeSchema>;

export const LocationSchema = z.object({
  uri: z.string(),
  range: RangeSchema,
});
export type Location = z.infer<typeof LocationSchema>;

// ============================================================
// textDocument/documentSymbol
// ============================================================

export interface DocumentSymbolParams {
  textDocument: { uri: string };
}

/**
 * Document symbols come in two shapes: hierarchical `DocumentSymbol[]` (LSP
 * 3.10+) or flat `SymbolInformation[]` (legacy). We accept either at the
 * Zod level — consumers in `enrich.ts` pick the shape they care about.
 */
const DocumentSymbolNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      name: z.string(),
      kind: z.number(),
      range: RangeSchema,
      selectionRange: RangeSchema,
      detail: z.string().optional(),
      children: z.array(DocumentSymbolNodeSchema).optional(),
    })
    .passthrough()
);

const SymbolInformationNodeSchema = z
  .object({
    name: z.string(),
    kind: z.number(),
    location: LocationSchema,
    containerName: z.string().optional(),
  })
  .passthrough();

export const DocumentSymbolResponseSchema = z.union([
  z.array(DocumentSymbolNodeSchema),
  z.array(SymbolInformationNodeSchema),
  z.null(),
]);
export type DocumentSymbolResponse = z.infer<typeof DocumentSymbolResponseSchema>;

// ============================================================
// workspace/symbol
// ============================================================

export interface WorkspaceSymbolParams {
  query: string;
}

export const WorkspaceSymbolResponseSchema = z.union([
  z.array(SymbolInformationNodeSchema),
  z.null(),
]);
export type WorkspaceSymbolResponse = z.infer<typeof WorkspaceSymbolResponseSchema>;

// ============================================================
// textDocument/definition
// ============================================================

export interface DefinitionParams {
  textDocument: { uri: string };
  position: Position;
}

/**
 * Definition can be a single Location, an array of Locations, or null.
 * (LSP also allows `LocationLink[]` — we accept it via passthrough but
 * downstream consumers stick to `Location`.)
 */
export const DefinitionResponseSchema = z.union([
  LocationSchema,
  z.array(LocationSchema),
  z.array(
    z
      .object({
        targetUri: z.string(),
        targetRange: RangeSchema,
        targetSelectionRange: RangeSchema,
      })
      .passthrough()
  ),
  z.null(),
]);
export type DefinitionResponse = z.infer<typeof DefinitionResponseSchema>;
