#!/usr/bin/env node
import{createRequire as __cr}from"module";const require=__cr(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/credentials.ts
import { homedir } from "os";
import { resolve } from "path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  chmodSync
} from "fs";
function credentialsDir(home = homedir()) {
  return resolve(home, ".massu");
}
function credentialsPath(home = homedir()) {
  return resolve(credentialsDir(home), "credentials");
}
function readUserCredentials(home = homedir()) {
  try {
    const p = credentialsPath(home);
    if (!existsSync(p)) return void 0;
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    const key = typeof parsed?.apiKey === "string" ? parsed.apiKey.trim() : "";
    return key.length > 0 ? key : void 0;
  } catch {
    return void 0;
  }
}
function isUnresolvedLiteral(v) {
  return /^\$\{[^}]+\}$/.test(v);
}
function resolveApiKey(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cfg = typeof opts.configApiKey === "string" ? opts.configApiKey.trim() : "";
  if (cfg.length > 0 && !isUnresolvedLiteral(cfg)) {
    return { apiKey: cfg, source: "config" };
  }
  const envRaw = env[MASSU_ENV_API_KEY];
  const envKey = typeof envRaw === "string" ? envRaw.trim() : "";
  if (envKey.length > 0) {
    return { apiKey: envKey, source: "env" };
  }
  const fileKey = readUserCredentials(home);
  if (fileKey) {
    return { apiKey: fileKey, source: "user-file" };
  }
  return { source: "none" };
}
function resolveEndpoint(opts = {}) {
  const env = opts.env ?? process.env;
  const cfg = typeof opts.configEndpoint === "string" ? opts.configEndpoint.trim() : "";
  if (cfg.length > 0) return cfg;
  const envRaw = env[MASSU_ENV_CLOUD_ENDPOINT];
  const envEp = typeof envRaw === "string" ? envRaw.trim() : "";
  if (envEp.length > 0) return envEp;
  return DEFAULT_CLOUD_ENDPOINT;
}
var MASSU_ENV_API_KEY, MASSU_ENV_CLOUD_ENDPOINT, DEFAULT_CLOUD_ENDPOINT;
var init_credentials = __esm({
  "src/credentials.ts"() {
    "use strict";
    MASSU_ENV_API_KEY = "MASSU_API_KEY";
    MASSU_ENV_CLOUD_ENDPOINT = "MASSU_CLOUD_ENDPOINT";
    DEFAULT_CLOUD_ENDPOINT = "https://api.massu.ai/v1";
  }
});

// src/lib/fileLock.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "fs";
import { dirname } from "path";
import * as lockfile from "proper-lockfile";
function readLockHolderPid(lockPath) {
  try {
    const raw = readFileSync2(`${lockPath}.pid`, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}
function busyWaitSync(ms) {
  if (typeof SharedArrayBuffer === "undefined" || typeof Atomics === "undefined") {
    throw new Error(
      `withFileLockSync requires SharedArrayBuffer + Atomics for its retry-loop wait. This Node runtime does not provide them \u2014 refusing to fall back to a CPU spinloop. If you hit this in a sandboxed serverless env, the fix is to perform the lock-protected operation in a host runtime that supports Atomics.`
    );
  }
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}
function withFileLockSync(lockPath, fn, opts = {}) {
  mkdirSync2(dirname(lockPath), { recursive: true });
  const staleMs = opts.staleMs ?? 3e4;
  const blockMs = opts.retries === 0 ? 0 : opts.blockMs ?? 3e4;
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const now = opts.now ?? Date.now;
  const sleep2 = opts.sleep ?? busyWaitSync;
  const makeBusyError = opts.errorFactory ?? ((path, pid, retrySeconds, code) => new FileLockBusyError(path, pid, retrySeconds, code));
  let release = null;
  const deadline = now() + blockMs;
  for (; ; ) {
    try {
      release = lockfile.lockSync(lockPath, {
        stale: staleMs,
        retries: 0,
        realpath: false
      });
      try {
        writeFileSync2(`${lockPath}.pid`, String(process.pid), "utf-8");
      } catch {
      }
      break;
    } catch (err) {
      const e = err;
      const code = e.code;
      if (code !== "ELOCKED" && code !== "EBUSY") {
        throw err;
      }
      if (now() >= deadline) {
        const holderPid = readLockHolderPid(lockPath);
        const remainingMs = Math.max(0, deadline - now());
        const retryAfterSeconds = blockMs === 0 ? Math.round(staleMs / 1e3) : Math.round(remainingMs / 1e3);
        throw makeBusyError(lockPath, holderPid, retryAfterSeconds, code);
      }
      sleep2(pollIntervalMs);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (release) release();
    } catch {
    }
    try {
      rmSync2(`${lockPath}.pid`, { force: true });
    } catch {
    }
  }
}
var FileLockBusyError;
var init_fileLock = __esm({
  "src/lib/fileLock.ts"() {
    "use strict";
    FileLockBusyError = class extends Error {
      constructor(lockPath, holderPid, retryAfterSeconds, causeCode) {
        const pidPart = holderPid != null ? `(PID=${holderPid})` : "(PID=unknown)";
        super(`File lock at ${lockPath} held by another process ${pidPart} \u2014 try again in ${retryAfterSeconds}s`);
        this.lockPath = lockPath;
        this.holderPid = holderPid;
        this.retryAfterSeconds = retryAfterSeconds;
        this.causeCode = causeCode;
        this.name = "FileLockBusyError";
      }
      lockPath;
      holderPid;
      retryAfterSeconds;
      causeCode;
    };
  }
});

// src/lib/sqlite-loader.ts
import { createRequire } from "module";
import { spawnSync } from "child_process";
import { accessSync, appendFileSync, chmodSync as chmodSync2, constants as fsConstants, existsSync as existsSync2, mkdirSync as mkdirSync3 } from "fs";
import { dirname as dirname2, join } from "path";
function isNativeAbiError(err) {
  const code = err?.code;
  if (code === "ERR_DLOPEN_FAILED") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /NODE_MODULE_VERSION/.test(msg) || /was compiled against a different Node\.js version/.test(msg) || /ERR_DLOPEN_FAILED/.test(msg) || /\.node\b/.test(msg) && /dlopen|invalid ELF|mach-o|image not found|no such file|not a valid Win32/i.test(msg);
}
function loadBetterSqlite3(opts = {}) {
  if (_testCtor) return _testCtor;
  if (opts.fresh) bustNativeCache();
  return req("better-sqlite3");
}
function bustNativeCache() {
  try {
    const cache = req.cache;
    if (!cache) return;
    for (const key of Object.keys(cache)) {
      if (/better[-_]sqlite3|better_sqlite3\.node|[\\/]bindings[\\/]/.test(key)) {
        delete cache[key];
      }
    }
  } catch {
  }
}
function openDatabase(dbPath, opts = {}) {
  const { selfHeal: selfHealOpt = true, ...ctorOpts } = opts;
  const selfHeal = selfHealOpt && process.env.MASSU_HOOK_RUNTIME !== "1";
  const Ctor = loadBetterSqlite3();
  try {
    return new Ctor(dbPath, ctorOpts);
  } catch (err) {
    if (!isNativeAbiError(err)) {
      throw err;
    }
    if (!selfHeal) {
      recordHealEvent({ phase: "skipped", reason: "self-heal-disabled", abiTo: process.versions.modules });
      throw new MemoryEngineUnusableError("abi-mismatch", detailOf(err));
    }
    const result = (_testHeal ?? attemptNativeHeal)(err);
    if (!result.healed && !result.contended) {
      throw new MemoryEngineUnusableError(result.reason ?? "heal-failed", result.detail ?? detailOf(err));
    }
    try {
      const FreshCtor = loadBetterSqlite3({ fresh: true });
      return new FreshCtor(dbPath, ctorOpts);
    } catch (retryErr) {
      throw new MemoryEngineUnusableError("heal-failed", detailOf(retryErr));
    }
  }
}
function attemptNativeHeal(err) {
  const start = Date.now();
  const abiTo = process.versions.modules;
  const abiFrom = parseAbiFrom(err);
  let pkgDir;
  try {
    pkgDir = dirname2(req.resolve("better-sqlite3/package.json"));
  } catch {
    recordHealEvent({ phase: "skipped", reason: "not-resolvable", abiFrom, abiTo });
    return { healed: false, reason: "missing", abiFrom, abiTo, detail: "better-sqlite3 not resolvable" };
  }
  if (!isWritable(pkgDir)) {
    recordHealEvent({ phase: "skipped", reason: "dir-not-writable", abiFrom, abiTo });
    return { healed: false, reason: "heal-failed", abiFrom, abiTo, detail: `install dir not writable: ${pkgDir}` };
  }
  recordHealEvent({ phase: "attempt", reason: "abi-mismatch", abiFrom, abiTo });
  try {
    return withFileLockSync(
      join(credentialsDir(), "native-heal.lock"),
      () => runRebuild(pkgDir, abiFrom, abiTo, start),
      { blockMs: 6e4, staleMs: 3e5 }
    );
  } catch (lockErr) {
    const detail = lockErr instanceof Error ? lockErr.message : String(lockErr);
    recordHealEvent({ phase: "failed", reason: "heal-failed", abiFrom, abiTo, detail: `lock: ${detail}` });
    return { healed: false, contended: true, reason: "heal-failed", abiFrom, abiTo, detail: `heal lock contended: ${detail}` };
  }
}
function runRebuild(pkgDir, abiFrom, abiTo, start) {
  try {
    const FreshCtor = loadBetterSqlite3({ fresh: true });
    new FreshCtor(":memory:").close();
    const res2 = {
      healed: true,
      abiFrom,
      abiTo,
      durationMs: Date.now() - start,
      detail: "already healed by a concurrent process"
    };
    recordHealEvent({ phase: "success", reason: "already-healed", abiFrom, abiTo, durationMs: res2.durationMs });
    return res2;
  } catch (probeErr) {
    if (!isNativeAbiError(probeErr)) {
      return { healed: false, reason: "heal-failed", abiFrom, abiTo, durationMs: Date.now() - start, detail: detailOf(probeErr) };
    }
  }
  const prebuildBin = resolveLocalBin(pkgDir, "prebuild-install");
  if (prebuildBin) {
    const r = spawnSync(process.execPath, [prebuildBin], {
      cwd: pkgDir,
      encoding: "utf-8",
      timeout: 12e4
    });
    if (r.status === 0) {
      const res2 = { healed: true, method: "prebuild-install", abiFrom, abiTo, durationMs: Date.now() - start };
      recordHealEvent({ phase: "success", reason: "abi-mismatch", ...res2 });
      return res2;
    }
  }
  const gypBin = resolveNodeGypBin();
  if (gypBin && hasCompiler()) {
    const r = spawnSync(process.execPath, [gypBin, "rebuild", "--release"], {
      cwd: pkgDir,
      encoding: "utf-8",
      timeout: 3e5
    });
    if (r.status === 0) {
      const res2 = { healed: true, method: "node-gyp", abiFrom, abiTo, durationMs: Date.now() - start };
      recordHealEvent({ phase: "success", reason: "abi-mismatch", ...res2 });
      return res2;
    }
  }
  const res = {
    healed: false,
    reason: "heal-failed",
    abiFrom,
    abiTo,
    durationMs: Date.now() - start,
    detail: prebuildBin ? "prebuild-install failed; node-gyp fallback unavailable or failed" : "no prebuild-install bin resolvable"
  };
  recordHealEvent({ phase: "failed", reason: "heal-failed", abiFrom, abiTo, durationMs: res.durationMs });
  return res;
}
function recordHealEvent(event) {
  try {
    const rec = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      ...event
    };
    const dir = credentialsDir();
    mkdirSync3(dir, { recursive: true });
    const file = join(dir, "native-heal-events.jsonl");
    appendFileSync(file, JSON.stringify(rec) + "\n", "utf-8");
    try {
      chmodSync2(file, 384);
    } catch {
    }
  } catch {
  }
}
function parseAbiFrom(err) {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const m = /NODE_MODULE_VERSION (\d+)/.exec(msg);
  if (m && /^\d+$/.test(m[1])) return m[1];
  return void 0;
}
function detailOf(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 300);
}
function isWritable(dir) {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}
function resolveLocalBin(pkgDir, name) {
  const candidates = [
    join(pkgDir, "node_modules", ".bin", name),
    // nested install
    join(pkgDir, "..", ".bin", name),
    // hoisted (node_modules/.bin)
    join(pkgDir, "..", "..", "node_modules", ".bin", name)
    // workspace hoist
  ];
  for (const c of candidates) {
    if (existsSync2(c)) return c;
  }
  return void 0;
}
function resolveNodeGypBin() {
  try {
    return req.resolve("node-gyp/bin/node-gyp.js");
  } catch {
    return void 0;
  }
}
function hasCompiler() {
  for (const cc of ["cc", "clang", "gcc"]) {
    try {
      const r = spawnSync(cc, ["--version"], { encoding: "utf-8", timeout: 5e3 });
      if (r.status === 0) return true;
    } catch {
    }
  }
  return false;
}
var req, NATIVE_DB_REMEDY, MemoryEngineUnusableError, _testCtor, _testHeal;
var init_sqlite_loader = __esm({
  "src/lib/sqlite-loader.ts"() {
    "use strict";
    init_credentials();
    init_fileLock();
    req = createRequire(import.meta.url);
    NATIVE_DB_REMEDY = "Run 'massu heal' to rebuild the database engine for your Node version, then restart your MCP client / Claude Code.";
    MemoryEngineUnusableError = class extends Error {
      reason;
      remedy;
      detail;
      constructor(reason, detail) {
        super(
          `Massu memory engine is unusable (${reason}). ${NATIVE_DB_REMEDY}` + (detail ? ` [${detail}]` : "")
        );
        this.name = "MemoryEngineUnusableError";
        this.reason = reason;
        this.remedy = NATIVE_DB_REMEDY;
        this.detail = detail;
      }
    };
    _testCtor = null;
    _testHeal = null;
  }
});

// src/db-driver.ts
import { createRequire as createRequire2 } from "module";
import { closeSync, existsSync as existsSync3, mkdtempSync, openSync, readFileSync as readFileSync3, rmSync as rmSync3, fsyncSync } from "fs";
import { tmpdir } from "os";
import { join as join2 } from "path";
function resolveDbEngine() {
  return process.env[DB_ENGINE_ENV] === "better-sqlite3" ? "better-sqlite3" : DEFAULT_DB_ENGINE;
}
function resolveBusyTimeoutMs() {
  const raw = process.env[DB_BUSY_TIMEOUT_ENV];
  if (raw === void 0 || raw === "") return DEFAULT_BUSY_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_BUSY_TIMEOUT_MS;
}
function nodeSqliteCtor() {
  if (!_nodeCtor) _nodeCtor = req2("node:sqlite").DatabaseSync;
  return _nodeCtor;
}
function plainRow(row) {
  if (row == null || typeof row !== "object") return row;
  return { ...row };
}
function openNodeSqlite(dbPath, opts) {
  const Ctor = nodeSqliteCtor();
  const raw = new Ctor(dbPath, {
    open: true,
    readOnly: !!opts.readonly,
    // FAITHFULNESS: better-sqlite3's ACTUAL default is foreign_keys=ON (empirically
    // verified — SQLite's own default is OFF, but bs3 enables it). massu was written +
    // tested against that default, so the adapter must match it, or a store that relies
    // on FK-ON-by-default (without an explicit pragma) would silently lose enforcement.
    // Explicit `foreign_keys=OFF/ON` pragmas (e.g. memory-db bulk ops) still override.
    enableForeignKeyConstraints: true,
    allowExtension: false
  });
  raw.exec(`PRAGMA busy_timeout = ${resolveBusyTimeoutMs()}`);
  let savepointSeq = 0;
  const wrapStmt = (sql) => {
    const st = raw.prepare(sql);
    return {
      run: (...p) => {
        const r = st.run(...p);
        return {
          changes: typeof r.changes === "bigint" ? Number(r.changes) : r.changes,
          lastInsertRowid: r.lastInsertRowid
        };
      },
      get: (...p) => plainRow(st.get(...p)),
      all: (...p) => st.all(...p).map(plainRow)
    };
  };
  const pragma = (source, options) => {
    const s = String(source).trim();
    if (s.includes("=")) {
      raw.exec(`PRAGMA ${s}`);
      return void 0;
    }
    const rows = raw.prepare(`PRAGMA ${s}`).all().map(plainRow);
    if (options?.simple) {
      const first = rows[0];
      return first ? Object.values(first)[0] : void 0;
    }
    return rows;
  };
  const transaction = (fn) => {
    const run = (...args) => {
      const nested = raw.isTransaction;
      const name = `msp_${savepointSeq++}`;
      if (nested) raw.exec(`SAVEPOINT ${name}`);
      else raw.exec("BEGIN");
      try {
        const out = fn(...args);
        if (nested) raw.exec(`RELEASE ${name}`);
        else raw.exec("COMMIT");
        return out;
      } catch (e) {
        if (nested) {
          raw.exec(`ROLLBACK TO ${name}`);
          raw.exec(`RELEASE ${name}`);
        } else {
          raw.exec("ROLLBACK");
        }
        throw e;
      }
    };
    return run;
  };
  const serialize = () => {
    if (raw.isTransaction) {
      throw new Error(
        "db-driver: .serialize() (node:sqlite engine) cannot run inside an open transaction \u2014 VACUUM is forbidden in a transaction. Serialize before BEGIN, or use MASSU_DB_ENGINE=better-sqlite3 for mid-transaction snapshots."
      );
    }
    const dir = mkdtempSync(join2(tmpdir(), "massu-serialize-"));
    const out = join2(dir, "snapshot.db");
    try {
      raw.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
      const fd = openSync(out, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return readFileSync3(out);
    } finally {
      rmSync3(dir, { recursive: true, force: true });
    }
  };
  const handle = {
    prepare: (sql) => wrapStmt(sql),
    exec: (sql) => raw.exec(sql),
    pragma,
    transaction,
    serialize,
    close: () => raw.close()
  };
  return handle;
}
function openBetterSqlite3(dbPath, opts) {
  const db = openDatabase(dbPath, opts);
  db.exec(`PRAGMA busy_timeout = ${resolveBusyTimeoutMs()}`);
  return db;
}
function openDatabase2(dbPath, opts = {}) {
  return resolveDbEngine() === "better-sqlite3" ? openBetterSqlite3(dbPath, opts) : openNodeSqlite(dbPath, opts);
}
var req2, DEFAULT_DB_ENGINE, DB_ENGINE_ENV, DEFAULT_BUSY_TIMEOUT_MS, DB_BUSY_TIMEOUT_ENV, _nodeCtor;
var init_db_driver = __esm({
  "src/db-driver.ts"() {
    "use strict";
    init_sqlite_loader();
    init_sqlite_loader();
    req2 = createRequire2(import.meta.url);
    DEFAULT_DB_ENGINE = "node-sqlite";
    DB_ENGINE_ENV = "MASSU_DB_ENGINE";
    DEFAULT_BUSY_TIMEOUT_MS = 5e3;
    DB_BUSY_TIMEOUT_ENV = "MASSU_DB_BUSY_TIMEOUT_MS";
    _nodeCtor = null;
  }
});

// src/lib/memory-path.ts
function encodeMemoryDirName(projectRoot) {
  return projectRoot.replace(/\//g, "-");
}
var init_memory_path = __esm({
  "src/lib/memory-path.ts"() {
    "use strict";
  }
});

// src/config-memory-schema.ts
import { z } from "zod";
var MemoryConfigSchema;
var init_config_memory_schema = __esm({
  "src/config-memory-schema.ts"() {
    "use strict";
    MemoryConfigSchema = z.object({
      recall: z.object({
        enabled: z.boolean().default(true),
        maxTokens: z.number().int().positive().default(1200),
        sources: z.array(
          z.enum([
            "observation",
            "architecture_decision",
            "knowledge_chunk",
            "failure_class"
          ])
        ).default(["observation", "architecture_decision", "knowledge_chunk", "failure_class"]),
        timeoutMs: z.number().int().positive().default(8e3),
        limit: z.number().int().positive().default(8),
        minScore: z.number().min(0).default(0),
        // --- Semantic embedder (plan-living-memory-slice-2a-embedder, P3-001) ---
        // embedEnabled: Tier-1 bundled WASM embedder on by default; false forces
        //   Tier-2 (FTS keyword-only) recall.
        // embedEndpoint: optional Tier-0 OpenAI-compatible /v1/embeddings provider
        //   (Ollama, LM Studio, vLLM, or any hosted API). When set, embedding egresses ONLY to this
        //   operator-chosen endpoint; unset means zero egress (bundled model).
        // embedModel: optional Tier-0 model name sent to that endpoint.
        embedEnabled: z.boolean().default(true),
        embedEndpoint: z.string().url().refine((s) => /^https?:\/\//i.test(s), {
          message: "memory.recall.embedEndpoint must be an http(s) URL"
        }).optional(),
        embedModel: z.string().min(1).optional()
      }).default({}),
      // --- Contradiction / supersede gate (plan-living-memory-slice-2-temporal-model, P5-001) ---
      // When a new high-value memory (decision/correction) is written, find
      // semantically-related existing records and, if the new one contradicts an
      // old one, supersede-don't-delete the old row. Fully fail-open + gated to a
      // small set of high-value types so the hot capture path is untouched.
      contradiction: z.object({
        // Master switch. false → every write is a plain insert (prior behavior).
        enabled: z.boolean().default(true),
        // Optional Tier-0 external judge (OpenAI-compatible). null/unset → local
        // heuristic only, ZERO egress. When set, candidate + related records egress
        // ONLY to this operator-chosen endpoint; any error falls back to heuristic.
        judgeEndpoint: z.string().url().refine((s) => /^https?:\/\//i.test(s), {
          message: "memory.contradiction.judgeEndpoint must be an http(s) URL"
        }).optional(),
        // Cosine similarity above which a correction-flavored new record is treated
        // as superseding a related existing record. Calibrated to all-MiniLM-L6-v2
        // (same-topic contradictions ≈0.65–0.86; related-but-complementary ≈0.47).
        similarityThreshold: z.number().min(0).max(1).default(0.6),
        // Cosine similarity above which a new record is a near-duplicate (NOOP).
        dedupThreshold: z.number().min(0).max(1).default(0.93),
        // Observation types the gate runs for. High-volume 'file_change' is
        // deliberately excluded so the hot path never triggers a hybridSearch.
        gatedTypes: z.array(z.string()).default(["decision", "cr_violation", "failed_attempt"]),
        // When true, superseded rows may still surface in recall with a
        // "(superseded on <date> by #<id>)" annotation instead of being excluded.
        annotateSuperseded: z.boolean().default(false),
        // Time budget (ms) for the contradiction check; exceeded → fail-open (ADD).
        budgetMs: z.number().int().positive().default(800)
      }).default({}),
      // --- Background consolidation, the "sleep-time" pass
      //     (plan-living-memory-slice-3-consolidation) ---
      // Keeps memory sharp over years: dedupes, distills dying sessions into
      // durable lessons, spots corrections you keep repeating, reweights by what
      // actually gets used, and retires dead weight by EXPIRING it (never deleting).
      //
      // Runs with ZERO LLM and ZERO network by default — every stage is arithmetic
      // plus the embedding model Massu already bundles. `llmEndpoint` is OPTIONAL
      // and upgrades the prose of session summaries ONLY.
      consolidation: z.object({
        enabled: z.boolean().default(true),
        // Bounded sweep at session end — the automatic path (no scheduler needed).
        sessionSweepEnabled: z.boolean().default(true),
        // OPTIONAL local/remote OpenAI-compatible chat endpoint. UNSET = zero egress.
        // When set, session text egresses ONLY to this endpoint you chose.
        // NOTE: the API key is NEVER configured here — it is read exclusively from
        // the MASSU_MEMORY_LLM_API_KEY env var, so a key can never be committed.
        llmEndpoint: z.string().url().refine((s) => /^https?:\/\//i.test(s), {
          message: "memory.consolidation.llmEndpoint must be an http(s) URL"
        }).optional(),
        // Model NAME/ALIAS sent to llmEndpoint (e.g. "llama3.1:8b").
        llmModel: z.string().optional(),
        // Distill a session once its newest turn is older than this. Must stay
        // INSIDE the 7-day conversation_turns prune window or the raw material is
        // destroyed before it is ever summarized.
        summarizeAfterDays: z.number().int().positive().default(5),
        // Age past which an unprotected, never-retrieved, low-importance row may expire.
        retentionDays: z.number().int().positive().default(90),
        importanceFloor: z.number().int().min(1).max(5).default(2),
        // Types that may NEVER expire, however old.
        protectedTypes: z.array(z.string()).default(["decision", "cr_violation", "incident_near_miss"]),
        // Days the retrieval counter must observe usage BEFORE any expiry is armed.
        // The cold-start guard: on a fresh counter nothing has "ever been
        // retrieved", so without this the first pass would gut the store.
        usageWarmupDays: z.number().int().nonnegative().default(30),
        // Per-pass decay on the windowed hit count, so usefulness must be sustained.
        usageDecay: z.number().min(0).max(1).default(0.9),
        // A record is reweighted at most once per this many days (idempotency).
        reweightIntervalDays: z.number().int().positive().default(1),
        // Recurrences (across >= 2 sessions) before a rule candidate is proposed.
        promoteMinOccurrences: z.number().int().positive().default(3),
        budgetMs: z.number().int().positive().default(3e3),
        // Surface optional upgrades (e.g. "a local model was detected") in chat.
        suggestUpgrades: z.boolean().default(true),
        suggestIntervalDays: z.number().int().positive().default(30)
      }).default({}),
      // A-20 (Slice 4) — memory FILES: the mirror, and the one switch that decides whether
      // Massu may ever WRITE into the user's memory directory.
      //
      // ⛔ `renderEnabled` DEFAULTS TO FALSE. 4B is the first capability in Massu's history
      // that writes files into the place the user keeps their own hand-written prose. A new
      // write capability that arrives switched-on in an `npm update` is a capability nobody
      // consented to. The path is: the advisor OFFERS it in chat -> the user runs
      // `massu memory render --dry-run` and sees exactly what WOULD be written -> the user
      // turns it on. Three deliberate steps, none implicit. A drift-guard pins this default.
      files: z.object({
        // The lossless file<->store mirror (ingest side). Read-only; it writes nothing.
        enabled: z.boolean().default(true),
        // The ONLY flag here that grants a WRITE. Never auto-enable.
        renderEnabled: z.boolean().default(false),
        // Anti-spam: files Massu may render in ONE session.
        renderMaxFilesPerSession: z.number().int().min(0).default(3),
        // Only memories at/above this importance are worth a durable file.
        renderMinImportance: z.number().int().min(1).max(5).default(4),
        // The clearly-labelled MEMORY.md section Massu's pointers live under.
        indexSection: z.string().default("Learned by Massu"),
        // Hard bound on the managed MEMORY.md region. MEMORY.md is auto-loaded into EVERY
        // turn of EVERY session, so an unbounded index is a permanent context tax — and the
        // per-session cap bounds only the RATE, never the total.
        indexMaxLines: z.number().int().min(1).default(50)
      }).default({}),
      // --- Cross-repo memory surfacing (plan-living-memory-slice-5-cross-repo-surfacing) ---
      // A decision made in one of your repos can surface in another — opt-in per
      // decision AND opt-in per repo, signed, verified, and materialized ONLY on
      // explicit human acceptance. Local transport is FREE and zero-network.
      //
      // ⛔ BOTH switches default OFF, and OFF means NOTHING EXISTS — no registry, no
      // keys, no inbox, no behavioural difference. Two INDEPENDENT opt-ins:
      //   • enabled   — may this repo EXPORT its shareable decisions? (opt-in #1)
      //   • subscribe — which repo LABELS may this repo IMPORT from? (opt-in #2)
      // `subscribe: []` means import NOTHING. There is deliberately NO `subscribe: all`
      // — a repo you never named is a repo Massu never reads from.
      share: z.object({
        enabled: z.boolean().default(false),
        subscribe: z.array(z.string()).default([]),
        // C-04 — recall surfacing of cross-repo memories. `enabled` defaults true but is
        // CONDITIONAL on `subscribe` being non-empty (empty by default), so the effective
        // default is DORMANT: with `subscribe: []` the recall hook output is byte-identical
        // to today's. `maxCrossRepoItems` caps how many accepted cross-repo items may appear
        // per recall block (default 1); `minScore` is an OPTIONAL strictly-higher floor for
        // cross-repo items (they are, by construction, less relevant than local ones).
        recall: z.object({
          enabled: z.boolean().default(true),
          maxCrossRepoItems: z.number().int().min(0).default(1),
          minScore: z.number().optional()
        }).default({})
      }).default({})
    }).optional();
  }
});

// src/config.ts
import { resolve as resolve2, dirname as dirname3 } from "path";
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "fs";
import { homedir as homedir2 } from "os";
import { parse as parseYaml } from "yaml";
import { z as z2 } from "zod";
function findProjectRoot() {
  const cwd = process.cwd();
  let dir = cwd;
  while (true) {
    if (existsSync4(resolve2(dir, "massu.config.yaml"))) {
      return dir;
    }
    const parent = dirname3(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dir = cwd;
  while (true) {
    if (existsSync4(resolve2(dir, "package.json"))) {
      return dir;
    }
    if (existsSync4(resolve2(dir, ".git"))) {
      return dir;
    }
    const parent = dirname3(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}
function getProjectRoot() {
  if (!_projectRoot) {
    _projectRoot = findProjectRoot();
  }
  return _projectRoot;
}
function getConfig() {
  if (_config) return _config;
  const root = getProjectRoot();
  const configPath = resolve2(root, "massu.config.yaml");
  let rawYaml = {};
  if (existsSync4(configPath)) {
    const content = readFileSync4(configPath, "utf-8");
    rawYaml = parseYaml(content) ?? {};
  }
  const result = RawConfigSchema.safeParse(rawYaml);
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      const received = "received" in i && i.received !== void 0 ? ` (received ${JSON.stringify(i.received)})` : "";
      return `  - ${path}: ${i.message}${received}`;
    }).join("\n");
    throw new Error(
      `Invalid massu.config.yaml at ${configPath}:
${issues}
Hint: run \`massu config refresh\` to regenerate a valid config or fix the listed fields manually.`
    );
  }
  const parsed = result.data;
  const projectRoot = parsed.project.root === "auto" || !parsed.project.root ? root : resolve2(root, parsed.project.root);
  const fw = parsed.framework;
  let router = fw.router;
  let orm = fw.orm;
  let ui = fw.ui;
  if (fw.type === "multi" && fw.primary && fw.languages) {
    const primaryEntry = fw.languages[fw.primary];
    if (primaryEntry) {
      if (router === "none" && primaryEntry.router) router = primaryEntry.router;
      if (orm === "none" && primaryEntry.orm) orm = primaryEntry.orm;
      if (ui === "none" && primaryEntry.ui) ui = primaryEntry.ui;
    }
  }
  _config = {
    schema_version: parsed.schema_version,
    project: {
      name: parsed.project.name,
      root: projectRoot
    },
    // Spread `fw` first so zod-`.passthrough()` extras (e.g., `framework.swift`,
    // `framework.python`) survive into the consumer-visible Config. Then override
    // the v2-backcompat-mirrored router/orm/ui values. Without the spread, the
    // variant-resolution `pickVariant` (install-commands.ts) cannot see the
    // top-level passthrough language blocks.
    framework: {
      ...fw,
      router,
      orm,
      ui
    },
    paths: parsed.paths,
    toolPrefix: parsed.toolPrefix,
    dbAccessPattern: parsed.dbAccessPattern,
    knownMismatches: parsed.knownMismatches,
    accessScopes: parsed.accessScopes,
    domains: parsed.domains,
    rules: parsed.rules,
    // P-M-036: customer-authored CR-style governance rules.
    governance_rules: parsed.governance_rules,
    analytics: parsed.analytics,
    governance: parsed.governance,
    security: parsed.security,
    team: parsed.team,
    regression: parsed.regression,
    cloud: parsed.cloud,
    memory: parsed.memory,
    conventions: parsed.conventions,
    autoLearning: parsed.autoLearning,
    python: parsed.python,
    verification: parsed.verification,
    canonical_paths: parsed.canonical_paths,
    verification_types: parsed.verification_types,
    detection: parsed.detection,
    detected: parsed.detected,
    watch: parsed.watch,
    adapters: parsed.adapters,
    telemetry: parsed.telemetry,
    lsp: parsed.lsp
  };
  const resolvedKey = resolveApiKey({ configApiKey: _config.cloud?.apiKey });
  _resolvedApiKeySource = resolvedKey.source;
  const resolvedEndpoint = resolveEndpoint({ configEndpoint: _config.cloud?.endpoint });
  if (resolvedKey.apiKey) {
    _config.cloud = {
      sync: { memory: true, analytics: true, audit: true },
      ..._config.cloud,
      // Spread FIRST, then decide `enabled`, so a workspace that declares a `cloud:`
      // block only to tune `requestTimeoutMs` does not disable its own sync. An
      // EXPLICIT `enabled: false` is still honoured; `undefined` (not stated) means
      // "a key resolved, so turn it on". (plan-2026-07-20-cloud-sync-timeout)
      enabled: _config.cloud?.enabled ?? true,
      apiKey: resolvedKey.apiKey,
      endpoint: resolvedEndpoint
    };
  } else if (_config.cloud) {
    _config.cloud = { ..._config.cloud, endpoint: _config.cloud.endpoint ?? resolvedEndpoint };
  }
  return _config;
}
function getResolvedPaths() {
  const config = getConfig();
  const root = getProjectRoot();
  const claudeDirName = config.conventions?.claudeDirName ?? ".claude";
  return {
    codegraphDbPath: resolve2(root, ".codegraph/codegraph.db"),
    dataDbPath: resolve2(root, ".massu/data.db"),
    prismaSchemaPath: resolve2(root, config.paths.schema ?? "prisma/schema.prisma"),
    rootRouterPath: resolve2(root, config.paths.routerRoot ?? "src/server/api/root.ts"),
    routersDir: resolve2(root, config.paths.routers ?? "src/server/api/routers"),
    srcDir: resolve2(root, config.paths.source),
    pathAlias: Object.fromEntries(
      Object.entries(config.paths.aliases).map(([alias, target]) => [
        alias,
        resolve2(root, target)
      ])
    ),
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    indexFiles: ["index.ts", "index.tsx", "index.js", "index.jsx"],
    patternsDir: resolve2(root, claudeDirName, "patterns"),
    claudeMdPath: resolve2(root, claudeDirName, "CLAUDE.md"),
    docsMapPath: resolve2(root, ".massu/docs-map.json"),
    helpSitePath: resolve2(root, "../" + config.project.name + "-help"),
    memoryDbPath: resolve2(root, ".massu/memory.db"),
    knowledgeDbPath: resolve2(root, ".massu/knowledge.db"),
    plansDir: resolve2(root, "docs/plans"),
    docsDir: resolve2(root, "docs"),
    claudeDir: resolve2(root, claudeDirName),
    memoryDir: resolve2(homedir2(), claudeDirName, "projects", encodeMemoryDirName(root), "memory"),
    sessionStatePath: resolve2(root, config.conventions?.sessionStatePath ?? `${claudeDirName}/session-state/CURRENT.md`),
    sessionArchivePath: resolve2(root, config.conventions?.sessionArchivePath ?? `${claudeDirName}/session-state/archive`),
    mcpJsonPath: resolve2(root, ".mcp.json"),
    settingsPath: resolve2(root, claudeDirName, "settings.json"),
    settingsLocalPath: resolve2(root, claudeDirName, "settings.local.json")
  };
}
var DomainConfigSchema, PatternRuleConfigSchema, CostModelSchema, AnalyticsConfigSchema, CustomPatternSchema, GovernanceConfigSchema, SecurityPatternSchema, SecurityConfigSchema, TeamConfigSchema, RegressionConfigSchema, AutoLearningConfigSchema, CloudConfigSchema, ConventionsConfigSchema, PythonDomainConfigSchema, PythonConfigSchema, PathsConfigSchema, LanguageFrameworkEntrySchema, FrameworkConfigSchema, DetectedConfigSchema, VerificationEntrySchema, VerificationConfigSchema, CanonicalPathsSchema, VerificationTypesSchema, DetectionRuleEntrySchema, DetectionConfigSchema, WatchConfigSchema, AdapterLocalPathSchema, AdaptersConfigSchema, TelemetryConfigSchema, LSPConfigSchema, RawConfigSchema, _config, _resolvedApiKeySource, _projectRoot;
var init_config = __esm({
  "src/config.ts"() {
    "use strict";
    init_memory_path();
    init_credentials();
    init_config_memory_schema();
    DomainConfigSchema = z2.object({
      name: z2.string().default("Unknown"),
      routers: z2.array(z2.string()).default([]),
      pages: z2.array(z2.string()).default([]),
      tables: z2.array(z2.string()).default([]),
      allowedImportsFrom: z2.array(z2.string()).default([])
    });
    PatternRuleConfigSchema = z2.object({
      pattern: z2.string().default("**"),
      rules: z2.array(z2.string()).default([]),
      language: z2.string().optional()
    });
    CostModelSchema = z2.object({
      input_per_million: z2.number(),
      output_per_million: z2.number(),
      cache_read_per_million: z2.number().optional(),
      cache_write_per_million: z2.number().optional()
    });
    AnalyticsConfigSchema = z2.object({
      quality: z2.object({
        weights: z2.record(z2.string(), z2.number()).default({
          bug_found: -5,
          vr_failure: -10,
          incident: -20,
          cr_violation: -3,
          vr_pass: 2,
          clean_commit: 5,
          successful_verification: 3
        }),
        categories: z2.array(z2.string()).default(["security", "architecture", "coupling", "tests", "rule_compliance"])
      }).optional(),
      cost: z2.object({
        models: z2.record(z2.string(), CostModelSchema).default({}),
        currency: z2.string().default("USD")
      }).optional(),
      prompts: z2.object({
        success_indicators: z2.array(z2.string()).default(["committed", "approved", "looks good", "perfect", "great", "thanks"]),
        failure_indicators: z2.array(z2.string()).default(["revert", "wrong", "that's not", "undo", "incorrect"]),
        max_turns_for_success: z2.number().default(2)
      }).optional()
    }).optional();
    CustomPatternSchema = z2.object({
      pattern: z2.string(),
      severity: z2.string(),
      message: z2.string()
    });
    GovernanceConfigSchema = z2.object({
      audit: z2.object({
        formats: z2.array(z2.string()).default(["summary", "detailed", "soc2"]),
        retention_days: z2.number().default(365),
        auto_log: z2.record(z2.string(), z2.boolean()).default({
          code_changes: true,
          rule_enforcement: true,
          approvals: true,
          commits: true
        })
      }).optional(),
      validation: z2.object({
        realtime: z2.boolean().default(true),
        checks: z2.record(z2.string(), z2.boolean()).default({
          rule_compliance: true,
          import_existence: true,
          naming_conventions: true
        }),
        custom_patterns: z2.array(CustomPatternSchema).default([])
      }).optional(),
      adr: z2.object({
        template: z2.string().default("default"),
        storage: z2.string().default("database"),
        output_dir: z2.string().default("docs/adr")
      }).optional()
    }).optional();
    SecurityPatternSchema = z2.object({
      pattern: z2.string(),
      severity: z2.string(),
      category: z2.string(),
      description: z2.string()
    });
    SecurityConfigSchema = z2.object({
      patterns: z2.array(SecurityPatternSchema).default([]),
      auto_score_on_edit: z2.boolean().default(true),
      score_threshold_alert: z2.number().default(50),
      severity_weights: z2.record(z2.string(), z2.number()).optional(),
      restrictive_licenses: z2.array(z2.string()).optional(),
      dep_alternatives: z2.record(z2.string(), z2.array(z2.string())).optional(),
      dependencies: z2.object({
        package_manager: z2.string().default("npm"),
        blocked_packages: z2.array(z2.string()).default([]),
        preferred_packages: z2.record(z2.string(), z2.string()).default({}),
        max_bundle_size_kb: z2.number().default(500)
      }).optional()
    }).optional();
    TeamConfigSchema = z2.object({
      enabled: z2.boolean().default(false),
      sync_backend: z2.string().default("local"),
      developer_id: z2.string().default("auto"),
      share_by_default: z2.boolean().default(false),
      expertise_weights: z2.object({
        session: z2.number().default(20),
        observation: z2.number().default(10)
      }).optional(),
      privacy: z2.object({
        share_file_paths: z2.boolean().default(true),
        share_code_snippets: z2.boolean().default(false),
        share_observations: z2.boolean().default(true)
      }).optional()
    }).optional();
    RegressionConfigSchema = z2.object({
      test_patterns: z2.array(z2.string()).default([
        "{dir}/__tests__/{name}.test.{ext}",
        "{dir}/{name}.spec.{ext}",
        "tests/{path}.test.{ext}"
      ]),
      test_runner: z2.string().default("npm test"),
      health_thresholds: z2.object({
        healthy: z2.number().default(80),
        warning: z2.number().default(50)
      }).optional()
    }).optional();
    AutoLearningConfigSchema = z2.object({
      enabled: z2.boolean().default(true),
      incidentDir: z2.string().default("docs/incidents"),
      memoryDir: z2.string().default("memory"),
      memoryIndexFile: z2.string().default("MEMORY.md"),
      enforcementHooksDir: z2.string().default("scripts/hooks"),
      fixDetection: z2.object({
        enabled: z2.boolean().default(true),
        lookbackDays: z2.number().default(7),
        signals: z2.array(z2.string()).default([
          "removed_broken_code",
          "added_error_handling",
          "method_name_correction",
          "auth_fix",
          "nil_handling_fix",
          "concurrency_fix",
          "async_pattern_fix",
          "added_missing_import"
        ])
      }).default({}),
      failureClassification: z2.object({
        enabled: z2.boolean().default(true),
        thresholds: z2.object({
          known: z2.number().default(5),
          similar: z2.number().default(3)
        }).default({}),
        scoring: z2.object({
          diffPatternWeight: z2.number().default(3),
          filePatternWeight: z2.number().default(2),
          promptKeywordWeight: z2.number().default(2)
        }).default({})
      }).default({}),
      pipeline: z2.object({
        requireIncidentReport: z2.boolean().default(true),
        requirePreventionRule: z2.boolean().default(true),
        requireEnforcement: z2.boolean().default(true)
      }).default({}),
      // plan-v0.2-interactive-rule-approval P-D-008 / P-D-009: project-configured
      // custom destinations for the rule-candidate funnel. The classifier matches
      // a candidate to one of these entries when none of the framework
      // destinations (pattern-scanner / claude-md-cr / corrections-md) apply.
      customDestinations: z2.array(z2.object({
        name: z2.string(),
        path: z2.string(),
        triggerKeywords: z2.array(z2.string()).default([]),
        template: z2.string()
      })).default([])
    }).optional();
    CloudConfigSchema = z2.object({
      // OPTIONAL, not `.default(false)`. A zod default is indistinguishable from an
      // explicit value once parsed, so `.default(false)` meant that merely declaring a
      // `cloud:` block (to set any OTHER key) silently produced `enabled: false`, which
      // then overrode the `enabled: true` auto-enable below via object spread — turning
      // cloud sync OFF as a side effect of tuning it. `undefined` now means "not stated",
      // and the auto-enable preserves it. (plan-2026-07-20-cloud-sync-timeout)
      enabled: z2.boolean().optional(),
      apiKey: z2.string().optional(),
      endpoint: z2.string().optional(),
      // Per-request POST budget for the `/sync` ingest. cloud-sync.ts reads this
      // (`(cloud as { requestTimeoutMs?: number }).requestTimeoutMs`) but it was ABSENT
      // from this schema, and zod strips unknown keys — so the knob was unreachable from
      // massu.config.yaml and the default could never be tuned. Measured 2026-07-20: a
      // 423-observation payload takes ~9.2s against the live ingest. Capped at
      // SYNC_DEADLINE_MS (20s) since the overall deadline clamps each attempt anyway.
      requestTimeoutMs: z2.number().int().positive().max(2e4).optional(),
      sync: z2.object({
        memory: z2.boolean().default(true),
        analytics: z2.boolean().default(true),
        audit: z2.boolean().default(true)
      }).default({ memory: true, analytics: true, audit: true })
    }).optional();
    ConventionsConfigSchema = z2.object({
      claudeDirName: z2.string().default(".claude").refine(
        (s) => !s.includes("..") && !s.startsWith("/"),
        { message: 'claudeDirName must not contain ".." or start with "/"' }
      ),
      sessionStatePath: z2.string().default(".claude/session-state/CURRENT.md").refine(
        (s) => !s.includes("..") && !s.startsWith("/"),
        { message: 'sessionStatePath must not contain ".." or start with "/"' }
      ),
      sessionArchivePath: z2.string().default(".claude/session-state/archive").refine(
        (s) => !s.includes("..") && !s.startsWith("/"),
        { message: 'sessionArchivePath must not contain ".." or start with "/"' }
      ),
      knowledgeCategories: z2.array(z2.string()).default([
        "patterns",
        "commands",
        "incidents",
        "reference",
        "protocols",
        "checklists",
        "playbooks",
        "critical",
        "scripts",
        "status",
        "templates",
        "loop-state",
        "session-state",
        "agents"
      ]),
      knowledgeSourceFiles: z2.array(z2.string()).default(["CLAUDE.md", "MEMORY.md", "corrections.md"]),
      excludePatterns: z2.array(z2.string()).default(["/ARCHIVE/", "/SESSION-HISTORY/"])
    }).optional();
    PythonDomainConfigSchema = z2.object({
      name: z2.string(),
      packages: z2.array(z2.string()),
      allowed_imports_from: z2.array(z2.string()).default([])
    });
    PythonConfigSchema = z2.object({
      root: z2.string(),
      alembic_dir: z2.string().optional(),
      domains: z2.array(PythonDomainConfigSchema).default([]),
      exclude_dirs: z2.array(z2.string()).default(["__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache"])
    }).optional();
    PathsConfigSchema = z2.object({
      source: z2.string().default("src"),
      aliases: z2.record(z2.string(), z2.string()).default({ "@": "src" }),
      monorepo_roots: z2.array(z2.string()).optional(),
      routers: z2.string().optional(),
      routerRoot: z2.string().optional(),
      pages: z2.string().optional(),
      middleware: z2.string().optional(),
      schema: z2.string().optional(),
      components: z2.string().optional(),
      hooks: z2.string().optional()
    });
    LanguageFrameworkEntrySchema = z2.object({
      framework: z2.string().optional(),
      test_framework: z2.string().optional(),
      test: z2.string().optional(),
      runtime: z2.string().optional(),
      orm: z2.string().optional(),
      router: z2.string().optional(),
      ui: z2.string().optional()
    }).passthrough();
    FrameworkConfigSchema = z2.object({
      type: z2.string().default("typescript"),
      primary: z2.string().optional(),
      router: z2.string().default("none"),
      orm: z2.string().default("none"),
      ui: z2.string().default("none"),
      languages: z2.record(z2.string(), LanguageFrameworkEntrySchema).optional()
    }).passthrough();
    DetectedConfigSchema = z2.object({}).passthrough().optional();
    VerificationEntrySchema = z2.object({
      type: z2.string().optional(),
      test: z2.string().optional(),
      syntax: z2.string().optional(),
      lint: z2.string().optional(),
      build: z2.string().optional()
    }).passthrough();
    VerificationConfigSchema = z2.record(z2.string(), VerificationEntrySchema).optional();
    CanonicalPathsSchema = z2.record(z2.string(), z2.string()).optional();
    VerificationTypesSchema = z2.record(z2.string(), z2.string()).optional();
    DetectionRuleEntrySchema = z2.object({
      signals: z2.array(z2.string()).default([]),
      priority: z2.number().optional()
    }).passthrough();
    DetectionConfigSchema = z2.object({
      rules: z2.record(
        z2.string(),
        // language
        z2.record(z2.string(), DetectionRuleEntrySchema)
        // framework -> rule entry
      ).optional(),
      signal_weights: z2.record(z2.string(), z2.number()).optional(),
      disable_builtin: z2.boolean().optional()
    }).passthrough().optional();
    WatchConfigSchema = z2.object({
      debounce_ms: z2.number().int().positive().default(3e3),
      storm_threshold: z2.number().int().positive().default(50),
      deep_storm_threshold: z2.number().int().positive().default(500),
      hard_timeout_ms: z2.number().int().positive().default(3e5),
      scope: z2.enum(["paths", "full"]).default("paths"),
      // Plan 3a hotfix 2026-05-02: refuse to start if the watch surface
      // exceeds this many files. Prevents the misconfig pattern where
      // `paths.source_dirs` includes `.` or otherwise expands to a 60K+
      // file tree, producing 30-100% steady CPU. Override via
      // `paths_full_root_opt_in: true` for users on small repos who genuinely
      // need root-level watching.
      max_watched_files: z2.number().int().positive().default(1e4),
      paths_full_root_opt_in: z2.boolean().default(false)
    }).passthrough().optional();
    AdapterLocalPathSchema = z2.string().refine((s) => !/^([A-Za-z]:[\\/]|[\\/])/.test(s), {
      message: "absolute paths are rejected; adapters.local entries must be relative to the massu.config.yaml directory"
    }).refine((s) => !s.split(/[\\/]/).includes(".."), {
      message: "parent-directory traversal (`..`) is rejected; adapters.local entries must stay inside the project tree"
    }).transform((s) => s.split(/[\\/]/).filter((part) => part !== "" && part !== ".").join("/"));
    AdaptersConfigSchema = z2.object({
      enabled: z2.boolean().default(false),
      local: z2.array(AdapterLocalPathSchema).default([])
    }).passthrough().optional();
    TelemetryConfigSchema = z2.object({
      adapters: z2.boolean().default(false)
    }).passthrough().optional();
    LSPConfigSchema = z2.object({
      enabled: z2.boolean().default(false),
      servers: z2.array(z2.object({
        language: z2.string(),
        command: z2.string(),
        // F-014 (closed 2026-05-06): explicit opt-in to spawn SUID/SGID
        // binaries. Default false — argv[0] with the SUID bit is rejected
        // unless this is true. Decision is auditable in the YAML.
        allow_setuid: z2.boolean().default(false),
        // F-015 (closed 2026-05-06): per-server RSS budget (MB). Watchdog
        // SIGKILLs the server after sustained breach. Default 1024 MB.
        // Set to 0 to disable the watchdog for this server.
        max_rss_mb: z2.number().int().nonnegative().default(1024)
      })).default([]),
      autoDetect: z2.object({
        viaPortScan: z2.boolean().default(false)
      }).optional()
    }).passthrough();
    RawConfigSchema = z2.object({
      schema_version: z2.union([z2.literal(1), z2.literal(2)]).default(1),
      project: z2.object({
        name: z2.string().default("my-project"),
        root: z2.string().default("auto")
      }).default({ name: "my-project", root: "auto" }),
      framework: FrameworkConfigSchema.default({
        type: "typescript",
        router: "none",
        orm: "none",
        ui: "none"
      }),
      paths: PathsConfigSchema.default({ source: "src", aliases: { "@": "src" } }),
      toolPrefix: z2.string().default("massu"),
      dbAccessPattern: z2.string().optional(),
      knownMismatches: z2.record(z2.string(), z2.record(z2.string(), z2.string())).optional(),
      accessScopes: z2.array(z2.string()).optional(),
      domains: z2.array(DomainConfigSchema).default([]),
      rules: z2.array(PatternRuleConfigSchema).default([]),
      // P-M-036 (plan-stage-d-medium-sweep): customer-authored CR-style
      // governance rules. DISTINCT from `rules:` above (path-scoped lint hints
      // used by pattern-scanner). At config-refresh time these entries are
      // loaded into the `knowledge_rules` SQLite table with
      // `source = 'customer-config'` so `massu_knowledge_rule` and the
      // governance docs surface customer-defined rules alongside framework CRs.
      governance_rules: z2.array(
        z2.object({
          id: z2.string().min(1, "governance_rules[].id is required"),
          title: z2.string().min(1, "governance_rules[].title is required"),
          description: z2.string().min(1, "governance_rules[].description is required"),
          vr_type: z2.string().default("VR-CUSTOM"),
          reference_path: z2.string().optional(),
          severity: z2.enum(["critical", "high", "medium", "low", "info"]).default("medium")
        }).passthrough()
      ).default([]),
      analytics: AnalyticsConfigSchema,
      governance: GovernanceConfigSchema,
      security: SecurityConfigSchema,
      team: TeamConfigSchema,
      regression: RegressionConfigSchema,
      cloud: CloudConfigSchema,
      // plan-living-memory-slice-1 P6-002: automatic-recall tunables.
      memory: MemoryConfigSchema,
      conventions: ConventionsConfigSchema,
      autoLearning: AutoLearningConfigSchema,
      python: PythonConfigSchema,
      // P2-004 / P2-005 / P2-006 / P2-008: v2 extensions (all optional)
      verification: VerificationConfigSchema,
      canonical_paths: CanonicalPathsSchema,
      verification_types: VerificationTypesSchema,
      detection: DetectionConfigSchema,
      // Plan #2: detector-owned per-language conventions (free-form passthrough)
      detected: DetectedConfigSchema,
      // Plan 3a: file-watcher daemon tunables
      watch: WatchConfigSchema,
      // Plan 3c: third-party adapter registry kill-switch + signing override + local-path opt-in.
      adapters: AdaptersConfigSchema,
      // Plan 3c: anonymous adapter-discovery telemetry opt-in (default off).
      telemetry: TelemetryConfigSchema,
      // Plan 3b Phase 4: optional LSP enrichment of AST adapter results.
      lsp: LSPConfigSchema.optional()
    }).passthrough();
    _config = null;
    _resolvedApiKeySource = "none";
    _projectRoot = null;
  }
});

// src/memory-vector.ts
function float32ToBlob(vec) {
  return Buffer.from(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
}
function blobToFloat32(buf) {
  if (!buf || buf.byteLength % 4 !== 0) return null;
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf instanceof Buffer ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf);
  return new Float32Array(bytes.buffer, 0, buf.byteLength / 4);
}
function l2normalize(vec) {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (norm === 0 || !Number.isFinite(norm)) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}
function cosineSim(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0 || !Number.isFinite(denom)) return 0;
  return dot / denom;
}
var init_memory_vector = __esm({
  "src/memory-vector.ts"() {
    "use strict";
  }
});

// src/db-backup.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync4, readdirSync, statSync, unlinkSync, copyFileSync, rmSync as rmSync4 } from "fs";
import { resolve as resolve3, join as join3, basename, dirname as dirname4 } from "path";
import { homedir as homedir3 } from "os";
function dbBackupsRoot(home = homedir3()) {
  return resolve3(home, ".massu", "db-backups");
}
function projectBackupDir(projectRoot, home = homedir3()) {
  const slug = basename(projectRoot).replace(/[^A-Za-z0-9._-]/g, "_") || "project";
  return join3(dbBackupsRoot(home), slug);
}
function backupStamp(nowMs) {
  return new Date(nowMs).toISOString().replace(/[:.]/g, "-");
}
function listDbBackups(projectRoot, home = homedir3()) {
  const dir = projectBackupDir(projectRoot, home);
  if (!existsSync5(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".db")) continue;
    const p = join3(dir, f);
    const st = statSync(p);
    const db = f.replace(/-\d{4}-\d{2}-\d{2}T.*$/, "");
    out.push({ db, path: p, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function hasFreshDbBackup(projectRoot, dbPath, nowMs = Date.now(), home = homedir3()) {
  const name = basename(dbPath, ".db");
  const backups = listDbBackups(projectRoot, home).filter((b) => b.db === name);
  if (backups.length === 0) return false;
  const newest = backups[0];
  if (nowMs - newest.mtimeMs > FRESH_WINDOW_MS) return false;
  if (existsSync5(dbPath) && statSync(dbPath).mtimeMs > newest.mtimeMs) return false;
  return true;
}
function integrityOk(dbPath) {
  let db = null;
  try {
    db = openDatabase2(dbPath, { readonly: true });
    const rows = db.pragma("integrity_check");
    return rows.length === 1 && rows[0].integrity_check === "ok";
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
function backupDb(projectRoot, dbPath, nowMs = Date.now(), home = homedir3()) {
  if (!existsSync5(dbPath)) {
    throw new DbBackupError(`cannot back up a database that does not exist: ${dbPath}`);
  }
  const dir = projectBackupDir(projectRoot, home);
  mkdirSync4(dir, { recursive: true });
  const name = basename(dbPath, ".db");
  const dest = join3(dir, `${name}-${backupStamp(nowMs)}.db`);
  let src = null;
  try {
    src = openDatabase2(dbPath, { readonly: true });
    src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } catch (err) {
    throw new DbBackupError(
      `VACUUM INTO failed for ${dbPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    try {
      src?.close();
    } catch {
    }
  }
  if (!integrityOk(dest)) {
    try {
      unlinkSync(dest);
    } catch {
    }
    throw new DbBackupError(
      `the backup of ${dbPath} FAILED its own integrity check and was deleted. A corrupt backup is worse than none \u2014 you only discover it when you need it.`
    );
  }
  pruneDbBackups(projectRoot, name, DEFAULT_RETENTION, home);
  const st = statSync(dest);
  return { db: name, path: dest, bytes: st.size, mtimeMs: st.mtimeMs };
}
function pruneDbBackups(projectRoot, dbName, keep = DEFAULT_RETENTION, home = homedir3()) {
  const mine = listDbBackups(projectRoot, home).filter((b) => b.db === dbName);
  let removed = 0;
  for (const old of mine.slice(keep)) {
    try {
      unlinkSync(old.path);
      removed++;
    } catch {
    }
  }
  return removed;
}
function backupBeforeSchemaChange(projectRoot, dbPath, onError, nowMs = Date.now(), home = homedir3()) {
  try {
    if (!existsSync5(dbPath)) return null;
    if (hasFreshDbBackup(projectRoot, dbPath, nowMs, home)) return null;
    return backupDb(projectRoot, dbPath, nowMs, home);
  } catch (err) {
    onError(err);
    return null;
  }
}
var DEFAULT_RETENTION, FRESH_WINDOW_MS, DbBackupError;
var init_db_backup = __esm({
  "src/db-backup.ts"() {
    "use strict";
    init_db_driver();
    DEFAULT_RETENTION = 5;
    FRESH_WINDOW_MS = 24 * 60 * 60 * 1e3;
    DbBackupError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "DbBackupError";
      }
    };
  }
});

// src/rule-delivery.ts
import { randomUUID } from "node:crypto";
function tableExists(db, table) {
  const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return row !== void 0;
}
function claimPage(db, table, pk, orderBy, limit, token, nowMs) {
  if (!tableExists(db, table)) return;
  const cutoff = nowMs - LEASE_TTL_MS;
  const ids = db.prepare(
    `SELECT ${pk} AS k FROM ${table}
        WHERE lease_token IS NULL OR leased_at_ms IS NULL OR leased_at_ms < ?
        ORDER BY ${orderBy} ASC LIMIT ?`
  ).all(cutoff, limit);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE ${table} SET lease_token = ?, leased_at_ms = ? WHERE ${pk} IN (${placeholders})`
  ).run(token, nowMs, ...ids.map((r) => r.k));
}
function columns(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => r.name));
}
function migrateRuleDelivery(db) {
  const ADDITIONS = [
    { name: "attempts", decl: "INTEGER NOT NULL DEFAULT 0" },
    { name: "lease_token", decl: "TEXT" },
    { name: "leased_at_ms", decl: "INTEGER" },
    { name: "last_error", decl: "TEXT" }
  ];
  for (const table of ALL_OUTBOUND_TABLES) {
    if (!tableExists(db, table)) continue;
    const cols = columns(db, table);
    for (const add of ADDITIONS) {
      if (cols.has(add.name)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${add.name} ${add.decl}`);
    }
  }
}
function leaseLearning(db, nowMs = Date.now()) {
  migrateRuleDelivery(db);
  const token = randomUUID();
  claimPage(db, "team_promotion_outbound", "prompt_hash", "created_at", PROMOTION_LEASE_LIMIT, token, nowMs);
  claimPage(db, "team_revocation_outbound", "prompt_hash", "created_at", PROMOTION_LEASE_LIMIT, token, nowMs);
  claimPage(db, TELEMETRY_OUTBOUND_TABLE, "id", "id", TELEMETRY_LEASE_LIMIT, token, nowMs);
  const promotions = tableExists(db, "team_promotion_outbound") ? db.prepare(
    `SELECT prompt_hash, destination, draft_text, score, signals_json,
                    content_hash, hardened, review_attestation_json
             FROM team_promotion_outbound WHERE lease_token = ?
             ORDER BY created_at ASC LIMIT ?`
  ).all(token, PROMOTION_LEASE_LIMIT).map((r) => ({
    prompt_hash: r.prompt_hash,
    destination: r.destination,
    draft_text: r.draft_text,
    ...r.score !== null ? { score: r.score } : {},
    signals: safeParseArray(r.signals_json),
    content_hash: r.content_hash,
    ...r.hardened ? { hardened: true } : {},
    ...r.review_attestation_json != null ? { review_attestation: safeParseUnknown(r.review_attestation_json) } : {}
  })) : [];
  const revocations = tableExists(db, "team_revocation_outbound") ? db.prepare(
    `SELECT prompt_hash FROM team_revocation_outbound
             WHERE lease_token = ? ORDER BY created_at ASC LIMIT ?`
  ).all(token, PROMOTION_LEASE_LIMIT).map((r) => r.prompt_hash) : [];
  const events = tableExists(db, TELEMETRY_OUTBOUND_TABLE) ? db.prepare(
    `SELECT prompt_hash, event_type, metadata_json, created_at
             FROM ${TELEMETRY_OUTBOUND_TABLE} WHERE lease_token = ?
             ORDER BY id ASC LIMIT ?`
  ).all(token, TELEMETRY_LEASE_LIMIT).map((r) => ({
    prompt_hash: r.prompt_hash,
    event_type: r.event_type,
    created_at: r.created_at,
    metadata: safeParseUnknown(r.metadata_json) ?? {}
  })) : [];
  return { token, promotions, revocations, events };
}
function ackLearning(db, lease) {
  const delivered = lease.promotions.length + lease.revocations.length + lease.events.length;
  for (const table of ALL_OUTBOUND_TABLES) {
    if (!tableExists(db, table)) continue;
    db.prepare(`DELETE FROM ${table} WHERE lease_token = ?`).run(lease.token);
  }
  if (delivered > 0) {
    recordAnalytics(db, EVENT_DELIVERY_CONFIRMED, {
      promotions: lease.promotions.length,
      revocations: lease.revocations.length,
      events: lease.events.length
    });
  }
}
function nackLearning(db, lease, error) {
  for (const table of ALL_OUTBOUND_TABLES) {
    if (!tableExists(db, table)) continue;
    db.prepare(
      `UPDATE ${table}
         SET lease_token = NULL,
             leased_at_ms = NULL,
             attempts = attempts + 1,
             last_error = ?
       WHERE lease_token = ?`
    ).run(error.slice(0, 500), lease.token);
  }
  const snap = undeliveredSnapshot(db);
  if (snap.stalled) alarmStalled(db, snap, error);
  return snap;
}
function undeliveredSnapshot(db) {
  const count = (t) => {
    if (!tableExists(db, t)) return 0;
    const r = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
    return r.n;
  };
  const promotions = count("team_promotion_outbound");
  const revocations = count("team_revocation_outbound");
  const events = count(TELEMETRY_OUTBOUND_TABLE);
  let maxAttempts = 0;
  let oldest = null;
  for (const t of RULE_OUTBOUND_TABLES) {
    if (!tableExists(db, t)) continue;
    if (!columns(db, t).has("attempts")) continue;
    const r = db.prepare(`SELECT MAX(attempts) AS a, MIN(created_at) AS c FROM ${t}`).get();
    if (r.a !== null && r.a > maxAttempts) maxAttempts = r.a;
    if (r.c !== null && (oldest === null || r.c < oldest)) oldest = r.c;
  }
  return {
    promotions,
    revocations,
    events,
    max_rule_attempts: maxAttempts,
    oldest_rule_created_at: oldest,
    stalled: promotions + revocations > 0 && maxAttempts >= STALL_ATTEMPTS
  };
}
function alarmStalled(db, snap, error) {
  const rules = snap.promotions + snap.revocations;
  process.stderr.write(
    `[massu] WARNING: ${rules} learned rule(s) have NOT reached your team after ${snap.max_rule_attempts} delivery attempts. They are SAFE (nothing was deleted) and will retry. Last error: ${error}. Run \`massu rule delivery-status\` for detail.
`
  );
  recordAnalytics(db, EVENT_DELIVERY_STALLED, {
    undelivered_promotions: snap.promotions,
    undelivered_revocations: snap.revocations,
    undelivered_events: snap.events,
    max_attempts: snap.max_rule_attempts,
    oldest_created_at: snap.oldest_rule_created_at,
    last_error: error.slice(0, 300)
  });
}
function capTelemetry(db, cap = TELEMETRY_OUTBOX_CAP) {
  if (!tableExists(db, TELEMETRY_OUTBOUND_TABLE)) return 0;
  const before = db.prepare(`SELECT COUNT(*) AS n FROM ${TELEMETRY_OUTBOUND_TABLE}`).get();
  if (before.n <= cap) return 0;
  const info = db.prepare(
    `DELETE FROM ${TELEMETRY_OUTBOUND_TABLE}
        WHERE id NOT IN (SELECT id FROM ${TELEMETRY_OUTBOUND_TABLE} ORDER BY id DESC LIMIT ?)`
  ).run(cap);
  const dropped = info.changes;
  if (dropped > 0) {
    process.stderr.write(
      `[massu] NOTE: dropped ${dropped} oldest promotion-funnel telemetry row(s) at the ${cap}-row cap. No learned rules were affected (rules are never dropped).
`
    );
    recordAnalytics(db, EVENT_TELEMETRY_CAPPED, { dropped, cap });
  }
  return dropped;
}
function stripLearningFromPayload(payload) {
  const clone = { ...payload };
  delete clone.rule_promotions;
  delete clone.rule_revocations;
  delete clone.rule_promotion_events;
  return clone;
}
function safeParseArray(raw) {
  const v = safeParseUnknown(raw);
  return Array.isArray(v) ? v : [];
}
function safeParseUnknown(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function recordAnalytics(db, eventType, data) {
  try {
    db.prepare(
      `INSERT INTO analytics_events (event_type, event_data, created_at)
       VALUES (?, ?, datetime('now'))`
    ).run(eventType, JSON.stringify(data));
  } catch (err) {
    process.stderr.write(
      `[massu] WARNING: could not record '${eventType}' telemetry: ${err instanceof Error ? err.message : String(err)}
`
    );
  }
}
var RULE_OUTBOUND_TABLES, TELEMETRY_OUTBOUND_TABLE, ALL_OUTBOUND_TABLES, TELEMETRY_OUTBOX_CAP, LEASE_TTL_MS, PROMOTION_LEASE_LIMIT, TELEMETRY_LEASE_LIMIT, STALL_ATTEMPTS, EVENT_DELIVERY_STALLED, EVENT_DELIVERY_CONFIRMED, EVENT_TELEMETRY_CAPPED;
var init_rule_delivery = __esm({
  "src/rule-delivery.ts"() {
    "use strict";
    RULE_OUTBOUND_TABLES = [
      "team_promotion_outbound",
      "team_revocation_outbound"
    ];
    TELEMETRY_OUTBOUND_TABLE = "rule_promotion_events_outbound";
    ALL_OUTBOUND_TABLES = [
      ...RULE_OUTBOUND_TABLES,
      TELEMETRY_OUTBOUND_TABLE
    ];
    TELEMETRY_OUTBOX_CAP = 2e4;
    LEASE_TTL_MS = 15 * 60 * 1e3;
    PROMOTION_LEASE_LIMIT = 1e3;
    TELEMETRY_LEASE_LIMIT = 5e3;
    STALL_ATTEMPTS = 5;
    EVENT_DELIVERY_STALLED = "rule_delivery_stalled";
    EVENT_DELIVERY_CONFIRMED = "rule_delivery_confirmed";
    EVENT_TELEMETRY_CAPPED = "rule_telemetry_capped";
  }
});

// src/rule-candidate-store.ts
function ensureRuleCandidatesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rule_candidates (
      prompt_hash  TEXT PRIMARY KEY,
      status       TEXT NOT NULL DEFAULT 'proposed'
                     CHECK (status IN ('proposed','shown','promoted','dismissed')),
      origin       TEXT NOT NULL DEFAULT 'local'
                     CHECK (origin IN ('local','team','pack')),
      score        REAL,
      destination  TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rule_candidates_status ON rule_candidates(status);
    CREATE INDEX IF NOT EXISTS idx_rule_candidates_created ON rule_candidates(created_at);
  `);
}
var init_rule_candidate_store = __esm({
  "src/rule-candidate-store.ts"() {
    "use strict";
  }
});

// src/hooks/lib/hook-failure-signal.ts
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync5, existsSync as existsSync6 } from "fs";
import { join as join4, dirname as dirname5 } from "path";
function resolveFailureLogPath() {
  const explicit = process.env.MASSU_HOOK_FAILURE_LOG;
  if (explicit) return explicit;
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync6(join4(dir, ".massu")) || existsSync6(join4(dir, "massu.config.yaml"))) {
      return join4(dir, ".massu", "hook-failures.jsonl");
    }
    const parent = dirname5(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join4(process.cwd(), ".massu", "hook-failures.jsonl");
}
function recordHookFailure(hook, error, context) {
  const record = {
    hook,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.split("\n").slice(0, 6).join("\n") : void 0,
    context,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  let wroteSomething = false;
  try {
    const path = resolveFailureLogPath();
    mkdirSync5(dirname5(path), { recursive: true });
    appendFileSync2(path, JSON.stringify(record) + "\n", "utf-8");
    wroteSomething = true;
  } catch {
  }
  try {
    process.stderr.write(
      `[massu] HOOK FAILURE in ${hook}: ${record.error}
[massu]   This is a bug in Massu, not in your code. See .massu/hook-failures.jsonl
`
    );
    wroteSomething = true;
  } catch {
  }
  try {
    recordHookHealthRow(record);
  } catch {
  }
  return wroteSomething;
}
function recordHookHealthRow(record) {
  const { getMemoryDb: getMemoryDb2 } = (init_memory_db(), __toCommonJS(memory_db_exports));
  const db = getMemoryDb2();
  try {
    db.prepare(
      `INSERT INTO hook_health (hook, error, context_json, occurred_at)
       VALUES (?, ?, ?, ?)`
    ).run(
      record.hook,
      record.error,
      record.context ? JSON.stringify(record.context) : null,
      record.timestamp
    );
  } finally {
    db.close();
  }
}
var init_hook_failure_signal = __esm({
  "src/hooks/lib/hook-failure-signal.ts"() {
    "use strict";
  }
});

// src/memory-embedder-tokenizer.ts
import { readFileSync as readFileSync5 } from "fs";
function loadVocab(vocabPath) {
  const lines = readFileSync5(vocabPath, "utf-8").split("\n");
  const vocab = /* @__PURE__ */ new Map();
  for (let i = 0; i < lines.length; i++) {
    const tok = lines[i].replace(/\r$/, "");
    if (tok.length === 0 && i === lines.length - 1) continue;
    vocab.set(tok, i);
  }
  return vocab;
}
function isWhitespace(ch) {
  if (ch === " " || ch === "	" || ch === "\n" || ch === "\r") return true;
  const cp = ch.codePointAt(0);
  return cp === 160 || cp >= 8192 && cp <= 8202 || cp === 8232 || cp === 8233 || cp === 8239 || cp === 8287 || cp === 12288 || cp === 65279;
}
function isControl(ch) {
  if (ch === "	" || ch === "\n" || ch === "\r") return false;
  const cp = ch.codePointAt(0);
  return cp <= 31 || cp >= 127 && cp <= 159;
}
function isPunctuation(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 33 && cp <= 47 || cp >= 58 && cp <= 64 || cp >= 91 && cp <= 96 || cp >= 123 && cp <= 126)
    return true;
  return /\p{P}|\p{S}/u.test(ch);
}
function isCJK(cp) {
  return cp >= 19968 && cp <= 40959 || cp >= 13312 && cp <= 19903 || cp >= 131072 && cp <= 173791 || cp >= 173824 && cp <= 177983 || cp >= 177984 && cp <= 178207 || cp >= 178208 && cp <= 183983 || cp >= 63744 && cp <= 64255 || cp >= 194560 && cp <= 195103;
}
function stripAccents(text) {
  return text.normalize("NFD").replace(/\p{Mn}/gu, "");
}
function basicTokenize(text) {
  let cleaned = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0 || cp === 65533 || isControl(ch)) continue;
    if (isWhitespace(ch)) {
      cleaned += " ";
      continue;
    }
    if (isCJK(cp)) {
      cleaned += " " + ch + " ";
      continue;
    }
    cleaned += ch;
  }
  const rawTokens = cleaned.split(/\s+/).filter(Boolean);
  const out = [];
  for (let tok of rawTokens) {
    tok = stripAccents(tok.toLowerCase());
    let cur = "";
    for (const ch of tok) {
      if (isPunctuation(ch)) {
        if (cur) {
          out.push(cur);
          cur = "";
        }
        out.push(ch);
      } else {
        cur += ch;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}
function wordpieceTokenize(token, vocab, maxChars = 100) {
  if (token.length > maxChars) return [UNK];
  const chars = Array.from(token);
  const subTokens = [];
  let start = 0;
  let bad = false;
  while (start < chars.length) {
    let end = chars.length;
    let curSub = null;
    while (start < end) {
      let substr = chars.slice(start, end).join("");
      if (start > 0) substr = "##" + substr;
      if (vocab.has(substr)) {
        curSub = substr;
        break;
      }
      end -= 1;
    }
    if (curSub === null) {
      bad = true;
      break;
    }
    subTokens.push(curSub);
    start = end;
  }
  return bad ? [UNK] : subTokens;
}
function encode(text, vocab, opts = {}) {
  const maxLen = opts.maxLen ?? 256;
  const basic = basicTokenize(text);
  const wpTokens = [];
  for (const t of basic) {
    for (const sub of wordpieceTokenize(t, vocab)) wpTokens.push(sub);
  }
  const truncated = wpTokens.slice(0, maxLen - 2);
  const tokens = [CLS, ...truncated, SEP];
  const unkId = vocab.get(UNK) ?? 100;
  const input_ids = tokens.map((t) => vocab.get(t) ?? unkId);
  const attention_mask = tokens.map(() => 1);
  const token_type_ids = tokens.map(() => 0);
  return { tokens, input_ids, attention_mask, token_type_ids };
}
var UNK, CLS, SEP;
var init_memory_embedder_tokenizer = __esm({
  "src/memory-embedder-tokenizer.ts"() {
    "use strict";
    UNK = "[UNK]";
    CLS = "[CLS]";
    SEP = "[SEP]";
  }
});

// src/memory-embedder.ts
import { fileURLToPath } from "url";
import { dirname as dirname6, join as join5 } from "path";
import { existsSync as existsSync7 } from "fs";
import { createRequire as createRequire3 } from "module";
function getActiveEmbedModel() {
  return _activeModel;
}
function loadEmbedSettings() {
  try {
    const r = getConfig().memory?.recall;
    return {
      enabled: r?.embedEnabled ?? true,
      endpoint: r?.embedEndpoint,
      model: r?.embedModel
    };
  } catch {
    return { enabled: true };
  }
}
function embeddingsDisabled() {
  return process.env.MASSU_DISABLE_EMBEDDINGS === "1";
}
function resolveModelDir() {
  try {
    let dir = dirname6(fileURLToPath(import.meta.url));
    let root = null;
    for (let i = 0; i < 8; i++) {
      if (existsSync7(join5(dir, "package.json"))) {
        root = dir;
        break;
      }
      const parent = dirname6(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!root) return null;
    for (const rel of ["dist/embedder", "assets/embedder"]) {
      const candidate = join5(root, rel);
      if (existsSync7(join5(candidate, "model_quantized.onnx"))) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}
function resolveWasmDir() {
  try {
    const req3 = createRequire3(import.meta.url);
    const main2 = req3.resolve(ORT_PKG);
    return dirname6(main2);
  } catch {
    return null;
  }
}
async function getSession() {
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = (async () => {
    try {
      const modelDir = resolveModelDir();
      const wasmDir = resolveWasmDir();
      if (!modelDir || !wasmDir) return null;
      const ort = await import(
        /* @vite-ignore */
        ORT_PKG
      );
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = wasmDir.endsWith("/") ? wasmDir : wasmDir + "/";
      _ortTensor = ort.Tensor;
      const modelPath = join5(modelDir, "model_quantized.onnx");
      const vocabPath = join5(modelDir, "vocab.txt");
      _vocab = loadVocab(vocabPath);
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all"
      });
      return session;
    } catch {
      return null;
    }
  })();
  return _sessionPromise;
}
function meanPool(hidden, mask, seqLen, hiddenSize) {
  const out = new Float32Array(hiddenSize);
  let maskSum = 0;
  for (let t = 0; t < seqLen; t++) {
    const m = mask[t];
    if (m === 0) continue;
    maskSum += m;
    const base = t * hiddenSize;
    for (let h = 0; h < hiddenSize; h++) out[h] += hidden[base + h] * m;
  }
  const denom = Math.max(maskSum, 1e-9);
  for (let h = 0; h < hiddenSize; h++) out[h] /= denom;
  return out;
}
function chunkForEmbedding(text) {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= CHUNK_TARGET_CHARS) return [t];
  const chunks = [];
  let start = 0;
  while (start < t.length && chunks.length < MAX_CHUNKS_PER_RECORD) {
    let end = Math.min(start + CHUNK_TARGET_CHARS, t.length);
    if (end < t.length) {
      const floor = start + Math.floor(CHUNK_TARGET_CHARS / 2);
      const slice = t.slice(start, end);
      const para = slice.lastIndexOf("\n\n");
      const sent = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(".\n"));
      const space = slice.lastIndexOf(" ");
      for (const rel of [para, sent, space]) {
        const abs = start + rel;
        if (rel > 0 && abs > floor) {
          end = abs + 1;
          break;
        }
      }
    }
    const chunk = t.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= t.length) break;
    start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
  }
  return chunks;
}
async function embedTier1(text) {
  try {
    const session = await getSession();
    if (!session || !_vocab || !_ortTensor) return null;
    const { input_ids, attention_mask, token_type_ids } = encode(text, _vocab);
    const seqLen = input_ids.length;
    const ids = BigInt64Array.from(input_ids.map((x) => BigInt(x)));
    const mask = BigInt64Array.from(attention_mask.map((x) => BigInt(x)));
    const types = BigInt64Array.from(token_type_ids.map((x) => BigInt(x)));
    const dims = [1, seqLen];
    const Tensor = _ortTensor;
    const feeds = {
      input_ids: new Tensor("int64", ids, dims),
      attention_mask: new Tensor("int64", mask, dims)
    };
    if (session.inputNames.includes("token_type_ids")) {
      feeds.token_type_ids = new Tensor("int64", types, dims);
    }
    const results = await session.run(feeds);
    const outName = session.outputNames.find((n) => results[n].dims.length === 3) ?? session.outputNames[0];
    const outTensor = results[outName];
    const hiddenSize = outTensor.dims[2];
    const pooled = meanPool(outTensor.data, attention_mask, seqLen, hiddenSize);
    const vec = l2normalize(pooled);
    if (vec.length !== EMBED_DIM) return null;
    _activeModel = { modelId: EMBED_MODEL_ID, dim: EMBED_DIM };
    return vec;
  } catch {
    return null;
  }
}
async function embedTier0(text, settings) {
  const endpoint = settings.endpoint;
  if (!endpoint) return null;
  const requestModel = settings.model || EMBED_MODEL_ID;
  const base = endpoint.replace(/\/+$/, "");
  const url = `${base}/v1/embeddings`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIER0_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: requestModel, input: text }),
      signal: controller.signal
    });
    if (!res.ok) return null;
    const body = await res.json();
    const raw = body?.data?.[0]?.embedding;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const vec = l2normalize(Float32Array.from(raw));
    _activeModel = { modelId: requestModel, dim: vec.length };
    return vec;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function embed(text) {
  if (!text || !text.trim()) return null;
  if (embeddingsDisabled()) return null;
  try {
    const settings = loadEmbedSettings();
    if (!settings.enabled) return null;
    if (settings.endpoint) {
      const t0 = await embedTier0(text, settings);
      if (t0) return t0;
    }
    return await embedTier1(text);
  } catch {
    return null;
  }
}
async function embedBatch(texts) {
  if (!texts || texts.length === 0) return [];
  if (embeddingsDisabled()) return texts.map(() => null);
  const settings = loadEmbedSettings();
  if (!settings.enabled) return texts.map(() => null);
  const results = [];
  for (const t of texts) {
    if (!t || !t.trim()) {
      results.push(null);
      continue;
    }
    try {
      let vec = null;
      if (settings.endpoint) {
        vec = await embedTier0(t, settings);
      }
      if (!vec) vec = await embedTier1(t);
      results.push(vec);
    } catch {
      results.push(null);
    }
  }
  return results;
}
var EMBED_MODEL_ID, EMBED_DIM, ORT_PKG, _activeModel, _sessionPromise, _vocab, _ortTensor, CHUNK_TARGET_CHARS, CHUNK_OVERLAP_CHARS, MAX_CHUNKS_PER_RECORD, TIER0_TIMEOUT_MS;
var init_memory_embedder = __esm({
  "src/memory-embedder.ts"() {
    "use strict";
    init_memory_vector();
    init_memory_embedder_tokenizer();
    init_config();
    EMBED_MODEL_ID = "all-MiniLM-L6-v2";
    EMBED_DIM = 384;
    ORT_PKG = "onnxruntime-web";
    _activeModel = null;
    _sessionPromise = null;
    _vocab = null;
    _ortTensor = null;
    CHUNK_TARGET_CHARS = 900;
    CHUNK_OVERLAP_CHARS = 120;
    MAX_CHUNKS_PER_RECORD = 24;
    TIER0_TIMEOUT_MS = 2e3;
  }
});

// src/memory-embed-sweep.ts
function readCursor(db, metaTable, key) {
  if (!KNOWN_META_TABLES.has(metaTable)) return 0;
  try {
    const row = db.prepare(`SELECT value FROM ${metaTable} WHERE key = ?`).get(key);
    const n = row ? Number(row.value) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
function writeCursor(db, metaTable, key, value) {
  if (!KNOWN_META_TABLES.has(metaTable)) return;
  try {
    db.prepare(`INSERT OR REPLACE INTO ${metaTable} (key, value) VALUES (?, ?)`).run(
      key,
      String(value)
    );
  } catch {
  }
}
async function runEmbedSweep(db, cfg, opts = {}) {
  const batchSize = Math.max(1, opts.batchSize ?? 16);
  const limit = opts.limit ?? Infinity;
  const budgetMs = opts.budgetMs;
  const start = Date.now();
  const cursorKey = `embed_sweep_cursor_${cfg.sourceLabel}`;
  let embedded = 0;
  let scanned = 0;
  let active = getActiveEmbedModel();
  let cursor = readCursor(db, cfg.metaTable, cursorKey);
  try {
    while (true) {
      if (embedded >= limit) break;
      if (budgetMs !== void 0 && Date.now() - start >= budgetMs) break;
      const remaining = limit === Infinity ? batchSize : Math.min(batchSize, limit - embedded);
      const rows = cfg.selectMissing(db, cursor, active, Math.max(1, remaining));
      if (rows.length === 0) {
        writeCursor(db, cfg.metaTable, cursorKey, 0);
        break;
      }
      const units = [];
      for (const r of rows) {
        if (cfg.chunked) {
          const parts = chunkForEmbedding(r.text);
          if (parts.length === 0) continue;
          parts.forEach((text, chunkIx) => units.push({ id: r.id, chunkIx, text }));
        } else {
          units.push({ id: r.id, chunkIx: 0, text: r.text });
        }
      }
      const vecs = await embedBatch(units.map((u) => u.text));
      if (!active) active = getActiveEmbedModel();
      if (!active) {
        break;
      }
      const tx = db.transaction(() => {
        const del = cfg.chunked ? db.prepare(
          `DELETE FROM ${cfg.embeddingTable}
                WHERE ${cfg.idCol} = ? AND model_id = ? AND dim = ?`
        ) : null;
        const stmt = cfg.chunked ? db.prepare(
          `INSERT OR REPLACE INTO ${cfg.embeddingTable}
                 (${cfg.idCol}, chunk_ix, model_id, dim, vec, created_at)
               VALUES (?, ?, ?, ?, ?, datetime('now'))`
        ) : db.prepare(
          `INSERT OR REPLACE INTO ${cfg.embeddingTable}
                 (${cfg.idCol}, model_id, dim, vec, created_at)
               VALUES (?, ?, ?, ?, datetime('now'))`
        );
        const cleared = /* @__PURE__ */ new Set();
        const embeddedIds = /* @__PURE__ */ new Set();
        for (let i = 0; i < units.length; i++) {
          const v = vecs[i];
          if (!v) continue;
          const u = units[i];
          if (del && !cleared.has(u.id)) {
            del.run(u.id, active.modelId, active.dim);
            cleared.add(u.id);
          }
          if (cfg.chunked) {
            stmt.run(u.id, u.chunkIx, active.modelId, active.dim, float32ToBlob(v));
          } else {
            stmt.run(u.id, active.modelId, active.dim, float32ToBlob(v));
          }
          embeddedIds.add(u.id);
        }
        embedded += embeddedIds.size;
      });
      tx();
      scanned += rows.length;
      cursor = rows[rows.length - 1].id;
      writeCursor(db, cfg.metaTable, cursorKey, cursor);
    }
  } catch {
  }
  return { embedded, scanned };
}
var KNOWN_META_TABLES;
var init_memory_embed_sweep = __esm({
  "src/memory-embed-sweep.ts"() {
    "use strict";
    init_memory_embedder();
    init_memory_vector();
    KNOWN_META_TABLES = /* @__PURE__ */ new Set(["memory_meta", "knowledge_meta"]);
  }
});

// src/memory-db.ts
var memory_db_exports = {};
__export(memory_db_exports, {
  CONSOLIDATION_LESSON_EVIDENCE: () => CONSOLIDATION_LESSON_EVIDENCE,
  MEMORY_FILE_TITLE_LIKE: () => MEMORY_FILE_TITLE_LIKE,
  MEMORY_FILE_TITLE_PREFIX: () => MEMORY_FILE_TITLE_PREFIX,
  MEMORY_SCHEMA_VERSION: () => MEMORY_SCHEMA_VERSION,
  TOOL_COST_EVENTS_RETENTION_DAYS: () => TOOL_COST_EVENTS_RETENTION_DAYS,
  USAGE_COUNTER_ARMED_KEY: () => USAGE_COUNTER_ARMED_KEY,
  addConversationTurn: () => addConversationTurn,
  addFailureClass: () => addFailureClass,
  addObservation: () => addObservation,
  addSummary: () => addSummary,
  addToolCallDetail: () => addToolCallDetail,
  addUserPrompt: () => addUserPrompt,
  appendIncidentToFailureClass: () => appendIncidentToFailureClass,
  armUsageCounter: () => armUsageCounter,
  assignImportance: () => assignImportance,
  autoDetectTaskId: () => autoDetectTaskId,
  createSession: () => createSession,
  deduplicateFailedAttempt: () => deduplicateFailedAttempt,
  dequeuePendingSync: () => dequeuePendingSync,
  embedMissingObservations: () => embedMissingObservations,
  endSession: () => endSession,
  enqueueRulePromotionEvent: () => enqueueRulePromotionEvent,
  enqueueSyncPayload: () => enqueueSyncPayload,
  enqueueTeamPromotion: () => enqueueTeamPromotion,
  enqueueTeamRevocation: () => enqueueTeamRevocation,
  expireOldLowValueObservations: () => expireOldLowValueObservations,
  getConversationTurns: () => getConversationTurns,
  getCrossTaskProgress: () => getCrossTaskProgress,
  getDecisionsAbout: () => getDecisionsAbout,
  getFailedAttempts: () => getFailedAttempts,
  getFailureClasses: () => getFailureClasses,
  getLastProcessedLine: () => getLastProcessedLine,
  getMemoryDb: () => getMemoryDb,
  getMemoryMeta: () => getMemoryMeta,
  getObservabilityDbSize: () => getObservabilityDbSize,
  getRecentObservations: () => getRecentObservations,
  getRecurrenceCountForPromptHash: () => getRecurrenceCountForPromptHash,
  getSessionStats: () => getSessionStats,
  getSessionSummaries: () => getSessionSummaries,
  getSessionTimeline: () => getSessionTimeline,
  getSessionsByTask: () => getSessionsByTask,
  getToolPatterns: () => getToolPatterns,
  incrementRetryCount: () => incrementRetryCount,
  initMemorySchema: () => initMemorySchema,
  linkSessionToTask: () => linkSessionToTask,
  markRecordSuperseded: () => markRecordSuperseded,
  memoryTableHasTemporal: () => memoryTableHasTemporal,
  migrateAuditLogCheckExtension: () => migrateAuditLogCheckExtension,
  migrateMemoryFilesFor4B: () => migrateMemoryFilesFor4B,
  migrateObservationEmbeddingChunks: () => migrateObservationEmbeddingChunks,
  migrateSharedMemoryFor5B: () => migrateSharedMemoryFor5B,
  pruneOldConversationTurns: () => pruneOldConversationTurns,
  pruneOldObservations: () => pruneOldObservations,
  pruneToolCostEvents: () => pruneToolCostEvents,
  recordRecallHits: () => recordRecallHits,
  recordTelemetry: () => recordTelemetry,
  removePendingSync: () => removePendingSync,
  sanitizeFts5Query: () => sanitizeFts5Query,
  sanitizeFts5QueryOr: () => sanitizeFts5QueryOr,
  scoreFailureClasses: () => scoreFailureClasses,
  searchConversationTurns: () => searchConversationTurns,
  searchObservations: () => searchObservations,
  setLastProcessedLine: () => setLastProcessedLine,
  setMemoryMeta: () => setMemoryMeta,
  upsertObservationEmbedding: () => upsertObservationEmbedding,
  usageWarmupElapsed: () => usageWarmupElapsed
});
import { dirname as dirname7, basename as basename2 } from "path";
import { existsSync as existsSync8, mkdirSync as mkdirSync6 } from "fs";
function sanitizeFts5Query(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return '""';
  const tokens = trimmed.replace(/"/g, "").split(/\s+/).filter(Boolean);
  return tokens.map((t) => `"${t}"`).join(" ");
}
function sanitizeFts5QueryOr(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return '""';
  const tokens = trimmed.replace(/"/g, "").split(/\s+/).filter((t) => t.replace(/[^a-zA-Z0-9]/g, "").length >= 3);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
function getMemoryDb() {
  const dbPath = getResolvedPaths().memoryDbPath;
  const dir = dirname7(dbPath);
  if (!existsSync8(dir)) {
    mkdirSync6(dir, { recursive: true });
  }
  const preExisting = existsSync8(dbPath);
  const db = openDatabase2(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const onDisk = db.pragma("user_version", { simple: true });
  if (preExisting && onDisk !== MEMORY_SCHEMA_VERSION) {
    backupBeforeSchemaChange(
      getProjectRoot(),
      dbPath,
      (err) => recordHookFailure("memory-db:pre-ddl-backup", err, { dbPath, onDisk })
    );
  }
  initMemorySchema(db);
  if (onDisk !== MEMORY_SCHEMA_VERSION) {
    db.pragma(`user_version = ${MEMORY_SCHEMA_VERSION}`);
  }
  return db;
}
function pruneToolCostEvents(db) {
  const result = db.prepare(
    `DELETE FROM tool_cost_events WHERE created_at < datetime('now', '-' || ? || ' days')`
  ).run(TOOL_COST_EVENTS_RETENTION_DAYS);
  return result.changes;
}
function migrateObservationEmbeddingChunks(db) {
  const cols = db.pragma("table_info(observation_embeddings)");
  if (cols.length === 0) return;
  if (cols.some((c) => c.name === "chunk_ix")) return;
  db.pragma("foreign_keys = OFF");
  try {
    db.exec("BEGIN TRANSACTION");
    db.exec(`
      CREATE TABLE observation_embeddings_new (
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        chunk_ix INTEGER NOT NULL DEFAULT 0,
        model_id TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (observation_id, model_id, dim, chunk_ix)
      );
      INSERT INTO observation_embeddings_new
        (observation_id, chunk_ix, model_id, dim, vec, created_at)
        SELECT observation_id, 0, model_id, dim, vec, created_at FROM observation_embeddings;
      DROP TABLE observation_embeddings;
      ALTER TABLE observation_embeddings_new RENAME TO observation_embeddings;
      CREATE INDEX IF NOT EXISTS idx_obs_emb_model ON observation_embeddings(model_id);
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
function migrateMemoryFilesFor4B(db) {
  const ADDITIONS = [
    // The renderer's authorship credential (OD-1). NULL on every pre-existing row,
    // which is the safe direction: no MAC ⇒ unverifiable ⇒ the file is HUMAN.
    { table: "memory_files", name: "massu_render_mac", decl: "TEXT" },
    // F-15 stickiness: once a file is human, only `massu memory adopt` reverses it.
    { table: "memory_files", name: "adopted_human_at_epoch", decl: "INTEGER" },
    // OD-2: a CACHE of `.massu-tombstones.jsonl`. The ledger is the source of truth.
    { table: "memory_files", name: "tombstoned_at_epoch", decl: "INTEGER" },
    { table: "memory_files", name: "origin", decl: "TEXT NOT NULL DEFAULT 'local'" },
    { table: "memory_files", name: "render_suppressed", decl: "INTEGER NOT NULL DEFAULT 0" },
    // N-03 — the SOURCE row. This is the one F-08 actually requires.
    { table: "observations", name: "origin", decl: "TEXT NOT NULL DEFAULT 'local'" }
  ];
  for (const add of ADDITIONS) {
    const cols = db.prepare(`PRAGMA table_info(${add.table})`).all();
    if (cols.length === 0) continue;
    if (cols.some((c) => c.name === add.name)) continue;
    db.exec(`ALTER TABLE ${add.table} ADD COLUMN ${add.name} ${add.decl}`);
  }
}
function migrateSharedMemoryFor5B(db) {
  const cols = db.prepare(`PRAGMA table_info(observations)`).all();
  if (cols.length > 0 && !cols.some((c) => c.name === "shareable")) {
    db.exec(`ALTER TABLE observations ADD COLUMN shareable INTEGER NOT NULL DEFAULT 0`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_memory_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_hash TEXT NOT NULL UNIQUE,        -- identity + idempotency key (hex sha256)
      origin_repo_id TEXT NOT NULL,            -- the signed origin repo_id (v4 UUID)
      origin_repo_label TEXT NOT NULL,         -- re-slugged on read; NEVER trusted from the wire
      envelope_raw TEXT NOT NULL,              -- the VERBATIM signed bytes; B-05 re-verifies these
      record_json TEXT NOT NULL,               -- the single record's canonical JSON
      received_at_epoch INTEGER NOT NULL,      -- epoch SECONDS (Slice-2 convention)
      accepted_at_epoch INTEGER,               -- set on accept (B-05); NULL while pending
      refused_at_epoch INTEGER,                -- set on refuse (B-06)
      expired_at_epoch INTEGER                 -- revocation \u21D2 EXPIRE, never DELETE (B-07 / S-3)
    );
    CREATE INDEX IF NOT EXISTS idx_smp_origin ON shared_memory_pending(origin_repo_id);
    CREATE INDEX IF NOT EXISTS idx_smp_received ON shared_memory_pending(received_at_epoch DESC);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_memory_outbound (
      record_hash TEXT PRIMARY KEY,          -- the exported record's canonical hash
      observation_id INTEGER NOT NULL,       -- the source observations.id (for B-07 revocation)
      origin_repo_id TEXT NOT NULL,          -- this repo's own repo_id at export time
      seq INTEGER NOT NULL,                  -- the envelope seq this record first went out in
      exported_at_epoch INTEGER NOT NULL,    -- epoch SECONDS
      revoked_at_epoch INTEGER               -- set when the source row is superseded/expired (B-07)
    );
    CREATE INDEX IF NOT EXISTS idx_smo_obs ON shared_memory_outbound(observation_id);
  `);
}
function migrateAuditLogCheckExtension(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='audit_log'").get();
  if (!row) return;
  const expected = [
    "code_change",
    "rule_enforced",
    "approval",
    "review",
    "commit",
    "compaction",
    "rule_candidate_emitted",
    "rule_promoted",
    "rule_dismissed",
    // A-19/N-02 — without these the memory-file events throw a CHECK violation.
    // In the ingest path the throw is swallowed by a bare catch, so observability
    // silently produces NOTHING; in the renderer's transaction it ROLLS BACK a
    // legitimate render. This migration is what lets an EXISTING db accept them.
    "memory_file_ingested",
    "memory_file_expired",
    "memory_file_adopted_human",
    "memory_file_rendered",
    "memory_file_render_refused",
    "memory_file_tombstoned",
    // B-10 (Slice 5) — the seven cross-repo shared-memory events. An existing DB whose
    // CHECK lacks any of these triggers the table rebuild below.
    "shared_memory_exported",
    "shared_memory_export_refused",
    "shared_memory_imported",
    "shared_memory_dropped",
    "shared_memory_accepted",
    "shared_memory_refused",
    "shared_memory_revoked"
  ];
  const checkClauseMatch = row.sql.match(/event_type\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*event_type\s+IN\s*\(([\s\S]*?)\)\s*\)/i);
  if (checkClauseMatch) {
    const values = (checkClauseMatch[1].match(/'([^']+)'/g) ?? []).map((s) => s.slice(1, -1));
    if (expected.every((v) => values.includes(v))) return;
  }
  db.pragma("foreign_keys = OFF");
  try {
    db.exec("BEGIN TRANSACTION");
    db.exec(`
      CREATE TABLE audit_log_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp TEXT DEFAULT (datetime('now')),
        event_type TEXT NOT NULL CHECK(event_type IN (
          'code_change', 'rule_enforced', 'approval', 'review', 'commit', 'compaction',
          'rule_candidate_emitted', 'rule_promoted', 'rule_dismissed',
          'memory_file_ingested', 'memory_file_expired', 'memory_file_adopted_human',
          'memory_file_rendered', 'memory_file_render_refused', 'memory_file_tombstoned',
          -- B-10 (Slice 5) \u2014 cross-repo shared-memory events (must mirror the CREATE +
          -- the expected[] list above, or the migration would loop rebuilding forever).
          'shared_memory_exported', 'shared_memory_export_refused', 'shared_memory_imported',
          'shared_memory_dropped', 'shared_memory_accepted', 'shared_memory_refused',
          'shared_memory_revoked'
        )),
        actor TEXT NOT NULL DEFAULT 'ai' CHECK(actor IN ('ai', 'human', 'hook', 'agent')),
        model_id TEXT,
        file_path TEXT,
        change_type TEXT CHECK(change_type IN ('create', 'edit', 'delete')),
        rules_in_effect TEXT,
        approval_status TEXT CHECK(approval_status IN ('auto_approved', 'human_approved', 'pending', 'denied')),
        evidence TEXT,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      INSERT INTO audit_log_new SELECT * FROM audit_log;
      DROP TABLE audit_log;
      ALTER TABLE audit_log_new RENAME TO audit_log;
      CREATE INDEX IF NOT EXISTS idx_al_session ON audit_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_al_file ON audit_log(file_path);
      CREATE INDEX IF NOT EXISTS idx_al_event ON audit_log(event_type);
      CREATE INDEX IF NOT EXISTS idx_al_timestamp ON audit_log(timestamp DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_rule_promoted
        ON audit_log (event_type, json_extract(metadata, '$.prompt_hash'))
        WHERE event_type = 'rule_promoted';
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
function initMemorySchema(db) {
  db.exec(`
    -- Sessions table (linked to Claude Code session IDs)
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      project TEXT NOT NULL DEFAULT 'my-project',
      git_branch TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      ended_at TEXT,
      ended_at_epoch INTEGER,
      status TEXT CHECK(status IN ('active', 'completed', 'abandoned')) NOT NULL DEFAULT 'active',
      plan_file TEXT,
      plan_phase TEXT,
      task_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_task_id ON sessions(task_id);

    -- Observations table (structured knowledge from tool usage)
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN (
        'decision', 'bugfix', 'feature', 'refactor', 'discovery',
        'cr_violation', 'vr_check', 'pattern_compliance', 'failed_attempt',
        'file_change', 'incident_near_miss'
      )),
      title TEXT NOT NULL,
      detail TEXT,
      files_involved TEXT DEFAULT '[]',
      plan_item TEXT,
      cr_rule TEXT,
      vr_type TEXT,
      evidence TEXT,
      importance INTEGER NOT NULL DEFAULT 3 CHECK(importance BETWEEN 1 AND 5),
      recurrence_count INTEGER NOT NULL DEFAULT 1,
      original_tokens INTEGER DEFAULT 0,
      -- B-10/F-08/N-03: the SOURCE-row provenance flag. The renderer refuses any
      -- row whose origin is not 'local' BEFORE it computes a path, mints a
      -- credential, or takes a snapshot. A Slice-5 synced memory arrives here with
      -- origin='team' and must never reach disk without CR-55's gates.
      origin TEXT NOT NULL DEFAULT 'local',
      -- B-01 (Slice 5, cross-repo surfacing): the per-decision SHARE opt-in. Set to 1
      -- ONLY by an explicit human act (massu memory share <id>); NEVER by a heuristic,
      -- score, LLM, hook, or consolidation pass. Export (B-02) reads WHERE shareable=1
      -- AND origin='local'. Defaults 0 so every pre-existing and machine-written row is
      -- un-shareable until a human says otherwise (fail-closed).
      shareable INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
    CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
    CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_observations_plan_item ON observations(plan_item);
    CREATE INDEX IF NOT EXISTS idx_observations_cr_rule ON observations(cr_rule);
    CREATE INDEX IF NOT EXISTS idx_observations_importance ON observations(importance DESC);
  `);
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        title, detail, evidence,
        content='observations',
        content_rowid='id'
      );
    `);
  } catch (_e) {
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, detail, evidence)
      VALUES (new.id, new.title, new.detail, new.evidence);
    END;

    CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, detail, evidence)
      VALUES ('delete', old.id, old.title, old.detail, old.evidence);
    END;

    CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, detail, evidence)
      VALUES ('delete', old.id, old.title, old.detail, old.evidence);
      INSERT INTO observations_fts(rowid, title, detail, evidence)
      VALUES (new.id, new.title, new.detail, new.evidence);
    END;
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      decisions TEXT,
      completed TEXT,
      failed_attempts TEXT,
      next_steps TEXT,
      files_created TEXT DEFAULT '[]',
      files_modified TEXT DEFAULT '[]',
      verification_results TEXT DEFAULT '{}',
      plan_progress TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_summaries_session ON session_summaries(session_id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      prompt_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
  `);
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS user_prompts_fts USING fts5(
        prompt_text,
        content='user_prompts',
        content_rowid='id'
      );
    `);
  } catch (_e) {
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS prompts_ai AFTER INSERT ON user_prompts BEGIN
      INSERT INTO user_prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
    END;

    CREATE TRIGGER IF NOT EXISTS prompts_ad AFTER DELETE ON user_prompts BEGIN
      INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
      VALUES ('delete', old.id, old.prompt_text);
    END;
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_usage (
      source TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      hits_windowed REAL NOT NULL DEFAULT 0,
      last_hit_epoch INTEGER,
      last_reweight_epoch INTEGER,
      PRIMARY KEY (source, record_id)
    );

    CREATE TABLE IF NOT EXISTS memory_usage_sessions (
      source TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (source, record_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_usage_hits
      ON memory_usage(source, hits_windowed DESC);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      user_prompt TEXT NOT NULL,
      assistant_response TEXT,
      tool_calls_json TEXT,
      tool_call_count INTEGER DEFAULT 0,
      model_used TEXT,
      duration_ms INTEGER,
      prompt_tokens INTEGER,
      response_tokens INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      created_at_epoch INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ct_session ON conversation_turns(session_id);
    CREATE INDEX IF NOT EXISTS idx_ct_created ON conversation_turns(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ct_turn ON conversation_turns(session_id, turn_number);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_call_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input_summary TEXT,
      tool_input_size INTEGER,
      tool_output_size INTEGER,
      tool_success INTEGER DEFAULT 1,
      duration_ms INTEGER,
      files_involved TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      created_at_epoch INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tcd_session ON tool_call_details(session_id);
    CREATE INDEX IF NOT EXISTS idx_tcd_tool ON tool_call_details(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tcd_created ON tool_call_details(created_at DESC);
  `);
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_fts USING fts5(
        user_prompt,
        assistant_response,
        content=conversation_turns,
        content_rowid=id
      );
    `);
  } catch (_e) {
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ct_fts_insert AFTER INSERT ON conversation_turns BEGIN
      INSERT INTO conversation_turns_fts(rowid, user_prompt, assistant_response)
      VALUES (new.id, new.user_prompt, new.assistant_response);
    END;

    CREATE TRIGGER IF NOT EXISTS ct_fts_delete AFTER DELETE ON conversation_turns BEGIN
      INSERT INTO conversation_turns_fts(conversation_turns_fts, rowid, user_prompt, assistant_response)
      VALUES ('delete', old.id, old.user_prompt, old.assistant_response);
    END;

    CREATE TRIGGER IF NOT EXISTS ct_fts_update AFTER UPDATE ON conversation_turns BEGIN
      INSERT INTO conversation_turns_fts(conversation_turns_fts, rowid, user_prompt, assistant_response)
      VALUES ('delete', old.id, old.user_prompt, old.assistant_response);
      INSERT INTO conversation_turns_fts(rowid, user_prompt, assistant_response)
      VALUES (new.id, new.user_prompt, new.assistant_response);
    END;
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_quality_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      project TEXT NOT NULL DEFAULT 'my-project',
      score INTEGER NOT NULL DEFAULT 100,
      security_score INTEGER NOT NULL DEFAULT 100,
      architecture_score INTEGER NOT NULL DEFAULT 100,
      coupling_score INTEGER NOT NULL DEFAULT 100,
      test_score INTEGER NOT NULL DEFAULT 100,
      rule_compliance_score INTEGER NOT NULL DEFAULT 100,
      observations_total INTEGER NOT NULL DEFAULT 0,
      bugs_found INTEGER NOT NULL DEFAULT 0,
      bugs_fixed INTEGER NOT NULL DEFAULT 0,
      vr_checks_passed INTEGER NOT NULL DEFAULT 0,
      vr_checks_failed INTEGER NOT NULL DEFAULT 0,
      incidents_triggered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sqs_session ON session_quality_scores(session_id);
    CREATE INDEX IF NOT EXISTS idx_sqs_project ON session_quality_scores(project);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      project TEXT NOT NULL DEFAULT 'my-project',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0.0,
      model TEXT,
      duration_minutes REAL NOT NULL DEFAULT 0.0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sc_session ON session_costs(session_id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS feature_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0.0,
      commit_hash TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_fc_feature ON feature_costs(feature_key);
    CREATE INDEX IF NOT EXISTS idx_fc_session ON feature_costs(session_id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      prompt_category TEXT NOT NULL DEFAULT 'feature',
      word_count INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL DEFAULT 'success' CHECK(outcome IN ('success', 'partial', 'failure', 'abandoned')),
      corrections_needed INTEGER NOT NULL DEFAULT 0,
      follow_up_prompts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_po_session ON prompt_outcomes(session_id);
    CREATE INDEX IF NOT EXISTS idx_po_category ON prompt_outcomes(prompt_category);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      event_type TEXT NOT NULL CHECK(event_type IN (
        'code_change', 'rule_enforced', 'approval', 'review', 'commit', 'compaction',
        'rule_candidate_emitted', 'rule_promoted', 'rule_dismissed',
        'memory_file_ingested', 'memory_file_expired', 'memory_file_adopted_human',
        'memory_file_rendered', 'memory_file_render_refused', 'memory_file_tombstoned',
        -- B-10 (Slice 5): cross-repo shared-memory observability. Without these seven,
        -- nobody could ever answer "what has crossed between my repos?" (and an ingest
        -- catch would swallow the CHECK violation, silently producing NOTHING).
        'shared_memory_exported', 'shared_memory_export_refused', 'shared_memory_imported',
        'shared_memory_dropped', 'shared_memory_accepted', 'shared_memory_refused',
        'shared_memory_revoked'
      )),
      actor TEXT NOT NULL DEFAULT 'ai' CHECK(actor IN ('ai', 'human', 'hook', 'agent')),
      model_id TEXT,
      file_path TEXT,
      change_type TEXT CHECK(change_type IN ('create', 'edit', 'delete')),
      rules_in_effect TEXT,
      approval_status TEXT CHECK(approval_status IN ('auto_approved', 'human_approved', 'pending', 'denied')),
      evidence TEXT,
      metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_al_session ON audit_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_al_file ON audit_log(file_path);
    CREATE INDEX IF NOT EXISTS idx_al_event ON audit_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_al_timestamp ON audit_log(timestamp DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_rule_promoted
      ON audit_log (event_type, json_extract(metadata, '$.prompt_hash'))
      WHERE event_type = 'rule_promoted';
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS hook_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hook TEXT NOT NULL,
      error TEXT NOT NULL,
      context_json TEXT,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hook_health_hook ON hook_health(hook);
    CREATE INDEX IF NOT EXISTS idx_hook_health_time ON hook_health(occurred_at DESC);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_outcomes_signal_blacklist (
      signal TEXT PRIMARY KEY,
      dismissal_count INTEGER NOT NULL DEFAULT 0,
      first_dismissed_at TEXT DEFAULT (datetime('now')),
      last_dismissed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_psb_count
      ON prompt_outcomes_signal_blacklist(dismissal_count DESC);
  `);
  migrateAuditLogCheckExtension(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rel_path TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT,
      raw TEXT NOT NULL,
      frontmatter_json TEXT,
      body TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      ingest_schema_version INTEGER NOT NULL DEFAULT 1,
      massu_authored INTEGER NOT NULL DEFAULT 0,
      massu_render_mac TEXT,
      adopted_human_at_epoch INTEGER,
      tombstoned_at_epoch INTEGER,
      origin TEXT NOT NULL DEFAULT 'local',
      render_suppressed INTEGER NOT NULL DEFAULT 0,
      observation_id INTEGER,
      synced_at_epoch INTEGER,
      expired_at_epoch INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mf_hash ON memory_files(content_hash);
    CREATE INDEX IF NOT EXISTS idx_mf_expired ON memory_files(expired_at_epoch);
    CREATE INDEX IF NOT EXISTS idx_mf_obs ON memory_files(observation_id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS validation_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      validation_type TEXT NOT NULL,
      passed INTEGER NOT NULL DEFAULT 1,
      details TEXT,
      rules_violated TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_vr_session ON validation_results(session_id);
    CREATE INDEX IF NOT EXISTS idx_vr_file ON validation_results(file_path);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS architecture_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      context TEXT,
      decision TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted', 'superseded', 'deprecated')),
      alternatives TEXT,
      consequences TEXT,
      affected_files TEXT,
      commit_hash TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ad_session ON architecture_decisions(session_id);
    CREATE INDEX IF NOT EXISTS idx_ad_status ON architecture_decisions(status);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      risk_score INTEGER NOT NULL DEFAULT 0,
      findings TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ss_session ON security_scores(session_id);
    CREATE INDEX IF NOT EXISTS idx_ss_file ON security_scores(file_path);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS dependency_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_name TEXT NOT NULL,
      version TEXT,
      risk_score INTEGER NOT NULL DEFAULT 0,
      vulnerabilities INTEGER NOT NULL DEFAULT 0,
      last_publish_days INTEGER,
      weekly_downloads INTEGER,
      license TEXT,
      bundle_size_kb INTEGER,
      previous_removals INTEGER NOT NULL DEFAULT 0,
      assessed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_da_package ON dependency_assessments(package_name);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS developer_expertise (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      developer_id TEXT NOT NULL,
      module TEXT NOT NULL,
      session_count INTEGER NOT NULL DEFAULT 0,
      observation_count INTEGER NOT NULL DEFAULT 0,
      expertise_score INTEGER NOT NULL DEFAULT 0,
      last_active TEXT DEFAULT (datetime('now')),
      UNIQUE(developer_id, module)
    );
    CREATE INDEX IF NOT EXISTS idx_de_developer ON developer_expertise(developer_id);
    CREATE INDEX IF NOT EXISTS idx_de_module ON developer_expertise(module);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_id INTEGER,
      developer_id TEXT NOT NULL,
      project TEXT NOT NULL,
      observation_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      file_path TEXT,
      module TEXT,
      severity INTEGER NOT NULL DEFAULT 3,
      is_shared INTEGER NOT NULL DEFAULT 0,
      shared_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_so_developer ON shared_observations(developer_id);
    CREATE INDEX IF NOT EXISTS idx_so_file ON shared_observations(file_path);
    CREATE INDEX IF NOT EXISTS idx_so_module ON shared_observations(module);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_promotion_outbound (
      prompt_hash TEXT PRIMARY KEY,
      destination TEXT NOT NULL,
      draft_text TEXT NOT NULL,
      score REAL,
      signals_json TEXT NOT NULL DEFAULT '[]',
      content_hash TEXT NOT NULL,
      -- PA3-004 (Phase 3 Stream A): hardened-destination publish carries the
      -- publisher's review attestation so the server CHECK (hardened rows need a
      -- review_attestation) is satisfiable. hardened=0 for the Phase-2 rows.
      hardened INTEGER NOT NULL DEFAULT 0,
      review_attestation_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS team_revocation_outbound (
      prompt_hash TEXT PRIMARY KEY,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rule_promotion_events_outbound (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_hash TEXT NOT NULL,
      event_type TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rpe_outbound_created ON rule_promotion_events_outbound(created_at);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      developer_a TEXT NOT NULL,
      developer_b TEXT NOT NULL,
      conflict_type TEXT NOT NULL DEFAULT 'concurrent_edit',
      resolved INTEGER NOT NULL DEFAULT 0,
      detected_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_kc_file ON knowledge_conflicts(file_path);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS feature_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_key TEXT NOT NULL UNIQUE,
      health_score INTEGER NOT NULL DEFAULT 100,
      tests_passing INTEGER NOT NULL DEFAULT 0,
      tests_failing INTEGER NOT NULL DEFAULT 0,
      test_coverage_pct REAL,
      modifications_since_test INTEGER NOT NULL DEFAULT 0,
      last_modified TEXT,
      last_tested TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fh_feature ON feature_health(feature_key);
    CREATE INDEX IF NOT EXISTS idx_fh_health ON feature_health(health_score);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_cost_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      estimated_input_tokens INTEGER DEFAULT 0,
      estimated_output_tokens INTEGER DEFAULT 0,
      model TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tce_session ON tool_cost_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_tce_tool ON tool_cost_events(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tce_created ON tool_cost_events(created_at DESC);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS quality_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      details TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_qe_session ON quality_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_qe_event_type ON quality_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_qe_created ON quality_events(created_at DESC);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_sync (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_sync_created ON pending_sync(created_at ASC);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS license_cache (
      api_key_hash TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      last_validated TEXT NOT NULL,
      features TEXT DEFAULT '[]'
    );
  `);
  const licenseCacheCols = db.prepare(`PRAGMA table_info(license_cache)`).all();
  if (!licenseCacheCols.some((c) => c.name === "signed_payload_json")) {
    db.exec(
      `ALTER TABLE license_cache ADD COLUMN signed_payload_json TEXT NOT NULL DEFAULT ''`
    );
  }
  const outboundCols = db.prepare(`PRAGMA table_info(team_promotion_outbound)`).all();
  if (!outboundCols.some((c) => c.name === "hardened")) {
    db.exec(`ALTER TABLE team_promotion_outbound ADD COLUMN hardened INTEGER NOT NULL DEFAULT 0`);
  }
  if (!outboundCols.some((c) => c.name === "review_attestation_json")) {
    db.exec(`ALTER TABLE team_promotion_outbound ADD COLUMN review_attestation_json TEXT`);
  }
  const sessionCols = db.prepare(`PRAGMA table_info(sessions)`).all();
  if (!sessionCols.some((c) => c.name === "consolidated_at")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN consolidated_at TEXT`);
  }
  if (!sessionCols.some((c) => c.name === "consolidated_at_epoch")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN consolidated_at_epoch INTEGER`);
  }
  if (!sessionCols.some((c) => c.name === "consolidated_status")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN consolidated_status TEXT`);
  }
  const BITEMPORAL_COLUMNS = [
    { name: "valid_from", type: "TEXT" },
    { name: "valid_to", type: "TEXT" },
    { name: "ingested_at", type: "TEXT" },
    { name: "expired_at", type: "TEXT" },
    { name: "valid_from_epoch", type: "INTEGER" },
    { name: "valid_to_epoch", type: "INTEGER" },
    { name: "ingested_at_epoch", type: "INTEGER" },
    { name: "expired_at_epoch", type: "INTEGER" },
    { name: "superseded_by", type: "INTEGER" }
  ];
  for (const table of ["observations", "architecture_decisions"]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    for (const col of BITEMPORAL_COLUMNS) {
      if (!cols.some((c) => c.name === col.name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`);
      }
    }
  }
  db.exec(`
    UPDATE observations
       SET valid_from = created_at,
           ingested_at = created_at,
           valid_from_epoch = created_at_epoch,
           ingested_at_epoch = created_at_epoch
     WHERE valid_from_epoch IS NULL;
  `);
  db.exec(`
    UPDATE architecture_decisions
       SET valid_from = created_at,
           ingested_at = created_at,
           valid_from_epoch = CAST(strftime('%s', created_at) AS INTEGER),
           ingested_at_epoch = CAST(strftime('%s', created_at) AS INTEGER)
     WHERE valid_from_epoch IS NULL AND created_at IS NOT NULL;
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_observations_expired ON observations(expired_at_epoch);
    CREATE INDEX IF NOT EXISTS idx_ad_expired ON architecture_decisions(expired_at_epoch);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS failure_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      diff_patterns TEXT NOT NULL DEFAULT '[]',
      file_patterns TEXT NOT NULL DEFAULT '[]',
      prompt_keywords TEXT NOT NULL DEFAULT '[]',
      incidents TEXT NOT NULL DEFAULT '[]',
      rules TEXT NOT NULL DEFAULT '[]',
      scanner_checks TEXT NOT NULL DEFAULT '[]',
      known_message TEXT NOT NULL DEFAULT '',
      needs_review INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fc_name ON failure_classes(name);
    CREATE INDEX IF NOT EXISTS idx_fc_needs_review ON failure_classes(needs_review);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS observation_embeddings (
      observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
      chunk_ix INTEGER NOT NULL DEFAULT 0,
      model_id TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (observation_id, model_id, dim, chunk_ix)
    );
    CREATE INDEX IF NOT EXISTS idx_obs_emb_model ON observation_embeddings(model_id);
  `);
  migrateObservationEmbeddingChunks(db);
  migrateMemoryFilesFor4B(db);
  migrateSharedMemoryFor5B(db);
  ensureRuleCandidatesTable(db);
  migrateRuleDelivery(db);
}
function enqueueSyncPayload(db, payload) {
  db.prepare("INSERT INTO pending_sync (payload) VALUES (?)").run(payload);
}
function getMemoryMeta(db, key) {
  const row = db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(key);
  return row ? row.value : null;
}
function setMemoryMeta(db, key, value) {
  db.prepare("INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)").run(key, value);
}
function upsertObservationEmbedding(db, observationId, vec, modelId, dim) {
  db.prepare(
    `INSERT OR REPLACE INTO observation_embeddings (observation_id, model_id, dim, vec, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(observationId, modelId, dim, float32ToBlob(vec));
}
function observationEmbedText(title, detail) {
  const t = (title ?? "").trim();
  const d = (detail ?? "").trim();
  return d ? `${t}. ${d}` : t;
}
async function embedMissingObservations(db, opts = {}) {
  return runEmbedSweep(
    db,
    {
      embeddingTable: "observation_embeddings",
      idCol: "observation_id",
      metaTable: "memory_meta",
      sourceLabel: "observation",
      // A-04: memory bodies are now stored WHOLE (up to ~14K chars). One vector per
      // memory would cover only its first ~1,000 chars.
      chunked: true,
      selectMissing: (d, cursor, model, batchSize) => {
        const rows = model ? d.prepare(
          `SELECT o.id AS id, o.title AS title, o.detail AS detail
                 FROM observations o
                 WHERE o.id > ?
                   AND NOT EXISTS (
                     SELECT 1 FROM observation_embeddings e
                     WHERE e.observation_id = o.id AND e.model_id = ? AND e.dim = ?
                   )
                 ORDER BY o.id LIMIT ?`
        ).all(cursor, model.modelId, model.dim, batchSize) : d.prepare(
          `SELECT o.id AS id, o.title AS title, o.detail AS detail
                 FROM observations o
                 WHERE o.id > ?
                   AND NOT EXISTS (
                     SELECT 1 FROM observation_embeddings e WHERE e.observation_id = o.id
                   )
                 ORDER BY o.id LIMIT ?`
        ).all(cursor, batchSize);
        return rows.map((r) => ({ id: r.id, text: observationEmbedText(r.title, r.detail) }));
      }
    },
    opts
  );
}
function enqueueTeamPromotion(db, promo) {
  db.prepare(`
    INSERT OR REPLACE INTO team_promotion_outbound
      (prompt_hash, destination, draft_text, score, signals_json, content_hash, hardened, review_attestation_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    promo.prompt_hash,
    promo.destination,
    promo.draft_text.slice(0, MAX_DRAFT_TEXT_LEN),
    promo.score ?? null,
    JSON.stringify(promo.signals ?? []),
    promo.content_hash,
    promo.hardened ? 1 : 0,
    promo.review_attestation !== void 0 ? JSON.stringify(promo.review_attestation) : null
  );
}
function enqueueTeamRevocation(db, promptHash) {
  db.prepare(`
    INSERT OR REPLACE INTO team_revocation_outbound (prompt_hash, created_at)
    VALUES (?, datetime('now'))
  `).run(promptHash);
}
function getRecurrenceCountForPromptHash(db, promptHash) {
  try {
    const row = db.prepare(`
      SELECT json_extract(metadata, '$.recurrence_count') AS rc
      FROM audit_log
      WHERE event_type = 'rule_promoted'
        AND json_extract(metadata, '$.prompt_hash') = ?
      LIMIT 1
    `).get(promptHash);
    if (!row || row.rc === null || row.rc === void 0) return null;
    return Number(row.rc);
  } catch {
    return null;
  }
}
function enqueueRulePromotionEvent(db, ev) {
  try {
    db.prepare(`
      INSERT INTO rule_promotion_events_outbound
        (prompt_hash, event_type, metadata_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      ev.prompt_hash,
      ev.event_type,
      JSON.stringify(ev.metadata ?? {}),
      ev.created_at
    );
    capTelemetry(db, FUNNEL_EVENT_OUTBOX_CAP);
  } catch (err) {
    process.stderr.write(
      `[massu] WARNING: failed to record promotion-funnel event (${ev.event_type} / ${ev.prompt_hash}): ${err instanceof Error ? err.message : String(err)}
`
    );
  }
}
function recordTelemetry(db, eventType, data) {
  try {
    db.prepare(`
      INSERT INTO analytics_events (event_type, event_data, created_at)
      VALUES (?, ?, datetime('now'))
    `).run(eventType, JSON.stringify(data));
  } catch {
  }
}
function rescueLearningFromStalePayloads(db, stale) {
  let rescued = 0;
  for (const item of stale) {
    let payload;
    try {
      payload = JSON.parse(item.payload);
    } catch {
      continue;
    }
    try {
      const promotions = Array.isArray(payload.rule_promotions) ? payload.rule_promotions : [];
      for (const p of promotions) {
        enqueueTeamPromotion(db, p);
        rescued++;
      }
      const revocations = Array.isArray(payload.rule_revocations) ? payload.rule_revocations : [];
      for (const r of revocations) {
        if (typeof r?.prompt_hash === "string") {
          enqueueTeamRevocation(db, r.prompt_hash);
          rescued++;
        }
      }
      const events = Array.isArray(payload.rule_promotion_events) ? payload.rule_promotion_events : [];
      for (const e of events) {
        enqueueRulePromotionEvent(db, e);
      }
    } catch (err) {
      process.stderr.write(
        `[massu] WARNING: failed to rescue learned rules from give-up payload ${item.id}: ${err instanceof Error ? err.message : String(err)}
`
      );
    }
  }
  return rescued;
}
function dequeuePendingSync(db, limit = 10) {
  const stale = db.prepare(
    "SELECT id, retry_count, last_error, payload FROM pending_sync WHERE retry_count >= 10 LIMIT 10000"
  ).all();
  if (stale.length > 0) {
    const rescued = rescueLearningFromStalePayloads(db, stale);
    const ids = stale.map((s) => s.id);
    db.prepare(`DELETE FROM pending_sync WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    if (rescued > 0) {
      process.stderr.write(
        `[massu] RESCUED ${rescued} learned rule(s) from ${stale.length} give-up payload(s) \u2014 they were re-queued for delivery, NOT discarded.
`
      );
    }
    const lastErrors = [...new Set(stale.map((s) => s.last_error).filter(Boolean))];
    process.stderr.write(
      `[massu] WARNING: ${stale.length} cloud-sync queue item(s) discarded after 10+ retries. Likely cause: invalid API key or unreachable endpoint. Recent errors: ${lastErrors.slice(0, 3).join("; ") || "(none recorded)"}
`
    );
    try {
      db.prepare(`
        INSERT INTO analytics_events (event_type, event_data, created_at)
        VALUES (?, ?, datetime('now'))
      `).run(
        "cloud_sync_giveup",
        JSON.stringify({
          discarded_count: stale.length,
          recent_errors: lastErrors.slice(0, 3)
        })
      );
    } catch {
    }
  }
  return db.prepare(
    "SELECT id, payload, retry_count FROM pending_sync ORDER BY created_at ASC LIMIT ?"
  ).all(limit);
}
function removePendingSync(db, id) {
  db.prepare("DELETE FROM pending_sync WHERE id = ?").run(id);
}
function incrementRetryCount(db, id, error) {
  db.prepare(
    "UPDATE pending_sync SET retry_count = retry_count + 1, last_error = ? WHERE id = ?"
  ).run(error, id);
}
function assignImportance(type, vrResult) {
  switch (type) {
    case "decision":
    case "failed_attempt":
      return 5;
    case "cr_violation":
    case "incident_near_miss":
      return 4;
    case "vr_check":
      return vrResult === "PASS" ? 2 : 4;
    case "pattern_compliance":
      return vrResult === "PASS" ? 2 : 4;
    case "feature":
    case "bugfix":
      return 3;
    case "refactor":
      return 2;
    case "file_change":
    case "discovery":
      return 1;
    default:
      return 3;
  }
}
function autoDetectTaskId(planFile) {
  if (!planFile) return null;
  const base = basename2(planFile);
  return base.replace(/\.md$/, "");
}
function createSession(db, sessionId, opts) {
  const now = /* @__PURE__ */ new Date();
  const taskId = autoDetectTaskId(opts?.planFile);
  db.prepare(`
    INSERT OR IGNORE INTO sessions (session_id, git_branch, plan_file, task_id, started_at, started_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, opts?.branch ?? null, opts?.planFile ?? null, taskId, now.toISOString(), Math.floor(now.getTime() / 1e3));
}
function endSession(db, sessionId, status = "completed") {
  const now = /* @__PURE__ */ new Date();
  db.prepare(`
    UPDATE sessions SET status = ?, ended_at = ?, ended_at_epoch = ? WHERE session_id = ?
  `).run(status, now.toISOString(), Math.floor(now.getTime() / 1e3), sessionId);
}
function memoryTableHasTemporal(db, table) {
  let perDb = _temporalColCache.get(db);
  if (!perDb) {
    perDb = /* @__PURE__ */ new Map();
    _temporalColCache.set(db, perDb);
  }
  let has = perDb.get(table);
  if (has === void 0) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      has = cols.some((c) => c.name === "valid_from_epoch");
    } catch {
      has = false;
    }
    perDb.set(table, has);
  }
  return has;
}
function addObservation(db, sessionId, type, title, detail, opts) {
  const now = /* @__PURE__ */ new Date();
  const importance = opts?.importance ?? assignImportance(type, opts?.evidence?.includes("PASS") ? "PASS" : void 0);
  const iso = now.toISOString();
  const epochSec = Math.floor(now.getTime() / 1e3);
  let result;
  if (memoryTableHasTemporal(db, "observations")) {
    result = db.prepare(`
      INSERT INTO observations (session_id, type, title, detail, files_involved, plan_item, cr_rule, vr_type, evidence, importance, original_tokens, created_at, created_at_epoch, valid_from, ingested_at, valid_from_epoch, ingested_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      type,
      title,
      detail,
      JSON.stringify(opts?.filesInvolved ?? []),
      opts?.planItem ?? null,
      opts?.crRule ?? null,
      opts?.vrType ?? null,
      opts?.evidence ?? null,
      importance,
      opts?.originalTokens ?? 0,
      iso,
      epochSec,
      iso,
      iso,
      epochSec,
      epochSec
    );
  } else {
    result = db.prepare(`
      INSERT INTO observations (session_id, type, title, detail, files_involved, plan_item, cr_rule, vr_type, evidence, importance, original_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      type,
      title,
      detail,
      JSON.stringify(opts?.filesInvolved ?? []),
      opts?.planItem ?? null,
      opts?.crRule ?? null,
      opts?.vrType ?? null,
      opts?.evidence ?? null,
      importance,
      opts?.originalTokens ?? 0,
      iso,
      epochSec
    );
  }
  return Number(result.lastInsertRowid);
}
function markRecordSuperseded(db, table, recordId, successorId, nowEpochSec = Math.floor(Date.now() / 1e3)) {
  const iso = new Date(nowEpochSec * 1e3).toISOString();
  const statusClause = table === "architecture_decisions" ? `, status = 'superseded'` : "";
  const res = db.prepare(
    `UPDATE ${table}
          SET valid_to = ?, expired_at = ?, valid_to_epoch = ?, expired_at_epoch = ?, superseded_by = ?${statusClause}
        WHERE id = ? AND expired_at IS NULL AND id != ?`
  ).run(iso, iso, nowEpochSec, nowEpochSec, successorId, recordId, successorId);
  return res.changes > 0;
}
function addSummary(db, sessionId, summary) {
  const now = /* @__PURE__ */ new Date();
  db.prepare(`
    INSERT INTO session_summaries (session_id, request, investigated, decisions, completed, failed_attempts, next_steps, files_created, files_modified, verification_results, plan_progress, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    summary.request ?? null,
    summary.investigated ?? null,
    summary.decisions ?? null,
    summary.completed ?? null,
    summary.failedAttempts ?? null,
    summary.nextSteps ?? null,
    JSON.stringify(summary.filesCreated ?? []),
    JSON.stringify(summary.filesModified ?? []),
    JSON.stringify(summary.verificationResults ?? {}),
    JSON.stringify(summary.planProgress ?? {}),
    now.toISOString(),
    Math.floor(now.getTime() / 1e3)
  );
}
function addUserPrompt(db, sessionId, text, promptNumber) {
  const now = /* @__PURE__ */ new Date();
  db.prepare(`
    INSERT INTO user_prompts (session_id, prompt_text, prompt_number, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, text, promptNumber, now.toISOString(), Math.floor(now.getTime() / 1e3));
}
function searchObservations(db, query, opts) {
  const limit = opts?.limit ?? 20;
  let sql = `
    SELECT o.id, o.type, o.title, o.created_at, o.session_id, o.importance,
           rank
    FROM observations_fts
    JOIN observations o ON observations_fts.rowid = o.id
    WHERE observations_fts MATCH ?
  `;
  const params = [sanitizeFts5Query(query)];
  if (opts?.type) {
    sql += " AND o.type = ?";
    params.push(opts.type);
  }
  if (opts?.crRule) {
    sql += " AND o.cr_rule = ?";
    params.push(opts.crRule);
  }
  if (opts?.dateFrom) {
    sql += " AND o.created_at >= ?";
    params.push(opts.dateFrom);
  }
  sql += " ORDER BY rank LIMIT ?";
  params.push(limit);
  return db.prepare(sql).all(...params);
}
function getRecentObservations(db, limit = 20, sessionId) {
  if (sessionId) {
    return db.prepare(`
      SELECT id, type, title, detail, importance, created_at, session_id
      FROM observations WHERE session_id = ?
      ORDER BY created_at_epoch DESC LIMIT ?
    `).all(sessionId, limit);
  }
  return db.prepare(`
    SELECT id, type, title, detail, importance, created_at, session_id
    FROM observations
    ORDER BY created_at_epoch DESC LIMIT ?
  `).all(limit);
}
function getSessionSummaries(db, limit = 10) {
  return db.prepare(`
    SELECT session_id, request, completed, failed_attempts, plan_progress, created_at
    FROM session_summaries
    ORDER BY created_at_epoch DESC LIMIT ?
  `).all(limit);
}
function getSessionTimeline(db, sessionId) {
  const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
  const observations = db.prepare("SELECT * FROM observations WHERE session_id = ? ORDER BY created_at_epoch ASC").all(sessionId);
  const summary = db.prepare("SELECT * FROM session_summaries WHERE session_id = ? ORDER BY created_at_epoch DESC LIMIT 1").get(sessionId);
  const prompts = db.prepare("SELECT * FROM user_prompts WHERE session_id = ? ORDER BY prompt_number ASC").all(sessionId);
  return {
    session: session ?? null,
    observations,
    summary: summary ?? null,
    prompts
  };
}
function getFailedAttempts(db, query, limit = 20) {
  if (query) {
    return db.prepare(`
      SELECT o.id, o.title, o.detail, o.session_id, o.recurrence_count, o.created_at
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.type = 'failed_attempt'
      ORDER BY o.recurrence_count DESC, rank LIMIT ?
    `).all(sanitizeFts5Query(query), limit);
  }
  return db.prepare(`
    SELECT id, title, detail, session_id, recurrence_count, created_at
    FROM observations WHERE type = 'failed_attempt'
    ORDER BY recurrence_count DESC, created_at_epoch DESC LIMIT ?
  `).all(limit);
}
function getDecisionsAbout(db, query, limit = 20) {
  return db.prepare(`
    SELECT o.id, o.title, o.detail, o.session_id, o.created_at
    FROM observations_fts
    JOIN observations o ON observations_fts.rowid = o.id
    WHERE observations_fts MATCH ? AND o.type = 'decision'
    ORDER BY rank LIMIT ?
  `).all(sanitizeFts5Query(query), limit);
}
function armUsageCounter(db, nowEpochSec) {
  const existing = getMemoryMeta(db, USAGE_COUNTER_ARMED_KEY);
  if (existing) {
    const n = Number(existing);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const now = nowEpochSec ?? Math.floor(Date.now() / 1e3);
  setMemoryMeta(db, USAGE_COUNTER_ARMED_KEY, String(now));
  return now;
}
function usageWarmupElapsed(db, warmupDays, nowEpochSec) {
  const armed = getMemoryMeta(db, USAGE_COUNTER_ARMED_KEY);
  if (!armed) return false;
  const armedEpoch = Number(armed);
  if (!Number.isFinite(armedEpoch) || armedEpoch <= 0) return false;
  const now = nowEpochSec ?? Math.floor(Date.now() / 1e3);
  return now - armedEpoch >= warmupDays * 86400;
}
function expireOldLowValueObservations(db, opts) {
  const now = opts.nowEpochSec ?? Math.floor(Date.now() / 1e3);
  if (!usageWarmupElapsed(db, opts.usageWarmupDays, now)) return 0;
  const cutoffEpoch = now - opts.retentionDays * 86400;
  const typePlaceholders = opts.protectedTypes.length ? opts.protectedTypes.map(() => "?").join(",") : "''";
  const iso = new Date(now * 1e3).toISOString();
  const result = db.prepare(
    `UPDATE observations
          SET expired_at = ?,
              expired_at_epoch = ?,
              valid_to = ?,
              valid_to_epoch = ?
        WHERE expired_at IS NULL
          AND created_at_epoch < ?
          AND importance <= ?
          AND type NOT IN (${typePlaceholders})
          AND COALESCE(evidence, '') != ?
          -- A file-backed row mirrors a file the human still keeps on disk.
          -- Value-decay may never retire it; only the file's removal can.
          AND title NOT LIKE ?
          AND NOT EXISTS (
                SELECT 1 FROM memory_usage u
                 WHERE u.source = 'observation'
                   AND u.record_id = observations.id
                   AND u.hit_count > 0
              )
          AND NOT EXISTS (
                -- The grace period: a row demoted within the last cadence
                -- window is NOT yet expirable, so being pushed to the floor can
                -- never be immediately fatal.
                SELECT 1 FROM memory_usage u
                 WHERE u.source = 'observation'
                   AND u.record_id = observations.id
                   AND u.last_reweight_epoch IS NOT NULL
                   AND u.last_reweight_epoch > ?
              )`
  ).run(
    iso,
    now,
    iso,
    now,
    cutoffEpoch,
    opts.importanceFloor,
    ...opts.protectedTypes,
    CONSOLIDATION_LESSON_EVIDENCE,
    MEMORY_FILE_TITLE_LIKE,
    now - (opts.reweightIntervalDays ?? 1) * 86400
  );
  return result.changes;
}
function pruneOldObservations(db, opts) {
  return expireOldLowValueObservations(db, opts);
}
function recordRecallHits(db, sessionId, hits, nowEpochSec) {
  if (!hits.length) return 0;
  const now = nowEpochSec ?? Math.floor(Date.now() / 1e3);
  let recorded = 0;
  const claim = db.prepare(
    `INSERT OR IGNORE INTO memory_usage_sessions (source, record_id, session_id)
     VALUES (?, ?, ?)`
  );
  const bump = db.prepare(
    `INSERT INTO memory_usage (source, record_id, hit_count, hits_windowed, last_hit_epoch)
     VALUES (?, ?, 1, 1, ?)
     ON CONFLICT(source, record_id) DO UPDATE SET
       hit_count     = hit_count + 1,
       hits_windowed = hits_windowed + 1,
       last_hit_epoch = excluded.last_hit_epoch`
  );
  const tx = db.transaction(() => {
    for (const h of hits) {
      if (claim.run(h.source, h.id, sessionId).changes === 0) continue;
      bump.run(h.source, h.id, now);
      recorded++;
    }
  });
  tx();
  return recorded;
}
function deduplicateFailedAttempt(db, sessionId, title, detail, opts) {
  const existing = db.prepare(`
    SELECT id, recurrence_count FROM observations
    WHERE type = 'failed_attempt' AND title = ?
    ORDER BY created_at_epoch DESC LIMIT 1
  `).get(title);
  if (existing) {
    db.prepare("UPDATE observations SET recurrence_count = recurrence_count + 1, detail = COALESCE(?, detail) WHERE id = ?").run(detail, existing.id);
    return existing.id;
  }
  return addObservation(db, sessionId, "failed_attempt", title, detail, {
    ...opts,
    importance: 5
  });
}
function getSessionsByTask(db, taskId) {
  return db.prepare(`
    SELECT session_id, status, started_at, ended_at, plan_phase
    FROM sessions WHERE task_id = ?
    ORDER BY started_at_epoch DESC
    LIMIT 10000
  `).all(taskId);
}
function getCrossTaskProgress(db, taskId) {
  const sessions = db.prepare(`
    SELECT session_id FROM sessions WHERE task_id = ? LIMIT 10000
  `).all(taskId);
  const merged = {};
  for (const session of sessions) {
    const summaries = db.prepare(`
      SELECT plan_progress FROM session_summaries WHERE session_id = ? LIMIT 10000
    `).all(session.session_id);
    for (const summary of summaries) {
      try {
        const progress = JSON.parse(summary.plan_progress);
        for (const [key, value] of Object.entries(progress)) {
          if (!merged[key] || value === "complete" || value === "in_progress" && merged[key] === "pending") {
            merged[key] = value;
          }
        }
      } catch (_e) {
      }
    }
  }
  return merged;
}
function linkSessionToTask(db, sessionId, taskId) {
  db.prepare("UPDATE sessions SET task_id = ? WHERE session_id = ?").run(taskId, sessionId);
}
function addConversationTurn(db, sessionId, turnNumber, userPrompt, assistantResponse, toolCallsJson, toolCallCount, promptTokens, responseTokens) {
  const result = db.prepare(`
    INSERT INTO conversation_turns (session_id, turn_number, user_prompt, assistant_response, tool_calls_json, tool_call_count, prompt_tokens, response_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    turnNumber,
    userPrompt,
    assistantResponse ? assistantResponse.slice(0, 1e4) : null,
    toolCallsJson,
    toolCallCount,
    promptTokens,
    responseTokens
  );
  return Number(result.lastInsertRowid);
}
function addToolCallDetail(db, sessionId, turnNumber, toolName, inputSummary, inputSize, outputSize, success, filesInvolved) {
  db.prepare(`
    INSERT INTO tool_call_details (session_id, turn_number, tool_name, tool_input_summary, tool_input_size, tool_output_size, tool_success, files_involved)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    turnNumber,
    toolName,
    inputSummary ? inputSummary.slice(0, 500) : null,
    inputSize,
    outputSize,
    success ? 1 : 0,
    filesInvolved ? JSON.stringify(filesInvolved) : null
  );
}
function getLastProcessedLine(db, sessionId) {
  const row = db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(`last_processed_line:${sessionId}`);
  return row ? parseInt(row.value, 10) : 0;
}
function setLastProcessedLine(db, sessionId, lineNumber) {
  db.prepare("INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)").run(`last_processed_line:${sessionId}`, String(lineNumber));
}
function pruneOldConversationTurns(db, retentionDays = 90) {
  const cutoffEpoch = Math.floor(Date.now() / 1e3) - retentionDays * 86400;
  const turnsResult = db.prepare("DELETE FROM conversation_turns WHERE created_at_epoch < ?").run(cutoffEpoch);
  const detailsResult = db.prepare("DELETE FROM tool_call_details WHERE created_at_epoch < ?").run(cutoffEpoch);
  return { turnsDeleted: turnsResult.changes, detailsDeleted: detailsResult.changes };
}
function getConversationTurns(db, sessionId, opts) {
  let sql = "SELECT id, turn_number, user_prompt, assistant_response, tool_calls_json, tool_call_count, prompt_tokens, response_tokens, created_at FROM conversation_turns WHERE session_id = ?";
  const params = [sessionId];
  if (opts?.turnFrom !== void 0) {
    sql += " AND turn_number >= ?";
    params.push(opts.turnFrom);
  }
  if (opts?.turnTo !== void 0) {
    sql += " AND turn_number <= ?";
    params.push(opts.turnTo);
  }
  sql += " ORDER BY turn_number ASC";
  return db.prepare(sql).all(...params);
}
function searchConversationTurns(db, query, opts) {
  const limit = opts?.limit ?? 20;
  let sql = `
    SELECT ct.id, ct.session_id, ct.turn_number, ct.user_prompt, ct.tool_call_count, ct.response_tokens, ct.created_at, rank
    FROM conversation_turns_fts
    JOIN conversation_turns ct ON conversation_turns_fts.rowid = ct.id
    WHERE conversation_turns_fts MATCH ?
  `;
  const params = [sanitizeFts5Query(query)];
  if (opts?.sessionId) {
    sql += " AND ct.session_id = ?";
    params.push(opts.sessionId);
  }
  if (opts?.dateFrom) {
    sql += " AND ct.created_at >= ?";
    params.push(opts.dateFrom);
  }
  if (opts?.dateTo) {
    sql += " AND ct.created_at <= ?";
    params.push(opts.dateTo);
  }
  if (opts?.minToolCalls !== void 0) {
    sql += " AND ct.tool_call_count >= ?";
    params.push(opts.minToolCalls);
  }
  sql += " ORDER BY rank LIMIT ?";
  params.push(limit);
  return db.prepare(sql).all(...params);
}
function getToolPatterns(db, opts) {
  const groupBy = opts?.groupBy ?? "tool";
  const params = [];
  let whereClause = "";
  const conditions = [];
  if (opts?.sessionId) {
    conditions.push("session_id = ?");
    params.push(opts.sessionId);
  }
  if (opts?.toolName) {
    conditions.push("tool_name = ?");
    params.push(opts.toolName);
  }
  if (opts?.dateFrom) {
    conditions.push("created_at >= ?");
    params.push(opts.dateFrom);
  }
  if (conditions.length > 0) {
    whereClause = "WHERE " + conditions.join(" AND ");
  }
  let sql;
  switch (groupBy) {
    case "session":
      sql = `SELECT session_id, COUNT(*) as call_count, COUNT(DISTINCT tool_name) as unique_tools,
             SUM(CASE WHEN tool_success = 1 THEN 1 ELSE 0 END) as successes,
             SUM(CASE WHEN tool_success = 0 THEN 1 ELSE 0 END) as failures,
             AVG(tool_output_size) as avg_output_size
             FROM tool_call_details ${whereClause}
             GROUP BY session_id ORDER BY call_count DESC`;
      break;
    case "day":
      sql = `SELECT date(created_at) as day, COUNT(*) as call_count, COUNT(DISTINCT tool_name) as unique_tools,
             SUM(CASE WHEN tool_success = 1 THEN 1 ELSE 0 END) as successes
             FROM tool_call_details ${whereClause}
             GROUP BY date(created_at) ORDER BY day DESC`;
      break;
    default:
      sql = `SELECT tool_name, COUNT(*) as call_count,
             SUM(CASE WHEN tool_success = 1 THEN 1 ELSE 0 END) as successes,
             SUM(CASE WHEN tool_success = 0 THEN 1 ELSE 0 END) as failures,
             AVG(tool_output_size) as avg_output_size,
             AVG(tool_input_size) as avg_input_size
             FROM tool_call_details ${whereClause}
             GROUP BY tool_name ORDER BY call_count DESC`;
      break;
  }
  return db.prepare(sql).all(...params);
}
function getSessionStats(db, opts) {
  if (opts?.sessionId) {
    const turns = db.prepare("SELECT COUNT(*) as turn_count, SUM(tool_call_count) as total_tool_calls, SUM(prompt_tokens) as total_prompt_tokens, SUM(response_tokens) as total_response_tokens FROM conversation_turns WHERE session_id = ?").get(opts.sessionId);
    const toolBreakdown = db.prepare("SELECT tool_name, COUNT(*) as count FROM tool_call_details WHERE session_id = ? GROUP BY tool_name ORDER BY count DESC").all(opts.sessionId);
    const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(opts.sessionId);
    return [{
      session_id: opts.sessionId,
      status: session?.status ?? "unknown",
      started_at: session?.started_at ?? null,
      ended_at: session?.ended_at ?? null,
      ...turns,
      tool_breakdown: toolBreakdown
    }];
  }
  const limit = opts?.limit ?? 10;
  return db.prepare(`
    SELECT s.session_id, s.status, s.started_at, s.ended_at,
           COUNT(ct.id) as turn_count,
           COALESCE(SUM(ct.tool_call_count), 0) as total_tool_calls,
           COALESCE(SUM(ct.prompt_tokens), 0) as total_prompt_tokens,
           COALESCE(SUM(ct.response_tokens), 0) as total_response_tokens
    FROM sessions s
    LEFT JOIN conversation_turns ct ON s.session_id = ct.session_id
    GROUP BY s.session_id
    ORDER BY s.started_at_epoch DESC
    LIMIT ?
  `).all(limit);
}
function getObservabilityDbSize(db) {
  const turnsCount = db.prepare("SELECT COUNT(*) as c FROM conversation_turns").get().c;
  const detailsCount = db.prepare("SELECT COUNT(*) as c FROM tool_call_details").get().c;
  const obsCount = db.prepare("SELECT COUNT(*) as c FROM observations").get().c;
  const pageCount = db.pragma("page_count")[0]?.page_count ?? 0;
  const pageSize = db.pragma("page_size")[0]?.page_size ?? 4096;
  return {
    conversation_turns_count: turnsCount,
    tool_call_details_count: detailsCount,
    observations_count: obsCount,
    db_page_count: pageCount,
    db_page_size: pageSize,
    estimated_size_mb: Math.round(pageCount * pageSize / (1024 * 1024) * 100) / 100
  };
}
function addFailureClass(db, opts) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO failure_classes (name, description, diff_patterns, file_patterns, prompt_keywords, incidents, rules, scanner_checks, known_message, needs_review)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.name,
    opts.description,
    JSON.stringify(opts.diffPatterns ?? []),
    JSON.stringify(opts.filePatterns ?? []),
    JSON.stringify(opts.promptKeywords ?? []),
    JSON.stringify(opts.incidents ?? []),
    JSON.stringify(opts.rules ?? []),
    JSON.stringify(opts.scannerChecks ?? []),
    opts.knownMessage ?? "",
    opts.needsReview ? 1 : 0
  );
  return Number(result.lastInsertRowid);
}
function getFailureClasses(db) {
  const rows = db.prepare("SELECT * FROM failure_classes ORDER BY name LIMIT 10000").all();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    diff_patterns: JSON.parse(row.diff_patterns || "[]"),
    file_patterns: JSON.parse(row.file_patterns || "[]"),
    prompt_keywords: JSON.parse(row.prompt_keywords || "[]"),
    incidents: JSON.parse(row.incidents || "[]"),
    rules: JSON.parse(row.rules || "[]"),
    scanner_checks: JSON.parse(row.scanner_checks || "[]"),
    known_message: row.known_message,
    needs_review: !!row.needs_review
  }));
}
function appendIncidentToFailureClass(db, className, incidentId) {
  const row = db.prepare("SELECT incidents FROM failure_classes WHERE name = ?").get(className);
  if (!row) return;
  const incidents = JSON.parse(row.incidents || "[]");
  if (!incidents.includes(incidentId)) {
    incidents.push(incidentId);
    db.prepare("UPDATE failure_classes SET incidents = ?, updated_at = datetime('now') WHERE name = ?").run(JSON.stringify(incidents), className);
  }
}
function scoreFailureClasses(db, matchText, filePath, promptContext, weights) {
  const classes = getFailureClasses(db);
  if (classes.length === 0) return null;
  const diffWeight = weights?.diffPatternWeight ?? 3;
  const fileWeight = weights?.filePatternWeight ?? 2;
  const promptWeight = weights?.promptKeywordWeight ?? 2;
  let bestMatch = null;
  for (const fc of classes) {
    let score = 0;
    for (const pattern of fc.diff_patterns) {
      if (!pattern) continue;
      try {
        if (new RegExp(pattern, "i").test(matchText)) {
          score += diffWeight;
        }
      } catch {
        if (matchText.toLowerCase().includes(pattern.toLowerCase())) {
          score += diffWeight;
        }
      }
    }
    for (const pattern of fc.file_patterns) {
      if (!pattern) continue;
      try {
        if (new RegExp(pattern).test(filePath)) {
          score += fileWeight;
        }
      } catch {
        if (filePath.includes(pattern)) {
          score += fileWeight;
        }
      }
    }
    if (promptContext) {
      for (const keyword of fc.prompt_keywords) {
        if (!keyword) continue;
        try {
          if (new RegExp(keyword, "i").test(promptContext)) {
            score += promptWeight;
          }
        } catch {
          if (promptContext.toLowerCase().includes(keyword.toLowerCase())) {
            score += promptWeight;
          }
        }
      }
    }
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = {
        name: fc.name,
        score,
        incidentCount: fc.incidents.length,
        rules: fc.rules,
        knownMessage: fc.known_message
      };
    }
  }
  return bestMatch;
}
var MEMORY_SCHEMA_VERSION, TOOL_COST_EVENTS_RETENTION_DAYS, MAX_DRAFT_TEXT_LEN, FUNNEL_EVENT_OUTBOX_CAP, _temporalColCache, CONSOLIDATION_LESSON_EVIDENCE, MEMORY_FILE_TITLE_PREFIX, MEMORY_FILE_TITLE_LIKE, USAGE_COUNTER_ARMED_KEY;
var init_memory_db = __esm({
  "src/memory-db.ts"() {
    "use strict";
    init_db_driver();
    init_config();
    init_memory_vector();
    init_db_backup();
    init_rule_delivery();
    init_rule_candidate_store();
    init_hook_failure_signal();
    init_memory_embed_sweep();
    MEMORY_SCHEMA_VERSION = 1;
    TOOL_COST_EVENTS_RETENTION_DAYS = 90;
    MAX_DRAFT_TEXT_LEN = 16384;
    FUNNEL_EVENT_OUTBOX_CAP = 2e4;
    _temporalColCache = /* @__PURE__ */ new WeakMap();
    CONSOLIDATION_LESSON_EVIDENCE = "consolidation:session-summary";
    MEMORY_FILE_TITLE_PREFIX = "[memory-file] ";
    MEMORY_FILE_TITLE_LIKE = `${MEMORY_FILE_TITLE_PREFIX}%`;
    USAGE_COUNTER_ARMED_KEY = "usage_counter_armed_epoch";
  }
});

// src/hooks/session-end.ts
init_memory_db();
init_rule_delivery();

// src/session-archiver.ts
import { existsSync as existsSync9, readFileSync as readFileSync6, writeFileSync as writeFileSync3, mkdirSync as mkdirSync7, renameSync } from "fs";
import { resolve as resolve5, dirname as dirname8 } from "path";

// src/session-state-generator.ts
function generateCurrentMd(db, sessionId) {
  const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
  if (!session) return "# Session State\n\nNo active session found.\n";
  const observations = db.prepare(
    "SELECT * FROM observations WHERE session_id = ? ORDER BY created_at_epoch ASC LIMIT 10000"
  ).all(sessionId);
  const summary = db.prepare(
    "SELECT * FROM session_summaries WHERE session_id = ? ORDER BY created_at_epoch DESC LIMIT 1"
  ).get(sessionId);
  const prompts = db.prepare(
    "SELECT prompt_text FROM user_prompts WHERE session_id = ? ORDER BY prompt_number ASC LIMIT 1"
  ).all(sessionId);
  const date = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  const firstPrompt = prompts[0]?.prompt_text ?? "Unknown task";
  const taskSummary = firstPrompt.slice(0, 100).replace(/\n/g, " ");
  const lines = [];
  lines.push(`# Session State - ${formatDate(date)}`);
  lines.push("");
  lines.push(`**Last Updated**: ${(/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19)} (auto-generated from massu-memory)`);
  lines.push(`**Status**: ${session.status === "active" ? "IN PROGRESS" : session.status.toUpperCase()} - ${taskSummary}`);
  lines.push(`**Task**: ${taskSummary}`);
  lines.push(`**Session ID**: ${sessionId}`);
  lines.push(`**Branch**: ${session.git_branch ?? "unknown"}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  const completedObs = observations.filter(
    (o) => ["feature", "bugfix", "refactor", "file_change"].includes(o.type)
  );
  if (completedObs.length > 0 || summary) {
    lines.push("## COMPLETED WORK");
    lines.push("");
    if (summary?.completed) {
      lines.push(summary.completed);
      lines.push("");
    }
    const filesCreated = observations.filter((o) => o.type === "file_change" && o.title.startsWith("Created")).map((o) => {
      const files = safeParseJson(o.files_involved, []);
      return files[0] ?? o.title.replace("Created/wrote: ", "");
    });
    if (filesCreated.length > 0) {
      lines.push("### Files Created");
      lines.push("");
      lines.push("| File | Purpose |");
      lines.push("|------|---------|");
      for (const f of filesCreated) {
        lines.push(`| \`${f}\` | |`);
      }
      lines.push("");
    }
    const filesModified = observations.filter((o) => o.type === "file_change" && o.title.startsWith("Edited")).map((o) => {
      const files = safeParseJson(o.files_involved, []);
      return files[0] ?? o.title.replace("Edited: ", "");
    });
    if (filesModified.length > 0) {
      lines.push("### Files Modified");
      lines.push("");
      lines.push("| File | Change |");
      lines.push("|------|--------|");
      for (const f of [...new Set(filesModified)]) {
        lines.push(`| \`${f}\` | |`);
      }
      lines.push("");
    }
  }
  const decisions = observations.filter((o) => o.type === "decision");
  if (decisions.length > 0) {
    lines.push("### Key Decisions");
    lines.push("");
    for (const d of decisions) {
      lines.push(`- ${d.title}`);
    }
    lines.push("");
  }
  const failures = observations.filter((o) => o.type === "failed_attempt");
  if (failures.length > 0) {
    lines.push("## FAILED ATTEMPTS (DO NOT RETRY)");
    lines.push("");
    for (const f of failures) {
      lines.push(`- ${f.title}`);
      if (f.detail) lines.push(`  ${f.detail.slice(0, 200)}`);
    }
    lines.push("");
  }
  const vrChecks = observations.filter((o) => o.type === "vr_check");
  if (vrChecks.length > 0) {
    lines.push("## VERIFICATION EVIDENCE");
    lines.push("");
    for (const v of vrChecks) {
      lines.push(`- ${v.title}`);
    }
    lines.push("");
  }
  if (summary?.next_steps) {
    lines.push("## PENDING");
    lines.push("");
    lines.push(summary.next_steps);
    lines.push("");
  }
  if (session.plan_file) {
    lines.push("## PLAN DOCUMENT");
    lines.push("");
    lines.push(`\`${session.plan_file}\``);
    if (summary?.plan_progress) {
      const progress = safeParseJson(summary.plan_progress, {});
      const total = Object.keys(progress).length;
      const complete = Object.values(progress).filter((v) => v === "complete").length;
      if (total > 0) {
        lines.push(`- Progress: ${complete}/${total} items complete`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
function formatDate(dateStr) {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];
  const [year, month, day] = dateStr.split("-").map(Number);
  return `${months[month - 1]} ${day}, ${year}`;
}
function safeParseJson(json, fallback) {
  try {
    return JSON.parse(json);
  } catch (_e) {
    return fallback;
  }
}

// src/session-archiver.ts
init_config();
function archiveAndRegenerate(db, sessionId) {
  const resolved = getResolvedPaths();
  const currentMdPath = resolved.sessionStatePath;
  const archiveDir = resolved.sessionArchivePath;
  let archived = false;
  let archivePath;
  if (existsSync9(currentMdPath)) {
    const existingContent = readFileSync6(currentMdPath, "utf-8");
    if (existingContent.trim().length > 10) {
      const { date, slug } = extractArchiveInfo(existingContent);
      archivePath = resolve5(archiveDir, `${date}-${slug}.md`);
      if (!existsSync9(archiveDir)) {
        mkdirSync7(archiveDir, { recursive: true });
      }
      try {
        renameSync(currentMdPath, archivePath);
        archived = true;
      } catch (_e) {
        writeFileSync3(archivePath, existingContent);
        archived = true;
      }
    }
  }
  const newContent = generateCurrentMd(db, sessionId);
  const dir = dirname8(currentMdPath);
  if (!existsSync9(dir)) {
    mkdirSync7(dir, { recursive: true });
  }
  writeFileSync3(currentMdPath, newContent, "utf-8");
  return { archived, archivePath, newContent };
}
function extractArchiveInfo(content) {
  const dateMatch = content.match(/# Session State - (\w+ \d+, \d+)/);
  let date = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  if (dateMatch) {
    const parsed = new Date(dateMatch[1]);
    if (!isNaN(parsed.getTime())) {
      date = parsed.toISOString().split("T")[0];
    }
  }
  const isoMatch = content.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    date = isoMatch[1];
  }
  let slug = "session";
  const taskMatch = content.match(/\*\*Task\*\*:\s*(.+)/);
  if (taskMatch) {
    slug = taskMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  }
  if (slug === "session") {
    const statusMatch = content.match(/\*\*Status\*\*:\s*\w+\s*-\s*(.+)/);
    if (statusMatch) {
      slug = statusMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
    }
  }
  return { date, slug };
}

// src/transcript-parser.ts
import { createReadStream } from "fs";
import { createInterface } from "readline";
function parseEntry(raw) {
  const entryType = raw.type;
  if (!entryType) return null;
  const base = {
    type: ["user", "assistant", "system", "progress", "summary", "file-history-snapshot"].includes(entryType) ? entryType : "unknown",
    sessionId: raw.sessionId,
    gitBranch: raw.gitBranch,
    timestamp: raw.timestamp,
    uuid: raw.uuid
  };
  if (raw.isMeta) {
    base.isMeta = true;
  }
  if (entryType === "user" || entryType === "assistant") {
    const msgRaw = raw.message;
    if (msgRaw) {
      base.message = {
        role: msgRaw.role ?? entryType,
        content: normalizeContent(msgRaw.content)
      };
    }
  }
  if (entryType === "progress") {
    base.data = raw.data;
  }
  return base;
}
function normalizeContent(content) {
  if (!content) return [];
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.filter(
      (block) => typeof block === "object" && block !== null && "type" in block
    );
  }
  return [];
}
async function parseTranscriptFrom(filePath, startLine) {
  const entries = [];
  let lineNumber = 0;
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    lineNumber++;
    if (lineNumber <= startLine) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed);
      const entry = parseEntry(raw);
      if (entry) {
        entries.push(entry);
      }
    } catch (_e) {
      continue;
    }
  }
  return { entries, totalLines: lineNumber };
}
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// src/cloud-sync.ts
init_config();
init_memory_db();
init_rule_delivery();

// src/observation-extractor.ts
init_memory_db();
init_config();
var PRIVATE_PATTERNS = [
  /\/Users\/\w+/,
  // Absolute macOS paths
  /\/home\/\w+/,
  // Absolute Linux paths
  /[A-Z]:\\/,
  // Windows paths
  /\b(api[_-]?key|secret|token|password|credential|dsn)\b/i,
  // Secrets
  /\b(STRIPE_|SUPABASE_|SENTRY_|AWS_|DATABASE_URL)\b/,
  // Env var names
  /\.(env|pem|key|cert)\b/,
  // Sensitive file extensions
  /Bearer\s+\S+/,
  // Auth tokens
  /sk_live_|sk_test_|whsec_/
  // Stripe keys
];
function classifyVisibility(title, detail) {
  const text = `${title} ${detail ?? ""}`;
  for (const pattern of PRIVATE_PATTERNS) {
    if (pattern.test(text)) return "private";
  }
  return "public";
}

// src/cloud-sync.ts
var MAX_RETRIES = 3;
var RETRY_DELAYS = [1e3, 2e3, 4e3];
var DEFAULT_CLOUD_REQUEST_TIMEOUT_MS = 15e3;
var SYNC_DEADLINE_MS = 2e4;
var MIN_ATTEMPT_BUDGET_MS = 1e3;
async function syncToCloud(db, payload) {
  const config = getConfig();
  const cloud = config.cloud;
  if (!cloud?.enabled) {
    return { success: true, synced: { sessions: 0, observations: 0, analytics: 0, audit: 0 } };
  }
  if (!cloud.apiKey) {
    return { success: false, synced: { sessions: 0, observations: 0, analytics: 0, audit: 0 }, error: "No API key configured" };
  }
  const endpoint = cloud.endpoint;
  if (!endpoint) {
    return { success: false, synced: { sessions: 0, observations: 0, analytics: 0, audit: 0 }, error: "No sync endpoint configured" };
  }
  const filteredPayload = {};
  if (cloud.sync?.memory !== false) {
    filteredPayload.sessions = payload.sessions;
    if (payload.observations) {
      let droppedPrivate = 0;
      filteredPayload.observations = payload.observations.filter((obs) => {
        if (classifyVisibility(obs.content ?? "", obs.content ?? "") === "private") {
          droppedPrivate += 1;
          return false;
        }
        if (obs.file_path && classifyVisibility(obs.file_path, obs.file_path) === "private") {
          droppedPrivate += 1;
          return false;
        }
        return true;
      });
      if (droppedPrivate > 0) {
        process.stderr.write(
          `[massu] cloud-sync: dropped ${droppedPrivate} private observation(s) (PRIVATE_PATTERNS match)
`
        );
      }
    }
  }
  if (cloud.sync?.analytics !== false) {
    filteredPayload.analytics = payload.analytics;
  }
  if (cloud.sync?.audit !== false) {
    filteredPayload.audit = payload.audit;
  }
  if (cloud.sync?.memory !== false) {
    if (payload.rule_promotions?.length) {
      let droppedPrivatePromos = 0;
      const safePromos = payload.rule_promotions.filter((p) => {
        if (classifyVisibility(p.draft_text ?? "", p.draft_text ?? "") === "private") {
          droppedPrivatePromos += 1;
          return false;
        }
        return true;
      });
      if (droppedPrivatePromos > 0) {
        process.stderr.write(
          `[massu] cloud-sync: dropped ${droppedPrivatePromos} team rule promotion(s) (PRIVATE_PATTERNS match in draft_text)
`
        );
      }
      if (safePromos.length) filteredPayload.rule_promotions = safePromos;
    }
    if (payload.rule_revocations?.length) filteredPayload.rule_revocations = payload.rule_revocations;
    if (payload.rule_promotion_events?.length) {
      let droppedPrivateEvents = 0;
      const safeEvents = payload.rule_promotion_events.filter((e) => {
        const meta = e.metadata ? JSON.stringify(e.metadata) : "";
        if (meta && classifyVisibility(meta, meta) === "private") {
          droppedPrivateEvents += 1;
          return false;
        }
        return true;
      });
      if (droppedPrivateEvents > 0) {
        process.stderr.write(
          `[massu] cloud-sync: dropped ${droppedPrivateEvents} promotion funnel event(s) (PRIVATE_PATTERNS match in metadata)
`
        );
      }
      if (safeEvents.length) filteredPayload.rule_promotion_events = safeEvents;
    }
  }
  let lastError = "";
  const configuredTimeoutMs = cloud.requestTimeoutMs ?? DEFAULT_CLOUD_REQUEST_TIMEOUT_MS;
  const deadlineAt = Date.now() + SYNC_DEADLINE_MS;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < MIN_ATTEMPT_BUDGET_MS) {
      lastError = lastError || `sync deadline exceeded (${SYNC_DEADLINE_MS}ms)`;
      break;
    }
    const requestTimeoutMs = Math.min(configuredTimeoutMs, remainingMs);
    try {
      const response = await fetch(`${endpoint}/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${cloud.apiKey}`
        },
        body: JSON.stringify(filteredPayload),
        // P-H003: bounded request — AbortSignal.timeout fires AbortError when
        // the request stalls (DNS failure, TCP unreachable, slow server). Cleans
        // up before hook timeout kills the whole process.
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${response.statusText}`;
        if (response.status >= 400 && response.status < 500) {
          break;
        }
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        break;
      }
      const result = await response.json();
      return {
        success: true,
        // THE ONLY place this is ever set. The server received the payload and
        // answered 2xx. This — and nothing else — is a receipt, and a receipt is
        // the sole authority to delete a learned rule.
        transmitted: true,
        synced: {
          sessions: result.synced?.sessions ?? 0,
          observations: result.synced?.observations ?? 0,
          analytics: result.synced?.analytics ?? 0,
          audit: 0
        }
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        break;
      }
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
    }
  }
  try {
    enqueueSyncPayload(db, JSON.stringify(stripLearningFromPayload(payload)));
  } catch (err) {
    process.stderr.write(
      `[massu] WARNING: could not queue sync payload for retry: ${err instanceof Error ? err.message : String(err)}
`
    );
  }
  return {
    success: false,
    synced: { sessions: 0, observations: 0, analytics: 0, audit: 0 },
    error: lastError
  };
}
async function drainSyncQueue(db) {
  const config = getConfig();
  if (!config.cloud?.enabled || !config.cloud?.apiKey) return;
  const pending = dequeuePendingSync(db, 10);
  for (const item of pending) {
    try {
      const payload = JSON.parse(item.payload);
      const result = await syncToCloud(db, payload);
      if (result.success) {
        removePendingSync(db, item.id);
      } else {
        incrementRetryCount(db, item.id, result.error ?? "Unknown error");
      }
    } catch (err) {
      incrementRetryCount(db, item.id, err instanceof Error ? err.message : String(err));
    }
  }
}
function sleep(ms) {
  return new Promise((resolve8) => setTimeout(resolve8, ms));
}

// src/team-rule-sync.ts
import { existsSync as existsSync12, writeFileSync as writeFileSync6, unlinkSync as unlinkSync3, mkdirSync as mkdirSync9 } from "fs";
import { homedir as homedir6 } from "os";
import { join as join6, dirname as dirname10 } from "path";

// src/security/promotion-apply-mac.ts
import { createHmac as createHmac2, timingSafeEqual as timingSafeEqual2 } from "crypto";
import { homedir as homedir5 } from "os";

// src/memory-authorship.ts
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { readFileSync as readFileSync7, writeFileSync as writeFileSync4, existsSync as existsSync10, mkdirSync as mkdirSync8, chmodSync as chmodSync3, statSync as statSync2 } from "fs";
import { homedir as homedir4 } from "os";
import { resolve as resolve6 } from "path";
function renderKeyPath(home = homedir4()) {
  return resolve6(home, ".massu", "render-key");
}
function readRenderKey(home = homedir4()) {
  const p = renderKeyPath(home);
  try {
    if (!existsSync10(p)) return void 0;
    const raw = readFileSync7(p);
    if (raw.length !== 32) return void 0;
    return raw;
  } catch {
    return void 0;
  }
}
function ensureRenderKey(home = homedir4()) {
  const existing = readRenderKey(home);
  if (existing) return existing;
  const p = renderKeyPath(home);
  try {
    const dir = resolve6(home, ".massu");
    mkdirSync8(dir, { recursive: true, mode: 448 });
    try {
      chmodSync3(dir, 448);
    } catch {
    }
    const key = randomBytes(32);
    writeFileSync4(p, key, { mode: 384 });
    try {
      chmodSync3(p, 384);
    } catch {
    }
    return key;
  } catch {
    return void 0;
  }
}

// src/security/promotion-apply-mac.ts
var DOMAIN = "massu.promotion-apply.v1";
function canonical(f) {
  return [DOMAIN, f.origin, f.org_id, f.prompt_hash, f.destination, f.draft_text].join("\n");
}
function deriveApplyKey(renderKey) {
  return createHmac2("sha256", renderKey).update(DOMAIN, "utf8").digest();
}
function computePromotionApplyMac(fields, home = homedir5()) {
  try {
    const key = ensureRenderKey(home);
    if (!key) return null;
    return createHmac2("sha256", deriveApplyKey(key)).update(canonical(fields), "utf8").digest("hex");
  } catch {
    return null;
  }
}

// src/team-rule-sync.ts
init_config();

// src/license.ts
init_config();
init_memory_db();
import { createHash } from "crypto";

// src/security/ed25519-envelope-verifier.ts
import { createPublicKey, verify as cryptoVerify } from "crypto";
var SPKI_ED25519_PREFIX = Buffer.from([
  48,
  42,
  48,
  5,
  6,
  3,
  43,
  101,
  112,
  3,
  33,
  0
]);
function verifyEd25519SignedEnvelope(key, payload) {
  if (!key.knownFingerprints.has(key.fingerprintHex)) {
    return {
      kind: "error",
      reason: `Bundled ${key.keyLabel} pubkey fingerprint ${key.fingerprintHex} is not in the trusted allowlist. Possible build-time tamper.`
    };
  }
  const sig = payload._signature;
  const alg = payload._signature_alg;
  const payloadKeys = payload._signature_payload_keys;
  const sigPubkey = payload._signature_pubkey_fingerprint;
  if (typeof sig !== "string" || sig.length === 0) {
    return { kind: "missing_signature" };
  }
  if (alg !== "ed25519") {
    return { kind: "error", reason: `Unsupported signature algorithm: ${alg}` };
  }
  if (!Array.isArray(payloadKeys) || payloadKeys.length === 0) {
    return { kind: "error", reason: "Missing _signature_payload_keys" };
  }
  if (typeof sigPubkey === "string" && sigPubkey !== key.fingerprintHex) {
    return { kind: "unknown_pubkey", got: sigPubkey };
  }
  const canonicalObj = {};
  for (const k of payloadKeys) {
    if (typeof k !== "string") continue;
    canonicalObj[k] = payload[k];
  }
  const canonical2 = JSON.stringify(canonicalObj, [...payloadKeys].sort());
  try {
    const der = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(key.pubkeyBytes)]);
    const pubkey = createPublicKey({ key: der, format: "der", type: "spki" });
    const ok = cryptoVerify(
      null,
      Buffer.from(canonical2, "utf-8"),
      pubkey,
      Buffer.from(sig, "base64")
    );
    return ok ? { kind: "valid" } : { kind: "bad_signature" };
  } catch (err) {
    return {
      kind: "error",
      reason: `Signature verification threw: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

// src/security/license-pubkey.generated.ts
var LICENSE_PUBKEY_ED25519 = new Uint8Array([254, 188, 221, 150, 111, 252, 154, 100, 253, 247, 113, 192, 144, 224, 127, 160, 202, 111, 75, 40, 35, 169, 108, 89, 252, 250, 255, 233, 250, 120, 47, 160]);
var LICENSE_PUBKEY_FINGERPRINT_HEX = "18c0456789a70eeee28012719f04725f43f59e693f735227ff73f0475f2290e3";
var KNOWN_LICENSE_PUBKEY_FINGERPRINTS = /* @__PURE__ */ new Set([
  "18a63d64fdec9e5a368fc45feaa49bed6ced815967e582bc7b8af534f22a9475",
  "18c0456789a70eeee28012719f04725f43f59e693f735227ff73f0475f2290e3"
]);

// src/security/license-response-verifier.ts
function verifyLicenseResponse(payload) {
  return verifyEd25519SignedEnvelope(
    {
      pubkeyBytes: LICENSE_PUBKEY_ED25519,
      fingerprintHex: LICENSE_PUBKEY_FINGERPRINT_HEX,
      knownFingerprints: KNOWN_LICENSE_PUBKEY_FINGERPRINTS,
      keyLabel: "license"
    },
    payload
  );
}
function isLicenseSignatureRequired() {
  return process.env.MASSU_REQUIRE_SIGNED_LICENSE !== "false";
}

// src/license.ts
var _warnedLicenseSig = false;
function warnLicenseSigOnce(reason) {
  if (_warnedLicenseSig) return;
  _warnedLicenseSig = true;
  process.stderr.write(
    `[massu] WARNING: license-validate response is unsigned or signature invalid (${reason}). Acceptance permitted under transition mode. Operator: provision Supabase Edge Function LICENSE_RESPONSE_SIGNING_PRIVATE_KEY_B64 then set MASSU_REQUIRE_SIGNED_LICENSE=true to enforce strict mode.
`
  );
}
var TIER_LEVELS = {
  free: 0,
  pro: 1,
  team: 2,
  enterprise: 3
};
function tierLevel(tier) {
  return TIER_LEVELS[tier] ?? 0;
}
var PLAN_TO_TIER_MAP = {
  free: "free",
  cloud_pro: "pro",
  cloud_team: "team",
  cloud_enterprise: "enterprise"
};
var IN_MEMORY_CACHE_TTL_MS = 15 * 60 * 1e3;
var GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1e3;
function readTrustedCache(cached) {
  if (!cached.signed_payload_json) {
    if (isLicenseSignatureRequired()) return null;
    warnLicenseSigOnce("cache_unsigned_transition");
    return {
      tier: cached.tier,
      validUntil: cached.valid_until,
      features: JSON.parse(cached.features || "[]")
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(cached.signed_payload_json);
  } catch {
    return null;
  }
  const result = verifyLicenseResponse(parsed);
  if (result.kind !== "valid") return null;
  const verifiedPlan = typeof parsed.plan === "string" ? parsed.plan : null;
  const verifiedTierField = typeof parsed.tier === "string" ? parsed.tier : null;
  const tier = verifiedPlan ? PLAN_TO_TIER_MAP[verifiedPlan] ?? "free" : verifiedTierField ?? "free";
  const validUntil = typeof parsed.validUntil === "string" ? parsed.validUntil : "";
  const features = Array.isArray(parsed.features) ? parsed.features : [];
  const orgId = typeof parsed.orgId === "string" && parsed.orgId.length > 0 ? parsed.orgId : void 0;
  return { tier, validUntil, features, orgId };
}
function getCachedTierReadOnly(memDb) {
  const config = getConfig();
  const apiKey = config.cloud?.apiKey;
  if (!apiKey) return "free";
  const ownsDb = !memDb;
  const db = memDb ?? getMemoryDb();
  try {
    const keyHash = createHash("sha256").update(apiKey).digest("hex");
    const cached = db.prepare(
      "SELECT tier, valid_until, last_validated, features, signed_payload_json FROM license_cache WHERE api_key_hash = ?"
    ).get(keyHash);
    if (!cached) return "free";
    const trusted = readTrustedCache(cached);
    if (!trusted) return "free";
    const lastValidated = new Date(cached.last_validated);
    const sevenDaysAgo = new Date(Date.now() - GRACE_PERIOD_MS);
    if (!(lastValidated > sevenDaysAgo)) return "free";
    return trusted.tier;
  } catch {
    return "free";
  } finally {
    if (ownsDb) {
      try {
        db.close();
      } catch {
      }
    }
  }
}
function getCachedOrgId(memDb) {
  const config = getConfig();
  const apiKey = config.cloud?.apiKey;
  if (!apiKey) return null;
  const ownsDb = !memDb;
  const db = memDb ?? getMemoryDb();
  try {
    const keyHash = createHash("sha256").update(apiKey).digest("hex");
    const cached = db.prepare(
      "SELECT tier, valid_until, last_validated, features, signed_payload_json FROM license_cache WHERE api_key_hash = ?"
    ).get(keyHash);
    if (!cached) return null;
    const trusted = readTrustedCache(cached);
    if (!trusted) return null;
    const lastValidated = new Date(cached.last_validated);
    const sevenDaysAgo = new Date(Date.now() - GRACE_PERIOD_MS);
    if (!(lastValidated > sevenDaysAgo)) return null;
    return trusted.orgId ?? null;
  } catch {
    return null;
  } finally {
    if (ownsDb) {
      try {
        db.close();
      } catch {
      }
    }
  }
}

// src/auto-learning-entitlement.ts
var AUTO_LEARNING_MIN_TIER = "pro";
function entitledForAutoLearning(tier) {
  return tierLevel(tier) >= tierLevel(AUTO_LEARNING_MIN_TIER);
}
var TEAM_SHARED_PROMOTION_MIN_TIER = "team";
function entitledForTeamSharedPromotion(tier) {
  return tierLevel(tier) >= tierLevel(TEAM_SHARED_PROMOTION_MIN_TIER);
}
var CROSS_REPO_SURFACING_MIN_TIER = "free";
function entitledForCrossRepoSurfacing(tier) {
  return tierLevel(tier) >= tierLevel(CROSS_REPO_SURFACING_MIN_TIER);
}

// src/security/promotion-pubkey.generated.ts
var PROMOTION_PUBKEY_ED25519 = new Uint8Array([107, 161, 33, 17, 189, 44, 193, 128, 252, 155, 188, 236, 100, 163, 23, 146, 219, 155, 216, 139, 134, 72, 211, 182, 151, 122, 209, 151, 135, 65, 167, 26]);
var PROMOTION_PUBKEY_FINGERPRINT_HEX = "b14e2a73e23c02891e976ec161d339da6c930266c0202828d3187a3bd6e5d83f";
var KNOWN_PROMOTION_PUBKEY_FINGERPRINTS = /* @__PURE__ */ new Set([
  "b14e2a73e23c02891e976ec161d339da6c930266c0202828d3187a3bd6e5d83f"
]);

// src/security/promotion-envelope-verifier.ts
function verifyPromotionEnvelope(payload) {
  return verifyEd25519SignedEnvelope(
    {
      pubkeyBytes: PROMOTION_PUBKEY_ED25519,
      fingerprintHex: PROMOTION_PUBKEY_FINGERPRINT_HEX,
      knownFingerprints: KNOWN_PROMOTION_PUBKEY_FINGERPRINTS,
      keyLabel: "promotion"
    },
    payload
  );
}

// src/lib/safe-write.ts
import {
  writeFileSync as writeFileSync5,
  renameSync as renameSync2,
  openSync as openSync2,
  fsyncSync as fsyncSync2,
  closeSync as closeSync2,
  existsSync as existsSync11,
  realpathSync,
  unlinkSync as unlinkSync2,
  accessSync as accessSync2,
  statSync as statSync3,
  chmodSync as chmodSync4,
  constants
} from "fs";
import { dirname as dirname9, resolve as resolve7, relative, isAbsolute, basename as basename3, sep } from "path";
var PathEscapeError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PathEscapeError";
  }
};
var RESERVED_DEVICE_NAMES = /* @__PURE__ */ new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);
function assertContainedIn(rootDir, candidate, opts = {}) {
  if (candidate.includes("\0")) {
    throw new PathEscapeError("path contains a NUL byte");
  }
  const root = resolve7(rootDir);
  const abs = resolve7(root, candidate);
  if (!opts.allowNested) {
    const rel = relative(root, abs);
    if (rel.includes(sep)) {
      throw new PathEscapeError(`path must be a plain basename inside ${root}: ${candidate}`);
    }
  }
  const base = basename3(abs);
  const stem = base.replace(/\.[^.]*$/, "").toLowerCase();
  if (RESERVED_DEVICE_NAMES.has(stem)) {
    throw new PathEscapeError(`reserved device name: ${base}`);
  }
  if (!isContainedIn(root, abs)) {
    throw new PathEscapeError(`path escapes ${root}: ${candidate}`);
  }
  return abs;
}
function isContainedIn(rootDir, candidate, opts = {}) {
  if (candidate.includes("\0")) return false;
  const root = resolve7(rootDir);
  const abs = resolve7(root, candidate);
  const rel = relative(root, abs);
  if (rel === "" && !opts.allowRoot) return false;
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  let probe = abs;
  while (!existsSync11(probe) && probe.length > 1) {
    const parent = dirname9(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let realRoot;
  let realProbe;
  try {
    realRoot = realpathSync(root);
    realProbe = realpathSync(probe);
  } catch {
    return true;
  }
  const realRel = relative(realRoot, realProbe);
  if (realRel === "") return true;
  return !realRel.startsWith("..") && !isAbsolute(realRel);
}
function atomicWriteFileSync(destPath, contents) {
  const dir = dirname9(destPath);
  const tmp = resolve7(dir, `.${basename3(destPath)}.massu-tmp-${process.pid}`);
  let destMode;
  if (existsSync11(destPath)) {
    accessSync2(destPath, constants.W_OK);
    destMode = statSync3(destPath).mode & 511;
  }
  let fd;
  try {
    writeFileSync5(tmp, contents, "utf-8");
    if (destMode !== void 0) chmodSync4(tmp, destMode);
    fd = openSync2(tmp, "r+");
    fsyncSync2(fd);
    closeSync2(fd);
    fd = void 0;
    renameSync2(tmp, destPath);
  } catch (err) {
    if (fd !== void 0) {
      try {
        closeSync2(fd);
      } catch {
      }
    }
    try {
      if (existsSync11(tmp)) unlinkSync2(tmp);
    } catch {
    }
    throw err;
  }
}
var SLUG_ALLOWED = /^[a-z0-9_]+$/;
function deriveSlug(input) {
  const cleaned = input.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 60) || "rule_candidate";
}

// src/memory-index-region.ts
init_fileLock();

// src/rule-candidate-applier.ts
init_config();
init_memory_path();

// src/audit-trail.ts
init_config();

// src/rule-candidate-applier.ts
init_memory_db();

// src/memory-origin.ts
var LOCAL_ORIGIN = "local";
function isLocalOrigin(o) {
  return o === LOCAL_ORIGIN;
}

// src/rule-candidate-funnel.ts
init_memory_db();

// src/rule-candidate-applier.ts
init_rule_candidate_store();

// src/rule-candidate-hardened.ts
var TEAM_HARDENED_SHAREABLE_DESTINATIONS = [
  "pattern-scanner",
  "custom-destination"
];
function isHardenedShareableDestination(destination) {
  return TEAM_HARDENED_SHAREABLE_DESTINATIONS.includes(destination);
}

// src/rule-candidate-applier.ts
var TEAM_SHAREABLE_DESTINATIONS = [
  "corrections-md",
  "claude-md-cr"
];
function isTeamShareableDestination(destination) {
  return TEAM_SHAREABLE_DESTINATIONS.includes(destination);
}

// src/team-knowledge.ts
init_config();
function shareObservation(db, developerId, project, observationType, summary, opts) {
  const result = db.prepare(`
    INSERT INTO shared_observations
    (original_id, developer_id, project, observation_type, summary, file_path, module, severity, is_shared, shared_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, datetime('now'))
  `).run(
    opts?.originalId ?? null,
    developerId,
    project,
    observationType,
    summary,
    opts?.filePath ?? null,
    opts?.module ?? null,
    opts?.severity ?? 3
  );
  return Number(result.lastInsertRowid);
}

// src/team-rule-sync.ts
init_memory_db();
var CURSOR_KEY = "team_promotions_cursor";
var DEFAULT_TIMEOUT_MS = 2e3;
var PROMPT_HASH_RE = /^[0-9a-f]{16}$/;
var ZERO = {
  pulled: 0,
  materialized: 0,
  skipped: 0,
  dropped_unverified: 0,
  dropped_nonshareable: 0,
  revoked_handled: 0
};
async function pullTeamPromotions(db, opts = {}) {
  const config = getConfig();
  const cloud = config.cloud;
  const projectRoot = opts.projectRoot ?? getProjectRoot();
  const tier = opts.tier ?? getCachedTierReadOnly(db);
  if (!entitledForTeamSharedPromotion(tier)) return { ...ZERO };
  const endpoint = opts.endpoint ?? cloud?.endpoint;
  const apiKey = opts.apiKey ?? cloud?.apiKey;
  if (!endpoint || !apiKey) return { ...ZERO };
  const ownOrgId = opts.orgId !== void 0 ? opts.orgId : getCachedOrgId(db);
  const since = parseCursor(getMemoryMeta(db, CURSOR_KEY));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? cloud?.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  let envelope;
  try {
    const res = await fetchImpl(`${endpoint}/promoted-rules?since=${since}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return failSync(db, `http_${res.status}`);
    envelope = await res.json();
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network";
    return failSync(db, reason);
  }
  const verdict = verifyPromotionEnvelope(envelope);
  if (verdict.kind !== "valid") {
    const result2 = { ...ZERO, dropped_unverified: countUntrusted(envelope) };
    emitDropTelemetry(db, "team_promotion_envelope_dropped", { reason: verdict.kind });
    return result2;
  }
  const signedKeys = Array.isArray(envelope._signature_payload_keys) ? envelope._signature_payload_keys : [];
  if (!signedKeys.includes("orgId") || !signedKeys.includes("promotions_json")) {
    const result2 = { ...ZERO, dropped_unverified: countUntrusted(envelope) };
    emitDropTelemetry(db, "team_promotion_unsigned_field", {
      orgId_signed: signedKeys.includes("orgId"),
      promotions_json_signed: signedKeys.includes("promotions_json")
    });
    return result2;
  }
  const signedOrgId = typeof envelope.orgId === "string" ? envelope.orgId : null;
  if (!signedOrgId || !ownOrgId || signedOrgId !== ownOrgId) {
    const result2 = { ...ZERO, dropped_unverified: countUntrusted(envelope) };
    emitDropTelemetry(db, "team_promotion_org_mismatch", {
      signed_org_present: !!signedOrgId,
      own_org_present: !!ownOrgId
    });
    return result2;
  }
  const promotions = parsePromotions(envelope.promotions_json);
  const result = { ...ZERO };
  let maxSeq = since;
  for (const p of promotions) {
    if (!isValidWirePromotion(p)) continue;
    result.pulled += 1;
    if (typeof p.seq === "number" && p.seq > maxSeq) maxSeq = p.seq;
    const hardenedMaterialize = isHardenedShareableDestination(p.destination) && p.hardened === true;
    if (!isTeamShareableDestination(p.destination) && !hardenedMaterialize) {
      result.dropped_nonshareable += 1;
      continue;
    }
    const candidatePath = sidecarPath(projectRoot, p.prompt_hash);
    if (p.revoked_at) {
      handleRevocation(db, projectRoot, candidatePath, p.prompt_hash);
      result.revoked_handled += 1;
      continue;
    }
    if (existsSync12(candidatePath) || alreadyApplied(db, p.prompt_hash)) {
      result.skipped += 1;
      continue;
    }
    materializeCandidate(db, projectRoot, candidatePath, p, signedOrgId, opts.home ?? homedir6());
    result.materialized += 1;
  }
  const serverCursor = typeof envelope.cursor === "number" ? envelope.cursor : 0;
  const nextCursor = Math.max(since, maxSeq, serverCursor);
  if (nextCursor > since) setMemoryMeta(db, CURSOR_KEY, String(nextCursor));
  return result;
}
function parseCursor(raw) {
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
function parsePromotions(json) {
  if (typeof json !== "string") return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function countUntrusted(envelope) {
  const arr = parsePromotions(envelope.promotions_json);
  return arr.length > 0 ? arr.length : 1;
}
function isValidWirePromotion(p) {
  if (!p || typeof p !== "object") return false;
  const r = p;
  return typeof r.prompt_hash === "string" && PROMPT_HASH_RE.test(r.prompt_hash) && typeof r.destination === "string" && typeof r.draft_text === "string" && typeof r.promoted_by === "string" && typeof r.promoted_at === "string";
}
function sidecarPath(projectRoot, promptHash) {
  return join6(projectRoot, ".massu", "rule-candidates", `${promptHash}.json`);
}
function alreadyApplied(db, promptHash) {
  try {
    const row = db.prepare(
      `SELECT 1 FROM audit_log WHERE event_type = 'rule_promoted'
           AND json_extract(metadata, '$.prompt_hash') = ? LIMIT 1`
    ).get(promptHash);
    return !!row;
  } catch {
    return false;
  }
}
function handleRevocation(db, projectRoot, candidatePath, promptHash) {
  if (existsSync12(candidatePath)) {
    try {
      unlinkSync3(candidatePath);
    } catch {
    }
    return;
  }
  if (alreadyApplied(db, promptHash)) {
    process.stderr.write(
      `[massu] team rule ${promptHash} was revoked by your org \u2014 consider reverting it.
`
    );
  }
}
function materializeCandidate(db, projectRoot, candidatePath, p, orgId, home) {
  const promptText = p.draft_text.replace(/\n+/g, " ").slice(0, 200) || `team rule ${p.prompt_hash}`;
  const applyMac = computePromotionApplyMac(
    { origin: "team", org_id: orgId, prompt_hash: p.prompt_hash, destination: p.destination, draft_text: p.draft_text },
    home
  );
  const sidecar = {
    // Standard RuleCandidatePayload fields (so `/massu-rule approve` → readCandidate
    // → validateCandidatePayload passes), synthesized from the promotion.
    prompt: promptText,
    prompt_hash: p.prompt_hash,
    score: clampScore(p.score),
    signals: sanitizeSignals(p.signals),
    prior_turn_files: [],
    timestamp: p.promoted_at,
    session_id: `team:${p.promoted_by}`,
    // Provenance (PB-004): the applier's team-origin gate keys on this. PA3-005:
    // a hardened materialization sets `hardened: true` so the applier's hardened
    // apply-gate (PA3-004) engages. `review_attestation` is intentionally NOT
    // copied from the publisher here — the RECEIVER's `/massu-rule review` records
    // ITS OWN two-operator + render-only ack into provenance.review_attestation
    // before apply; until then the gate refuses (hardened-PENDING).
    provenance: {
      origin: "team",
      org_id: orgId,
      promoted_by: p.promoted_by,
      promoted_at: p.promoted_at,
      signature_verified: true,
      ...applyMac ? { apply_mac: applyMac } : {},
      ...p.hardened === true ? { hardened: true } : {}
    },
    // Extra fields the `/massu-rule approve` flow reads to drive the apply (the
    // publisher already decided destination + body). validateCandidatePayload
    // ignores unknown keys. `publisher_review_attestation` is retained for the
    // receiver's review UI (display only — never the apply-gate authority).
    destination: p.destination,
    draft_text: p.draft_text,
    ...p.review_attestation !== void 0 ? { publisher_review_attestation: p.review_attestation } : {}
  };
  const dir = dirname10(candidatePath);
  if (!existsSync12(dir)) mkdirSync9(dir, { recursive: true });
  writeFileSync6(candidatePath, JSON.stringify(sidecar, null, 2), "utf-8");
  try {
    shareObservation(db, p.promoted_by, getProjectName(), "rule_promotion", promptText, {
      filePath: void 0,
      module: p.destination
    });
  } catch {
  }
}
function clampScore(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return 0;
  return Math.max(-200, Math.min(200, score));
}
function sanitizeSignals(signals) {
  if (!Array.isArray(signals)) return [];
  const out = [];
  for (const s of signals) {
    if (!s || typeof s !== "object") continue;
    const sig = s;
    out.push({
      name: typeof sig.name === "string" ? sig.name : "unknown",
      baseWeight: typeof sig.baseWeight === "number" ? sig.baseWeight : 0,
      applied: typeof sig.applied === "number" ? sig.applied : 0,
      ...typeof sig.evidence === "string" ? { evidence: sig.evidence } : {}
    });
  }
  return out;
}
function getProjectName() {
  try {
    return getConfig().project?.name ?? "massu";
  } catch {
    return "massu";
  }
}
function emitDropTelemetry(db, eventType, data) {
  recordTelemetry(db, eventType, data);
  process.stderr.write(
    `[massu] team-shared promotion pull: dropped envelope (${eventType}). A signed/org-matched response is required \u2014 see massu.ai for details.
`
  );
}
function failSync(db, reason) {
  recordTelemetry(db, "team_promotion_sync_failed", { reason });
  process.stderr.write(
    `[massu] team-shared promotion pull FAILED (${reason}). This is NOT "nothing to sync" \u2014 the cloud was unreachable or rejected the request; promotions were NOT refreshed this run.
`
  );
  return { ...ZERO, sync_error: reason };
}

// src/shared-memory-sync.ts
init_config();
import { homedir as homedir10 } from "os";

// src/memory-repo-identity.ts
init_config();
init_memory_db();
import { randomUUID as randomUUID2 } from "crypto";
var REPO_ID_META_KEY = "repo_id";
var SHARED_PIN_META_PREFIX = "shared_pin:";
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function getRepoId(db) {
  const v = getMemoryMeta(db, REPO_ID_META_KEY);
  return v && UUID_RE.test(v) ? v : null;
}
function mintRepoId(db) {
  const existing = getRepoId(db);
  if (existing) return existing;
  const id = randomUUID2();
  setMemoryMeta(db, REPO_ID_META_KEY, id);
  return id;
}
function deriveRepoLabel(projectName) {
  if (!projectName || !projectName.trim()) return "repo";
  const slug = deriveSlug(projectName);
  return slug && SLUG_ALLOWED.test(slug) ? slug : "repo";
}
function getRepoLabel() {
  return deriveRepoLabel(getConfig().project.name);
}
function getSharedPin(db, originRepoId) {
  return getMemoryMeta(db, SHARED_PIN_META_PREFIX + originRepoId);
}
function tofuPinSharedFingerprint(db, originRepoId, fingerprint) {
  const existing = getSharedPin(db, originRepoId);
  if (existing) return existing;
  setMemoryMeta(db, SHARED_PIN_META_PREFIX + originRepoId, fingerprint);
  return fingerprint;
}

// src/memory-repos-registry.ts
import {
  chmodSync as chmodSync5,
  existsSync as existsSync13,
  mkdirSync as mkdirSync10,
  readFileSync as readFileSync9,
  writeFileSync as writeFileSync7
} from "fs";
import { homedir as homedir7 } from "os";
import { dirname as dirname11, join as join7 } from "path";
var REPOS_REGISTRY_VERSION = 1;
function reposRegistryPath(home = homedir7()) {
  return join7(home, ".massu", "repos.json");
}
function emptyRegistry() {
  return { version: REPOS_REGISTRY_VERSION, repos: [] };
}
function readReposRegistry(home = homedir7()) {
  const p = reposRegistryPath(home);
  if (!existsSync13(p)) return emptyRegistry();
  try {
    const parsed = JSON.parse(readFileSync9(p, "utf-8"));
    if (!parsed || typeof parsed !== "object") return emptyRegistry();
    const r = parsed;
    if (!Array.isArray(r.repos)) return emptyRegistry();
    const repos = r.repos.filter(
      (e) => !!e && typeof e === "object" && typeof e.repo_id === "string" && typeof e.label === "string"
    );
    return { version: typeof r.version === "number" ? r.version : REPOS_REGISTRY_VERSION, repos };
  } catch {
    return emptyRegistry();
  }
}
function findRepoByLabel(home, label) {
  return readReposRegistry(home).repos.find((e) => e.label === label) ?? null;
}
function upsertRepoRegistration(entry, home = homedir7()) {
  const registry = readReposRegistry(home);
  const next = registry.repos.filter((e) => e.repo_id !== entry.repo_id);
  next.push(entry);
  const out = { version: REPOS_REGISTRY_VERSION, repos: next };
  const p = reposRegistryPath(home);
  mkdirSync10(dirname11(p), { recursive: true, mode: 448 });
  writeFileSync7(p, JSON.stringify(out, null, 2), { mode: 384 });
  chmodSync5(p, 384);
}

// src/security/local-share-verifier.ts
import { homedir as homedir9 } from "os";

// src/security/local-share-signer.ts
import {
  chmodSync as chmodSync6,
  existsSync as existsSync14,
  mkdirSync as mkdirSync11,
  readFileSync as readFileSync10,
  writeFileSync as writeFileSync8
} from "fs";
import { homedir as homedir8 } from "os";
import { join as join8 } from "path";
import {
  createHash as createHash3,
  createPrivateKey,
  createPublicKey as createPublicKey2,
  generateKeyPairSync,
  sign as cryptoSign
} from "crypto";

// src/shared-memory-envelope.ts
import { createHash as createHash2 } from "crypto";
var SHARED_MEMORY_KIND = "massu.shared-memory.v1";
var SHARED_MEMORY_SIGNATURE_PAYLOAD_KEYS = [
  "issued_at",
  "kind",
  "origin_repo_id",
  "origin_repo_label",
  "records_json",
  "revokes_json",
  "seq"
];
function canonicalizeSharedMemoryEnvelope(body) {
  const keys = SHARED_MEMORY_SIGNATURE_PAYLOAD_KEYS;
  const canonicalObj = {};
  for (const k of keys) {
    canonicalObj[k] = body[k];
  }
  return JSON.stringify(canonicalObj, [...keys].sort());
}
function hashSharedMemoryRecord(record) {
  const canonical2 = JSON.stringify({
    created_at_epoch: record.created_at_epoch,
    detail: record.detail,
    importance: record.importance,
    superseded_by_hash: record.superseded_by_hash,
    title: record.title,
    type: record.type
  });
  return createHash2("sha256").update(canonical2, "utf-8").digest("hex");
}

// src/security/local-share-signer.ts
function localShareKeyDir(home = homedir8()) {
  return join8(home, ".massu", "keys");
}
function localSharePrivKeyPath(home = homedir8()) {
  return join8(localShareKeyDir(home), "local-share.key");
}
function localSharePubKeyPath(home = homedir8()) {
  return join8(localShareKeyDir(home), "local-share.pub");
}
var SPKI_ED25519_PREFIX_LEN = 12;
function ensureLocalShareKeypair(home = homedir8()) {
  const privPath = localSharePrivKeyPath(home);
  if (existsSync14(privPath)) return;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ format: "pem", type: "pkcs8" });
  const pubPem = publicKey.export({ format: "pem", type: "spki" });
  mkdirSync11(localShareKeyDir(home), { recursive: true, mode: 448 });
  writeFileSync8(privPath, privPem, { mode: 384 });
  chmodSync6(privPath, 384);
  writeFileSync8(localSharePubKeyPath(home), pubPem, { mode: 420 });
}
function readLocalSharePublicKeyRaw(home = homedir8()) {
  const pubPem = readFileSync10(localSharePubKeyPath(home), "utf-8");
  const der = createPublicKey2(pubPem).export({ format: "der", type: "spki" });
  return Uint8Array.from(der.subarray(SPKI_ED25519_PREFIX_LEN));
}
function localSharePubkeyFingerprint(home = homedir8()) {
  return createHash3("sha256").update(Buffer.from(readLocalSharePublicKeyRaw(home))).digest("hex");
}
function signSharedMemoryEnvelope(body, home = homedir8()) {
  ensureLocalShareKeypair(home);
  const privPem = readFileSync10(localSharePrivKeyPath(home), "utf-8");
  const privKey = createPrivateKey(privPem);
  const canonical2 = canonicalizeSharedMemoryEnvelope(body);
  const signature = cryptoSign(null, Buffer.from(canonical2, "utf-8"), privKey).toString("base64");
  return {
    ...body,
    _signature: signature,
    _signature_alg: "ed25519",
    _signature_payload_keys: SHARED_MEMORY_SIGNATURE_PAYLOAD_KEYS,
    _signature_pubkey_fingerprint: localSharePubkeyFingerprint(home)
  };
}

// src/security/local-share-verifier.ts
function verifyLocalShareEnvelope(envelope, pinnedFingerprint, home = homedir9()) {
  let key;
  try {
    const pubkeyBytes = readLocalSharePublicKeyRaw(home);
    key = {
      pubkeyBytes,
      // The fingerprint of the key we are ABOUT to verify with (the on-disk key).
      fingerprintHex: localSharePubkeyFingerprint(home),
      // The trusted set comes from the PIN — a different artifact than the key.
      // If the on-disk key was swapped, fingerprintHex ∉ this set → the core's
      // self-check fails → hard drop. This Set is deliberately NOT built from
      // `fingerprintHex`/`pubkeyBytes` (that would be vacuous — defect D4).
      knownFingerprints: /* @__PURE__ */ new Set([pinnedFingerprint]),
      keyLabel: "local-share"
    };
  } catch (err) {
    return {
      kind: "error",
      reason: `local-share pubkey unavailable: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  return verifyEd25519SignedEnvelope(key, envelope);
}

// src/shared-memory-sync.ts
init_memory_db();

// src/shared-memory-audit.ts
function latestSessionId(db) {
  try {
    const row = db.prepare(`SELECT session_id FROM sessions ORDER BY started_at_epoch DESC LIMIT 1`).get();
    return row?.session_id ?? null;
  } catch {
    return null;
  }
}
function writeSharedAudit(db, eventType, evidence, metadata, actor = "hook") {
  const sessionId = latestSessionId(db);
  if (!sessionId) return;
  try {
    db.prepare(
      `INSERT INTO audit_log (session_id, event_type, actor, evidence, metadata)
       VALUES (?, ?, ?, ?, ?)`
    ).run(sessionId, eventType, actor, evidence, JSON.stringify(metadata));
  } catch {
  }
}

// src/shared-memory-sync.ts
var REPO_ID_RE = /^[0-9a-f-]{36}$/;
var SHARED_CURSOR_PREFIX = "shared_cursor:";
var ZERO_IMPORT = { imported: 0, dropped: 0, revoked: 0, skipped: 0 };
async function importSharedMemories(db, transport, opts = {}) {
  const home = opts.home ?? homedir10();
  const nowEpoch = opts.nowEpoch ?? Math.floor(Date.now() / 1e3);
  const config = getConfig();
  const tier = opts.tier ?? getCachedTierReadOnly(db);
  if (!entitledForCrossRepoSurfacing(tier)) return { ...ZERO_IMPORT };
  const subscribe = opts.subscribe ?? config.memory?.share?.subscribe ?? [];
  if (!Array.isArray(subscribe) || subscribe.length === 0) return { ...ZERO_IMPORT };
  const ownRepoId = getRepoId(db);
  const result = { ...ZERO_IMPORT };
  for (const subscribedLabel of subscribe) {
    const entry = findRepoByLabel(home, subscribedLabel);
    if (!entry || !REPO_ID_RE.test(entry.repo_id)) continue;
    const originRepoId = entry.repo_id;
    if (ownRepoId && originRepoId === ownRepoId) continue;
    const pinned = getSharedPin(db, originRepoId) ?? tofuPinSharedFingerprint(db, originRepoId, entry.pubkey_fingerprint);
    const cursorKey = SHARED_CURSOR_PREFIX + originRepoId;
    const since = parseCursor2(getMemoryMeta(db, cursorKey));
    let envelopes;
    try {
      envelopes = await transport.fetchSince(originRepoId, since);
    } catch {
      continue;
    }
    let maxSeq = since;
    const advancePast = (env) => {
      if (typeof env.seq === "number" && env.seq > maxSeq) maxSeq = env.seq;
    };
    for (const env of envelopes) {
      const verdict = verifyLocalShareEnvelope(env, pinned, home);
      if (verdict.kind !== "valid") {
        result.dropped += 1;
        drop(db, "bad_signature", { kind: verdict.kind, origin: originRepoId });
        if (verdict.kind === "bad_signature") advancePast(env);
        continue;
      }
      if (!hasSignedLoadBearingKeys(env)) {
        result.dropped += 1;
        drop(db, "unsigned_field", { origin: originRepoId });
        advancePast(env);
        continue;
      }
      if (env.origin_repo_id !== originRepoId) {
        result.dropped += 1;
        drop(db, "origin_mismatch", { expected: originRepoId, got: env.origin_repo_id });
        advancePast(env);
        continue;
      }
      if (ownRepoId && env.origin_repo_id === ownRepoId) {
        result.dropped += 1;
        advancePast(env);
        continue;
      }
      advancePast(env);
      for (const revokedHash of parseStringArray(env.revokes_json)) {
        if (applyRevocation(db, revokedHash, nowEpoch)) result.revoked += 1;
      }
      const originLabel = deriveRepoLabel(entry.label);
      for (const rec of parseRecords(env.records_json)) {
        if (!isWellFormedRecord(rec)) {
          result.dropped += 1;
          drop(db, "malformed_record", { origin: originRepoId });
          continue;
        }
        const computed = hashSharedMemoryRecord(stripHash(rec));
        if (computed !== rec.record_hash) {
          result.dropped += 1;
          drop(db, "record_hash_mismatch", { origin: originRepoId });
          continue;
        }
        if (pendingExists(db, rec.record_hash)) {
          result.skipped += 1;
          continue;
        }
        insertPending(db, rec, env, originRepoId, originLabel, nowEpoch);
        result.imported += 1;
        writeSharedAudit(db, "shared_memory_imported", `pending from ${originLabel}`, {
          record_hash: rec.record_hash,
          origin_repo_id: originRepoId
        });
      }
    }
    if (maxSeq > since) setMemoryMeta(db, cursorKey, String(maxSeq));
  }
  return result;
}
var SIGNED_LOAD_BEARING_KEYS = ["origin_repo_id", "records_json", "revokes_json"];
function hasSignedLoadBearingKeys(env) {
  const signed = Array.isArray(env._signature_payload_keys) ? env._signature_payload_keys : [];
  return SIGNED_LOAD_BEARING_KEYS.every((k) => signed.includes(k));
}
function parseCursor2(raw) {
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
function parseStringArray(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function parseRecords(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function isWellFormedRecord(r) {
  if (!r || typeof r !== "object") return false;
  const o = r;
  return typeof o.record_hash === "string" && typeof o.type === "string" && typeof o.title === "string" && typeof o.detail === "string" && typeof o.importance === "number" && typeof o.created_at_epoch === "number" && (o.superseded_by_hash === null || typeof o.superseded_by_hash === "string");
}
function stripHash(r) {
  return {
    type: r.type,
    title: r.title,
    detail: r.detail,
    importance: r.importance,
    created_at_epoch: r.created_at_epoch,
    superseded_by_hash: r.superseded_by_hash
  };
}
function pendingExists(db, recordHash) {
  return !!db.prepare(`SELECT 1 FROM shared_memory_pending WHERE record_hash = ? LIMIT 1`).get(recordHash);
}
function loadPending(db, recordHash) {
  return db.prepare(
    `SELECT id, record_hash, origin_repo_id, origin_repo_label, envelope_raw, record_json,
                accepted_at_epoch, refused_at_epoch, expired_at_epoch
           FROM shared_memory_pending WHERE record_hash = ? LIMIT 1`
  ).get(recordHash) ?? null;
}
function insertPending(db, rec, env, originRepoId, originLabel, nowEpoch) {
  db.prepare(
    `INSERT OR IGNORE INTO shared_memory_pending
       (record_hash, origin_repo_id, origin_repo_label, envelope_raw, record_json, received_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(rec.record_hash, originRepoId, originLabel, JSON.stringify(env), JSON.stringify(rec), nowEpoch);
}
function applyRevocation(db, recordHash, nowEpoch) {
  const row = loadPending(db, recordHash);
  if (!row) return false;
  let changed = false;
  if (row.accepted_at_epoch !== null) {
    const iso = new Date(nowEpoch * 1e3).toISOString();
    const res = db.prepare(
      `UPDATE observations
            SET valid_to = ?, expired_at = ?, valid_to_epoch = ?, expired_at_epoch = ?
          WHERE origin = ?
            AND expired_at IS NULL
            AND json_extract(evidence, '$.record_hash') = ?`
    ).run(iso, iso, nowEpoch, nowEpoch, `repo:${row.origin_repo_id}`, recordHash);
    changed = res.changes > 0;
  }
  const p = db.prepare(`UPDATE shared_memory_pending SET expired_at_epoch = ? WHERE record_hash = ? AND expired_at_epoch IS NULL`).run(nowEpoch, recordHash);
  changed = changed || p.changes > 0;
  if (changed) writeSharedAudit(db, "shared_memory_revoked", `revoked ${recordHash}`, { record_hash: recordHash });
  return changed;
}
function drop(db, reason, meta) {
  recordTelemetry(db, "shared_memory_dropped", { reason, ...meta });
  writeSharedAudit(db, "shared_memory_dropped", `dropped: ${reason}`, { reason, ...meta });
}

// src/shared-memory-export.ts
init_config();
import { homedir as homedir11 } from "os";
import { join as join9, dirname as dirname12 } from "path";
import { mkdirSync as mkdirSync12, chmodSync as chmodSync7, writeFileSync as writeFileSync9, renameSync as renameSync3, openSync as openSync3, fsyncSync as fsyncSync3, closeSync as closeSync3 } from "fs";

// src/consolidation-config.ts
init_config();
var DEFAULT_CONSOLIDATION_CONFIG = {
  enabled: true,
  sessionSweepEnabled: true,
  // llmEndpoint / llmModel deliberately UNSET: the shipped default is
  // zero-LLM, zero-network, works offline on any machine.
  summarizeAfterDays: 5,
  // inside the 7-day conversation_turns prune window
  retentionDays: 90,
  importanceFloor: 2,
  protectedTypes: ["decision", "cr_violation", "incident_near_miss"],
  usageWarmupDays: 30,
  usageDecay: 0.9,
  reweightIntervalDays: 1,
  promoteMinOccurrences: 3,
  budgetMs: 3e3,
  suggestUpgrades: true,
  suggestIntervalDays: 30
};
function resolveConsolidationConfig() {
  try {
    const c = getConfig().memory?.consolidation;
    if (!c) return { ...DEFAULT_CONSOLIDATION_CONFIG };
    return { ...DEFAULT_CONSOLIDATION_CONFIG, ...c };
  } catch {
    return { ...DEFAULT_CONSOLIDATION_CONFIG };
  }
}

// src/memory-llm.ts
var LLM_API_KEY_ENV = "MASSU_MEMORY_LLM_API_KEY";
var DEFAULT_BUDGET_MS = 2e4;
var DEFAULT_MAX_CHARS = 900;
var NOISE_PATTERNS = [
  /<command-(name|message|args)>/i,
  /<local-command-[^>]*>/i,
  /^\s*<[a-z-]+>\s*$/i,
  /^\s*(ok|okay|thanks|thank you|yes|no|yep|nope|sure|continue|proceed|go ahead)\s*[.!]?\s*$/i,
  /^\s*\/[a-z-]+\s*$/i,
  // a bare slash-command invocation
  /system-reminder/i
];
function isSummarizableSignal(text) {
  const t = text.trim();
  if (t.length < 25) return false;
  return !NOISE_PATTERNS.some((re) => re.test(t));
}
var CREDENTIAL_LABELS = ["api[_-]?key", "secret", "password", "token"];
var LABELLED_CREDENTIAL = new RegExp(
  `\\b[A-Za-z0-9_-]*(?:${CREDENTIAL_LABELS.join("|")})["'\\s:=]+[A-Za-z0-9_\\-/+]{16,}`,
  "gi"
);
var SECRET_PATTERNS = [
  [/\bms_live_[A-Za-z0-9_-]{6,}/g, "ms_live_[REDACTED]", "MASSU_LIVE_KEY"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]", "OPENAI_STYLE_KEY"],
  [/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g, "[REDACTED_TOKEN]", "GITHUB_TOKEN"],
  [/\bsbp_[A-Za-z0-9]{16,}/g, "sbp_[REDACTED]", "SUPABASE_TOKEN"],
  [/\bAKIA[0-9A-Z]{12,}/g, "[REDACTED_AWS_KEY]", "AWS_ACCESS_KEY"],
  [
    /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g,
    "[REDACTED_JWT]",
    "JWT"
  ],
  [LABELLED_CREDENTIAL, "[REDACTED_CREDENTIAL]", "LABELLED_CREDENTIAL"]
];
function redactSecrets(text) {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}
function containsSecret(text) {
  for (const [re, , name] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    const hit = re.test(text);
    re.lastIndex = 0;
    if (hit) return { matched: true, patternName: name };
  }
  return { matched: false };
}
function extractiveSummary(sources, maxChars = DEFAULT_MAX_CHARS) {
  const cleaned = sources.map((s, i) => ({ ...s, i, text: s.text.replace(/\s+/g, " ").trim() })).filter((s) => isSummarizableSignal(s.text));
  if (cleaned.length === 0) return "";
  const ranked = [...cleaned].sort((a, b) => b.weight - a.weight || a.i - b.i);
  const picked = [];
  let used = 0;
  for (const s of ranked) {
    const cost = s.text.length + 1;
    if (used + cost > maxChars) continue;
    picked.push(s);
    used += cost;
  }
  if (picked.length === 0) {
    return ranked[0].text.slice(0, maxChars);
  }
  picked.sort((a, b) => a.i - b.i);
  return picked.map((s) => s.text).join(" ");
}
async function summarizeViaEndpoint(endpoint, model, material, budgetMs, maxChars) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const apiKey = process.env[LLM_API_KEY_ENV];
    const headers = { "content-type": "application/json" };
    if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
    let resp;
    try {
      resp = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          // a NAME/ALIAS the user configured — never a physical model id
          messages: [
            {
              role: "system",
              content: "You distill a software engineering session into ONE durable lesson a developer will read months later. Be concrete and factual. State what broke, what was tried and rejected, and what actually worked. Invent nothing that is not in the input."
            },
            { role: "user", content: material }
          ],
          max_tokens: 400,
          temperature: 0.2
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) return null;
    return text.trim().slice(0, maxChars);
  } catch {
    return null;
  }
}
async function summarizeText(sources, opts = {}) {
  const cfg = opts.config ?? resolveConsolidationConfig();
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const extractive = extractiveSummary(sources, maxChars);
  if (!cfg.llmEndpoint || !cfg.llmModel || !extractive) {
    return { text: extractive, tier: "extractive" };
  }
  const material = redactSecrets(
    sources.map((s) => s.text.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n")
  );
  const viaModel = await summarizeViaEndpoint(
    cfg.llmEndpoint,
    cfg.llmModel,
    material,
    budgetMs,
    maxChars
  );
  return viaModel ? { text: viaModel, tier: "model" } : { text: extractive, tier: "extractive" };
}

// src/shared-memory-export.ts
init_memory_db();
var DEFAULT_EXPORT_CAPS = {
  maxRecords: 200,
  maxBytesPerRecord: 16384,
  maxTotalBytes: 512e3
};
var EXPORT_SEQ_KEY = "shared_export_seq";
var BACKUP_DONE_KEY = "shared_backup_at";
function zero(enabled) {
  return { enabled, published: false, exported: 0, refused: 0, refusals: [], seq: null };
}
function ensureSharingBackup(db, repoId, home, nowEpoch, backupDirOverride) {
  if (getMemoryMeta(db, BACKUP_DONE_KEY)) return;
  const backupDir = backupDirOverride ?? join9(home, ".massu", "shared", "backups", repoId);
  const dest = join9(backupDir, `memory-${nowEpoch}.db`);
  const snapshot = db.serialize();
  mkdirSync12(dirname12(dest), { recursive: true, mode: 448 });
  const tmp = `${dest}.tmp-${process.pid}`;
  writeFileSync9(tmp, snapshot, { mode: 384 });
  const fd = openSync3(tmp, "r+");
  fsyncSync3(fd);
  closeSync3(fd);
  renameSync3(tmp, dest);
  chmodSync7(dest, 384);
  setMemoryMeta(db, BACKUP_DONE_KEY, String(nowEpoch));
}
async function exportSharedMemories(db, transport, opts = {}) {
  const home = opts.home ?? homedir11();
  const nowEpoch = opts.nowEpoch ?? Math.floor(Date.now() / 1e3);
  const caps = opts.caps ?? DEFAULT_EXPORT_CAPS;
  const config = getConfig();
  const shareEnabled = opts.shareEnabled ?? config.memory?.share?.enabled ?? false;
  if (!shareEnabled) return zero(false);
  const tier = opts.tier ?? getCachedTierReadOnly(db);
  if (!entitledForCrossRepoSurfacing(tier)) return zero(true);
  const repoId = getRepoId(db) ?? mintRepoId(db);
  const label = getRepoLabel();
  ensureLocalShareKeypair(home);
  const fingerprint = localSharePubkeyFingerprint(home);
  upsertRepoRegistration(
    {
      repo_id: repoId,
      label,
      pubkey_fingerprint: fingerprint,
      last_seen_path: getProjectRoot(),
      share_enabled: true
    },
    home
  );
  try {
    ensureSharingBackup(db, repoId, home, nowEpoch, opts.backupDir);
  } catch (err) {
    recordTelemetry(db, "shared_memory_export_refused", {
      reason: "backup_failed",
      detail: err instanceof Error ? err.message : String(err)
    });
    auditExportRefused(db, null, "backup_failed");
    return { ...zero(true), refused: 1, refusals: [{ observation_id: null, reason: "backup_failed" }] };
  }
  const rows = db.prepare(
    `SELECT id, type, title, detail, importance, created_at_epoch, origin
         FROM observations
        WHERE shareable = 1
        ORDER BY id
        LIMIT ?`
  ).all(caps.maxRecords + 1);
  if (rows.length > caps.maxRecords) {
    recordTelemetry(db, "shared_memory_export_refused", { reason: "too_many_records", count: rows.length });
    auditExportRefused(db, null, "too_many_records");
    return { ...zero(true), refused: 1, refusals: [{ observation_id: null, reason: "too_many_records" }] };
  }
  const wasExported = db.prepare(`SELECT 1 FROM shared_memory_outbound WHERE record_hash = ? LIMIT 1`);
  const refusals = [];
  const records = [];
  const outboundInserts = [];
  for (const r of rows) {
    if (!isLocalOrigin(r.origin)) {
      refusals.push({ observation_id: r.id, reason: "non_local_origin" });
      auditExportRefused(db, r.id, "non_local_origin");
      continue;
    }
    const title = r.title ?? "";
    const detail = r.detail ?? "";
    const sTitle = containsSecret(title);
    const sDetail = containsSecret(detail);
    if (sTitle.matched || sDetail.matched) {
      const reason = `secret:${sTitle.patternName ?? sDetail.patternName}`;
      refusals.push({ observation_id: r.id, reason });
      auditExportRefused(db, r.id, reason);
      continue;
    }
    if (home && (title.includes(home) || detail.includes(home))) {
      refusals.push({ observation_id: r.id, reason: "home_path" });
      auditExportRefused(db, r.id, "home_path");
      continue;
    }
    const base = {
      type: r.type,
      title,
      detail,
      importance: r.importance,
      created_at_epoch: r.created_at_epoch,
      superseded_by_hash: null
    };
    const record_hash = hashSharedMemoryRecord(base);
    if (wasExported.get(record_hash)) continue;
    const recordBytes = Buffer.byteLength(JSON.stringify({ ...base, record_hash }), "utf-8");
    if (recordBytes > caps.maxBytesPerRecord) {
      refusals.push({ observation_id: r.id, reason: "record_too_large" });
      auditExportRefused(db, r.id, "record_too_large");
      continue;
    }
    records.push({ ...base, record_hash });
    outboundInserts.push({ hash: record_hash, id: r.id });
  }
  const revokeRows = db.prepare(
    `SELECT o.record_hash AS h
         FROM shared_memory_outbound o
         JOIN observations obs ON obs.id = o.observation_id
        WHERE o.revoked_at_epoch IS NULL
          AND obs.expired_at IS NOT NULL
        LIMIT ?`
  ).all(caps.maxRecords);
  const revokedHashes = revokeRows.map((r) => r.h);
  if (records.length === 0 && revokedHashes.length === 0) {
    return { ...zero(true), refused: refusals.length, refusals };
  }
  const recordsJson = JSON.stringify(records);
  if (Buffer.byteLength(recordsJson, "utf-8") > caps.maxTotalBytes) {
    recordTelemetry(db, "shared_memory_export_refused", { reason: "envelope_too_large" });
    auditExportRefused(db, null, "envelope_too_large");
    return { ...zero(true), refused: refusals.length + 1, refusals: [...refusals, { observation_id: null, reason: "envelope_too_large" }] };
  }
  const seq = nextSeq(db);
  const body = {
    kind: SHARED_MEMORY_KIND,
    origin_repo_id: repoId,
    origin_repo_label: label,
    seq,
    issued_at: new Date(nowEpoch * 1e3).toISOString(),
    records_json: recordsJson,
    revokes_json: JSON.stringify(revokedHashes)
  };
  const envelope = signSharedMemoryEnvelope(body, home);
  await transport.publish(envelope);
  const insertOutbound = db.prepare(
    `INSERT OR IGNORE INTO shared_memory_outbound (record_hash, observation_id, origin_repo_id, seq, exported_at_epoch)
     VALUES (?, ?, ?, ?, ?)`
  );
  const markRevoked = db.prepare(
    `UPDATE shared_memory_outbound SET revoked_at_epoch = ? WHERE record_hash = ? AND revoked_at_epoch IS NULL`
  );
  const commit = db.transaction(() => {
    for (const o of outboundInserts) insertOutbound.run(o.hash, o.id, repoId, seq, nowEpoch);
    for (const h of revokedHashes) markRevoked.run(nowEpoch, h);
    setMemoryMeta(db, EXPORT_SEQ_KEY, String(seq));
  });
  commit();
  recordTelemetry(db, "shared_memory_exported", { count: records.length, revoked: revokedHashes.length, seq });
  auditExported(db, records.length, seq);
  return { enabled: true, published: true, exported: records.length, refused: refusals.length, refusals, seq };
}
function nextSeq(db) {
  const raw = getMemoryMeta(db, EXPORT_SEQ_KEY);
  const last = raw !== null && Number.isInteger(Number(raw)) ? Number(raw) : 0;
  return last + 1;
}
function auditExported(db, count, seq) {
  writeSharedAudit(db, "shared_memory_exported", `exported ${count} record(s) at seq ${seq}`, { count, seq });
}
function auditExportRefused(db, obsId, reason) {
  writeSharedAudit(db, "shared_memory_export_refused", `export refused: ${reason}`, { observation_id: obsId, reason });
}

// src/shared-memory-transport.ts
import {
  chmodSync as chmodSync8,
  existsSync as existsSync15,
  mkdirSync as mkdirSync13,
  readdirSync as readdirSync2,
  readFileSync as readFileSync11
} from "fs";
import { homedir as homedir12 } from "os";
import { join as join10 } from "path";
import { createHash as createHash4 } from "crypto";
var REPO_ID_PATH_RE = /^[0-9a-f-]{36}$/;
var CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
function sharedRootDir(home = homedir12()) {
  return join10(home, ".massu", "shared");
}
function outboxDirFor(originRepoId, home = homedir12()) {
  if (!REPO_ID_PATH_RE.test(originRepoId)) {
    throw new Error(`refusing to use an unvalidated repo_id as a path component: ${originRepoId}`);
  }
  const rel = join10("outbox", originRepoId);
  return assertContainedIn(sharedRootDir(home), rel, { allowNested: true });
}
function envelopeContentHash(env) {
  return createHash4("sha256").update(JSON.stringify(env), "utf-8").digest("hex");
}
var LocalFsTransport = class {
  constructor(home = homedir12()) {
    this.home = home;
  }
  home;
  async publish(env) {
    const dir = outboxDirFor(env.origin_repo_id, this.home);
    mkdirSync13(dir, { recursive: true, mode: 448 });
    const hash = envelopeContentHash(env);
    if (!CONTENT_HASH_RE.test(hash)) {
      throw new Error(`refusing to write an envelope with a malformed content hash: ${hash}`);
    }
    const dest = assertContainedIn(dir, `${seqPrefix(env.seq)}-${hash}.json`, { allowNested: false });
    atomicWriteFileSync(dest, JSON.stringify(env, null, 2));
    chmodSync8(dest, 384);
  }
  async fetchSince(originRepoId, sinceSeq) {
    if (!REPO_ID_PATH_RE.test(originRepoId)) return [];
    let dir;
    try {
      dir = outboxDirFor(originRepoId, this.home);
    } catch {
      return [];
    }
    if (!existsSync15(dir)) return [];
    const out = [];
    for (const name of readdirSync2(dir)) {
      if (!name.endsWith(".json")) continue;
      const seqFromName = parseSeqPrefix(name);
      if (seqFromName !== null && seqFromName <= sinceSeq) continue;
      let env;
      try {
        const p = assertContainedIn(dir, name, { allowNested: false });
        env = JSON.parse(readFileSync11(p, "utf-8"));
      } catch {
        continue;
      }
      if (typeof env?.seq === "number" && env.seq > sinceSeq) out.push(env);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
};
function seqPrefix(seq) {
  const s = Number.isInteger(seq) && seq >= 0 ? seq : 0;
  return String(s).padStart(16, "0");
}
function parseSeqPrefix(name) {
  const m = name.match(/^(\d{1,16})-/);
  return m ? Number(m[1]) : null;
}

// src/hooks/session-end.ts
init_config();

// src/analytics.ts
init_config();
var DEFAULT_WEIGHTS = {
  bug_found: -5,
  vr_failure: -10,
  incident: -20,
  cr_violation: -3,
  vr_pass: 2,
  clean_commit: 5,
  successful_verification: 3
};
var DEFAULT_CATEGORIES = ["security", "architecture", "coupling", "tests", "rule_compliance"];
function getWeights() {
  return getConfig().analytics?.quality?.weights ?? DEFAULT_WEIGHTS;
}
function getCategories() {
  return getConfig().analytics?.quality?.categories ?? DEFAULT_CATEGORIES;
}
function calculateQualityScore(db, sessionId) {
  const weights = getWeights();
  const categories = getCategories();
  const observations = db.prepare(
    "SELECT type, detail FROM observations WHERE session_id = ? LIMIT 10000"
  ).all(sessionId);
  let score = 50;
  const breakdown = Object.fromEntries(
    categories.map((c) => [c, 0])
  );
  for (const obs of observations) {
    const weight = weights[obs.type] ?? 0;
    score += weight;
    const desc = (obs.detail ?? "").toLowerCase();
    for (const category of categories) {
      if (desc.includes(category)) {
        breakdown[category] += weight;
      }
    }
  }
  return {
    score: Math.max(0, Math.min(100, score)),
    breakdown
  };
}
function storeQualityScore(db, sessionId, score, breakdown) {
  db.prepare(`
    INSERT INTO session_quality_scores
    (session_id, score, security_score, architecture_score, coupling_score, test_score, rule_compliance_score)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    score,
    breakdown.security ?? 0,
    breakdown.architecture ?? 0,
    breakdown.coupling ?? 0,
    breakdown.tests ?? 0,
    breakdown.rule_compliance ?? 0
  );
}
function backfillQualityScores(db) {
  const sessions = db.prepare(`
    SELECT DISTINCT s.session_id
    FROM sessions s
    LEFT JOIN session_quality_scores q ON s.session_id = q.session_id
    WHERE q.session_id IS NULL
    LIMIT 100000
  `).all();
  let backfilled = 0;
  for (const session of sessions) {
    const { score, breakdown } = calculateQualityScore(db, session.session_id);
    storeQualityScore(db, session.session_id, score, breakdown);
    backfilled++;
  }
  return backfilled;
}

// src/cost-tracker.ts
init_config();
var DEFAULT_MODEL_PRICING = {
  "claude-opus-4-6": { input_per_million: 15, output_per_million: 75, cache_read_per_million: 1.5, cache_write_per_million: 18.75 },
  "claude-sonnet-4-6": { input_per_million: 3, output_per_million: 15, cache_read_per_million: 0.3, cache_write_per_million: 3.75 },
  "claude-sonnet-4-5": { input_per_million: 3, output_per_million: 15, cache_read_per_million: 0.3, cache_write_per_million: 3.75 },
  "claude-haiku-4-5-20251001": { input_per_million: 0.8, output_per_million: 4, cache_read_per_million: 0.08, cache_write_per_million: 1 },
  "default": { input_per_million: 3, output_per_million: 15, cache_read_per_million: 0.3, cache_write_per_million: 3.75 }
};
function getModelPricing() {
  return getConfig().analytics?.cost?.models ?? DEFAULT_MODEL_PRICING;
}
function getCurrency() {
  return getConfig().analytics?.cost?.currency ?? "USD";
}
function extractTokenUsage(entries) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let model = "unknown";
  for (const entry of entries) {
    const msg = entry.message;
    if (entry.type === "assistant" && msg?.usage) {
      const usage = msg.usage;
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      cacheReadTokens += usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0;
      cacheWriteTokens += usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0;
    }
    if (entry.type === "assistant" && msg?.model) {
      model = msg.model;
    }
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, model };
}
function calculateCost(usage) {
  const pricing = getModelPricing();
  const modelPricing = pricing[usage.model] ?? pricing["default"] ?? pricing["claude-sonnet-4-5"] ?? { input_per_million: 3, output_per_million: 15 };
  const inputCost = usage.inputTokens / 1e6 * modelPricing.input_per_million;
  const outputCost = usage.outputTokens / 1e6 * modelPricing.output_per_million;
  const cacheReadCost = usage.cacheReadTokens / 1e6 * (modelPricing.cache_read_per_million ?? 0);
  const cacheWriteCost = usage.cacheWriteTokens / 1e6 * (modelPricing.cache_write_per_million ?? 0);
  return {
    totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    currency: getCurrency()
  };
}
function storeSessionCost(db, sessionId, usage, cost) {
  const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  db.prepare(`
    INSERT INTO session_costs
    (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
     total_tokens, estimated_cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    usage.model,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    totalTokens,
    cost.totalCost
  );
}

// src/prompt-analyzer.ts
init_config();
import { createHash as createHash5 } from "crypto";

// src/security-utils.ts
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function redactSensitiveContent(text) {
  return text.replace(/\b(sk-|ghp_|gho_|xoxb-|xoxp-|AKIA)[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_KEY]").replace(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, "Bearer [REDACTED_TOKEN]").replace(/:\/\/[^:]+:[^@\s]+@/g, "://[REDACTED_CREDENTIALS]@").replace(/(https?:\/\/[^\s]+[?&](?:token|key|secret|password|auth)=)[^\s&]*/gi, "$1[REDACTED]").replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]").replace(/(?:\/Users\/|\/home\/|C:\\Users\\)[^\s"'`]+/g, "[REDACTED_PATH]");
}

// src/prompt-analyzer.ts
var DEFAULT_SUCCESS_INDICATORS = ["committed", "approved", "looks good", "perfect", "great", "thanks"];
var DEFAULT_ABANDON_PATTERNS = /\b(nevermind|forget it|skip|let's move on|different|instead)\b/i;
function categorizePrompt(promptText) {
  const lower = promptText.toLowerCase();
  if (/\b(fix|bug|error|broken|issue|crash|fail)\b/.test(lower)) return "bugfix";
  if (/\b(refactor|rename|move|extract|cleanup|reorganize)\b/.test(lower)) return "refactor";
  if (/\b(what|how|why|where|when|explain|describe|tell me)\b/.test(lower)) return "question";
  if (/^\/\w+/.test(promptText.trim())) return "command";
  if (/\b(add|create|implement|build|new|feature)\b/.test(lower)) return "feature";
  return "feature";
}
function hashPrompt(promptText) {
  const normalized = promptText.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash5("sha256").update(normalized).digest("hex").slice(0, 16);
}
function detectOutcome(followUpPrompts, assistantResponses) {
  let correctionsNeeded = 0;
  let outcome = "success";
  const correctionPatterns = /\b(no|wrong|that's not|fix this|try again|revert|undo|incorrect|not what)\b/i;
  const config = getConfig();
  const successIndicators = config.analytics?.prompts?.success_indicators ?? DEFAULT_SUCCESS_INDICATORS;
  const escapedIndicators = successIndicators.map(escapeRegex);
  const successRegex = new RegExp(`\\b(${escapedIndicators.join("|")})\\b`, "i");
  for (const prompt of followUpPrompts) {
    if (correctionPatterns.test(prompt)) {
      correctionsNeeded++;
    }
    if (DEFAULT_ABANDON_PATTERNS.test(prompt)) {
      outcome = "abandoned";
      break;
    }
  }
  for (const response of assistantResponses) {
    if (/\b(error|failed|cannot|unable to)\b/i.test(response) && response.length < 200) {
      outcome = "failure";
    }
  }
  if (outcome === "abandoned") {
  } else if (correctionsNeeded >= 3) {
    outcome = "partial";
  } else if (correctionsNeeded > 0) {
    outcome = "partial";
  } else {
    for (const prompt of followUpPrompts) {
      if (successRegex.test(prompt)) {
        outcome = "success";
        break;
      }
    }
  }
  return {
    outcome,
    correctionsNeeded,
    followUpCount: followUpPrompts.length
  };
}
function analyzeSessionPrompts(db, sessionId) {
  const prompts = db.prepare(
    "SELECT prompt_text, prompt_number FROM user_prompts WHERE session_id = ? ORDER BY prompt_number ASC LIMIT 10000"
  ).all(sessionId);
  if (prompts.length === 0) return 0;
  let stored = 0;
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const followUps = prompts.slice(i + 1, i + 4).map((p) => p.prompt_text);
    const category = categorizePrompt(prompt.prompt_text);
    const hash = hashPrompt(prompt.prompt_text);
    const { outcome, correctionsNeeded, followUpCount } = detectOutcome(followUps, []);
    const existing = db.prepare(
      "SELECT id FROM prompt_outcomes WHERE session_id = ? AND prompt_hash = ?"
    ).get(sessionId, hash);
    if (existing) continue;
    const redactedText = redactSensitiveContent(prompt.prompt_text.slice(0, 2e3));
    db.prepare(`
      INSERT INTO prompt_outcomes
      (session_id, prompt_hash, prompt_text, prompt_category, word_count, outcome,
       corrections_needed, follow_up_prompts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      hash,
      redactedText,
      category,
      prompt.prompt_text.split(/\s+/).length,
      outcome,
      correctionsNeeded,
      followUpCount
    );
    stored++;
  }
  return stored;
}

// src/memory-supersede.ts
init_config();
init_memory_embedder();
init_memory_vector();

// src/memory-hybrid-search.ts
init_memory_db();
init_memory_vector();
function temporalPredicate(asOf, includeSuperseded, prefix) {
  const c = (name) => `${prefix}${name}`;
  if (asOf != null && Number.isFinite(asOf)) {
    const t = Math.floor(Number(asOf) / 1e3);
    return `${c("ingested_at_epoch")} <= ${t} AND (${c("expired_at_epoch")} IS NULL OR ${c("expired_at_epoch")} > ${t}) AND ${c("valid_from_epoch")} <= ${t} AND (${c("valid_to_epoch")} IS NULL OR ${c("valid_to_epoch")} > ${t})`;
  }
  if (!includeSuperseded) {
    return `${c("expired_at_epoch")} IS NULL`;
  }
  return "";
}
var RRF_K = 10;
var RECENCY_HALF_LIFE_DAYS = 180;
var DEFAULT_LIMIT = 8;
var DEFAULT_POOL = 30;
var ALL_SOURCES = [
  "observation",
  "architecture_decision",
  "knowledge_chunk",
  "failure_class"
];
function snippetOf(text, max = 160) {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "\u2026" : clean;
}
function ageDaysFrom(epochMs, nowMs) {
  const days = (nowMs - epochMs) / 864e5;
  return days < 0 ? 0 : days;
}
function recencyWeight(ageDays) {
  const freshness = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return 0.7 + 0.3 * freshness;
}
function importanceWeightOf(importance) {
  const clamped = Math.max(1, Math.min(5, importance));
  return 0.7 + 0.3 * (clamped / 5);
}
function collectObservations(memDb, queryText, pool, nowMs, loadVec, modelId, dim, asOf, includeSuperseded) {
  const map = /* @__PURE__ */ new Map();
  const bm25Temporal = temporalPredicate(asOf, includeSuperseded, "o.");
  const plainTemporal = temporalPredicate(asOf, includeSuperseded, "");
  try {
    const rows = memDb.prepare(
      `SELECT o.id, o.title, o.detail, o.importance, o.created_at_epoch
         FROM observations_fts
         JOIN observations o ON observations_fts.rowid = o.id
         WHERE observations_fts MATCH ?${bm25Temporal ? ` AND ${bm25Temporal}` : ""}
         ORDER BY rank LIMIT ?`
    ).all(sanitizeFts5QueryOr(queryText), pool);
    rows.forEach((r, i) => {
      map.set(r.id, {
        id: r.id,
        source: "observation",
        title: r.title,
        snippet: snippetOf(r.detail ?? r.title),
        importance: r.importance,
        ageDays: ageDaysFrom(r.created_at_epoch * 1e3, nowMs),
        bm25Order: i,
        vecs: []
      });
    });
  } catch {
  }
  const recent = memDb.prepare(
    `SELECT id, title, detail, importance, created_at_epoch
       FROM observations${plainTemporal ? ` WHERE ${plainTemporal}` : ""} ORDER BY created_at_epoch DESC LIMIT ?`
  ).all(pool);
  for (const r of recent) {
    if (!map.has(r.id)) {
      map.set(r.id, {
        id: r.id,
        source: "observation",
        title: r.title,
        snippet: snippetOf(r.detail ?? r.title),
        importance: r.importance,
        ageDays: ageDaysFrom(r.created_at_epoch * 1e3, nowMs),
        bm25Order: null,
        vecs: []
      });
    }
  }
  if (loadVec && map.size > 0) {
    loadEmbeddings(
      memDb,
      "observation_embeddings",
      "observation_id",
      [...map.keys()],
      modelId,
      dim,
      (id, vec) => {
        const c = map.get(id);
        if (c) c.vecs.push(vec);
      }
    );
  }
  return [...map.values()];
}
function collectLikeSource(db, source, cfg, queryText, pool, nowMs) {
  const map = /* @__PURE__ */ new Map();
  const tokens = queryText.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length >= 3).slice(0, 8);
  const ageExpr = (created) => {
    const ms = cfg.createdIsEpoch ? Number(created) * 1e3 : Date.parse(String(created));
    return Number.isFinite(ms) ? ageDaysFrom(ms, nowMs) : 0;
  };
  if (tokens.length > 0) {
    const likeClause = cfg.searchCols.map((col) => tokens.map(() => `${col} LIKE ?`).join(" OR ")).join(" OR ");
    const params = [];
    for (const _col of cfg.searchCols) for (const t of tokens) params.push(`%${t}%`);
    try {
      const rows = db.prepare(
        `SELECT ${cfg.idCol} AS id, ${cfg.titleExpr} AS title,
                  ${cfg.snippetCol} AS snippet, ${cfg.createdCol} AS created
           FROM ${cfg.table} WHERE (${likeClause})${cfg.temporalClause ? ` AND ${cfg.temporalClause}` : ""}
           ORDER BY ${cfg.createdCol} DESC LIMIT ?`
      ).all(...params, pool);
      rows.forEach((r, i) => {
        map.set(r.id, {
          id: r.id,
          source,
          title: r.title,
          snippet: snippetOf(r.snippet ?? r.title),
          importance: 3,
          ageDays: ageExpr(r.created),
          bm25Order: i,
          vecs: []
        });
      });
    } catch {
    }
  }
  const recent = db.prepare(
    `SELECT ${cfg.idCol} AS id, ${cfg.titleExpr} AS title,
              ${cfg.snippetCol} AS snippet, ${cfg.createdCol} AS created
       FROM ${cfg.table}${cfg.temporalClause ? ` WHERE ${cfg.temporalClause}` : ""} ORDER BY ${cfg.createdCol} DESC LIMIT ?`
  ).all(pool);
  for (const r of recent) {
    if (!map.has(r.id)) {
      map.set(r.id, {
        id: r.id,
        source,
        title: r.title,
        snippet: snippetOf(r.snippet ?? r.title),
        importance: 3,
        ageDays: ageExpr(r.created),
        bm25Order: null,
        vecs: []
      });
    }
  }
  return [...map.values()];
}
function collectKnowledgeChunks(knowledgeDb, queryText, pool, nowMs, loadVec, modelId, dim) {
  const map = /* @__PURE__ */ new Map();
  try {
    const rows = knowledgeDb.prepare(
      `SELECT kc.id AS id, kc.heading AS heading, kc.content AS content,
                kd.indexed_at_epoch AS epoch
         FROM knowledge_fts
         JOIN knowledge_chunks kc ON knowledge_fts.rowid = kc.id
         JOIN knowledge_documents kd ON kd.id = kc.document_id
         WHERE knowledge_fts MATCH ?
         ORDER BY rank LIMIT ?`
    ).all(sanitizeFts5QueryOr(queryText), pool);
    rows.forEach((r, i) => {
      map.set(r.id, {
        id: r.id,
        source: "knowledge_chunk",
        title: r.heading || snippetOf(r.content, 60),
        snippet: snippetOf(r.content),
        importance: 3,
        ageDays: ageDaysFrom((r.epoch ?? 0) * 1e3, nowMs),
        bm25Order: i,
        vecs: []
      });
    });
  } catch {
  }
  if (loadVec && map.size > 0) {
    loadEmbeddings(
      knowledgeDb,
      "knowledge_chunk_embeddings",
      "chunk_id",
      [...map.keys()],
      modelId,
      dim,
      (id, vec) => {
        const c = map.get(id);
        if (c) c.vecs.push(vec);
      }
    );
  }
  return [...map.values()];
}
function loadEmbeddings(db, table, idCol, ids, modelId, dim, assign) {
  if (!modelId || !dim || ids.length === 0) return;
  try {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT ${idCol} AS id, vec FROM ${table}
         WHERE ${idCol} IN (${placeholders}) AND model_id = ? AND dim = ?
         LIMIT ?`
    ).all(...ids, modelId, dim, ids.length);
    for (const r of rows) {
      const v = blobToFloat32(r.vec);
      if (v && v.length === dim) assign(r.id, v);
    }
  } catch {
  }
}
function hybridSearch(memDb, knowledgeDb, opts) {
  const sources = opts.sources ?? ALL_SOURCES;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const minScore = opts.minScore ?? 0;
  const pool = opts.candidatePool ?? DEFAULT_POOL;
  const nowMs = opts.now ?? Date.now();
  const queryVec = opts.queryVec ?? null;
  const modelId = queryVec ? opts.modelId ?? null : null;
  const dim = queryVec ? opts.dim ?? null : null;
  const loadVec = !!(queryVec && modelId && dim);
  const includeSuperseded = opts.includeSuperseded ?? false;
  let candidates = [];
  if (sources.includes("observation")) {
    candidates = candidates.concat(
      collectObservations(
        memDb,
        opts.queryText,
        pool,
        nowMs,
        loadVec,
        modelId,
        dim,
        opts.asOf,
        includeSuperseded
      )
    );
  }
  if (sources.includes("architecture_decision")) {
    candidates = candidates.concat(
      collectLikeSource(
        memDb,
        "architecture_decision",
        {
          table: "architecture_decisions",
          idCol: "id",
          titleExpr: "title",
          snippetCol: "decision",
          searchCols: ["title", "decision", "context"],
          createdCol: "created_at",
          createdIsEpoch: false,
          temporalClause: temporalPredicate(opts.asOf, includeSuperseded, "")
        },
        opts.queryText,
        pool,
        nowMs
      )
    );
  }
  if (sources.includes("failure_class")) {
    candidates = candidates.concat(
      collectLikeSource(
        memDb,
        "failure_class",
        {
          table: "failure_classes",
          idCol: "id",
          titleExpr: "name",
          snippetCol: "description",
          searchCols: ["name", "description", "known_message"],
          createdCol: "created_at",
          createdIsEpoch: false
        },
        opts.queryText,
        pool,
        nowMs
      )
    );
  }
  if (sources.includes("knowledge_chunk") && knowledgeDb) {
    candidates = candidates.concat(
      collectKnowledgeChunks(knowledgeDb, opts.queryText, pool, nowMs, loadVec, modelId, dim)
    );
  }
  if (candidates.length === 0) return [];
  const worstBm25 = pool + 1;
  let cosineOrder = null;
  if (loadVec && queryVec) {
    const scored = candidates.map((c) => ({
      key: `${c.source}:${c.id}`,
      // MAX-POOL: score the record by its BEST-matching passage.
      sim: c.vecs.length ? Math.max(...c.vecs.map((v) => cosineSim(queryVec, v))) : -Infinity
    })).filter((s) => s.sim > -Infinity).sort((a, b) => b.sim - a.sim);
    cosineOrder = /* @__PURE__ */ new Map();
    scored.forEach((s, i) => cosineOrder.set(s.key, i));
  }
  const worstCosine = candidates.length + 1;
  const ranked = candidates.map((c) => {
    const key = `${c.source}:${c.id}`;
    const bm25Rank = c.bm25Order ?? worstBm25;
    let rrf = 1 / (RRF_K + bm25Rank);
    if (cosineOrder) {
      const cRank = cosineOrder.has(key) ? cosineOrder.get(key) : worstCosine;
      rrf += 1 / (RRF_K + cRank);
    }
    const score = rrf * importanceWeightOf(c.importance) * recencyWeight(c.ageDays);
    return {
      id: c.id,
      source: c.source,
      title: c.title,
      snippet: c.snippet,
      score,
      importance: c.importance,
      ageDays: c.ageDays
    };
  });
  const top = ranked.filter((r) => r.score >= minScore).sort((a, b) => b.score - a.score || a.ageDays - b.ageDays).slice(0, limit);
  if (includeSuperseded && opts.asOf == null) {
    for (const r of top) {
      const table = r.source === "observation" ? "observations" : r.source === "architecture_decision" ? "architecture_decisions" : null;
      if (!table) continue;
      try {
        const row = memDb.prepare(`SELECT valid_to, superseded_by, expired_at_epoch FROM ${table} WHERE id = ?`).get(r.id);
        if (row && row.expired_at_epoch != null) {
          const when = row.valid_to ? row.valid_to.slice(0, 10) : "an earlier date";
          const by = row.superseded_by != null ? ` by #${row.superseded_by}` : "";
          r.snippet = `(superseded on ${when}${by}) ${r.snippet}`;
        }
      } catch {
      }
    }
  }
  return top;
}

// src/memory-supersede.ts
init_memory_db();
var DEFAULT_CONFIG = {
  enabled: true,
  similarityThreshold: 0.6,
  dedupThreshold: 0.93,
  gatedTypes: ["decision", "cr_violation", "failed_attempt"],
  annotateSuperseded: false,
  budgetMs: 800
};
var REPLACEMENT_SIGNAL = /\b(instead of|no longer|not\s+\w+\s+anymore|switch(?:ing|ed)?\s+(?:from|to)|replac(?:e|es|ed|ing)|deprecat(?:e|ed|es)|supersed(?:e|ed|es)|now\s+(?:we|use|using)|actually|correction|revert(?:ed|ing)?|changed?\s+to|moved?\s+(?:from|to)|abandon(?:ed)?|rolled?\s+back)\b/i;
function hasReplacementSignal(text) {
  return REPLACEMENT_SIGNAL.test(text);
}
function resolveContradictionConfig() {
  try {
    const c = getConfig().memory?.contradiction;
    if (!c) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...c };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function judgeContradiction(newText, candidates, cfg) {
  if (candidates.length === 0) {
    return { op: "ADD", reason: "no related candidates" };
  }
  const top = [...candidates].sort((a, b) => b.cosine - a.cosine)[0];
  if (top.cosine >= cfg.dedupThreshold) {
    return { op: "NOOP", targetId: top.id, targetSource: top.source, reason: `near-duplicate (cos=${top.cosine.toFixed(3)})` };
  }
  if (top.cosine >= cfg.similarityThreshold && hasReplacementSignal(newText)) {
    return {
      op: "UPDATE",
      targetId: top.id,
      targetSource: top.source,
      reason: `contradiction: related (cos=${top.cosine.toFixed(3)}) + replacement signal`
    };
  }
  return { op: "ADD", reason: `related but no contradiction (top cos=${top.cosine.toFixed(3)})` };
}
async function judgeViaEndpoint(endpoint, newText, candidates, budgetMs) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    let resp;
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: newText, candidates }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.op !== "ADD" && data.op !== "UPDATE" && data.op !== "NOOP") return null;
    if (data.op === "UPDATE" && typeof data.targetId !== "number") return null;
    const match = candidates.find((c) => c.id === data.targetId);
    return {
      op: data.op,
      targetId: data.op === "UPDATE" ? data.targetId : void 0,
      targetSource: match?.source,
      reason: "external judge"
    };
  } catch {
    return null;
  }
}
async function candidateVec(memDb, source, id) {
  try {
    if (source === "observation") {
      const row = memDb.prepare(
        `SELECT vec FROM observation_embeddings
            WHERE observation_id = ? ORDER BY chunk_ix ASC LIMIT 1`
      ).get(id);
      if (row?.vec) {
        const v = blobToFloat32(row.vec);
        if (v) return v;
      }
      const obs = memDb.prepare(`SELECT title, detail FROM observations WHERE id = ?`).get(id);
      if (!obs) return null;
      return await embed(`${obs.title}
${obs.detail ?? ""}`.trim());
    }
    const ad = memDb.prepare(`SELECT title, decision FROM architecture_decisions WHERE id = ?`).get(id);
    if (!ad) return null;
    return await embed(`${ad.title}
${ad.decision}`.trim());
  } catch {
    return null;
  }
}
async function supersedeIfContradicted(memDb, knowledgeDb, args) {
  const cfg = args.config ?? resolveContradictionConfig();
  if (!cfg.enabled) return { op: "ADD", superseded: null, reason: "disabled" };
  const start = Date.now();
  try {
    const queryVec = await embed(args.text);
    if (!queryVec) return { op: "ADD", superseded: null, reason: "no embedder (fail-open)" };
    const active = getActiveEmbedModel();
    const results = hybridSearch(memDb, knowledgeDb, {
      queryText: args.text,
      queryVec,
      modelId: active?.modelId ?? null,
      dim: active?.dim ?? null,
      sources: [args.source],
      limit: 5,
      candidatePool: 20
    });
    const scored = [];
    for (const r of results) {
      if (r.id === args.newId) continue;
      if (Date.now() - start > cfg.budgetMs) break;
      const vec = await candidateVec(memDb, args.source, r.id);
      if (vec) scored.push({ id: r.id, source: args.source, cosine: cosineSim(queryVec, vec) });
    }
    let verdict = null;
    if (cfg.judgeEndpoint && Date.now() - start < cfg.budgetMs) {
      verdict = await judgeViaEndpoint(cfg.judgeEndpoint, args.text, scored, cfg.budgetMs);
    }
    if (!verdict) verdict = judgeContradiction(args.text, scored, cfg);
    if (verdict.op === "UPDATE" && typeof verdict.targetId === "number") {
      const table = args.source === "observation" ? "observations" : "architecture_decisions";
      const ok = markRecordSuperseded(memDb, table, verdict.targetId, args.newId, args.nowEpochSec);
      return { op: "UPDATE", superseded: ok ? verdict.targetId : null, reason: verdict.reason };
    }
    return { op: verdict.op, superseded: null, reason: verdict.reason };
  } catch (e) {
    return { op: "ADD", superseded: null, reason: `fail-open: ${e.message}` };
  }
}
var SWEEP_MAX_RECORDS = 500;
async function runSessionSupersedeSweep(memDb, sessionId, opts) {
  const cfg = opts?.config ?? resolveContradictionConfig();
  if (!cfg.enabled) return { superseded: 0 };
  const overallBudget = opts?.budgetMs ?? 4e3;
  const start = Date.now();
  let count = 0;
  const stillLive = (table, id) => {
    const row = memDb.prepare(`SELECT expired_at FROM ${table} WHERE id = ?`).get(id);
    return !!row && row.expired_at == null;
  };
  try {
    if (cfg.gatedTypes.length > 0) {
      const placeholders = cfg.gatedTypes.map(() => "?").join(",");
      const obs = memDb.prepare(
        `SELECT id, title, detail FROM observations
            WHERE session_id = ? AND expired_at IS NULL AND type IN (${placeholders})
            ORDER BY created_at_epoch DESC LIMIT ?`
      ).all(sessionId, ...cfg.gatedTypes, SWEEP_MAX_RECORDS);
      for (const o of obs) {
        if (Date.now() - start > overallBudget) break;
        if (!stillLive("observations", o.id)) continue;
        const res = await supersedeIfContradicted(memDb, null, {
          text: `${o.title}
${o.detail ?? ""}`.trim(),
          source: "observation",
          newId: o.id,
          config: cfg,
          nowEpochSec: opts?.nowEpochSec
        });
        if (res.superseded != null) count++;
      }
    }
    const decs = memDb.prepare(
      `SELECT id, title, decision FROM architecture_decisions
          WHERE session_id = ? AND expired_at IS NULL ORDER BY id DESC LIMIT ?`
    ).all(sessionId, SWEEP_MAX_RECORDS);
    for (const d of decs) {
      if (Date.now() - start > overallBudget) break;
      if (!stillLive("architecture_decisions", d.id)) continue;
      const res = await supersedeIfContradicted(memDb, null, {
        text: `${d.title}
${d.decision}`.trim(),
        source: "architecture_decision",
        newId: d.id,
        config: cfg,
        nowEpochSec: opts?.nowEpochSec
      });
      if (res.superseded != null) count++;
    }
  } catch {
  }
  return { superseded: count };
}

// src/memory-consolidate.ts
init_memory_db();
import { createHash as createHash6 } from "crypto";
import { existsSync as existsSync16, mkdirSync as mkdirSync14, writeFileSync as writeFileSync10 } from "fs";
import { join as join11 } from "path";
init_memory_embedder();
init_memory_vector();
var LEASE_KEY = "consolidate_lease";
var DEDUPE_CURSOR = "consolidate_cursor_dedupe";
var MAX_ROWS_PER_STAGE = 500;
function emptyResult() {
  return {
    deduped: 0,
    summarized: 0,
    promoted: 0,
    reweighted: 0,
    expired: 0,
    sessionsMissed: 0,
    candidatesRefusedByTier: 0,
    embedderUnavailable: false,
    summaryTier: null,
    stagesRun: [],
    stagesFailed: [],
    warmingUp: false
  };
}
function acquireLease(db, now, ttlSec) {
  const raw = getMemoryMeta(db, LEASE_KEY);
  if (raw) {
    const expiry = Number(raw.split(":")[1]);
    if (Number.isFinite(expiry) && expiry > now) return false;
  }
  setMemoryMeta(db, LEASE_KEY, `${process.pid}:${now + ttlSec}`);
  return true;
}
function releaseLease(db) {
  try {
    setMemoryMeta(db, LEASE_KEY, "");
  } catch {
  }
}
async function stageDedupe(db, cfg, deadline, now) {
  const gated = ["decision", "cr_violation", "failed_attempt"];
  const cursor = Number(getMemoryMeta(db, DEDUPE_CURSOR) ?? "0") || 0;
  const rows = db.prepare(
    `SELECT id, title, detail FROM observations
        WHERE expired_at IS NULL AND id > ?
          AND type IN (${gated.map(() => "?").join(",")})
          AND title NOT LIKE ?
        ORDER BY id ASC LIMIT ?`
  ).all(cursor, ...gated, MEMORY_FILE_TITLE_LIKE, MAX_ROWS_PER_STAGE);
  if (rows.length === 0) {
    setMemoryMeta(db, DEDUPE_CURSOR, "0");
    return 0;
  }
  let deduped = 0;
  for (const r of rows) {
    if (Date.now() > deadline) break;
    const live = db.prepare(`SELECT expired_at FROM observations WHERE id = ?`).get(r.id);
    if (!live || live.expired_at != null) continue;
    const res = await supersedeIfContradicted(db, null, {
      text: `${r.title}
${r.detail ?? ""}`.trim(),
      source: "observation",
      newId: r.id,
      nowEpochSec: now
    });
    if (res.superseded != null) deduped++;
    setMemoryMeta(db, DEDUPE_CURSOR, String(r.id));
  }
  return deduped;
}
async function stageSummarize(db, cfg, deadline, now) {
  const cutoff = now - cfg.summarizeAfterDays * 86400;
  const sessions = db.prepare(
    `SELECT s.session_id AS sid,
              (SELECT MAX(t.created_at_epoch) FROM conversation_turns t
                WHERE t.session_id = s.session_id) AS newest_turn
         FROM sessions s
        WHERE s.consolidated_at IS NULL
        ORDER BY s.session_id ASC
        LIMIT ?`
  ).all(MAX_ROWS_PER_STAGE);
  let summarized = 0;
  let sessionsMissed = 0;
  let tier = null;
  const stamp = db.prepare(
    `UPDATE sessions
        SET consolidated_at = ?, consolidated_at_epoch = ?, consolidated_status = ?
      WHERE session_id = ?`
  );
  const iso = new Date(now * 1e3).toISOString();
  for (const s of sessions) {
    if (Date.now() > deadline) break;
    if (s.newest_turn == null) {
      stamp.run(iso, now, "no_turns", s.sid);
      sessionsMissed++;
      continue;
    }
    if (s.newest_turn > cutoff) continue;
    const obs = db.prepare(
      `SELECT type, title, detail, importance FROM observations
          WHERE session_id = ? AND expired_at IS NULL
            AND COALESCE(evidence,'') != ?
          ORDER BY importance DESC LIMIT 40`
    ).all(s.sid, CONSOLIDATION_LESSON_EVIDENCE);
    const sources = obs.map((o) => ({
      text: redactSecrets(`${o.type}: ${o.title}${o.detail ? ` \u2014 ${o.detail}` : ""}`),
      weight: o.importance
    }));
    const summary = sources.length > 0 ? await summarizeText(sources, { config: cfg }) : null;
    if (summary) tier = summary.tier;
    if (!summary || !summary.text) {
      stamp.run(iso, now, "no_signal", s.sid);
      continue;
    }
    addObservation(
      db,
      s.sid,
      "discovery",
      `Session lesson: ${s.sid.slice(0, 8)}`,
      redactSecrets(summary.text),
      // also redact model output — it echoes its input
      { importance: 4, evidence: CONSOLIDATION_LESSON_EVIDENCE }
    );
    stamp.run(iso, now, "summarized", s.sid);
    summarized++;
  }
  return { summarized, sessionsMissed, tier };
}
async function stagePromote(db, cfg, projectRoot, deadline, now, dryRun) {
  const tier = getCachedTierReadOnly(db);
  if (!entitledForAutoLearning(tier)) {
    const wouldHave = db.prepare(
      `SELECT COUNT(*) AS n FROM observations
          WHERE type IN ('cr_violation','failed_attempt') AND recurrence_count >= ?`
    ).get(cfg.promoteMinOccurrences);
    return { promoted: 0, refusedByTier: wouldHave.n, embedderUnavailable: false };
  }
  const rows = db.prepare(
    `SELECT id, title, detail, session_id, recurrence_count FROM observations
        WHERE type IN ('cr_violation','failed_attempt')
        ORDER BY id DESC LIMIT ?`
  ).all(MAX_ROWS_PER_STAGE);
  if (rows.length === 0) return { promoted: 0, refusedByTier: 0, embedderUnavailable: false };
  const vecs = /* @__PURE__ */ new Map();
  for (const r of rows) {
    if (Date.now() > deadline) break;
    const v = await embed(`${r.title}
${r.detail ?? ""}`.trim());
    if (v) vecs.set(r.id, v);
  }
  if (vecs.size === 0) {
    return { promoted: 0, refusedByTier: 0, embedderUnavailable: true };
  }
  const CLUSTER_THRESHOLD = 0.8;
  const used = /* @__PURE__ */ new Set();
  const clusters = [];
  for (const r of rows) {
    if (used.has(r.id) || !vecs.has(r.id)) continue;
    const cluster = [r];
    used.add(r.id);
    for (const other of rows) {
      if (used.has(other.id) || !vecs.has(other.id)) continue;
      if (cosineSim(vecs.get(r.id), vecs.get(other.id)) >= CLUSTER_THRESHOLD) {
        cluster.push(other);
        used.add(other.id);
      }
    }
    clusters.push(cluster);
  }
  const candidateDir = join11(projectRoot, ".massu", "rule-candidates");
  let promoted = 0;
  for (const cluster of clusters) {
    const occurrences = cluster.reduce((n, c) => n + (c.recurrence_count || 1), 0);
    const sessions = new Set(cluster.map((c) => c.session_id));
    if (occurrences < cfg.promoteMinOccurrences || sessions.size < 2) continue;
    const representative = [...cluster].sort(
      (a, b) => (b.recurrence_count || 1) - (a.recurrence_count || 1)
    )[0];
    const promptText = `${representative.title}${representative.detail ? `
${representative.detail}` : ""}`;
    const clusterKey = cluster.map((c) => c.title.toLowerCase().replace(/\s+/g, " ").trim()).sort().join("|");
    const promptHash = createHash6("sha256").update(clusterKey).digest("hex").slice(0, 16);
    const candidatePath = join11(candidateDir, `${promptHash}.json`);
    if (existsSync16(candidatePath)) continue;
    if (dryRun) {
      promoted++;
      continue;
    }
    mkdirSync14(candidateDir, { recursive: true });
    writeFileSync10(
      candidatePath,
      JSON.stringify(
        {
          prompt: promptText,
          prompt_hash: promptHash,
          score: Math.min(100, 60 + occurrences * 5 + sessions.size * 5),
          signals: [
            {
              type: "consolidation-cluster",
              occurrences,
              sessions: sessions.size,
              detail: `This correction has recurred ${occurrences}x across ${sessions.size} sessions.`
            }
          ],
          prior_turn_files: [],
          timestamp: new Date(now * 1e3).toISOString(),
          session_id: representative.session_id,
          // Marks this as machine-clustered, so /massu-rule can label it and
          // does not re-classify it as an ordinary per-prompt local candidate.
          provenance: { origin: "consolidation" }
        },
        null,
        2
      )
    );
    promoted++;
  }
  return { promoted, refusedByTier: 0, embedderUnavailable: false };
}
function stageReweight(db, cfg, now) {
  const staleCutoff = now - cfg.retentionDays * 86400;
  const reweightCutoff = now - cfg.reweightIntervalDays * 86400;
  db.prepare(`UPDATE memory_usage SET hits_windowed = hits_windowed * ?`).run(cfg.usageDecay);
  let changed = 0;
  const promote = db.prepare(
    `SELECT u.record_id AS id FROM memory_usage u
         JOIN observations o ON o.id = u.record_id
        WHERE u.source = 'observation'
          AND u.hits_windowed >= 2
          AND o.importance < 5
          AND o.expired_at IS NULL
          AND (u.last_reweight_epoch IS NULL OR u.last_reweight_epoch <= ?)
        LIMIT ?`
  ).all(reweightCutoff, MAX_ROWS_PER_STAGE);
  const demote = db.prepare(
    `SELECT o.id AS id FROM observations o
         LEFT JOIN memory_usage u
           ON u.source = 'observation' AND u.record_id = o.id
        WHERE o.expired_at IS NULL
          AND o.created_at_epoch < ?
          AND o.importance > 1
          AND COALESCE(o.evidence,'') != ?
          AND o.title NOT LIKE ?
          AND COALESCE(u.hit_count, 0) = 0
          AND (u.last_reweight_epoch IS NULL OR u.last_reweight_epoch <= ?)
        LIMIT ?`
  ).all(
    staleCutoff,
    CONSOLIDATION_LESSON_EVIDENCE,
    MEMORY_FILE_TITLE_LIKE,
    reweightCutoff,
    MAX_ROWS_PER_STAGE
  );
  const bump = db.prepare(`UPDATE observations SET importance = importance + 1 WHERE id = ?`);
  const drop2 = db.prepare(`UPDATE observations SET importance = importance - 1 WHERE id = ?`);
  const mark = db.prepare(
    `INSERT INTO memory_usage (source, record_id, hit_count, hits_windowed, last_reweight_epoch)
     VALUES ('observation', ?, 0, 0, ?)
     ON CONFLICT(source, record_id) DO UPDATE SET last_reweight_epoch = excluded.last_reweight_epoch`
  );
  const tx = db.transaction(() => {
    for (const r of promote) {
      bump.run(r.id);
      mark.run(r.id, now);
      changed++;
    }
    for (const r of demote) {
      drop2.run(r.id);
      mark.run(r.id, now);
      changed++;
    }
  });
  tx();
  return changed;
}
async function runConsolidation(db, opts = {}) {
  const cfg = opts.config ?? resolveConsolidationConfig();
  const result = emptyResult();
  if (!cfg.enabled) return { ...result, skipped: "disabled" };
  const now = opts.nowEpochSec ?? Math.floor(Date.now() / 1e3);
  const budgetMs = opts.budgetMs ?? 6e4;
  const deadline = Date.now() + budgetMs;
  const dryRun = opts.dryRun === true;
  const projectRoot = opts.projectRoot ?? process.cwd();
  if (!dryRun) armUsageCounter(db, now);
  result.warmingUp = !usageWarmupElapsed(db, cfg.usageWarmupDays, now);
  if (!dryRun && !acquireLease(db, now, Math.ceil(budgetMs * 2 / 1e3))) {
    return { ...result, skipped: "lease-held" };
  }
  try {
    try {
      result.deduped = await stageDedupe(db, cfg, deadline, now);
      result.stagesRun.push("dedupe");
    } catch {
      result.stagesFailed.push("dedupe");
    }
    try {
      if (!dryRun) {
        const s = await stageSummarize(db, cfg, deadline, now);
        result.summarized = s.summarized;
        result.sessionsMissed = s.sessionsMissed;
        result.summaryTier = s.tier;
      }
      result.stagesRun.push("summarize");
    } catch {
      result.stagesFailed.push("summarize");
    }
    try {
      const p = await stagePromote(db, cfg, projectRoot, deadline, now, dryRun);
      result.promoted = p.promoted;
      result.candidatesRefusedByTier = p.refusedByTier;
      result.embedderUnavailable = p.embedderUnavailable;
      result.stagesRun.push("promote");
    } catch {
      result.stagesFailed.push("promote");
    }
    try {
      if (!dryRun) {
        result.expired = expireOldLowValueObservations(db, {
          retentionDays: cfg.retentionDays,
          importanceFloor: cfg.importanceFloor,
          protectedTypes: cfg.protectedTypes,
          usageWarmupDays: cfg.usageWarmupDays,
          reweightIntervalDays: cfg.reweightIntervalDays,
          nowEpochSec: now
        });
      }
      result.stagesRun.push("expire");
    } catch {
      result.stagesFailed.push("expire");
    }
    try {
      if (!dryRun) result.reweighted = stageReweight(db, cfg, now);
      result.stagesRun.push("reweight");
    } catch {
      result.stagesFailed.push("reweight");
    }
  } finally {
    if (!dryRun) releaseLease(db);
  }
  return result;
}

// src/hooks/session-end.ts
init_hook_failure_signal();
async function main() {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input);
    const { session_id, cwd } = hookInput;
    const db = getMemoryDb();
    try {
      createSession(db, session_id);
      const observations = db.prepare(
        "SELECT * FROM observations WHERE session_id = ? ORDER BY created_at_epoch ASC LIMIT 10000"
      ).all(session_id);
      const prompts = db.prepare(
        "SELECT prompt_text FROM user_prompts WHERE session_id = ? ORDER BY prompt_number ASC LIMIT 10000"
      ).all(session_id);
      const summary = buildSummaryFromObservations(observations, prompts);
      addSummary(db, session_id, summary);
      try {
        await captureConversationData(db, session_id, hookInput.transcript_path);
      } catch (_captureErr) {
      }
      try {
        const { score, breakdown } = calculateQualityScore(db, session_id);
        if (score !== 50) {
          storeQualityScore(db, session_id, score, breakdown);
        }
        backfillQualityScores(db);
      } catch (_qualityErr) {
      }
      try {
        const { entries } = await parseTranscriptFrom(hookInput.transcript_path, 0);
        const tokenUsage = extractTokenUsage(entries);
        const cost = calculateCost(tokenUsage);
        storeSessionCost(db, session_id, tokenUsage, cost);
      } catch (_costErr) {
      }
      try {
        analyzeSessionPrompts(db, session_id);
      } catch (_promptErr) {
      }
      try {
        await embedMissingObservations(db, { budgetMs: 3e3 });
      } catch (_embedErr) {
      }
      try {
        await runSessionSupersedeSweep(db, session_id, { budgetMs: 4e3 });
      } catch (_supersedeErr) {
      }
      try {
        const consolidationCfg = resolveConsolidationConfig();
        if (consolidationCfg.enabled && consolidationCfg.sessionSweepEnabled) {
          await runConsolidation(db, {
            config: consolidationCfg,
            budgetMs: consolidationCfg.budgetMs,
            projectRoot: cwd
          });
        }
      } catch (_consolidateErr) {
      }
      endSession(db, session_id, "completed");
      archiveAndRegenerate(db, session_id);
      let openLease = null;
      try {
        await drainSyncQueue(db);
        const cloudCfg = getConfig().cloud;
        const willTransmit = !!cloudCfg?.enabled && !!cloudCfg?.apiKey && !!cloudCfg?.endpoint && cloudCfg?.sync?.memory !== false;
        const lease = willTransmit ? leaseLearning(db) : null;
        openLease = lease;
        const syncPayload = buildSyncPayload(db, session_id, observations, summary, lease);
        const result = await syncToCloud(db, syncPayload);
        if (lease) {
          if (result.transmitted === true) {
            ackLearning(db, lease);
          } else {
            nackLearning(db, lease, result.error ?? "not transmitted (sync disabled or unreachable)");
          }
        }
        openLease = null;
        try {
          await pullTeamPromotions(db);
        } catch (_pullErr) {
        }
        try {
          const shareTransport = new LocalFsTransport();
          await exportSharedMemories(db, shareTransport);
          await importSharedMemories(db, shareTransport);
        } catch (_shareErr) {
        }
      } catch (syncErr) {
        const msg = syncErr instanceof Error ? syncErr.message : String(syncErr);
        if (openLease) nackLearning(db, openLease, msg);
        recordHookFailure("session-end:cloud-sync", syncErr);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    recordHookFailure("session-end", err);
  }
  process.exit(0);
}
function buildSyncPayload(db, sessionId, observations, summary, lease) {
  const promotions = lease?.promotions ?? [];
  const revocations = lease?.revocations ?? [];
  const funnelEvents = lease?.events ?? [];
  return {
    sessions: [{
      local_session_id: sessionId,
      summary: summary.request ?? void 0,
      started_at: void 0,
      // Will be filled from session data if available
      ended_at: (/* @__PURE__ */ new Date()).toISOString(),
      turns: 0,
      tokens_used: 0,
      estimated_cost: 0,
      tools_used: []
    }],
    observations: observations.map((o, idx) => ({
      local_observation_id: `${sessionId}_obs_${idx}`,
      session_id: sessionId,
      type: o.type,
      content: o.title + (o.detail ? `: ${o.detail}` : ""),
      importance: o.importance ?? 3,
      file_path: void 0
    })),
    ...promotions.length > 0 ? {
      rule_promotions: promotions.map((p) => {
        const recurrence = getRecurrenceCountForPromptHash(db, p.prompt_hash);
        return {
          prompt_hash: p.prompt_hash,
          destination: p.destination,
          draft_text: p.draft_text,
          score: p.score,
          signals: p.signals,
          content_hash: p.content_hash,
          ...recurrence !== null ? { recurrence_count: recurrence } : {},
          // PA3-004: hardened-destination publish carries the flag + attestation.
          ...p.hardened ? { hardened: true } : {},
          ...p.review_attestation !== void 0 ? { review_attestation: p.review_attestation } : {}
        };
      })
    } : {},
    ...revocations.length > 0 ? { rule_revocations: revocations.map((prompt_hash) => ({ prompt_hash })) } : {},
    ...funnelEvents.length > 0 ? {
      rule_promotion_events: funnelEvents.map((e) => ({
        prompt_hash: e.prompt_hash,
        event_type: e.event_type,
        created_at: e.created_at,
        ...e.metadata && Object.keys(e.metadata).length > 0 ? { metadata: e.metadata } : {}
      }))
    } : {}
  };
}
function buildSummaryFromObservations(observations, prompts) {
  const request = prompts[0]?.prompt_text?.slice(0, 500) ?? void 0;
  const discoveries = observations.filter((o) => o.type === "discovery").map((o) => o.title).join("; ");
  const decisions = observations.filter((o) => o.type === "decision").map((o) => `- ${o.title}`).join("\n");
  const completed = observations.filter((o) => ["feature", "bugfix", "refactor"].includes(o.type)).map((o) => `- ${o.title}`).join("\n");
  const failedAttempts = observations.filter((o) => o.type === "failed_attempt").map((o) => `- ${o.title}`).join("\n");
  const lastTenPercent = observations.slice(Math.floor(observations.length * 0.9));
  const hasCompletion = completed.length > 0;
  const nextSteps = hasCompletion ? void 0 : lastTenPercent.map((o) => `- [${o.type}] ${o.title}`).join("\n");
  const filesCreated = [];
  const filesModified = [];
  for (const o of observations) {
    if (o.type !== "file_change") continue;
    const files = safeParseJson2(o.files_involved, []);
    const title = o.title;
    if (title.startsWith("Created") || title.startsWith("Created/wrote")) {
      filesCreated.push(...files);
    } else if (title.startsWith("Edited")) {
      filesModified.push(...files);
    }
  }
  const verificationResults = {};
  for (const o of observations) {
    if (o.type !== "vr_check") continue;
    const vrType = o.vr_type;
    const passed = o.title.includes("PASS");
    if (vrType) verificationResults[vrType] = passed ? "PASS" : "FAIL";
  }
  const planProgress = {};
  for (const o of observations) {
    if (!o.plan_item) continue;
    planProgress[o.plan_item] = "in_progress";
  }
  return {
    request,
    investigated: discoveries || void 0,
    decisions: decisions || void 0,
    completed: completed || void 0,
    failedAttempts: failedAttempts || void 0,
    nextSteps,
    filesCreated: [...new Set(filesCreated)],
    filesModified: [...new Set(filesModified)],
    verificationResults,
    planProgress
  };
}
function safeParseJson2(json, fallback) {
  try {
    return JSON.parse(json);
  } catch (_e) {
    return fallback;
  }
}
async function captureConversationData(db, sessionId, transcriptPath) {
  if (!transcriptPath) return;
  const lastLine = getLastProcessedLine(db, sessionId);
  const { entries, totalLines } = await parseTranscriptFrom(transcriptPath, lastLine);
  if (entries.length === 0) {
    setLastProcessedLine(db, sessionId, totalLines);
    return;
  }
  const turns = groupEntriesIntoTurns(entries);
  const insertTurns = db.transaction(() => {
    const existingMax = db.prepare(
      "SELECT MAX(turn_number) as max_turn FROM conversation_turns WHERE session_id = ?"
    ).get(sessionId);
    let turnNumber = (existingMax.max_turn ?? 0) + 1;
    for (const turn of turns) {
      const toolCallSummaries = turn.toolCalls.map((tc) => ({
        name: tc.toolName,
        input_summary: summarizeToolInput(tc.toolName, tc.input).slice(0, 200),
        is_error: tc.isError ?? false
      }));
      const assistantText = turn.assistantText?.slice(0, 1e4) ?? null;
      addConversationTurn(
        db,
        sessionId,
        turnNumber,
        turn.userPrompt,
        assistantText,
        toolCallSummaries.length > 0 ? JSON.stringify(toolCallSummaries) : null,
        turn.toolCalls.length,
        estimateTokens(turn.userPrompt),
        assistantText ? estimateTokens(assistantText) : 0
      );
      for (const tc of turn.toolCalls) {
        const inputStr = JSON.stringify(tc.input);
        const outputStr = tc.result ?? "";
        const files = extractFilesFromToolCall(tc.toolName, tc.input);
        addToolCallDetail(
          db,
          sessionId,
          turnNumber,
          tc.toolName,
          summarizeToolInput(tc.toolName, tc.input),
          inputStr.length,
          outputStr.length,
          !(tc.isError ?? false),
          files.length > 0 ? files : void 0
        );
      }
      turnNumber++;
    }
  });
  insertTurns();
  setLastProcessedLine(db, sessionId, totalLines);
}
function groupEntriesIntoTurns(entries) {
  const turns = [];
  let currentTurn = null;
  const toolUseMap = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (entry.type === "user" && entry.message && !entry.isMeta) {
      if (currentTurn) {
        turns.push(currentTurn);
      }
      const text = getTextFromBlocks(entry.message.content);
      if (text.trim()) {
        currentTurn = {
          userPrompt: text.trim(),
          assistantText: null,
          toolCalls: []
        };
      }
    } else if (entry.type === "assistant" && entry.message && currentTurn) {
      const text = getTextFromBlocks(entry.message.content);
      if (text.trim()) {
        currentTurn.assistantText = currentTurn.assistantText ? currentTurn.assistantText + "\n" + text.trim() : text.trim();
      }
      for (const block of entry.message.content) {
        if (block.type === "tool_use") {
          const tc = {
            toolName: block.name,
            toolUseId: block.id,
            input: block.input ?? {}
          };
          currentTurn.toolCalls.push(tc);
          toolUseMap.set(tc.toolUseId, tc);
        } else if (block.type === "tool_result") {
          const toolUseId = block.tool_use_id;
          const existing = toolUseMap.get(toolUseId);
          if (existing) {
            existing.result = getToolResultFromBlock(block);
            existing.isError = block.is_error ?? false;
          }
        }
      }
    }
  }
  if (currentTurn) {
    turns.push(currentTurn);
  }
  return turns;
}
function getTextFromBlocks(content) {
  return content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function getToolResultFromBlock(block) {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => typeof b === "object" && b !== null && b.type === "text").map((b) => b.text).join("\n");
  }
  return "";
}
function summarizeToolInput(toolName, input) {
  switch (toolName) {
    case "Read":
      return `Read ${input.file_path ?? ""}`;
    case "Write":
      return `Write ${input.file_path ?? ""}`;
    case "Edit":
      return `Edit ${input.file_path ?? ""}`;
    case "Bash":
      return `$ ${(input.command ?? "").slice(0, 200)}`;
    case "Grep":
      return `Grep "${input.pattern ?? ""}" in ${input.path ?? "."}`;
    case "Glob":
      return `Glob "${input.pattern ?? ""}" in ${input.path ?? "."}`;
    case "Task":
      return `Task: ${(input.description ?? "").slice(0, 100)}`;
    case "WebFetch":
      return `Fetch ${input.url ?? ""}`;
    case "WebSearch":
      return `Search "${input.query ?? ""}"`;
    default:
      return `${toolName}: ${JSON.stringify(input).slice(0, 200)}`;
  }
}
function extractFilesFromToolCall(toolName, input) {
  const filePath = input.file_path;
  if (filePath) return [filePath];
  const path = input.path;
  if (path && !path.startsWith(".") && toolName !== "Grep") return [path];
  return [];
}
function readStdin() {
  return new Promise((resolve8) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve8(data));
    setTimeout(() => resolve8(data), 5e3);
  });
}
main();
