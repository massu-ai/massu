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
  const sleep = opts.sleep ?? busyWaitSync;
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
      sleep(pollIntervalMs);
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
      // `source_dirs` is emitted by `init` (commands/init.ts:417) and existence-checked
      // by config validation (init.ts:868-876), but until 2026-08-14 it survived only via
      // `.passthrough()` — declared in the file, untyped in the schema. `lib/source-layout.ts`
      // derives the index builders' candidate set from it, so it is typed here rather than
      // read as an unknown: a consumer that has to shape-check its own SoT is one branch away
      // from silently contributing `undefined` to a path predicate.
      source_dirs: z2.array(z2.string()).optional(),
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
function l2normalize(vec) {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (norm === 0 || !Number.isFinite(norm)) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}
var init_memory_vector = __esm({
  "src/memory-vector.ts"() {
    "use strict";
  }
});

// src/lib/timestamps.ts
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
var init_timestamps = __esm({
  "src/lib/timestamps.ts"() {
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
function tableExists(db, table) {
  const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return row !== void 0;
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
var RULE_OUTBOUND_TABLES, TELEMETRY_OUTBOUND_TABLE, ALL_OUTBOUND_TABLES, TELEMETRY_OUTBOX_CAP, LEASE_TTL_MS, EVENT_TELEMETRY_CAPPED;
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
    INSERT INTO conversation_turns (session_id, turn_number, user_prompt, assistant_response, tool_calls_json, tool_call_count, prompt_tokens, response_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    turnNumber,
    userPrompt,
    assistantResponse ? assistantResponse.slice(0, 1e4) : null,
    toolCallsJson,
    toolCallCount,
    promptTokens,
    responseTokens,
    nowIso()
  );
  return Number(result.lastInsertRowid);
}
function addToolCallDetail(db, sessionId, turnNumber, toolName, inputSummary, inputSize, outputSize, success, filesInvolved) {
  db.prepare(`
    INSERT INTO tool_call_details (session_id, turn_number, tool_name, tool_input_summary, tool_input_size, tool_output_size, tool_success, files_involved, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    turnNumber,
    toolName,
    inputSummary ? inputSummary.slice(0, 500) : null,
    inputSize,
    outputSize,
    success ? 1 : 0,
    filesInvolved ? JSON.stringify(filesInvolved) : null,
    nowIso()
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
    init_timestamps();
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

// src/hooks/quality-event.ts
init_memory_db();

// src/hooks/lib/tool-response.ts
function asString(v) {
  return typeof v === "string" ? v : "";
}
function fromContentBlocks(arr) {
  const parts = [];
  for (const block of arr) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block && typeof block === "object") {
      const t = asString(block.text);
      if (t) parts.push(t);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}
function textFromObject(o) {
  if ("stdout" in o || "stderr" in o) {
    const out = asString(o.stdout);
    const err = asString(o.stderr);
    return err ? out ? `${out}
${err}` : err : out;
  }
  const file = o.file;
  if (file && typeof file === "object") {
    const c = asString(file.content);
    if (c) return c;
  }
  const content = o.content;
  if (typeof content === "string" && content) return content;
  if (Array.isArray(content)) {
    const blocks = fromContentBlocks(content);
    if (blocks) return blocks;
  }
  if ("structuredPatch" in o || "oldString" in o || "newString" in o) {
    const path = asString(o.filePath);
    const newStr = asString(o.newString);
    return [path, newStr].filter(Boolean).join("\n");
  }
  for (const k of ["text", "message", "output", "result", "stdout"]) {
    const v = asString(o[k]);
    if (v) return v;
  }
  try {
    return JSON.stringify(o);
  } catch {
    return "";
  }
}
function detectError(raw, text) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw;
    if (o.is_error === true || o.isError === true) return true;
    if (o.interrupted === true) return true;
  }
  return /^Error: (Exit code \d+|.*failed)/i.test(text.trimStart());
}
function normalizeToolResponse(raw) {
  if (raw === null || raw === void 0 || raw === "") {
    return { text: "", isError: false, shape: "empty" };
  }
  let text;
  let shape;
  if (typeof raw === "string") {
    text = raw;
    shape = "string";
  } else if (Array.isArray(raw)) {
    shape = "array";
    const blocks = fromContentBlocks(raw);
    if (blocks !== null) {
      text = blocks;
    } else {
      try {
        text = JSON.stringify(raw);
      } catch {
        text = "";
      }
    }
  } else if (typeof raw === "object") {
    shape = "object";
    try {
      text = textFromObject(raw);
    } catch {
      text = "";
    }
  } else {
    shape = "string";
    text = String(raw);
  }
  return { text, isError: detectError(raw, text), shape };
}
function toolResponseText(raw) {
  return normalizeToolResponse(raw).text;
}

// src/hooks/quality-event.ts
init_hook_failure_signal();
init_timestamps();

// src/hooks/lib/is-direct-invocation.ts
import { pathToFileURL } from "url";
function isDirectInvocation(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return moduleUrl === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

// src/hooks/quality-event.ts
var TEST_FAILURE_PATTERNS = [
  /\bFAIL\b/,
  /✗/,
  /\bfailed\b/i,
  /\bError:/
];
var TYPE_ERROR_PATTERNS = [
  /error TS\d+/,
  /\btsc\b.*error/i
];
var BUILD_FAILURE_PATTERNS = [
  /Build failed/i,
  /\besbuild\b.*error/i,
  /\besbuild\b.*failed/i
];
function detectQualitySignals(toolResponse) {
  const signals = [];
  const response = toolResponse ?? "";
  for (const pattern of TEST_FAILURE_PATTERNS) {
    if (pattern.test(response)) {
      const match = response.match(pattern);
      signals.push({
        event_type: "test_failure",
        details: match ? match[0].slice(0, 500) : "Test failure detected"
      });
      break;
    }
  }
  for (const pattern of TYPE_ERROR_PATTERNS) {
    if (pattern.test(response)) {
      const match = response.match(pattern);
      signals.push({
        event_type: "type_error",
        details: match ? match[0].slice(0, 500) : "TypeScript error detected"
      });
      break;
    }
  }
  for (const pattern of BUILD_FAILURE_PATTERNS) {
    if (pattern.test(response)) {
      const match = response.match(pattern);
      signals.push({
        event_type: "build_failure",
        details: match ? match[0].slice(0, 500) : "Build failure detected"
      });
      break;
    }
  }
  return signals;
}
async function main() {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input);
    const { session_id, tool_name, tool_response } = hookInput;
    const signals = detectQualitySignals(toolResponseText(tool_response));
    if (signals.length === 0) {
      process.exit(0);
      return;
    }
    const db = getMemoryDb();
    try {
      const stmt = db.prepare(`
        INSERT INTO quality_events (session_id, event_type, tool_name, details, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const signal of signals) {
        stmt.run(session_id, signal.event_type, tool_name, signal.details, nowIso());
      }
    } finally {
      db.close();
    }
  } catch (err) {
    recordHookFailure("quality-event", err);
  }
  process.exit(0);
}
function readStdin() {
  return new Promise((resolve5) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve5(data));
    setTimeout(() => resolve5(data), 3e3);
  });
}
if (isDirectInvocation(import.meta.url)) {
  main();
}
