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

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { lstatSync, realpathSync } from 'fs';
import { isAbsolute, resolve as resolvePath } from 'path';
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
/**
 * Maximum cumulative bytes the parser will buffer waiting for a header to
 * arrive. A malicious LSP that drips characters forever without ever
 * producing `\r\n\r\n` would otherwise grow the inbound buffer unbounded.
 * 1MB is far more than any legitimate header. (Phase 3.5 finding #2)
 */
const MAX_HEADER_BUFFER_BYTES = 1 * 1024 * 1024;

/**
 * Strip prototype-pollution keys from any object before it crosses the
 * trust boundary. Zod's `.passthrough()` accepts arbitrary keys including
 * `__proto__` and `constructor.prototype`; we sanitise here so consumers
 * never observe a polluted object. (Phase 3.5 finding #2 — prototype
 * pollution.)
 */
function sanitizePolluted(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(sanitizePolluted);
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = sanitizePolluted((value as Record<string, unknown>)[k]);
  }
  return out;
}

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
      if (headerEnd === -1) {
        // No complete header yet. Cap buffer growth so a malicious LSP
        // that drips bytes without `\r\n\r\n` cannot exhaust memory.
        if (buffer.length > MAX_HEADER_BUFFER_BYTES) {
          process.stderr.write(
            `[massu/lsp] WARN: header buffer exceeded ${MAX_HEADER_BUFFER_BYTES} bytes without framing — dropping. (Phase 3.5 mitigation)\n`,
          );
          buffer = Buffer.alloc(0);
        }
        return;
      }
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
  /**
   * F-014 (closed 2026-05-06): when true, allow argv[0] to be a SUID/SGID
   * binary (or symlink resolving to one). Default false. SUID binaries
   * inherit elevated privileges from the kernel at exec time; Node has no
   * post-spawn way to strip them. The user-trust boundary is at config
   * time, but a defensive lstat catches accidental misconfigs (e.g.
   * pointing argv[0] at a system tool).
   */
  allowSetuid?: boolean;
  /**
   * F-015 (closed 2026-05-06): RSS budget in MB. The watchdog polls
   * `ps -p <pid> -o rss=` every WATCHDOG_INTERVAL_MS and SIGKILLs the
   * child if RSS exceeds this budget for two consecutive samples.
   * Default 1024 (1 GB). Set to 0 to disable the watchdog.
   */
  maxRssMb?: number;
}

// ============================================================
// Typed errors — F-014, F-015 (closed 2026-05-06)
// ============================================================

/**
 * Thrown by `LSPClient.fromCommand` when argv[0] (or its symlink target)
 * has the SUID/SGID bit set and `spec.allowSetuid: true` was not opted in.
 *
 * Why throw rather than silently accept: SUID binaries inherit elevated
 * privileges from the kernel at exec time. Node cannot strip them
 * post-spawn. A user who wants this MUST opt in explicitly so the
 * decision is auditable in their config.
 */
export class LspBinaryIsSetuidError extends Error {
  public readonly path: string;
  public readonly mode: number;
  constructor(path: string, mode: number) {
    super(
      `LSPClient.fromCommand: refused SUID/SGID binary at "${path}" ` +
        `(mode=${mode.toString(8)}). The kernel will exec this with ` +
        `elevated privileges; Node cannot strip that post-spawn. ` +
        `Set spec.allowSetuid: true to opt in (auditable in config).`,
    );
    this.name = 'LspBinaryIsSetuidError';
    this.path = path;
    this.mode = mode;
  }
}

/**
 * Constants for the F-015 RSS watchdog. Exported so tests can inspect
 * (and so a future config can override per-deployment if needed).
 */
export const DEFAULT_LSP_MAX_RSS_MB = 1024;
export const LSP_WATCHDOG_INTERVAL_MS = 30_000;
/**
 * Number of consecutive over-budget samples required before SIGKILL.
 * Avoids killing a server that briefly spikes during indexing — only
 * sustained over-budget triggers eviction.
 */
export const LSP_WATCHDOG_OVERBUDGET_SAMPLES = 2;

/**
 * F-014 helper: detect SUID/SGID bits on a file. Follows the chain via
 * lstat then statSync(realpath) so a symlink to a SUID binary is also
 * caught. Returns null if the file doesn't exist or the stat fails.
 *
 * Bit semantics (per stat(2)):
 *   - 0o4000 = SUID (set-user-ID on execution)
 *   - 0o2000 = SGID (set-group-ID on execution)
 */
export function _detectSetuid(path: string): { hasSetuid: boolean; mode: number; resolvedPath: string } | null {
  // First lstat — if argv[0] itself is a symlink, follow it via realpath.
  let resolved = path;
  try {
    const linkStat = lstatSync(path);
    if (linkStat.isSymbolicLink()) {
      resolved = realpathSync(path);
    }
  } catch {
    return null;
  }
  // Now stat the resolved (non-symlink) target.
  try {
    const targetStat = lstatSync(resolved);
    const mode = targetStat.mode;
    return {
      hasSetuid: (mode & 0o4000) !== 0 || (mode & 0o2000) !== 0,
      mode,
      resolvedPath: resolved,
    };
  } catch {
    return null;
  }
}

/**
 * F-015 helper: probe a child's RSS in MB via `ps -p <pid> -o rss=`.
 * Returns null if ps fails (e.g., process already gone, or non-POSIX
 * platform without ps). Best-effort — watchdog treats null as "no
 * sample, don't count toward over-budget streak."
 */
export function _probeChildRssMb(pid: number): number | null {
  try {
    const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    if (result.status !== 0 || !result.stdout) return null;
    const rssKb = parseInt(result.stdout.trim(), 10);
    if (!Number.isFinite(rssKb) || rssKb < 0) return null;
    return Math.round((rssKb / 1024) * 10) / 10;
  } catch {
    return null;
  }
}

/**
 * F-015 helper: install an interval-based RSS watchdog on a spawned child.
 * Returns the watchdog handle (interval id + cleanup) so the caller can
 * stop it on transport shutdown / process exit.
 *
 * The watchdog SIGKILLs the child if RSS exceeds the budget for
 * `LSP_WATCHDOG_OVERBUDGET_SAMPLES` consecutive samples. Killing emits a
 * stderr warning naming the LSP language and the breach.
 */
export function _startRssWatchdog(
  child: ChildProcess,
  language: string,
  maxRssMb: number,
  intervalMs: number = LSP_WATCHDOG_INTERVAL_MS,
): { stop: () => void } {
  if (maxRssMb <= 0) return { stop: () => { /* disabled */ } };
  let overBudgetStreak = 0;
  const tick = (): void => {
    if (!child.pid || child.killed || child.exitCode !== null) return;
    const rss = _probeChildRssMb(child.pid);
    if (rss === null) return; // no sample; don't penalise
    if (rss > maxRssMb) {
      overBudgetStreak += 1;
      process.stderr.write(
        `[massu/lsp] WARN: ${language} server RSS=${rss}MB > budget ${maxRssMb}MB ` +
          `(streak=${overBudgetStreak}/${LSP_WATCHDOG_OVERBUDGET_SAMPLES})\n`,
      );
      if (overBudgetStreak >= LSP_WATCHDOG_OVERBUDGET_SAMPLES) {
        process.stderr.write(
          `[massu/lsp] KILLING ${language} server pid=${child.pid}: ` +
            `sustained RSS over budget. (F-015 watchdog)\n`,
        );
        try { child.kill('SIGKILL'); } catch { /* best-effort */ }
        clearInterval(handle);
      }
    } else {
      overBudgetStreak = 0;
    }
  };
  const handle = setInterval(tick, intervalMs);
  // Don't keep the event loop alive solely for the watchdog.
  if (typeof handle.unref === 'function') handle.unref();
  return {
    stop: () => clearInterval(handle),
  };
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
      // Phase 3.5 finding #4 — null-byte injection. Node's spawn refuses
      // strings containing NUL on most platforms, but we add an explicit
      // check so the failure is descriptive and can never be silently
      // mishandled by a kernel-level argv split.
      if (a.includes('\0')) {
        throw new Error(`LSPClient.fromCommand: refused argv element containing NUL byte`);
      }
    }
    if (!spec.allowRelativePath && !isAbsolute(exe)) {
      throw new Error(
        `LSPClient.fromCommand: refused non-absolute executable "${exe}". ` +
          `Pass an absolute path or set allowRelativePath: true to opt in.`
      );
    }

    // F-014 (closed 2026-05-06): SUID/SGID bit detection. We only check
    // when argv[0] is absolute (post the relative-path gate) — for
    // allowRelativePath shapes the user has explicitly accepted that
    // PATH-resolution semantics apply, including any SUID a binary
    // resolved from PATH might have. Resolve the path to an absolute
    // form so the lstat target is unambiguous.
    if (!spec.allowSetuid) {
      const absExe = isAbsolute(exe) ? exe : resolvePath(exe);
      const det = _detectSetuid(absExe);
      if (det !== null && det.hasSetuid) {
        throw new LspBinaryIsSetuidError(det.resolvedPath, det.mode);
      }
    }

    const child = spawn(exe, spec.argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Explicitly NO `shell: true` — argv array form is the security
      // contract.
      shell: false,
      // Phase 3.5 finding #4: drop the parent's environment so the
      // spawned LSP cannot leak ambient secrets via env. Carry only PATH
      // (LSP servers commonly expect it for resolving sub-tools) and
      // HOME (some servers use it for cache directories).
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        LANG: process.env.LANG ?? 'C.UTF-8',
      },
    });

    // F-015 (closed 2026-05-06): RSS watchdog. Polls every 30s, kills
    // child after sustained over-budget. Disabled when maxRssMb === 0.
    const maxRssMb = spec.maxRssMb ?? DEFAULT_LSP_MAX_RSS_MB;
    const watchdog = _startRssWatchdog(child, spec.language, maxRssMb);

    // Stop the watchdog when the child exits naturally so the interval
    // doesn't outlive the process.
    child.once('exit', () => watchdog.stop());
    child.once('error', () => watchdog.stop());

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
    const parsed = InitializeResponseSchema.safeParse(sanitizePolluted(raw));
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
    const parsed = DocumentSymbolResponseSchema.safeParse(sanitizePolluted(raw));
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
    const parsed = WorkspaceSymbolResponseSchema.safeParse(sanitizePolluted(raw));
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
    const parsed = DefinitionResponseSchema.safeParse(sanitizePolluted(raw));
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
