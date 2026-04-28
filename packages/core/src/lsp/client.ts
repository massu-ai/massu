// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 4: Minimal JSON-RPC LSP client.
 *
 * Methods supported: `initialize`, `textDocument/documentSymbol`,
 * `workspace/symbol`, `textDocument/definition`, `shutdown`.
 *
 * Wire transport: stdio JSON-RPC via `child_process.spawn` with the
 * `Content-Length: N\r\n\r\n<body>` framing required by LSP.
 *
 * Security guarantees:
 *   - `command` MUST be a pre-split `[argv0, ...args]` array (no shell). The
 *     factory rejects shell-string input — the caller in `auto-detect.ts`
 *     splits commands safely. (Phase 3.5 finding #4)
 *   - Refuses paths containing `..`. Refuses non-absolute paths unless
 *     `allowRelativePath: true`.
 *   - Per-server method-support matrix: capabilities checked from the
 *     `initialize` response; methods whose `*Provider` capability is
 *     absent/false are SKIPPED (not sent). (audit-iter-2 fix N6)
 *   - MethodNotFound (-32601) for a method we did send → that single
 *     capability is marked unavailable for the lifetime of this client
 *     instance.
 *   - Every response payload is validated against the Zod schema from
 *     `types.ts` before the consumer sees it. Validation failure logs to
 *     stderr (per VR-USER-ERROR-MESSAGES item 2) and returns null.
 *   - 5s per-request timeout. On timeout: log info, return null.
 *   - Max body size 5MB. Oversized → log warning, abort, return null.
 *   - Mismatched response ids (response-injection) are silently dropped.
 *
 * Library purity: never terminates the process; never touches the memory DB.
 * ESM imports throughout.
 */

import { spawn, type ChildProcess } from 'child_process';
import { isAbsolute } from 'path';
import {
  DefinitionResponseSchema,
  DocumentSymbolResponseSchema,
  InitializeResponseSchema,
  LSPErrorCode,
  LSPMessageEnvelopeSchema,
  WorkspaceSymbolResponseSchema,
  type DefinitionResponse,
  type DocumentSymbolResponse,
  type InitializeResponse,
  type Position,
  type ServerCapabilities,
  type WorkspaceSymbolResponse,
} from './types.ts';

/**
 * Maximum body size (bytes) for any LSP response. Protection against memory
 * exhaustion via oversized responses (Phase 3.5 finding #2).
 */
const MAX_RESPONSE_BODY_BYTES = 5 * 1024 * 1024;
/** Default per-request timeout (ms). LSP unresponsive → degrade to AST-only. */
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

// ============================================================
// Transport contract — pluggable for tests
// ============================================================

/**
 * In-memory transport interface. Tests inject a stub; production wires the
 * stdio of a spawned LSP process. The contract is:
 *   - `send(jsonText)`: client → server; framed by the transport.
 *   - `onMessage(fn)`: server → client; one parsed envelope per call.
 *   - `close()`: terminate cleanly.
 */
export interface LSPTransport {
  send(json: string): void;
  onMessage(handler: (envelope: unknown) => void): void;
  onError(handler: (err: Error) => void): void;
  close(): void;
}

/**
 * Stdio-framed transport over a spawned child process. Produced by
 * `LSPClient.fromCommand()` for production use; tests use `LSPClient.with(...)`.
 */
function createStdioTransport(child: ChildProcess): LSPTransport {
  let messageHandler: ((env: unknown) => void) | null = null;
  let errorHandler: ((err: Error) => void) | null = null;
  let buffer = Buffer.alloc(0);

  const stdout = child.stdout;
  const stdin = child.stdin;
  if (!stdout || !stdin) {
    throw new Error('LSP child process is missing stdio handles');
  }

  stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      // Parse `Content-Length: N\r\n\r\n<body>` framing.
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const headerText = buffer.subarray(0, headerEnd).toString('utf-8');
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        // Malformed framing — drop everything and continue (server may be
        // emitting non-LSP chatter on stdout; LSP says it shouldn't, but be
        // forgiving).
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(match[1] ?? '0', 10);
      if (Number.isNaN(len) || len < 0) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      if (len > MAX_RESPONSE_BODY_BYTES) {
        // Oversized — log and drop (don't try to read it).
        process.stderr.write(
          `[massu/lsp] WARN: oversized LSP response body (${len} > ${MAX_RESPONSE_BODY_BYTES} bytes) — dropping. (Phase 3.5 mitigation)\n`
        );
        // Skip the header + body; still need len bytes available before we
        // can drop them. If not all here yet, wait — but cap waiting by
        // returning early and letting the next `data` event re-enter.
        if (buffer.length < headerEnd + 4 + len) return;
        buffer = buffer.subarray(headerEnd + 4 + len);
        continue;
      }
      if (buffer.length < headerEnd + 4 + len) return;
      const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf-8');
      buffer = buffer.subarray(headerEnd + 4 + len);

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        if (errorHandler) errorHandler(e instanceof Error ? e : new Error(String(e)));
        continue;
      }
      if (messageHandler) messageHandler(parsed);
    }
  });

  stdout.on('error', (err: Error) => {
    if (errorHandler) errorHandler(err);
  });
  stdin.on('error', (err: Error) => {
    if (errorHandler) errorHandler(err);
  });
  child.on('error', (err: Error) => {
    if (errorHandler) errorHandler(err);
  });

  return {
    send(json: string) {
      const body = Buffer.from(json, 'utf-8');
      const header = `Content-Length: ${body.length}\r\n\r\n`;
      stdin.write(header + json);
    },
    onMessage(fn) {
      messageHandler = fn;
    },
    onError(fn) {
      errorHandler = fn;
    },
    close() {
      try { stdin.end(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
    },
  };
}

// ============================================================
// LSP server spec (config -> client factory input)
// ============================================================

export interface LSPServerSpec {
  /** Logical language name (matches `lsp.servers[].language`). */
  language: string;
  /** Pre-split argv. First element is the executable path. */
  argv: string[];
  /** When true, allow non-absolute argv[0]. Default false (security). */
  allowRelativePath?: boolean;
}

// ============================================================
// LSPClient
// ============================================================

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/**
 * Optional client configuration. `requestTimeoutMs` lets tests run timeout
 * scenarios without waiting the full 5s default; production callers should
 * always use the default.
 */
export interface LSPClientOptions {
  requestTimeoutMs?: number;
}

/**
 * Minimal LSP client. Construct via `LSPClient.fromCommand(spec)` for the
 * production stdio path, or `LSPClient.with(transport)` for tests.
 */
export class LSPClient {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private capabilities: ServerCapabilities = {};
  private initialized = false;
  /** Methods that returned MethodNotFound at runtime — never call again. */
  private deadMethods = new Set<string>();
  private closed = false;
  private requestTimeoutMs: number;

  private constructor(private transport: LSPTransport, options: LSPClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.transport.onMessage((env) => this.handleMessage(env));
    this.transport.onError((err) => {
      // Errors are non-fatal; pending requests resolve null on timeout.
      process.stderr.write(`[massu/lsp] WARN: transport error: ${err.message}\n`);
    });
  }

  /**
   * Wire a pre-built transport (used by tests that swap stdin/stdout for an
   * in-memory shim). Production callers should use `fromCommand`.
   */
  static with(transport: LSPTransport, options: LSPClientOptions = {}): LSPClient {
    return new LSPClient(transport, options);
  }

  /**
   * Spawn the LSP server via `child_process.spawn` with argv array form
   * (NEVER a shell string).
   *
   * Security:
   *   - `spec.argv` MUST be a pre-split array. We don't accept a shell-string
   *     `command` field — the caller pre-splits it.
   *   - argv[0] MUST be absolute unless `spec.allowRelativePath === true`.
   *   - argv[0] MUST NOT contain `..`.
   *   - Any argv element MUST NOT contain `..` (defense in depth).
   */
  static fromCommand(spec: LSPServerSpec, options: LSPClientOptions = {}): LSPClient {
    if (!Array.isArray(spec.argv) || spec.argv.length === 0) {
      throw new Error('LSPClient.fromCommand: spec.argv must be a non-empty array');
    }
    const exe = spec.argv[0];
    if (typeof exe !== 'string' || exe.length === 0) {
      throw new Error('LSPClient.fromCommand: spec.argv[0] (executable) must be a non-empty string');
    }
    for (const a of spec.argv) {
      if (typeof a !== 'string') {
        throw new Error('LSPClient.fromCommand: every spec.argv element must be a string');
      }
      if (a.includes('..')) {
        throw new Error(`LSPClient.fromCommand: refused argv element containing "..": ${a}`);
      }
    }
    if (!spec.allowRelativePath && !isAbsolute(exe)) {
      throw new Error(
        `LSPClient.fromCommand: refused non-absolute executable "${exe}". ` +
          `Pass an absolute path or set allowRelativePath: true to opt in.`
      );
    }

    const child = spawn(exe, spec.argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Explicitly NO `shell: true` — argv array form is the security
      // contract.
    });
    return new LSPClient(createStdioTransport(child), options);
  }

  // --------------------------------------------------------
  // Public API
  // --------------------------------------------------------

  /**
   * Initialize the server. Stores `ServerCapabilities` for later capability
   * gating. Returns null on timeout / Zod validation failure.
   */
  async initialize(rootUri: string | null = null): Promise<InitializeResponse | null> {
    const params = {
      processId: process.pid,
      rootUri,
      capabilities: {},
    };
    const raw = await this.sendRequest('initialize', params);
    if (raw === null) return null;
    const parsed = InitializeResponseSchema.safeParse(raw);
    if (!parsed.success) {
      process.stderr.write(
        `[massu/lsp] WARN: initialize response failed Zod validation: ${parsed.error.message}\n`
      );
      return null;
    }
    this.capabilities = parsed.data.capabilities;
    this.initialized = true;
    // LSP requires a notification after initialize.
    this.sendNotification('initialized', {});
    return parsed.data;
  }

  /**
   * Document symbols for a single file. Returns null when:
   *   - capability `documentSymbolProvider` is false/absent (skip request)
   *   - method previously returned MethodNotFound
   *   - timeout
   *   - Zod validation failure
   */
  async documentSymbol(uri: string): Promise<DocumentSymbolResponse | null> {
    if (!this.checkCapability('documentSymbolProvider', 'textDocument/documentSymbol')) {
      return null;
    }
    const raw = await this.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri },
    });
    if (raw === null) return null;
    const parsed = DocumentSymbolResponseSchema.safeParse(raw);
    if (!parsed.success) {
      process.stderr.write(
        `[massu/lsp] WARN: textDocument/documentSymbol response failed Zod validation — falling back to AST-only for this file. (${parsed.error.message})\n`
      );
      return null;
    }
    return parsed.data;
  }

  /**
   * Workspace symbol search. Returns null when capability is missing/false
   * (e.g., sourcekit-lsp's `workspaceSymbolProvider: false` per plan line 151
   * — empty result is INCONCLUSIVE; we don't even send the request).
   */
  async workspaceSymbol(query: string): Promise<WorkspaceSymbolResponse | null> {
    if (!this.checkCapability('workspaceSymbolProvider', 'workspace/symbol')) {
      return null;
    }
    const raw = await this.sendRequest('workspace/symbol', { query });
    if (raw === null) return null;
    const parsed = WorkspaceSymbolResponseSchema.safeParse(raw);
    if (!parsed.success) {
      process.stderr.write(
        `[massu/lsp] WARN: workspace/symbol response failed Zod validation. (${parsed.error.message})\n`
      );
      return null;
    }
    return parsed.data;
  }

  /** Resolve a symbol's defining location. */
  async definition(uri: string, position: Position): Promise<DefinitionResponse | null> {
    if (!this.checkCapability('definitionProvider', 'textDocument/definition')) {
      return null;
    }
    const raw = await this.sendRequest('textDocument/definition', {
      textDocument: { uri },
      position,
    });
    if (raw === null) return null;
    const parsed = DefinitionResponseSchema.safeParse(raw);
    if (!parsed.success) {
      process.stderr.write(
        `[massu/lsp] WARN: textDocument/definition response failed Zod validation. (${parsed.error.message})\n`
      );
      return null;
    }
    return parsed.data;
  }

  /** Send `shutdown` then `exit`, then close transport. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      // Best-effort — don't block on shutdown if the server is unresponsive.
      await Promise.race([
        this.sendRequest('shutdown', null),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    } catch {
      /* ignore */
    }
    try {
      this.sendNotification('exit', null);
    } catch {
      /* ignore */
    }
    // Reject all in-flight requests.
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(null);
      this.pending.delete(id);
    }
    this.transport.close();
  }

  /** Read-only view of captured capabilities (post-initialize). */
  getCapabilities(): ServerCapabilities {
    return { ...this.capabilities };
  }

  // --------------------------------------------------------
  // Internals
  // --------------------------------------------------------

  /**
   * Returns true if the method should be sent. Returns false (and the caller
   * returns null) when the capability is missing/false OR was previously
   * marked dead via MethodNotFound.
   */
  private checkCapability(
    capabilityName: keyof ServerCapabilities,
    method: string
  ): boolean {
    if (this.deadMethods.has(method)) return false;
    if (!this.initialized) {
      // Pre-initialize calls are programmer errors — don't crash, just skip.
      process.stderr.write(
        `[massu/lsp] WARN: ${method} called before initialize() — skipping.\n`
      );
      return false;
    }
    const cap = this.capabilities[capabilityName];
    // `*Provider: true | { ...options }` → supported. `false | undefined` → not.
    if (cap === undefined || cap === false) return false;
    return true;
  }

  /**
   * Send a JSON-RPC request and resolve with the `result` field (raw, not yet
   * Zod-validated). Returns null on timeout, MethodNotFound (for graceful
   * degrade), or any other LSP error.
   */
  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const envelope = {
      jsonrpc: '2.0' as const,
      id,
      method,
      params,
    };
    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        process.stderr.write(
          `[massu/lsp] INFO: ${method} timed out after ${this.requestTimeoutMs}ms — degrading to AST-only for this field.\n`
        );
        resolve(null);
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value),
        reject: (err) => {
          process.stderr.write(`[massu/lsp] WARN: ${method} rejected: ${err.message}\n`);
          resolve(null);
        },
        timer,
        method,
      });

      try {
        this.transport.send(JSON.stringify(envelope));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        process.stderr.write(
          `[massu/lsp] WARN: failed to send ${method}: ${e instanceof Error ? e.message : String(e)}\n`
        );
        resolve(null);
      }
    });
  }

  /** Fire-and-forget notification (no response expected). */
  private sendNotification(method: string, params: unknown): void {
    const envelope = {
      jsonrpc: '2.0' as const,
      method,
      params,
    };
    try {
      this.transport.send(JSON.stringify(envelope));
    } catch (e) {
      process.stderr.write(
        `[massu/lsp] WARN: notification ${method} failed to send: ${e instanceof Error ? e.message : String(e)}\n`
      );
    }
  }

  /**
   * Dispatch an inbound message. Validates the envelope, ignores rogue
   * responses with mismatched ids (response-injection mitigation), and
   * marks methods as dead on MethodNotFound.
   */
  private handleMessage(raw: unknown): void {
    const env = LSPMessageEnvelopeSchema.safeParse(raw);
    if (!env.success) {
      process.stderr.write(
        `[massu/lsp] WARN: ignored malformed LSP envelope: ${env.error.message}\n`
      );
      return;
    }
    const e = env.data;
    if (e.id === undefined) {
      // Notification — ignore (we don't subscribe to anything).
      return;
    }
    if (typeof e.id !== 'number') {
      // We only ever send numeric ids.
      return;
    }
    const pending = this.pending.get(e.id);
    if (!pending) {
      // Mismatched id → response-injection or duplicate. Drop silently.
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(e.id);

    if (e.error) {
      if (e.error.code === LSPErrorCode.MethodNotFound) {
        // Mark this method dead for the lifetime of this client. Future calls
        // short-circuit via `deadMethods` check.
        this.deadMethods.add(pending.method);
        process.stderr.write(
          `[massu/lsp] INFO: server reported ${pending.method} not implemented — disabling for this session.\n`
        );
      }
      pending.resolve(null);
      return;
    }
    pending.resolve(e.result ?? null);
  }
}
