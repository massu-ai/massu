#!/usr/bin/env node
import{createRequire as __cr}from"module";const require=__cr(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
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

// src/memory-authorship.ts
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { readFileSync as readFileSync6, writeFileSync as writeFileSync3, existsSync as existsSync9, mkdirSync as mkdirSync7, chmodSync as chmodSync3, statSync as statSync2 } from "fs";
import { homedir as homedir4 } from "os";
import { resolve as resolve5 } from "path";
function renderKeyPath(home = homedir4()) {
  return resolve5(home, ".massu", "render-key");
}
function readRenderKey(home = homedir4()) {
  const p = renderKeyPath(home);
  try {
    if (!existsSync9(p)) return void 0;
    const raw = readFileSync6(p);
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
    const dir = resolve5(home, ".massu");
    mkdirSync7(dir, { recursive: true, mode: 448 });
    try {
      chmodSync3(dir, 448);
    } catch {
    }
    const key = randomBytes(32);
    writeFileSync3(p, key, { mode: 384 });
    try {
      chmodSync3(p, 384);
    } catch {
    }
    return key;
  } catch {
    return void 0;
  }
}
function mintAuthorship(body, home = homedir4()) {
  try {
    const key = ensureRenderKey(home);
    if (!key) return null;
    return createHmac("sha256", key).update(body, "utf8").digest("hex");
  } catch {
    return null;
  }
}
function verifyAuthorship(body, frontmatter, storeRow, home = homedir4()) {
  try {
    if (storeRow?.adopted_human_at_epoch != null) return false;
    const key = readRenderKey(home);
    if (!key) return false;
    const claimed = frontmatter?.[RENDER_MAC_KEY];
    if (typeof claimed !== "string" || claimed.length === 0) return false;
    const expected = createHmac("sha256", key).update(body, "utf8").digest("hex");
    const a = Buffer.from(claimed, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
function extractRenderMac(frontmatter) {
  const v = frontmatter?.[RENDER_MAC_KEY];
  return typeof v === "string" && v.length > 0 ? v : null;
}
var RENDER_MAC_KEY;
var init_memory_authorship = __esm({
  "src/memory-authorship.ts"() {
    "use strict";
    RENDER_MAC_KEY = "massu_render_mac";
  }
});

// src/lib/safe-write.ts
import {
  writeFileSync as writeFileSync4,
  renameSync,
  openSync as openSync2,
  fsyncSync as fsyncSync2,
  closeSync as closeSync2,
  existsSync as existsSync10,
  realpathSync,
  unlinkSync as unlinkSync2,
  accessSync as accessSync2,
  statSync as statSync3,
  chmodSync as chmodSync4,
  constants
} from "fs";
import { dirname as dirname8, resolve as resolve6, relative, isAbsolute, basename as basename3, sep } from "path";
import { createHash as createHash2 } from "crypto";
function assertContainedIn(rootDir, candidate, opts = {}) {
  if (candidate.includes("\0")) {
    throw new PathEscapeError("path contains a NUL byte");
  }
  const root = resolve6(rootDir);
  const abs = resolve6(root, candidate);
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
  const root = resolve6(rootDir);
  const abs = resolve6(root, candidate);
  const rel = relative(root, abs);
  if (rel === "" && !opts.allowRoot) return false;
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  let probe = abs;
  while (!existsSync10(probe) && probe.length > 1) {
    const parent = dirname8(probe);
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
  const dir = dirname8(destPath);
  const tmp = resolve6(dir, `.${basename3(destPath)}.massu-tmp-${process.pid}`);
  let destMode;
  if (existsSync10(destPath)) {
    accessSync2(destPath, constants.W_OK);
    destMode = statSync3(destPath).mode & 511;
  }
  let fd;
  try {
    writeFileSync4(tmp, contents, "utf-8");
    if (destMode !== void 0) chmodSync4(tmp, destMode);
    fd = openSync2(tmp, "r+");
    fsyncSync2(fd);
    closeSync2(fd);
    fd = void 0;
    renameSync(tmp, destPath);
  } catch (err) {
    if (fd !== void 0) {
      try {
        closeSync2(fd);
      } catch {
      }
    }
    try {
      if (existsSync10(tmp)) unlinkSync2(tmp);
    } catch {
    }
    throw err;
  }
}
function deriveSlug(input) {
  const cleaned = input.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 60) || "rule_candidate";
}
function memoryFileSlug(name, discriminator) {
  const base = deriveSlug(name);
  if (!discriminator) {
    if (!SLUG_ALLOWED.test(base)) throw new PathEscapeError(`name does not slug safely: ${name}`);
    return base;
  }
  const h = createHash2("sha256").update(discriminator, "utf-8").digest("hex").slice(0, 8);
  const slug = `${base.slice(0, 51)}_${h}`;
  if (!SLUG_ALLOWED.test(slug)) throw new PathEscapeError(`name does not slug safely: ${name}`);
  return slug;
}
function assertSingleLine(line, maxLen = 300) {
  if (/[\r\n]/.test(line)) {
    throw new UnsafeLineError("index line must not contain a newline");
  }
  if (line.includes("\0")) {
    throw new UnsafeLineError("index line must not contain a NUL byte");
  }
  if (line.length > maxLen) {
    throw new UnsafeLineError(`index line exceeds ${maxLen} chars (got ${line.length})`);
  }
  return line;
}
var PathEscapeError, UnsafeLineError, RESERVED_DEVICE_NAMES, SLUG_ALLOWED;
var init_safe_write = __esm({
  "src/lib/safe-write.ts"() {
    "use strict";
    PathEscapeError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "PathEscapeError";
      }
    };
    UnsafeLineError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "UnsafeLineError";
      }
    };
    RESERVED_DEVICE_NAMES = /* @__PURE__ */ new Set([
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
    SLUG_ALLOWED = /^[a-z0-9_]+$/;
  }
});

// src/memory-index-region.ts
import { readFileSync as readFileSync7, existsSync as existsSync11 } from "fs";
import { dirname as dirname9, join as join6 } from "path";
function parseRegion(content) {
  const begins = countOccurrences(content, BEGIN_SENTINEL);
  const ends = countOccurrences(content, END_SENTINEL);
  if (begins === 0 && ends === 0) return { kind: "absent" };
  if (begins !== 1 || ends !== 1) {
    return {
      kind: "damaged",
      why: `expected exactly one of each sentinel, found ${begins} begin / ${ends} end`
    };
  }
  const beginIdx = content.indexOf(BEGIN_SENTINEL);
  const endIdx = content.indexOf(END_SENTINEL);
  if (endIdx <= beginIdx) {
    return { kind: "damaged", why: "end sentinel precedes begin sentinel" };
  }
  return { kind: "valid", beginIdx, endIdx };
}
function countOccurrences(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}
function renderRegion(content, lines) {
  const state = parseRegion(content);
  if (state.kind === "damaged") {
    throw new RegionRefused(
      `MEMORY.md sentinels are damaged (${state.why}) \u2014 refusing to write any bytes. A region computed from a damaged sentinel pair erases everything past it.`,
      "damaged_sentinels"
    );
  }
  for (const line of lines) assertSingleLine(line);
  const body = lines.length > 0 ? `
${lines.join("\n")}
` : "\n";
  if (state.kind === "absent") {
    const sep2 = content.endsWith("\n") ? "" : "\n";
    return `${content}${sep2}
${BEGIN_SENTINEL}${body}${END_SENTINEL}
`;
  }
  const before = content.slice(0, state.beginIdx + BEGIN_SENTINEL.length);
  const after = content.slice(state.endIdx);
  return `${before}${body}${after}`;
}
function assertOutsideRegionUnchanged(pre, post) {
  const preState = parseRegion(pre);
  const postState = parseRegion(post);
  if (postState.kind === "damaged") {
    throw new RegionRefused("post-write MEMORY.md has damaged sentinels", "post_write_damaged");
  }
  if (preState.kind === "absent") {
    if (!post.startsWith(pre.endsWith("\n") ? pre : `${pre}
`)) {
      throw new RegionRefused(
        "MEMORY.md sentinel creation modified pre-existing bytes",
        "creation_mutated_prefix"
      );
    }
    return;
  }
  if (preState.kind !== "valid" || postState.kind !== "valid") {
    throw new RegionRefused("MEMORY.md region could not be validated", "unvalidatable");
  }
  const preHead = pre.slice(0, preState.beginIdx);
  const postHead = post.slice(0, postState.beginIdx);
  const preTail = pre.slice(preState.endIdx);
  const postTail = post.slice(postState.endIdx);
  if (preHead !== postHead) {
    throw new RegionRefused(
      "MEMORY.md bytes ABOVE the managed region changed \u2014 aborting",
      "head_mutated"
    );
  }
  if (preTail !== postTail) {
    throw new RegionRefused(
      "MEMORY.md bytes BELOW the managed region changed \u2014 aborting",
      "tail_mutated"
    );
  }
}
function memoryIndexLockPath(memoryDir) {
  return join6(dirname9(memoryDir), ".massu-memory-index.lock");
}
function withMemoryIndexLock(memoryDir, fn) {
  return withFileLockSync(memoryIndexLockPath(memoryDir), fn, {
    blockMs: LOCK_BLOCK_MS,
    staleMs: LOCK_STALE_MS,
    errorFactory: (lockPath, holderPid) => new MemoryIndexLockBusy(
      `memory index is locked by pid ${holderPid ?? "unknown"} (${lockPath}) \u2014 skipping the render this session. Renders are idempotent; the next session retries.`
    )
  });
}
function readMemoryIndex(indexPath) {
  if (!existsSync11(indexPath)) return void 0;
  try {
    return readFileSync7(indexPath, "utf8");
  } catch {
    return void 0;
  }
}
function writeMemoryIndex(indexPath, pre, post) {
  assertOutsideRegionUnchanged(pre, post);
  atomicWriteFileSync(indexPath, post);
}
var BEGIN_SENTINEL, END_SENTINEL, RegionRefused, LOCK_BLOCK_MS, LOCK_STALE_MS, MemoryIndexLockBusy;
var init_memory_index_region = __esm({
  "src/memory-index-region.ts"() {
    "use strict";
    init_fileLock();
    init_safe_write();
    BEGIN_SENTINEL = "<!-- massu:learned:begin -->";
    END_SENTINEL = "<!-- massu:learned:end -->";
    RegionRefused = class extends Error {
      constructor(message, reason) {
        super(message);
        this.reason = reason;
        this.name = "RegionRefused";
      }
      reason;
    };
    LOCK_BLOCK_MS = 2e3;
    LOCK_STALE_MS = 3e4;
    MemoryIndexLockBusy = class extends Error {
      constructor(message) {
        super(message);
        this.name = "MemoryIndexLockBusy";
      }
    };
  }
});

// src/memory-origin.ts
function isLocalOrigin(o) {
  return o === LOCAL_ORIGIN;
}
var LOCAL_ORIGIN;
var init_memory_origin = __esm({
  "src/memory-origin.ts"() {
    "use strict";
    LOCAL_ORIGIN = "local";
  }
});

// src/rule-candidate-snapshot.ts
import { existsSync as existsSync12, readFileSync as readFileSync8, writeFileSync as writeFileSync5, unlinkSync as unlinkSync3 } from "fs";
function takeSnapshots(paths) {
  const out = /* @__PURE__ */ new Map();
  for (const p of paths) {
    if (existsSync12(p)) out.set(p, readFileSync8(p, "utf-8"));
    else out.set(p, null);
  }
  return out;
}
function restoreSnapshots(snapshot) {
  const errors = [];
  for (const [path, content] of snapshot) {
    try {
      if (content === null) {
        if (existsSync12(path)) unlinkSync3(path);
      } else {
        writeFileSync5(path, content, "utf-8");
      }
    } catch (err) {
      errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { errors };
}
var init_rule_candidate_snapshot = __esm({
  "src/rule-candidate-snapshot.ts"() {
    "use strict";
  }
});

// src/memory-file-ingest.ts
import { readFileSync as readFileSync10, existsSync as existsSync14, readdirSync as readdirSync2 } from "fs";
import { join as join8 } from "path";
import { parse as parseYaml2 } from "yaml";
import { basename as pathBasename } from "path";
import { createHash as createHash3 } from "crypto";
function stripMdExtension(filePathOrName) {
  return pathBasename(filePathOrName).replace(/\.md$/, "");
}
function parseFrontmatterLoosely(raw) {
  const out = {};
  const metadata = {};
  const WANTED = /* @__PURE__ */ new Set(["name", "description", "type", "confidence"]);
  let inMetadata = false;
  for (const line of raw.split("\n")) {
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true;
      continue;
    }
    if (/^[A-Za-z_][\w-]*:/.test(line)) inMetadata = false;
    const m = line.match(/^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const [, indent, key, rawValue] = m;
    if (!WANTED.has(key)) continue;
    let value = rawValue.trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1 || value.startsWith("'") && value.endsWith("'") && value.length > 1) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    if (indent.length > 0 && inMetadata) metadata[key] = value;
    else if (indent.length === 0) out[key] = value;
  }
  if (Object.keys(metadata).length > 0) out.metadata = metadata;
  return out;
}
function readMemoryFileFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return void 0;
  try {
    return parseYaml2(match[1]) ?? void 0;
  } catch {
    return parseFrontmatterLoosely(match[1]);
  }
}
function readMemoryKey(fm, key) {
  const metadata = fm.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const nested = metadata[key];
    if (nested != null) return String(nested);
  }
  const top = fm[key];
  if (top != null) return String(top);
  return void 0;
}
function auditMemoryFileEvent(db, sessionId, eventType, detail) {
  if (!sessionId) return;
  try {
    db.prepare(
      `INSERT INTO audit_log (session_id, event_type, actor, evidence)
       VALUES (?, ?, 'hook', ?)`
    ).run(sessionId, eventType, detail);
  } catch {
  }
}
function upsertMemoryFileMirror(db, f) {
  const now = Math.floor(Date.now() / 1e3);
  const existing = db.prepare(
    `SELECT id, content_hash, ingest_schema_version FROM memory_files WHERE rel_path = ?`
  ).get(f.relPath);
  if (existing && existing.content_hash === f.contentHash && existing.ingest_schema_version === INGEST_SCHEMA_VERSION) {
    return "unchanged";
  }
  if (existing) {
    db.prepare(
      `UPDATE memory_files
          SET name = ?, raw = ?, frontmatter_json = ?, body = ?, content_hash = ?,
              ingest_schema_version = ?, synced_at_epoch = ?,
              expired_at_epoch = NULL
        WHERE id = ?`
    ).run(
      f.name,
      f.raw,
      f.frontmatterJson,
      f.body,
      f.contentHash,
      INGEST_SCHEMA_VERSION,
      now,
      existing.id
    );
    return "updated";
  }
  db.prepare(
    `INSERT INTO memory_files
       (rel_path, name, raw, frontmatter_json, body, content_hash, ingest_schema_version, synced_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    f.relPath,
    f.name,
    f.raw,
    f.frontmatterJson,
    f.body,
    f.contentHash,
    INGEST_SCHEMA_VERSION,
    now
  );
  return "inserted";
}
function ingestMemoryFile(db, sessionId, filePath) {
  if (!existsSync14(filePath)) return "skipped";
  const content = readFileSync10(filePath, "utf-8");
  if (Buffer.byteLength(content, "utf-8") > MAX_MEMORY_FILE_BYTES) {
    process.stderr.write(
      `[massu] memory file exceeds ${MAX_MEMORY_FILE_BYTES} bytes, not ingested: ${filePath}
`
    );
    return "skipped";
  }
  const basename5 = stripMdExtension(filePath);
  const fm = readMemoryFileFrontmatter(content);
  let name = basename5;
  let description = "";
  let type = "discovery";
  let confidence;
  if (fm) {
    name = fm.name ?? basename5;
    description = fm.description ?? "";
    type = readMemoryKey(fm, "type") ?? "discovery";
    const rawConfidence = readMemoryKey(fm, "confidence");
    confidence = rawConfidence != null ? Number(rawConfidence) : void 0;
  }
  const obsType = mapMemoryTypeToObservationType(type);
  const importance = confidence != null ? Math.max(1, Math.min(5, Math.round(confidence * 4 + 1))) : 4;
  const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
  const body = bodyMatch ? bodyMatch[1] : "";
  const title = `${MEMORY_FILE_TITLE_PREFIX}${name}`;
  const detail = description ? `${description}

${body}` : body;
  const relPath = pathBasename(filePath);
  const contentHash = createHash3("sha256").update(content, "utf-8").digest("hex");
  const mirror = upsertMemoryFileMirror(db, {
    relPath,
    name,
    raw: content,
    frontmatterJson: fm ? JSON.stringify(fm) : null,
    body,
    contentHash
  });
  const existing = db.prepare(
    "SELECT id, type FROM observations WHERE title = ? LIMIT 1"
  ).get(title);
  const projectionCurrent = existing !== void 0 && existing.type === obsType;
  if (mirror === "unchanged" && projectionCurrent) {
    db.prepare(
      `UPDATE observations
          SET expired_at = NULL, expired_at_epoch = NULL,
              valid_to = NULL, valid_to_epoch = NULL
        WHERE title = ? AND expired_at IS NOT NULL`
    ).run(title);
    return "skipped";
  }
  if (existing) {
    db.prepare(
      `UPDATE observations
          SET type = ?, detail = ?, importance = ?,
              expired_at = NULL, expired_at_epoch = NULL,
              valid_to = NULL, valid_to_epoch = NULL
        WHERE id = ?`
    ).run(obsType, detail, importance, existing.id);
    auditMemoryFileEvent(db, sessionId, "memory_file_ingested", relPath);
    return "updated";
  } else {
    addObservation(db, sessionId, obsType, title, detail, { importance });
    auditMemoryFileEvent(db, sessionId, "memory_file_ingested", relPath);
    return "inserted";
  }
}
function backfillMemoryFiles(db, memoryDir, sessionId) {
  const stats = { inserted: 0, updated: 0, skipped: 0, total: 0 };
  if (!existsSync14(memoryDir)) return stats;
  const files = readdirSync2(memoryDir).filter(
    (f) => f.endsWith(".md") && f !== "MEMORY.md"
  );
  stats.total = files.length;
  const sid = sessionId ?? `backfill-${Date.now()}`;
  for (const file of files) {
    const result = ingestMemoryFile(db, sid, join8(memoryDir, file));
    stats[result]++;
  }
  return stats;
}
function reconcileMemoryFileObservations(db, memoryDir, sessionId) {
  try {
    if (!existsSync14(memoryDir)) return 0;
    let entries;
    try {
      entries = readdirSync2(memoryDir);
    } catch {
      return 0;
    }
    const liveNames = /* @__PURE__ */ new Set();
    const files = entries.filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    for (const file of files) {
      liveNames.add(stripMdExtension(file));
      try {
        const content = readFileSync10(join8(memoryDir, file), "utf-8");
        const fm = readMemoryFileFrontmatter(content);
        if (fm && typeof fm.name === "string" && fm.name) liveNames.add(fm.name);
      } catch {
      }
    }
    const now = Math.floor(Date.now() / 1e3);
    const iso = new Date(now * 1e3).toISOString();
    const liveTitles = [...liveNames].map((n) => `${MEMORY_FILE_TITLE_PREFIX}${n}`);
    if (liveTitles.length === 0) {
      const res2 = db.prepare(
        `UPDATE observations
              SET expired_at = ?, expired_at_epoch = ?, valid_to = ?, valid_to_epoch = ?
            WHERE title LIKE ? AND expired_at IS NULL`
      ).run(iso, now, iso, now, MEMORY_FILE_TITLE_LIKE);
      return res2.changes;
    }
    const placeholders = liveTitles.map(() => "?").join(",");
    const res = db.prepare(
      `UPDATE observations
            SET expired_at = ?, expired_at_epoch = ?, valid_to = ?, valid_to_epoch = ?
          WHERE title LIKE ? AND expired_at IS NULL AND title NOT IN (${placeholders})`
    ).run(iso, now, iso, now, MEMORY_FILE_TITLE_LIKE, ...liveTitles);
    if (res.changes > 0) {
      auditMemoryFileEvent(db, sessionId, "memory_file_expired", String(res.changes));
    }
    return res.changes;
  } catch {
    return 0;
  }
}
function mapMemoryTypeToObservationType(memoryType) {
  switch (memoryType) {
    case "user":
    case "feedback":
      return "decision";
    case "project":
      return "feature";
    case "reference":
      return "discovery";
    default:
      return "discovery";
  }
}
var INGEST_SCHEMA_VERSION, MAX_MEMORY_FILE_BYTES;
var init_memory_file_ingest = __esm({
  "src/memory-file-ingest.ts"() {
    "use strict";
    init_memory_db();
    INGEST_SCHEMA_VERSION = 1;
    MAX_MEMORY_FILE_BYTES = 1e6;
  }
});

// src/consolidation-config.ts
function resolveConsolidationConfig() {
  try {
    const c = getConfig().memory?.consolidation;
    if (!c) return { ...DEFAULT_CONSOLIDATION_CONFIG };
    return { ...DEFAULT_CONSOLIDATION_CONFIG, ...c };
  } catch {
    return { ...DEFAULT_CONSOLIDATION_CONFIG };
  }
}
var DEFAULT_CONSOLIDATION_CONFIG;
var init_consolidation_config = __esm({
  "src/consolidation-config.ts"() {
    "use strict";
    init_config();
    DEFAULT_CONSOLIDATION_CONFIG = {
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
  }
});

// src/memory-render-path.ts
function computeRenderPath(memoryDir, src, ownerOfRelPath) {
  if (!/[a-z0-9]/i.test(src.name)) {
    throw new RenderPathRefused(
      `name has no alphanumeric content and cannot become a filename: ${JSON.stringify(src.name)}`,
      "unsluggable_name"
    );
  }
  const base = deriveSlug(src.name);
  if (!base || !SLUG_ALLOWED.test(base)) {
    throw new RenderPathRefused(
      `name does not slug to a safe filename: ${JSON.stringify(src.name)}`,
      "unsluggable_name"
    );
  }
  const candidates = [
    `${base}.md`,
    // Deterministic discriminator, keyed on the memory's own identity.
    `${memoryFileSlug(src.name, `${src.observationId}:${src.title}`)}.md`
  ];
  for (const relPath of candidates) {
    const owner = ownerOfRelPath(relPath);
    if (owner !== void 0 && owner !== src.observationId) continue;
    try {
      const absPath = assertContainedIn(memoryDir, relPath);
      return { absPath, relPath };
    } catch (err) {
      throw new RenderPathRefused(
        `refused to render ${JSON.stringify(src.name)}: ${err.message}`,
        err instanceof PathEscapeError ? "path_escape" : "containment_error"
      );
    }
  }
  throw new RenderPathRefused(
    `slug collision could not be resolved for ${JSON.stringify(src.name)}`,
    "unresolvable_collision"
  );
}
function relPathOwnerLookup(db) {
  const stmt = db.prepare(
    `SELECT observation_id FROM memory_files WHERE rel_path = ? COLLATE NOCASE`
  );
  return (relPath) => {
    const row = stmt.get(relPath);
    return row?.observation_id ?? void 0;
  };
}
var RenderPathRefused;
var init_memory_render_path = __esm({
  "src/memory-render-path.ts"() {
    "use strict";
    init_safe_write();
    RenderPathRefused = class extends Error {
      constructor(message, reason) {
        super(message);
        this.reason = reason;
        this.name = "RenderPathRefused";
      }
      reason;
    };
  }
});

// src/memory-tombstones.ts
import { readFileSync as readFileSync13, appendFileSync as appendFileSync3, existsSync as existsSync17 } from "fs";
import { join as join11 } from "path";
function tombstoneLedgerPath(memoryDir) {
  return join11(memoryDir, TOMBSTONE_LEDGER);
}
function readTombstones(memoryDir) {
  const out = /* @__PURE__ */ new Map();
  const p = tombstoneLedgerPath(memoryDir);
  if (!existsSync17(p)) return out;
  let raw;
  try {
    raw = readFileSync13(p, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed);
      if (typeof e?.rel_path === "string" && e.rel_path.length > 0) {
        out.set(e.rel_path.toLowerCase(), e);
      }
    } catch {
      continue;
    }
  }
  return out;
}
function isTombstoned(memoryDir, relPath) {
  return readTombstones(memoryDir).has(relPath.toLowerCase());
}
var TOMBSTONE_LEDGER;
var init_memory_tombstones = __esm({
  "src/memory-tombstones.ts"() {
    "use strict";
    TOMBSTONE_LEDGER = ".massu-tombstones.jsonl";
  }
});

// src/memory-llm.ts
function containsSecret(text) {
  for (const [re, , name] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    const hit = re.test(text);
    re.lastIndex = 0;
    if (hit) return { matched: true, patternName: name };
  }
  return { matched: false };
}
var CREDENTIAL_LABELS, LABELLED_CREDENTIAL, SECRET_PATTERNS;
var init_memory_llm = __esm({
  "src/memory-llm.ts"() {
    "use strict";
    init_consolidation_config();
    CREDENTIAL_LABELS = ["api[_-]?key", "secret", "password", "token"];
    LABELLED_CREDENTIAL = new RegExp(
      `\\b[A-Za-z0-9_-]*(?:${CREDENTIAL_LABELS.join("|")})["'\\s:=]+[A-Za-z0-9_\\-/+]{16,}`,
      "gi"
    );
    SECRET_PATTERNS = [
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
  }
});

// src/memory-backup.ts
import {
  readdirSync as readdirSync3,
  mkdirSync as mkdirSync11,
  copyFileSync as copyFileSync2,
  statSync as statSync4,
  existsSync as existsSync18,
  rmSync as rmSync5,
  readFileSync as readFileSync14
} from "fs";
import { homedir as homedir10 } from "os";
import { join as join12, resolve as resolve7 } from "path";
function backupsRoot(home = homedir10()) {
  return resolve7(home, ".massu", "memory-backups");
}
function backupStamp2(nowMs) {
  return new Date(nowMs).toISOString().replace(/:/g, "-");
}
function newestMtimeMs(dir) {
  if (!existsSync18(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync3(dir)) {
    const p = join12(dir, entry);
    try {
      const st = statSync4(p);
      if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      continue;
    }
  }
  return newest;
}
function listBackups(home = homedir10()) {
  const root = backupsRoot(home);
  if (!existsSync18(root)) return [];
  const out = [];
  for (const stamp of readdirSync3(root)) {
    const dir = join12(root, stamp);
    try {
      const st = statSync4(dir);
      if (!st.isDirectory()) continue;
      out.push({ stamp, dir, createdMs: st.mtimeMs });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.createdMs - a.createdMs);
}
function hasFreshBackup(memoryDir, home = homedir10()) {
  const backups = listBackups(home);
  if (backups.length === 0) return false;
  const newestChange = newestMtimeMs(memoryDir);
  return backups[0].createdMs >= newestChange;
}
function takeBackup(memoryDir, nowMs, home = homedir10(), retention = DEFAULT_RETENTION2) {
  if (!existsSync18(memoryDir)) {
    throw new BackupError(`memory directory does not exist: ${memoryDir}`);
  }
  const stamp = backupStamp2(nowMs);
  const dir = join12(backupsRoot(home), stamp);
  try {
    mkdirSync11(dir, { recursive: true, mode: 448 });
    for (const entry of readdirSync3(memoryDir)) {
      const srcPath = join12(memoryDir, entry);
      try {
        if (!statSync4(srcPath).isFile()) continue;
      } catch {
        continue;
      }
      copyFileSync2(srcPath, join12(dir, entry));
    }
  } catch (err) {
    throw new BackupError(`backup failed: ${err.message}`);
  }
  pruneBackups(home, retention);
  return { stamp, dir, createdMs: nowMs };
}
function pruneBackups(home = homedir10(), retention = DEFAULT_RETENTION2) {
  const backups = listBackups(home);
  for (const stale of backups.slice(Math.max(retention, 1))) {
    try {
      rmSync5(stale.dir, { recursive: true, force: true });
    } catch {
    }
  }
}
var DEFAULT_RETENTION2, BackupError;
var init_memory_backup = __esm({
  "src/memory-backup.ts"() {
    "use strict";
    DEFAULT_RETENTION2 = 10;
    BackupError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "BackupError";
      }
    };
  }
});

// src/memory-files-config.ts
function resolveMemoryFilesConfig() {
  try {
    const c = getConfig().memory?.files;
    if (!c) return { ...DEFAULT_MEMORY_FILES_CONFIG };
    return { ...DEFAULT_MEMORY_FILES_CONFIG, ...c };
  } catch {
    return { ...DEFAULT_MEMORY_FILES_CONFIG };
  }
}
var DEFAULT_MEMORY_FILES_CONFIG;
var init_memory_files_config = __esm({
  "src/memory-files-config.ts"() {
    "use strict";
    init_config();
    DEFAULT_MEMORY_FILES_CONFIG = {
      enabled: true,
      // ⛔ Never flip this default. See the module doc.
      renderEnabled: false,
      renderMaxFilesPerSession: 3,
      renderMinImportance: 4,
      indexSection: "Learned by Massu",
      indexMaxLines: 50
    };
  }
});

// src/memory-renderer.ts
var memory_renderer_exports = {};
__export(memory_renderer_exports, {
  composeFile: () => composeFile,
  renderMemoryFiles: () => renderMemoryFiles,
  stripFrontmatter: () => stripFrontmatter
});
import { existsSync as existsSync19, readFileSync as readFileSync15 } from "fs";
import { join as join13 } from "path";
import { homedir as homedir11 } from "os";
import { createHash as createHash5 } from "crypto";
function renderMemoryFiles(db, candidates, opts) {
  const config = opts.config ?? resolveMemoryFilesConfig();
  if (!config.renderEnabled) {
    return EMPTY("render_disabled");
  }
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? Date.now();
  const home = opts.home ?? homedir11();
  const audit = opts.audit ?? (() => {
  });
  const { memoryDir } = opts;
  if (!existsSync19(memoryDir)) {
    return EMPTY("no_memory_dir");
  }
  try {
    return withMemoryIndexLock(
      memoryDir,
      () => renderLocked(db, candidates, { ...opts, dryRun, now, home, config, audit })
    );
  } catch (err) {
    if (err instanceof MemoryIndexLockBusy) {
      return EMPTY("lock_busy");
    }
    audit("memory_file_render_refused", { reason: "unexpected_error", error: String(err) });
    return EMPTY("error");
  }
}
function renderLocked(db, candidates, o) {
  const { memoryDir, dryRun, now, home, config, audit } = o;
  const refusals = [];
  let tombstones;
  try {
    tombstones = readTombstones(memoryDir);
  } catch {
    return EMPTY("tombstone_ledger_unreadable");
  }
  const ownerOf = relPathOwnerLookup(db);
  const planned = [];
  for (const c of candidates) {
    if (!isLocalOrigin(c.origin)) {
      refusals.push({ name: c.name, reason: "non_local_origin", detail: c.origin || "unknown" });
      audit("memory_file_render_refused", { name: c.name, reason: "non_local_origin" });
      continue;
    }
    if (c.importance < config.renderMinImportance) {
      refusals.push({ name: c.name, reason: "below_min_importance" });
      continue;
    }
    let scan;
    try {
      scan = containsSecret(c.body);
    } catch {
      scan = { matched: true, patternName: "SCANNER_ERROR" };
    }
    if (scan.matched) {
      refusals.push({ name: c.name, reason: "secret_detected", detail: scan.patternName });
      audit("memory_file_render_refused", {
        name: c.name,
        reason: "secret_detected",
        pattern: scan.patternName
      });
      continue;
    }
    let relPath;
    let absPath;
    try {
      const p = computeRenderPath(memoryDir, c, ownerOf);
      relPath = p.relPath;
      absPath = p.absPath;
    } catch (err) {
      const reason = err instanceof RenderPathRefused ? err.reason : "path_error";
      refusals.push({ name: c.name, reason, detail: err.message });
      audit("memory_file_render_refused", { name: c.name, reason });
      continue;
    }
    if (tombstones.has(relPath.toLowerCase()) || isTombstoned(memoryDir, relPath)) {
      refusals.push({ name: c.name, reason: "tombstoned" });
      continue;
    }
    if (existsSync19(absPath)) {
      const existing = readFileSync15(absPath, "utf8");
      const fm = readMemoryFileFrontmatter(existing);
      const storeRow = db.prepare(
        `SELECT massu_authored, massu_render_mac, adopted_human_at_epoch
             FROM memory_files WHERE rel_path = ? COLLATE NOCASE`
      ).get(relPath);
      const body = stripFrontmatter(existing);
      const ours = verifyAuthorship(body, fm, storeRow ?? null, home);
      if (!ours) {
        refusals.push({ name: c.name, reason: "human_authored" });
        audit("memory_file_render_refused", { name: c.name, rel_path: relPath, reason: "human_authored" });
        continue;
      }
      const next = composeFile(c, home);
      if (next !== null && next === existing) continue;
    }
    const content = composeFile(c, home);
    if (content === null) {
      refusals.push({ name: c.name, reason: "no_render_key" });
      continue;
    }
    planned.push({ c, relPath, absPath, content });
    if (planned.length >= config.renderMaxFilesPerSession) break;
  }
  const indexLines = buildIndexLines(db, memoryDir, planned, config);
  if (dryRun) {
    return {
      enabled: true,
      dryRun: true,
      written: planned.map((p) => p.relPath),
      refusals,
      indexLines,
      bytesWritten: 0
    };
  }
  if (planned.length === 0 && indexLines.length === 0) {
    return { enabled: true, dryRun: false, written: [], refusals, indexLines: [], bytesWritten: 0 };
  }
  if (!hasFreshBackup(memoryDir, home)) {
    try {
      takeBackup(memoryDir, now, home);
    } catch (err) {
      audit("memory_file_render_refused", {
        reason: "backup_failed",
        error: err instanceof BackupError ? err.message : String(err)
      });
      return EMPTY("backup_failed");
    }
  }
  const indexPath = o.indexPath ?? join13(memoryDir, "MEMORY.md");
  const targets = [...planned.map((p) => p.absPath), indexPath];
  const snapshot = takeSnapshots(targets);
  let bytesWritten = 0;
  const written = [];
  try {
    db.exec("BEGIN");
    for (const p of planned) {
      atomicWriteFileSync(p.absPath, p.content);
      bytesWritten += Buffer.byteLength(p.content, "utf8");
      written.push(p.relPath);
      const mac = extractMac(p.content);
      db.prepare(
        `INSERT INTO memory_files
           (rel_path, name, raw, body, content_hash, massu_authored, massu_render_mac,
            observation_id, origin)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'local')
         ON CONFLICT(rel_path) DO UPDATE SET
           raw = excluded.raw,
           body = excluded.body,
           content_hash = excluded.content_hash,
           massu_authored = 1,
           massu_render_mac = excluded.massu_render_mac,
           observation_id = excluded.observation_id`
      ).run(
        p.relPath,
        p.c.name,
        p.content,
        stripFrontmatter(p.content),
        sha256(p.content),
        mac,
        p.c.observationId
      );
      audit("memory_file_rendered", { name: p.c.name, rel_path: p.relPath });
    }
    const pre = readMemoryIndex(indexPath);
    if (pre !== void 0 && indexLines.length > 0) {
      try {
        const post = renderRegion(pre, indexLines);
        if (post !== pre) {
          writeMemoryIndex(indexPath, pre, post);
          bytesWritten += Buffer.byteLength(post, "utf8") - Buffer.byteLength(pre, "utf8");
        }
      } catch (err) {
        if (err instanceof RegionRefused) {
          refusals.push({ name: "MEMORY.md", reason: err.reason, detail: err.message });
          audit("memory_file_render_refused", { name: "MEMORY.md", reason: err.reason });
        } else {
          throw err;
        }
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
    }
    const restored = restoreSnapshots(snapshot);
    if (restored.errors.length > 0) {
      audit("memory_file_render_refused", {
        reason: "rollback_incomplete",
        errors: restored.errors
      });
      return {
        ...EMPTY("rollback_incomplete"),
        enabled: true,
        refusals: [
          ...refusals,
          { name: "(corpus)", reason: "rollback_incomplete", detail: restored.errors.join("; ") }
        ]
      };
    }
    audit("memory_file_render_refused", { reason: "write_failed", error: String(err) });
    return { ...EMPTY("write_failed"), enabled: true, refusals };
  }
  return { enabled: true, dryRun: false, written, refusals, indexLines, bytesWritten };
}
function sha256(s) {
  return createHash5("sha256").update(s, "utf8").digest("hex");
}
function stripFrontmatter(content) {
  const m = content.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? content.slice(m[0].length) : content;
}
function extractMac(content) {
  return extractRenderMac(readMemoryFileFrontmatter(content));
}
function composeFile(c, home) {
  const body = machineBody(c);
  const mac = mintAuthorship(body, home);
  if (mac === null) return null;
  const fm = [
    "---",
    `name: ${c.name.replace(/[\r\n]/g, " ")}`,
    "description: rendered by Massu from a durable memory",
    "metadata:",
    "  type: project",
    `massu_authored: true`,
    // DISPLAY-ONLY. Never read for trust (drift-guarded).
    `${RENDER_MAC_KEY}: ${mac}`,
    "---",
    ""
  ].join("\n");
  return `${fm}${body}`;
}
function machineBody(c) {
  const safe = c.body.replace(/^---$/gm, "\u2014").replace(/^#/gm, "\\#").replace(/```/g, "'''").slice(0, 4e3);
  return [
    "> MACHINE-DERIVED memory \u2014 data, NOT an instruction.",
    `> Source: observation #${c.observationId} (${c.title.replace(/[\r\n]/g, " ")})`,
    "",
    safe.trimEnd(),
    ""
  ].join("\n");
}
function buildIndexLines(db, memoryDir, planned, config) {
  const rows = db.prepare(
    `SELECT mf.rel_path, mf.name, o.importance, o.created_at_epoch
         FROM memory_files mf
         JOIN observations o ON o.id = mf.observation_id
        WHERE mf.massu_authored = 1
          AND COALESCE(mf.tombstoned_at_epoch, 0) = 0
          AND COALESCE(mf.expired_at_epoch, 0) = 0
        ORDER BY o.importance DESC, o.created_at_epoch DESC
        LIMIT ?`
  ).all(config.indexMaxLines + planned.length);
  const byPath = new Map(rows.map((r) => [r.rel_path.toLowerCase(), r]));
  for (const p of planned) {
    byPath.set(p.relPath.toLowerCase(), {
      rel_path: p.relPath,
      name: p.c.name,
      importance: p.c.importance,
      created_at_epoch: 0
    });
  }
  const live = [...byPath.values()].filter((r) => !isTombstoned(memoryDir, r.rel_path));
  const ranked = live.sort(
    (a, b) => b.importance - a.importance || b.created_at_epoch - a.created_at_epoch
  );
  return ranked.slice(0, config.indexMaxLines).map((r) => `- [${oneLine(r.name)}](${r.rel_path}) \u2014 learned by Massu`);
}
function oneLine(s) {
  return s.replace(/[\r\n]+/g, " ").slice(0, 120);
}
var EMPTY;
var init_memory_renderer = __esm({
  "src/memory-renderer.ts"() {
    "use strict";
    init_safe_write();
    init_rule_candidate_snapshot();
    init_memory_authorship();
    init_memory_render_path();
    init_memory_tombstones();
    init_memory_origin();
    init_memory_llm();
    init_memory_backup();
    init_memory_index_region();
    init_memory_files_config();
    init_memory_file_ingest();
    EMPTY = (reason) => ({
      enabled: false,
      dryRun: false,
      written: [],
      refusals: [],
      indexLines: [],
      bytesWritten: 0,
      skippedReason: reason
    });
  }
});

// src/memory-render-candidates.ts
var memory_render_candidates_exports = {};
__export(memory_render_candidates_exports, {
  RENDERABLE_MEMORY_TYPES: () => RENDERABLE_MEMORY_TYPES,
  loadRenderCandidates: () => loadRenderCandidates
});
function loadRenderCandidates(db) {
  const cfg = resolveMemoryFilesConfig();
  const typePlaceholders = RENDERABLE_MEMORY_TYPES.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT id, title, detail, importance, COALESCE(origin, 'local') AS origin
         FROM observations
        WHERE importance >= ?
          AND COALESCE(expired_at_epoch, 0) = 0
          AND type IN (${typePlaceholders})
        ORDER BY importance DESC, created_at_epoch DESC
        LIMIT 50`
  ).all(cfg.renderMinImportance, ...RENDERABLE_MEMORY_TYPES);
  return rows.filter((r) => !r.title.startsWith("[memory-file]")).map((r) => ({
    observationId: r.id,
    name: r.title,
    title: r.title,
    body: r.detail ?? "",
    importance: r.importance,
    origin: r.origin
  }));
}
var RENDERABLE_MEMORY_TYPES;
var init_memory_render_candidates = __esm({
  "src/memory-render-candidates.ts"() {
    "use strict";
    init_memory_files_config();
    RENDERABLE_MEMORY_TYPES = [
      "decision",
      "failed_attempt",
      "incident_near_miss",
      "cr_violation"
    ];
  }
});

// src/detect/manifest-registry.ts
var manifest_registry_exports = {};
__export(manifest_registry_exports, {
  getManifestPatterns: () => getManifestPatterns,
  getManifestRegistry: () => getManifestRegistry,
  matchManifestPattern: () => matchManifestPattern
});
function matchManifestPattern(name, pattern) {
  if (pattern.startsWith("*")) {
    const suffix = pattern.slice(1);
    if (suffix.includes("*")) {
      throw new Error(
        `[manifest-registry] pattern "${pattern}" has more than one wildcard. Only "*.<ext>" extension-globs are supported.`
      );
    }
    return name.endsWith(suffix);
  }
  return name === pattern;
}
function getManifestRegistry() {
  if (_registryCache !== null) return _registryCache;
  _registryCache = [
    {
      pattern: "package.json",
      manifestType: "package.json",
      language: "typescript",
      runtime: "node",
      parse: parsePackageJson,
      signalKey: "packageJson",
      signalShape: "json"
    },
    {
      pattern: "pyproject.toml",
      manifestType: "pyproject.toml",
      language: "python",
      runtime: "python3",
      parse: parsePyproject,
      signalKey: "pyprojectToml",
      signalShape: "toml"
    },
    {
      pattern: "requirements.txt",
      manifestType: "requirements.txt",
      language: "python",
      runtime: "python3",
      parse: parseRequirementsTxt,
      // Captured via pyprojectToml sibling already; no separate signal.
      signalKey: null,
      signalShape: "string"
    },
    {
      pattern: "Pipfile",
      manifestType: "Pipfile",
      language: "python",
      runtime: "python3",
      parse: parsePipfile,
      // Captured via pyprojectToml sibling already; no separate signal.
      signalKey: null,
      signalShape: "string"
    },
    {
      pattern: "Cargo.toml",
      manifestType: "Cargo.toml",
      language: "rust",
      runtime: "cargo",
      parse: parseCargoToml,
      signalKey: "cargoToml",
      signalShape: "toml"
    },
    {
      pattern: "Package.swift",
      manifestType: "Package.swift",
      language: "swift",
      runtime: "xcode",
      parse: parsePackageSwift,
      // No AST adapter consumer yet (swift-swiftui doesn't need it).
      signalKey: null,
      signalShape: "string"
    },
    {
      pattern: "go.mod",
      manifestType: "go.mod",
      language: "go",
      runtime: "go",
      parse: parseGoMod,
      signalKey: "goMod",
      signalShape: "string"
    },
    {
      pattern: "pom.xml",
      manifestType: "pom.xml",
      language: "java",
      runtime: "jvm",
      parse: parsePomXml,
      signalKey: "pomXml",
      signalShape: "string"
    },
    {
      pattern: "build.gradle",
      manifestType: "build.gradle",
      language: "java",
      runtime: "jvm",
      parse: parseBuildGradle,
      signalKey: "gradleBuild",
      signalShape: "string"
    },
    {
      pattern: "build.gradle.kts",
      manifestType: "build.gradle",
      language: "java",
      runtime: "jvm",
      parse: parseBuildGradle,
      signalKey: "gradleBuild",
      signalShape: "string"
    },
    {
      pattern: "Gemfile",
      manifestType: "Gemfile",
      language: "ruby",
      runtime: "ruby",
      parse: parseGemfile,
      signalKey: "gemfile",
      signalShape: "string"
    },
    // Plan 1.5.1 — closes CR-39 violation (1.5.0 init failed for Phoenix
    // + ASP.NET fixtures). Both rely on AST adapters that already work
    // in introspect; the gap was solely package-detector unaware of the
    // manifest filenames.
    {
      pattern: "mix.exs",
      manifestType: "mix.exs",
      language: "elixir",
      runtime: "beam",
      parse: parseMixExs,
      signalKey: "mixExs",
      signalShape: "string"
    },
    {
      pattern: "*.csproj",
      manifestType: "*.csproj",
      language: "csharp",
      runtime: "dotnet",
      parse: parseCsproj,
      signalKey: "csproj",
      signalShape: "string"
    }
  ];
  return _registryCache;
}
function getManifestPatterns() {
  return getManifestRegistry().map((e) => e.pattern);
}
var _registryCache;
var init_manifest_registry = __esm({
  "src/detect/manifest-registry.ts"() {
    "use strict";
    init_package_detector();
    _registryCache = null;
  }
});

// src/detect/package-detector.ts
import { readFileSync as readFileSync16, existsSync as existsSync20, statSync as statSync5, lstatSync, readdirSync as readdirSync4 } from "fs";
import { join as join14, relative as relative2 } from "path";
import { parse as parseToml } from "smol-toml";
function safeRead(path) {
  try {
    if (!existsSync20(path)) return null;
    const ls = lstatSync(path);
    if (ls.isSymbolicLink()) return null;
    const st = statSync5(path);
    if (!st.isFile()) return null;
    return readFileSync16(path, "utf-8");
  } catch {
    return null;
  }
}
function normalizeRelative(root, path) {
  const rel = relative2(root, path);
  return rel.split(/[/\\]/).join("/");
}
function parsePackageJson(path, directory, root, warnings) {
  const raw = safeRead(path);
  if (raw === null) return null;
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    warnings.push({
      path,
      reason: `package.json JSON parse failed: ${err.message}`
    });
    return null;
  }
  const deps = Object.keys(
    pkg.dependencies ?? {}
  );
  const devDeps = Object.keys(
    pkg.devDependencies ?? {}
  );
  const peer = Object.keys(
    pkg.peerDependencies ?? {}
  );
  const hasTs = deps.includes("typescript") || devDeps.includes("typescript") || existsSync20(join14(directory, "tsconfig.json"));
  const language = hasTs ? "typescript" : "javascript";
  const scripts = Object.keys(
    pkg.scripts ?? {}
  );
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language,
    runtime: "node",
    name: typeof pkg.name === "string" ? pkg.name : null,
    version: typeof pkg.version === "string" ? pkg.version : null,
    dependencies: [...deps, ...peer],
    devDependencies: devDeps,
    scripts,
    manifestType: "package.json"
  };
}
function parsePyproject(path, directory, root, warnings) {
  const raw = safeRead(path);
  if (raw === null) return null;
  let toml;
  try {
    toml = parseToml(raw);
  } catch (err) {
    warnings.push({
      path,
      reason: `pyproject.toml TOML parse failed: ${err.message}`
    });
    return null;
  }
  const deps = [];
  const devDeps = [];
  const scripts = [];
  let name = null;
  let version = null;
  const project = toml.project;
  if (project && typeof project === "object") {
    if (typeof project.name === "string") name = project.name;
    if (typeof project.version === "string") version = project.version;
    const pd = project.dependencies;
    if (Array.isArray(pd)) {
      for (const d of pd) {
        if (typeof d === "string") deps.push(normalizePyDep(d));
      }
    }
    const optDeps = project["optional-dependencies"];
    if (optDeps && typeof optDeps === "object") {
      for (const grp of Object.values(optDeps)) {
        if (Array.isArray(grp)) {
          for (const d of grp) {
            if (typeof d === "string") devDeps.push(normalizePyDep(d));
          }
        }
      }
    }
    const psScripts = project.scripts;
    if (psScripts && typeof psScripts === "object") {
      scripts.push(...Object.keys(psScripts));
    }
  }
  const tool = toml.tool;
  const poetry = tool?.poetry;
  if (poetry && typeof poetry === "object") {
    if (!name && typeof poetry.name === "string") name = poetry.name;
    if (!version && typeof poetry.version === "string") version = poetry.version;
    const pdeps = poetry.dependencies;
    if (pdeps && typeof pdeps === "object") {
      for (const k of Object.keys(pdeps)) {
        if (k !== "python") deps.push(k);
      }
    }
    const groups = poetry.group;
    if (groups && typeof groups === "object") {
      for (const grp of Object.values(groups)) {
        const grpObj = grp;
        const grpDeps = grpObj?.dependencies;
        if (grpDeps && typeof grpDeps === "object") {
          for (const k of Object.keys(grpDeps)) {
            if (k !== "python") devDeps.push(k);
          }
        }
      }
    }
    const legacyDev = poetry["dev-dependencies"];
    if (legacyDev && typeof legacyDev === "object") {
      for (const k of Object.keys(legacyDev)) {
        if (k !== "python") devDeps.push(k);
      }
    }
    const pScripts = poetry.scripts;
    if (pScripts && typeof pScripts === "object") {
      scripts.push(...Object.keys(pScripts));
    }
  }
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: "python",
    runtime: "python3",
    name,
    version,
    dependencies: deps,
    devDependencies: devDeps,
    scripts,
    manifestType: "pyproject.toml"
  };
}
function normalizePyDep(spec) {
  const semi = spec.split(";")[0];
  const extras = semi.split("[")[0];
  const name = extras.split(/[=<>!~ ]/)[0];
  return name.trim();
}
function parseRequirementsTxt(path, directory, root, _warnings) {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("-")) continue;
    const name = normalizePyDep(trimmed);
    if (name) deps.push(name);
  }
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: "python",
    runtime: "python3",
    name: null,
    version: null,
    dependencies: deps,
    devDependencies: [],
    scripts: [],
    manifestType: "requirements.txt"
  };
}
function parsePipfile(path, directory, root, warnings) {
  const raw = safeRead(path);
  if (raw === null) return null;
  let toml;
  try {
    toml = parseToml(raw);
  } catch (err) {
    warnings.push({
      path,
      reason: `Pipfile TOML parse failed: ${err.message}`
    });
    return null;
  }
  const packages = toml.packages ?? {};
  const devPackages = toml["dev-packages"] ?? {};
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: "python",
    runtime: "python3",
    name: null,
    version: null,
    dependencies: Object.keys(packages),
    devDependencies: Object.keys(devPackages),
    scripts: [],
    manifestType: "Pipfile"
  };
}
function parseCargoToml(path, directory, root, warnings) {
  const raw = safeRead(path);
  if (raw === null) return null;
  let toml;
  try {
    toml = parseToml(raw);
  } catch (err) {
    warnings.push({
      path,
      reason: `Cargo.toml TOML parse failed: ${err.message}`
    });
    return null;
  }
  const pkg = toml.package;
  const deps = toml.dependencies;
  const devDeps = toml["dev-dependencies"];
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: "rust",
    runtime: "cargo",
    name: typeof pkg?.name === "string" ? pkg.name : null,
    version: typeof pkg?.version === "string" ? pkg.version : null,
    dependencies: deps ? Object.keys(deps) : [],
    devDependencies: devDeps ? Object.keys(devDeps) : [],
    scripts: [],
    manifestType: "Cargo.toml"
  };
}
function parsePackageSwift(path, directory, root, _warnings) {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps = [];
  const urlRe = /\.package\s*\(\s*(?:name\s*:\s*"([^"]+)"\s*,\s*)?url\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = urlRe.exec(raw)) !== null) {
    const explicitName = m[1];
    if (explicitName) {
      deps.push(explicitName);
      continue;
    }
    const url = m[2];
    const last = url.split("/").pop() ?? "";
    const clean = last.replace(/\.git$/, "").trim();
    if (clean) deps.push(clean);
  }
  const nameMatch = /let\s+package\s*=\s*Package\s*\(\s*name\s*:\s*"([^"]+)"/.exec(
    raw
  );
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: "swift",
    runtime: "xcode",
    name: nameMatch ? nameMatch[1] : null,
    version: null,
    dependencies: deps,
    devDependencies: [],
    scripts: [],
    manifestType: "Package.swift"
  };
}
function parseGoMod(path, directory, root, _warnings) {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps = [];
  let name = null;
  let inRequire = false;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("module ")) {
      name = line.slice("module ".length).trim();
      continue;
    }
    if (line === "require (") {
      inRequire = true;
      continue;
    }
    if (inRequire) {
      if (line === ")") {
        inRequire = false;
        continue;
      }
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && !parts[0].startsWith("//")) deps.push(parts[0]);
      continue;
    }
    if (line.startsWith("require ")) {
      const parts = line.slice("require ".length).trim().split(/\s+/);
      if (parts[0]) deps.push(parts[0]);
    }
  }
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: "go",
    runtime: "go",
    name,
    version: null,
    dependencies: deps,
    devDependencies: [],
    scripts: [],
    manifestType: "go.mod"
  };
}
function parsePomXml(path, directory, root, _warnings) {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps = [];
  const depRe = /<dependency>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<\/dependency>/g;
  let m;
  while ((m = depRe.exec(raw)) !== null) deps.push(m[1].trim());
  const nameMatch = /<artifactId>([^<]+)<\/artifactId>/.exec(raw);
  const versionMatch = /<project[^>]*>[\s\S]*?<version>([^<]+)<\/version>/.exec(
    raw
  );
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: "java",
    runtime: "jvm",
    name: nameMatch ? nameMatch[1].trim() : null,
    version: versionMatch ? versionMatch[1].trim() : null,
    dependencies: deps,
    devDependencies: [],
    scripts: [],
    manifestType: "pom.xml"
  };
}
function parseBuildGradle(path, directory, root, _warnings) {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps = [];
  const devDeps = [];
  const re = /(implementation|api|runtimeOnly|compileOnly|testImplementation|testRuntimeOnly|androidTestImplementation)\s*[\("']+([^"'\)]+)[\)"']+/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const scope = m[1];
    const coord = m[2];
    const parts = coord.split(":");
    const artifact = parts.length >= 2 ? parts[1] : parts[0];
    if (!artifact) continue;
    if (scope.toLowerCase().startsWith("test")) devDeps.push(artifact);
    else deps.push(artifact);
  }
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: "java",
    runtime: "jvm",
    name: null,
    version: null,
    dependencies: deps,
    devDependencies: devDeps,
    scripts: [],
    manifestType: "build.gradle"
  };
}
function parseGemfile(path, directory, root, _warnings) {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps = [];
  const devDeps = [];
  let inDevGroup = false;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^group\s*:test|^group\s+:development/.test(line)) inDevGroup = true;
    if (/^end\b/.test(line)) inDevGroup = false;
    const gemMatch = /^gem\s+["']([^"']+)["']/.exec(line);
    if (gemMatch) {
      if (inDevGroup) devDeps.push(gemMatch[1]);
      else deps.push(gemMatch[1]);
    }
  }
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: "ruby",
    runtime: "ruby",
    name: null,
    version: null,
    dependencies: deps,
    devDependencies: devDeps,
    scripts: [],
    manifestType: "Gemfile"
  };
}
function parseMixExs(path, directory, root, _warnings) {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps = [];
  const depPattern = /\{\s*:([a-z][a-z0-9_]*)\s*,/g;
  let m;
  while ((m = depPattern.exec(raw)) !== null) {
    if (!deps.includes(m[1])) deps.push(m[1]);
  }
  const appMatch = /\bapp\s*:\s*:([a-z][a-z0-9_]*)/.exec(raw);
  const name = appMatch ? appMatch[1] : null;
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: "elixir",
    runtime: "beam",
    name,
    version: null,
    dependencies: deps,
    devDependencies: [],
    scripts: [],
    manifestType: "mix.exs"
  };
}
function parseCsproj(path, directory, root, _warnings) {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps = [];
  const pkgRefPattern = /<PackageReference\s+[^>]*Include\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = pkgRefPattern.exec(raw)) !== null) {
    if (!deps.includes(m[1])) deps.push(m[1]);
  }
  const sdkMatch = /<Project\s+[^>]*Sdk\s*=\s*"([^"]+)"/i.exec(raw);
  if (sdkMatch && !deps.includes(sdkMatch[1])) {
    deps.push(sdkMatch[1]);
  }
  const fname = path.split(/[/\\]/).pop() ?? "";
  const name = fname.endsWith(".csproj") ? fname.slice(0, -".csproj".length) : null;
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: "csharp",
    runtime: "dotnet",
    name,
    version: null,
    dependencies: deps,
    devDependencies: [],
    scripts: [],
    manifestType: "*.csproj"
  };
}
function detectManifestsInDir(dir, root, warnings) {
  const { getManifestRegistry: getManifestRegistry2, matchManifestPattern: matchManifestPattern2 } = manifest_registry_exports;
  const out = [];
  let dirEntries = null;
  for (const entry of getManifestRegistry2()) {
    if (!entry.pattern.startsWith("*")) {
      const path = join14(dir, entry.pattern);
      if (!existsSync20(path)) continue;
      const m = entry.parse(path, dir, root, warnings);
      if (m !== null) out.push(m);
    } else {
      if (dirEntries === null) {
        try {
          dirEntries = readdirSync4(dir);
        } catch {
          dirEntries = [];
        }
      }
      for (const fname of dirEntries) {
        if (!matchManifestPattern2(fname, entry.pattern)) continue;
        const path = join14(dir, fname);
        if (!existsSync20(path)) continue;
        const m = entry.parse(path, dir, root, warnings);
        if (m !== null) out.push(m);
      }
    }
  }
  return out;
}
function listSubdirs(dir) {
  try {
    return readdirSync4(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name)).map((e) => join14(dir, e.name));
  } catch {
    return [];
  }
}
function detectPackageManifests(projectRoot) {
  const warnings = [];
  const manifests = [];
  manifests.push(...detectManifestsInDir(projectRoot, projectRoot, warnings));
  for (const ws of WORKSPACE_DIRS) {
    const wsRoot = join14(projectRoot, ws);
    if (!existsSync20(wsRoot)) continue;
    for (const sub of listSubdirs(wsRoot)) {
      manifests.push(...detectManifestsInDir(sub, projectRoot, warnings));
      for (const sub2 of listSubdirs(sub)) {
        manifests.push(...detectManifestsInDir(sub2, projectRoot, warnings));
      }
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const dedup = [];
  for (const m of manifests) {
    if (seen.has(m.path)) continue;
    seen.add(m.path);
    dedup.push(m);
  }
  return { manifests: dedup, warnings };
}
var WORKSPACE_DIRS, IGNORED_DIRS;
var init_package_detector = __esm({
  "src/detect/package-detector.ts"() {
    "use strict";
    init_manifest_registry();
    WORKSPACE_DIRS = ["apps", "packages", "services", "libs", "modules"];
    IGNORED_DIRS = /* @__PURE__ */ new Set([
      "node_modules",
      ".venv",
      "venv",
      "__pycache__",
      "dist",
      "build",
      ".build",
      "target",
      ".next",
      ".nuxt",
      "coverage",
      ".git",
      ".massu",
      ".turbo",
      ".cache",
      ".pytest_cache",
      ".mypy_cache",
      "DerivedData",
      "Pods"
    ]);
  }
});

// src/detect/framework-detector.ts
function matchRule(rules, language, kind, deps) {
  let best = null;
  for (const r of rules) {
    if (r.language !== language) continue;
    if (r.kind !== kind) continue;
    if (!deps.has(r.keyword.toLowerCase())) continue;
    const pr = r.priority ?? 0;
    if (!best || pr > best.priority) {
      best = { value: r.value, priority: pr };
    }
  }
  return best;
}
function matchUserFrameworkRules(userRules, language, deps) {
  if (!userRules) return null;
  const byLang = userRules[language];
  if (!byLang) return null;
  let best = null;
  for (const [framework, entry] of Object.entries(byLang)) {
    const signals = entry.signals ?? [];
    const priority = entry.priority ?? 100;
    for (const sig of signals) {
      if (deps.has(sig.toLowerCase())) {
        if (!best || priority > best.priority) {
          best = { framework, priority };
        }
        break;
      }
    }
  }
  return best;
}
function detectFrameworks(manifests, userDetection) {
  const byLang = /* @__PURE__ */ new Map();
  for (const m of manifests) {
    const entry = byLang.get(m.language) ?? {
      deps: /* @__PURE__ */ new Set(),
      versionOf: /* @__PURE__ */ new Map()
    };
    for (const d of m.dependencies) entry.deps.add(d.toLowerCase());
    for (const d of m.devDependencies) entry.deps.add(d.toLowerCase());
    byLang.set(m.language, entry);
  }
  const rules = userDetection?.disable_builtin ? [] : [...DETECTION_RULES];
  const out = {};
  for (const [language, { deps }] of byLang.entries()) {
    const fw = matchRule(rules, language, "framework", deps);
    const userFw = matchUserFrameworkRules(
      userDetection?.rules,
      language,
      deps
    );
    let frameworkValue = null;
    if (userFw && (!fw || userFw.priority > fw.priority)) {
      frameworkValue = userFw.framework;
    } else if (fw) {
      frameworkValue = fw.value;
    }
    const info = {
      framework: frameworkValue,
      version: null,
      test_framework: matchRule(rules, language, "test_framework", deps)?.value ?? null,
      orm: matchRule(rules, language, "orm", deps)?.value ?? null,
      ui_library: matchRule(rules, language, "ui_library", deps)?.value ?? null,
      router: matchRule(rules, language, "router", deps)?.value ?? null
    };
    out[language] = info;
  }
  return out;
}
var DETECTION_RULES;
var init_framework_detector = __esm({
  "src/detect/framework-detector.ts"() {
    "use strict";
    DETECTION_RULES = [
      // Python frameworks
      { language: "python", kind: "framework", keyword: "fastapi", value: "fastapi", priority: 10 },
      { language: "python", kind: "framework", keyword: "flask", value: "flask", priority: 9 },
      { language: "python", kind: "framework", keyword: "django", value: "django", priority: 9 },
      { language: "python", kind: "framework", keyword: "aiohttp", value: "aiohttp", priority: 8 },
      { language: "python", kind: "framework", keyword: "sanic", value: "sanic", priority: 8 },
      { language: "python", kind: "framework", keyword: "starlette", value: "starlette", priority: 7 },
      // Python test
      { language: "python", kind: "test_framework", keyword: "pytest", value: "pytest", priority: 10 },
      { language: "python", kind: "test_framework", keyword: "pytest-asyncio", value: "pytest", priority: 9 },
      // Python ORM
      { language: "python", kind: "orm", keyword: "sqlalchemy", value: "sqlalchemy", priority: 10 },
      { language: "python", kind: "orm", keyword: "django-orm", value: "django-orm", priority: 9 },
      { language: "python", kind: "orm", keyword: "peewee", value: "peewee", priority: 8 },
      { language: "python", kind: "orm", keyword: "tortoise-orm", value: "tortoise-orm", priority: 8 },
      // TypeScript / JavaScript frameworks
      { language: "typescript", kind: "framework", keyword: "next", value: "next", priority: 10 },
      { language: "typescript", kind: "framework", keyword: "@nestjs/core", value: "nestjs", priority: 10 },
      { language: "typescript", kind: "framework", keyword: "fastify", value: "fastify", priority: 9 },
      { language: "typescript", kind: "framework", keyword: "express", value: "express", priority: 9 },
      { language: "typescript", kind: "framework", keyword: "hono", value: "hono", priority: 9 },
      { language: "typescript", kind: "framework", keyword: "@sveltejs/kit", value: "sveltekit", priority: 10 },
      { language: "typescript", kind: "framework", keyword: "nuxt", value: "nuxt", priority: 10 },
      { language: "typescript", kind: "framework", keyword: "@angular/core", value: "angular", priority: 10 },
      { language: "typescript", kind: "framework", keyword: "react", value: "react", priority: 5 },
      { language: "typescript", kind: "framework", keyword: "vue", value: "vue", priority: 5 },
      // Mirror for javascript
      { language: "javascript", kind: "framework", keyword: "next", value: "next", priority: 10 },
      { language: "javascript", kind: "framework", keyword: "express", value: "express", priority: 9 },
      { language: "javascript", kind: "framework", keyword: "fastify", value: "fastify", priority: 9 },
      { language: "javascript", kind: "framework", keyword: "react", value: "react", priority: 5 },
      // TS/JS test
      { language: "typescript", kind: "test_framework", keyword: "vitest", value: "vitest", priority: 10 },
      { language: "typescript", kind: "test_framework", keyword: "jest", value: "jest", priority: 9 },
      { language: "typescript", kind: "test_framework", keyword: "mocha", value: "mocha", priority: 8 },
      { language: "typescript", kind: "test_framework", keyword: "@playwright/test", value: "playwright", priority: 7 },
      { language: "javascript", kind: "test_framework", keyword: "vitest", value: "vitest", priority: 10 },
      { language: "javascript", kind: "test_framework", keyword: "jest", value: "jest", priority: 9 },
      { language: "javascript", kind: "test_framework", keyword: "mocha", value: "mocha", priority: 8 },
      // TS/JS ORM
      { language: "typescript", kind: "orm", keyword: "@prisma/client", value: "prisma", priority: 10 },
      { language: "typescript", kind: "orm", keyword: "prisma", value: "prisma", priority: 9 },
      { language: "typescript", kind: "orm", keyword: "drizzle-orm", value: "drizzle", priority: 10 },
      { language: "typescript", kind: "orm", keyword: "typeorm", value: "typeorm", priority: 9 },
      { language: "typescript", kind: "orm", keyword: "mongoose", value: "mongoose", priority: 9 },
      { language: "typescript", kind: "orm", keyword: "sequelize", value: "sequelize", priority: 8 },
      { language: "javascript", kind: "orm", keyword: "@prisma/client", value: "prisma", priority: 10 },
      { language: "javascript", kind: "orm", keyword: "mongoose", value: "mongoose", priority: 9 },
      // TS/JS UI
      { language: "typescript", kind: "ui_library", keyword: "next", value: "next", priority: 9 },
      { language: "typescript", kind: "ui_library", keyword: "react", value: "react", priority: 8 },
      { language: "typescript", kind: "ui_library", keyword: "vue", value: "vue", priority: 8 },
      { language: "typescript", kind: "ui_library", keyword: "@sveltejs/kit", value: "svelte", priority: 9 },
      { language: "javascript", kind: "ui_library", keyword: "react", value: "react", priority: 8 },
      // TS/JS router
      { language: "typescript", kind: "router", keyword: "@trpc/server", value: "trpc", priority: 10 },
      { language: "typescript", kind: "router", keyword: "@apollo/server", value: "graphql", priority: 9 },
      { language: "typescript", kind: "router", keyword: "graphql", value: "graphql", priority: 8 },
      { language: "typescript", kind: "router", keyword: "express", value: "express", priority: 7 },
      { language: "typescript", kind: "router", keyword: "fastify", value: "fastify", priority: 7 },
      { language: "typescript", kind: "router", keyword: "hono", value: "hono", priority: 7 },
      // Rust
      { language: "rust", kind: "framework", keyword: "actix-web", value: "actix-web", priority: 10 },
      { language: "rust", kind: "framework", keyword: "axum", value: "axum", priority: 10 },
      { language: "rust", kind: "framework", keyword: "rocket", value: "rocket", priority: 10 },
      { language: "rust", kind: "framework", keyword: "warp", value: "warp", priority: 9 },
      { language: "rust", kind: "framework", keyword: "tokio", value: "tokio", priority: 5 },
      { language: "rust", kind: "test_framework", keyword: "cargo", value: "cargo", priority: 1 },
      { language: "rust", kind: "orm", keyword: "diesel", value: "diesel", priority: 10 },
      { language: "rust", kind: "orm", keyword: "sqlx", value: "sqlx", priority: 10 },
      { language: "rust", kind: "orm", keyword: "sea-orm", value: "sea-orm", priority: 10 },
      // Go
      { language: "go", kind: "framework", keyword: "github.com/gin-gonic/gin", value: "gin", priority: 10 },
      { language: "go", kind: "framework", keyword: "github.com/labstack/echo", value: "echo", priority: 10 },
      { language: "go", kind: "framework", keyword: "github.com/gofiber/fiber", value: "fiber", priority: 10 },
      { language: "go", kind: "framework", keyword: "github.com/go-chi/chi", value: "chi", priority: 9 },
      // chi versioned import paths (Go convention: github.com/<org>/<name>/v<N>).
      // matchRule does exact case-insensitive set lookup, so the unversioned and
      // each major-version path each need their own rule.
      { language: "go", kind: "framework", keyword: "github.com/go-chi/chi/v2", value: "chi", priority: 9 },
      { language: "go", kind: "framework", keyword: "github.com/go-chi/chi/v3", value: "chi", priority: 9 },
      { language: "go", kind: "framework", keyword: "github.com/go-chi/chi/v4", value: "chi", priority: 9 },
      { language: "go", kind: "framework", keyword: "github.com/go-chi/chi/v5", value: "chi", priority: 9 },
      { language: "go", kind: "test_framework", keyword: "github.com/stretchr/testify", value: "testify", priority: 8 },
      { language: "go", kind: "orm", keyword: "gorm.io/gorm", value: "gorm", priority: 10 },
      // Swift (SPM dependency names, best-effort)
      { language: "swift", kind: "framework", keyword: "vapor", value: "vapor", priority: 10 },
      { language: "swift", kind: "framework", keyword: "swift-nio", value: "swift-nio", priority: 7 },
      { language: "swift", kind: "test_framework", keyword: "xctest", value: "xctest", priority: 5 },
      // Java
      { language: "java", kind: "framework", keyword: "spring-boot-starter", value: "spring-boot", priority: 10 },
      { language: "java", kind: "framework", keyword: "spring-boot-starter-web", value: "spring-boot", priority: 10 },
      { language: "java", kind: "test_framework", keyword: "junit", value: "junit", priority: 10 },
      { language: "java", kind: "test_framework", keyword: "junit-jupiter", value: "junit", priority: 10 },
      // Ruby
      { language: "ruby", kind: "framework", keyword: "rails", value: "rails", priority: 10 },
      { language: "ruby", kind: "framework", keyword: "sinatra", value: "sinatra", priority: 9 },
      { language: "ruby", kind: "test_framework", keyword: "rspec", value: "rspec", priority: 10 },
      { language: "ruby", kind: "orm", keyword: "activerecord", value: "activerecord", priority: 10 },
      // Plan 1.5.1: elixir + csharp framework rules. Closes the CR-39 gap
      // where Phoenix + ASP.NET projects produced `framework.languages.<lang>`
      // entries WITHOUT a `framework:` value, which prevented variant
      // templates from being looked up.
      { language: "elixir", kind: "framework", keyword: "phoenix", value: "phoenix", priority: 10 },
      { language: "elixir", kind: "test_framework", keyword: "ex_unit", value: "ex-unit", priority: 10 },
      { language: "elixir", kind: "orm", keyword: "ecto", value: "ecto", priority: 10 },
      // ASP.NET Core surfaces via several PackageReference names; the canonical
      // ones in modern .NET projects are .App and .Mvc. matchRule does exact
      // (case-insensitive) lookup against the deps set parseCsproj extracts.
      { language: "csharp", kind: "framework", keyword: "Microsoft.AspNetCore.App", value: "aspnet-core", priority: 10 },
      { language: "csharp", kind: "framework", keyword: "Microsoft.AspNetCore.Mvc", value: "aspnet-core", priority: 10 },
      { language: "csharp", kind: "framework", keyword: "Microsoft.AspNetCore", value: "aspnet-core", priority: 9 },
      // SDK-style projects: `<Project Sdk="Microsoft.NET.Sdk.Web">` is the
      // canonical ASP.NET Core declaration in modern .NET. parseCsproj
      // surfaces the Sdk attribute as a dep so this rule can match.
      { language: "csharp", kind: "framework", keyword: "Microsoft.NET.Sdk.Web", value: "aspnet-core", priority: 10 },
      { language: "csharp", kind: "test_framework", keyword: "xunit", value: "xunit", priority: 10 },
      { language: "csharp", kind: "orm", keyword: "EntityFrameworkCore", value: "ef-core", priority: 10 }
    ];
  }
});

// ../../node_modules/fast-glob/out/utils/array.js
var require_array = __commonJS({
  "../../node_modules/fast-glob/out/utils/array.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.splitWhen = exports.flatten = void 0;
    function flatten(items) {
      return items.reduce((collection, item) => [].concat(collection, item), []);
    }
    exports.flatten = flatten;
    function splitWhen(items, predicate) {
      const result = [[]];
      let groupIndex = 0;
      for (const item of items) {
        if (predicate(item)) {
          groupIndex++;
          result[groupIndex] = [];
        } else {
          result[groupIndex].push(item);
        }
      }
      return result;
    }
    exports.splitWhen = splitWhen;
  }
});

// ../../node_modules/fast-glob/out/utils/errno.js
var require_errno = __commonJS({
  "../../node_modules/fast-glob/out/utils/errno.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isEnoentCodeError = void 0;
    function isEnoentCodeError(error) {
      return error.code === "ENOENT";
    }
    exports.isEnoentCodeError = isEnoentCodeError;
  }
});

// ../../node_modules/fast-glob/out/utils/fs.js
var require_fs = __commonJS({
  "../../node_modules/fast-glob/out/utils/fs.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createDirentFromStats = void 0;
    var DirentFromStats = class {
      constructor(name, stats) {
        this.name = name;
        this.isBlockDevice = stats.isBlockDevice.bind(stats);
        this.isCharacterDevice = stats.isCharacterDevice.bind(stats);
        this.isDirectory = stats.isDirectory.bind(stats);
        this.isFIFO = stats.isFIFO.bind(stats);
        this.isFile = stats.isFile.bind(stats);
        this.isSocket = stats.isSocket.bind(stats);
        this.isSymbolicLink = stats.isSymbolicLink.bind(stats);
      }
    };
    function createDirentFromStats(name, stats) {
      return new DirentFromStats(name, stats);
    }
    exports.createDirentFromStats = createDirentFromStats;
  }
});

// ../../node_modules/fast-glob/out/utils/path.js
var require_path = __commonJS({
  "../../node_modules/fast-glob/out/utils/path.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.convertPosixPathToPattern = exports.convertWindowsPathToPattern = exports.convertPathToPattern = exports.escapePosixPath = exports.escapeWindowsPath = exports.escape = exports.removeLeadingDotSegment = exports.makeAbsolute = exports.unixify = void 0;
    var os = __require("os");
    var path = __require("path");
    var IS_WINDOWS_PLATFORM = os.platform() === "win32";
    var LEADING_DOT_SEGMENT_CHARACTERS_COUNT = 2;
    var POSIX_UNESCAPED_GLOB_SYMBOLS_RE = /(\\?)([()*?[\]{|}]|^!|[!+@](?=\()|\\(?![!()*+?@[\]{|}]))/g;
    var WINDOWS_UNESCAPED_GLOB_SYMBOLS_RE = /(\\?)([()[\]{}]|^!|[!+@](?=\())/g;
    var DOS_DEVICE_PATH_RE = /^\\\\([.?])/;
    var WINDOWS_BACKSLASHES_RE = /\\(?![!()+@[\]{}])/g;
    function unixify(filepath) {
      return filepath.replace(/\\/g, "/");
    }
    exports.unixify = unixify;
    function makeAbsolute(cwd, filepath) {
      return path.resolve(cwd, filepath);
    }
    exports.makeAbsolute = makeAbsolute;
    function removeLeadingDotSegment(entry) {
      if (entry.charAt(0) === ".") {
        const secondCharactery = entry.charAt(1);
        if (secondCharactery === "/" || secondCharactery === "\\") {
          return entry.slice(LEADING_DOT_SEGMENT_CHARACTERS_COUNT);
        }
      }
      return entry;
    }
    exports.removeLeadingDotSegment = removeLeadingDotSegment;
    exports.escape = IS_WINDOWS_PLATFORM ? escapeWindowsPath : escapePosixPath;
    function escapeWindowsPath(pattern) {
      return pattern.replace(WINDOWS_UNESCAPED_GLOB_SYMBOLS_RE, "\\$2");
    }
    exports.escapeWindowsPath = escapeWindowsPath;
    function escapePosixPath(pattern) {
      return pattern.replace(POSIX_UNESCAPED_GLOB_SYMBOLS_RE, "\\$2");
    }
    exports.escapePosixPath = escapePosixPath;
    exports.convertPathToPattern = IS_WINDOWS_PLATFORM ? convertWindowsPathToPattern : convertPosixPathToPattern;
    function convertWindowsPathToPattern(filepath) {
      return escapeWindowsPath(filepath).replace(DOS_DEVICE_PATH_RE, "//$1").replace(WINDOWS_BACKSLASHES_RE, "/");
    }
    exports.convertWindowsPathToPattern = convertWindowsPathToPattern;
    function convertPosixPathToPattern(filepath) {
      return escapePosixPath(filepath);
    }
    exports.convertPosixPathToPattern = convertPosixPathToPattern;
  }
});

// ../../node_modules/is-extglob/index.js
var require_is_extglob = __commonJS({
  "../../node_modules/is-extglob/index.js"(exports, module) {
    module.exports = function isExtglob(str) {
      if (typeof str !== "string" || str === "") {
        return false;
      }
      var match;
      while (match = /(\\).|([@?!+*]\(.*\))/g.exec(str)) {
        if (match[2]) return true;
        str = str.slice(match.index + match[0].length);
      }
      return false;
    };
  }
});

// ../../node_modules/is-glob/index.js
var require_is_glob = __commonJS({
  "../../node_modules/is-glob/index.js"(exports, module) {
    var isExtglob = require_is_extglob();
    var chars = { "{": "}", "(": ")", "[": "]" };
    var strictCheck = function(str) {
      if (str[0] === "!") {
        return true;
      }
      var index = 0;
      var pipeIndex = -2;
      var closeSquareIndex = -2;
      var closeCurlyIndex = -2;
      var closeParenIndex = -2;
      var backSlashIndex = -2;
      while (index < str.length) {
        if (str[index] === "*") {
          return true;
        }
        if (str[index + 1] === "?" && /[\].+)]/.test(str[index])) {
          return true;
        }
        if (closeSquareIndex !== -1 && str[index] === "[" && str[index + 1] !== "]") {
          if (closeSquareIndex < index) {
            closeSquareIndex = str.indexOf("]", index);
          }
          if (closeSquareIndex > index) {
            if (backSlashIndex === -1 || backSlashIndex > closeSquareIndex) {
              return true;
            }
            backSlashIndex = str.indexOf("\\", index);
            if (backSlashIndex === -1 || backSlashIndex > closeSquareIndex) {
              return true;
            }
          }
        }
        if (closeCurlyIndex !== -1 && str[index] === "{" && str[index + 1] !== "}") {
          closeCurlyIndex = str.indexOf("}", index);
          if (closeCurlyIndex > index) {
            backSlashIndex = str.indexOf("\\", index);
            if (backSlashIndex === -1 || backSlashIndex > closeCurlyIndex) {
              return true;
            }
          }
        }
        if (closeParenIndex !== -1 && str[index] === "(" && str[index + 1] === "?" && /[:!=]/.test(str[index + 2]) && str[index + 3] !== ")") {
          closeParenIndex = str.indexOf(")", index);
          if (closeParenIndex > index) {
            backSlashIndex = str.indexOf("\\", index);
            if (backSlashIndex === -1 || backSlashIndex > closeParenIndex) {
              return true;
            }
          }
        }
        if (pipeIndex !== -1 && str[index] === "(" && str[index + 1] !== "|") {
          if (pipeIndex < index) {
            pipeIndex = str.indexOf("|", index);
          }
          if (pipeIndex !== -1 && str[pipeIndex + 1] !== ")") {
            closeParenIndex = str.indexOf(")", pipeIndex);
            if (closeParenIndex > pipeIndex) {
              backSlashIndex = str.indexOf("\\", pipeIndex);
              if (backSlashIndex === -1 || backSlashIndex > closeParenIndex) {
                return true;
              }
            }
          }
        }
        if (str[index] === "\\") {
          var open = str[index + 1];
          index += 2;
          var close = chars[open];
          if (close) {
            var n = str.indexOf(close, index);
            if (n !== -1) {
              index = n + 1;
            }
          }
          if (str[index] === "!") {
            return true;
          }
        } else {
          index++;
        }
      }
      return false;
    };
    var relaxedCheck = function(str) {
      if (str[0] === "!") {
        return true;
      }
      var index = 0;
      while (index < str.length) {
        if (/[*?{}()[\]]/.test(str[index])) {
          return true;
        }
        if (str[index] === "\\") {
          var open = str[index + 1];
          index += 2;
          var close = chars[open];
          if (close) {
            var n = str.indexOf(close, index);
            if (n !== -1) {
              index = n + 1;
            }
          }
          if (str[index] === "!") {
            return true;
          }
        } else {
          index++;
        }
      }
      return false;
    };
    module.exports = function isGlob(str, options) {
      if (typeof str !== "string" || str === "") {
        return false;
      }
      if (isExtglob(str)) {
        return true;
      }
      var check = strictCheck;
      if (options && options.strict === false) {
        check = relaxedCheck;
      }
      return check(str);
    };
  }
});

// ../../node_modules/glob-parent/index.js
var require_glob_parent = __commonJS({
  "../../node_modules/glob-parent/index.js"(exports, module) {
    "use strict";
    var isGlob = require_is_glob();
    var pathPosixDirname = __require("path").posix.dirname;
    var isWin32 = __require("os").platform() === "win32";
    var slash = "/";
    var backslash = /\\/g;
    var enclosure = /[\{\[].*[\}\]]$/;
    var globby = /(^|[^\\])([\{\[]|\([^\)]+$)/;
    var escaped = /\\([\!\*\?\|\[\]\(\)\{\}])/g;
    module.exports = function globParent(str, opts) {
      var options = Object.assign({ flipBackslashes: true }, opts);
      if (options.flipBackslashes && isWin32 && str.indexOf(slash) < 0) {
        str = str.replace(backslash, slash);
      }
      if (enclosure.test(str)) {
        str += slash;
      }
      str += "a";
      do {
        str = pathPosixDirname(str);
      } while (isGlob(str) || globby.test(str));
      return str.replace(escaped, "$1");
    };
  }
});

// ../../node_modules/braces/lib/utils.js
var require_utils = __commonJS({
  "../../node_modules/braces/lib/utils.js"(exports) {
    "use strict";
    exports.isInteger = (num) => {
      if (typeof num === "number") {
        return Number.isInteger(num);
      }
      if (typeof num === "string" && num.trim() !== "") {
        return Number.isInteger(Number(num));
      }
      return false;
    };
    exports.find = (node, type) => node.nodes.find((node2) => node2.type === type);
    exports.exceedsLimit = (min, max, step = 1, limit) => {
      if (limit === false) return false;
      if (!exports.isInteger(min) || !exports.isInteger(max)) return false;
      return (Number(max) - Number(min)) / Number(step) >= limit;
    };
    exports.escapeNode = (block, n = 0, type) => {
      const node = block.nodes[n];
      if (!node) return;
      if (type && node.type === type || node.type === "open" || node.type === "close") {
        if (node.escaped !== true) {
          node.value = "\\" + node.value;
          node.escaped = true;
        }
      }
    };
    exports.encloseBrace = (node) => {
      if (node.type !== "brace") return false;
      if (node.commas >> 0 + node.ranges >> 0 === 0) {
        node.invalid = true;
        return true;
      }
      return false;
    };
    exports.isInvalidBrace = (block) => {
      if (block.type !== "brace") return false;
      if (block.invalid === true || block.dollar) return true;
      if (block.commas >> 0 + block.ranges >> 0 === 0) {
        block.invalid = true;
        return true;
      }
      if (block.open !== true || block.close !== true) {
        block.invalid = true;
        return true;
      }
      return false;
    };
    exports.isOpenOrClose = (node) => {
      if (node.type === "open" || node.type === "close") {
        return true;
      }
      return node.open === true || node.close === true;
    };
    exports.reduce = (nodes) => nodes.reduce((acc, node) => {
      if (node.type === "text") acc.push(node.value);
      if (node.type === "range") node.type = "text";
      return acc;
    }, []);
    exports.flatten = (...args) => {
      const result = [];
      const flat = (arr) => {
        for (let i = 0; i < arr.length; i++) {
          const ele = arr[i];
          if (Array.isArray(ele)) {
            flat(ele);
            continue;
          }
          if (ele !== void 0) {
            result.push(ele);
          }
        }
        return result;
      };
      flat(args);
      return result;
    };
  }
});

// ../../node_modules/braces/lib/stringify.js
var require_stringify = __commonJS({
  "../../node_modules/braces/lib/stringify.js"(exports, module) {
    "use strict";
    var utils = require_utils();
    module.exports = (ast, options = {}) => {
      const stringify = (node, parent = {}) => {
        const invalidBlock = options.escapeInvalid && utils.isInvalidBrace(parent);
        const invalidNode = node.invalid === true && options.escapeInvalid === true;
        let output = "";
        if (node.value) {
          if ((invalidBlock || invalidNode) && utils.isOpenOrClose(node)) {
            return "\\" + node.value;
          }
          return node.value;
        }
        if (node.value) {
          return node.value;
        }
        if (node.nodes) {
          for (const child of node.nodes) {
            output += stringify(child);
          }
        }
        return output;
      };
      return stringify(ast);
    };
  }
});

// ../../node_modules/is-number/index.js
var require_is_number = __commonJS({
  "../../node_modules/is-number/index.js"(exports, module) {
    "use strict";
    module.exports = function(num) {
      if (typeof num === "number") {
        return num - num === 0;
      }
      if (typeof num === "string" && num.trim() !== "") {
        return Number.isFinite ? Number.isFinite(+num) : isFinite(+num);
      }
      return false;
    };
  }
});

// ../../node_modules/to-regex-range/index.js
var require_to_regex_range = __commonJS({
  "../../node_modules/to-regex-range/index.js"(exports, module) {
    "use strict";
    var isNumber = require_is_number();
    var toRegexRange = (min, max, options) => {
      if (isNumber(min) === false) {
        throw new TypeError("toRegexRange: expected the first argument to be a number");
      }
      if (max === void 0 || min === max) {
        return String(min);
      }
      if (isNumber(max) === false) {
        throw new TypeError("toRegexRange: expected the second argument to be a number.");
      }
      let opts = { relaxZeros: true, ...options };
      if (typeof opts.strictZeros === "boolean") {
        opts.relaxZeros = opts.strictZeros === false;
      }
      let relax = String(opts.relaxZeros);
      let shorthand = String(opts.shorthand);
      let capture = String(opts.capture);
      let wrap = String(opts.wrap);
      let cacheKey = min + ":" + max + "=" + relax + shorthand + capture + wrap;
      if (toRegexRange.cache.hasOwnProperty(cacheKey)) {
        return toRegexRange.cache[cacheKey].result;
      }
      let a = Math.min(min, max);
      let b = Math.max(min, max);
      if (Math.abs(a - b) === 1) {
        let result = min + "|" + max;
        if (opts.capture) {
          return `(${result})`;
        }
        if (opts.wrap === false) {
          return result;
        }
        return `(?:${result})`;
      }
      let isPadded = hasPadding(min) || hasPadding(max);
      let state = { min, max, a, b };
      let positives = [];
      let negatives = [];
      if (isPadded) {
        state.isPadded = isPadded;
        state.maxLen = String(state.max).length;
      }
      if (a < 0) {
        let newMin = b < 0 ? Math.abs(b) : 1;
        negatives = splitToPatterns(newMin, Math.abs(a), state, opts);
        a = state.a = 0;
      }
      if (b >= 0) {
        positives = splitToPatterns(a, b, state, opts);
      }
      state.negatives = negatives;
      state.positives = positives;
      state.result = collatePatterns(negatives, positives, opts);
      if (opts.capture === true) {
        state.result = `(${state.result})`;
      } else if (opts.wrap !== false && positives.length + negatives.length > 1) {
        state.result = `(?:${state.result})`;
      }
      toRegexRange.cache[cacheKey] = state;
      return state.result;
    };
    function collatePatterns(neg, pos, options) {
      let onlyNegative = filterPatterns(neg, pos, "-", false, options) || [];
      let onlyPositive = filterPatterns(pos, neg, "", false, options) || [];
      let intersected = filterPatterns(neg, pos, "-?", true, options) || [];
      let subpatterns = onlyNegative.concat(intersected).concat(onlyPositive);
      return subpatterns.join("|");
    }
    function splitToRanges(min, max) {
      let nines = 1;
      let zeros = 1;
      let stop = countNines(min, nines);
      let stops = /* @__PURE__ */ new Set([max]);
      while (min <= stop && stop <= max) {
        stops.add(stop);
        nines += 1;
        stop = countNines(min, nines);
      }
      stop = countZeros(max + 1, zeros) - 1;
      while (min < stop && stop <= max) {
        stops.add(stop);
        zeros += 1;
        stop = countZeros(max + 1, zeros) - 1;
      }
      stops = [...stops];
      stops.sort(compare);
      return stops;
    }
    function rangeToPattern(start, stop, options) {
      if (start === stop) {
        return { pattern: start, count: [], digits: 0 };
      }
      let zipped = zip(start, stop);
      let digits = zipped.length;
      let pattern = "";
      let count = 0;
      for (let i = 0; i < digits; i++) {
        let [startDigit, stopDigit] = zipped[i];
        if (startDigit === stopDigit) {
          pattern += startDigit;
        } else if (startDigit !== "0" || stopDigit !== "9") {
          pattern += toCharacterClass(startDigit, stopDigit, options);
        } else {
          count++;
        }
      }
      if (count) {
        pattern += options.shorthand === true ? "\\d" : "[0-9]";
      }
      return { pattern, count: [count], digits };
    }
    function splitToPatterns(min, max, tok, options) {
      let ranges = splitToRanges(min, max);
      let tokens = [];
      let start = min;
      let prev;
      for (let i = 0; i < ranges.length; i++) {
        let max2 = ranges[i];
        let obj = rangeToPattern(String(start), String(max2), options);
        let zeros = "";
        if (!tok.isPadded && prev && prev.pattern === obj.pattern) {
          if (prev.count.length > 1) {
            prev.count.pop();
          }
          prev.count.push(obj.count[0]);
          prev.string = prev.pattern + toQuantifier(prev.count);
          start = max2 + 1;
          continue;
        }
        if (tok.isPadded) {
          zeros = padZeros(max2, tok, options);
        }
        obj.string = zeros + obj.pattern + toQuantifier(obj.count);
        tokens.push(obj);
        start = max2 + 1;
        prev = obj;
      }
      return tokens;
    }
    function filterPatterns(arr, comparison, prefix2, intersection, options) {
      let result = [];
      for (let ele of arr) {
        let { string } = ele;
        if (!intersection && !contains(comparison, "string", string)) {
          result.push(prefix2 + string);
        }
        if (intersection && contains(comparison, "string", string)) {
          result.push(prefix2 + string);
        }
      }
      return result;
    }
    function zip(a, b) {
      let arr = [];
      for (let i = 0; i < a.length; i++) arr.push([a[i], b[i]]);
      return arr;
    }
    function compare(a, b) {
      return a > b ? 1 : b > a ? -1 : 0;
    }
    function contains(arr, key, val) {
      return arr.some((ele) => ele[key] === val);
    }
    function countNines(min, len) {
      return Number(String(min).slice(0, -len) + "9".repeat(len));
    }
    function countZeros(integer, zeros) {
      return integer - integer % Math.pow(10, zeros);
    }
    function toQuantifier(digits) {
      let [start = 0, stop = ""] = digits;
      if (stop || start > 1) {
        return `{${start + (stop ? "," + stop : "")}}`;
      }
      return "";
    }
    function toCharacterClass(a, b, options) {
      return `[${a}${b - a === 1 ? "" : "-"}${b}]`;
    }
    function hasPadding(str) {
      return /^-?(0+)\d/.test(str);
    }
    function padZeros(value, tok, options) {
      if (!tok.isPadded) {
        return value;
      }
      let diff = Math.abs(tok.maxLen - String(value).length);
      let relax = options.relaxZeros !== false;
      switch (diff) {
        case 0:
          return "";
        case 1:
          return relax ? "0?" : "0";
        case 2:
          return relax ? "0{0,2}" : "00";
        default: {
          return relax ? `0{0,${diff}}` : `0{${diff}}`;
        }
      }
    }
    toRegexRange.cache = {};
    toRegexRange.clearCache = () => toRegexRange.cache = {};
    module.exports = toRegexRange;
  }
});

// ../../node_modules/fill-range/index.js
var require_fill_range = __commonJS({
  "../../node_modules/fill-range/index.js"(exports, module) {
    "use strict";
    var util = __require("util");
    var toRegexRange = require_to_regex_range();
    var isObject = (val) => val !== null && typeof val === "object" && !Array.isArray(val);
    var transform = (toNumber) => {
      return (value) => toNumber === true ? Number(value) : String(value);
    };
    var isValidValue = (value) => {
      return typeof value === "number" || typeof value === "string" && value !== "";
    };
    var isNumber = (num) => Number.isInteger(+num);
    var zeros = (input) => {
      let value = `${input}`;
      let index = -1;
      if (value[0] === "-") value = value.slice(1);
      if (value === "0") return false;
      while (value[++index] === "0") ;
      return index > 0;
    };
    var stringify = (start, end, options) => {
      if (typeof start === "string" || typeof end === "string") {
        return true;
      }
      return options.stringify === true;
    };
    var pad = (input, maxLength, toNumber) => {
      if (maxLength > 0) {
        let dash = input[0] === "-" ? "-" : "";
        if (dash) input = input.slice(1);
        input = dash + input.padStart(dash ? maxLength - 1 : maxLength, "0");
      }
      if (toNumber === false) {
        return String(input);
      }
      return input;
    };
    var toMaxLen = (input, maxLength) => {
      let negative = input[0] === "-" ? "-" : "";
      if (negative) {
        input = input.slice(1);
        maxLength--;
      }
      while (input.length < maxLength) input = "0" + input;
      return negative ? "-" + input : input;
    };
    var toSequence = (parts, options, maxLen) => {
      parts.negatives.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      parts.positives.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      let prefix2 = options.capture ? "" : "?:";
      let positives = "";
      let negatives = "";
      let result;
      if (parts.positives.length) {
        positives = parts.positives.map((v) => toMaxLen(String(v), maxLen)).join("|");
      }
      if (parts.negatives.length) {
        negatives = `-(${prefix2}${parts.negatives.map((v) => toMaxLen(String(v), maxLen)).join("|")})`;
      }
      if (positives && negatives) {
        result = `${positives}|${negatives}`;
      } else {
        result = positives || negatives;
      }
      if (options.wrap) {
        return `(${prefix2}${result})`;
      }
      return result;
    };
    var toRange = (a, b, isNumbers, options) => {
      if (isNumbers) {
        return toRegexRange(a, b, { wrap: false, ...options });
      }
      let start = String.fromCharCode(a);
      if (a === b) return start;
      let stop = String.fromCharCode(b);
      return `[${start}-${stop}]`;
    };
    var toRegex = (start, end, options) => {
      if (Array.isArray(start)) {
        let wrap = options.wrap === true;
        let prefix2 = options.capture ? "" : "?:";
        return wrap ? `(${prefix2}${start.join("|")})` : start.join("|");
      }
      return toRegexRange(start, end, options);
    };
    var rangeError = (...args) => {
      return new RangeError("Invalid range arguments: " + util.inspect(...args));
    };
    var invalidRange = (start, end, options) => {
      if (options.strictRanges === true) throw rangeError([start, end]);
      return [];
    };
    var invalidStep = (step, options) => {
      if (options.strictRanges === true) {
        throw new TypeError(`Expected step "${step}" to be a number`);
      }
      return [];
    };
    var fillNumbers = (start, end, step = 1, options = {}) => {
      let a = Number(start);
      let b = Number(end);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        if (options.strictRanges === true) throw rangeError([start, end]);
        return [];
      }
      if (a === 0) a = 0;
      if (b === 0) b = 0;
      let descending = a > b;
      let startString = String(start);
      let endString = String(end);
      let stepString = String(step);
      step = Math.max(Math.abs(step), 1);
      let padded = zeros(startString) || zeros(endString) || zeros(stepString);
      let maxLen = padded ? Math.max(startString.length, endString.length, stepString.length) : 0;
      let toNumber = padded === false && stringify(start, end, options) === false;
      let format = options.transform || transform(toNumber);
      if (options.toRegex && step === 1) {
        return toRange(toMaxLen(start, maxLen), toMaxLen(end, maxLen), true, options);
      }
      let parts = { negatives: [], positives: [] };
      let push = (num) => parts[num < 0 ? "negatives" : "positives"].push(Math.abs(num));
      let range = [];
      let index = 0;
      while (descending ? a >= b : a <= b) {
        if (options.toRegex === true && step > 1) {
          push(a);
        } else {
          range.push(pad(format(a, index), maxLen, toNumber));
        }
        a = descending ? a - step : a + step;
        index++;
      }
      if (options.toRegex === true) {
        return step > 1 ? toSequence(parts, options, maxLen) : toRegex(range, null, { wrap: false, ...options });
      }
      return range;
    };
    var fillLetters = (start, end, step = 1, options = {}) => {
      if (!isNumber(start) && start.length > 1 || !isNumber(end) && end.length > 1) {
        return invalidRange(start, end, options);
      }
      let format = options.transform || ((val) => String.fromCharCode(val));
      let a = `${start}`.charCodeAt(0);
      let b = `${end}`.charCodeAt(0);
      let descending = a > b;
      let min = Math.min(a, b);
      let max = Math.max(a, b);
      if (options.toRegex && step === 1) {
        return toRange(min, max, false, options);
      }
      let range = [];
      let index = 0;
      while (descending ? a >= b : a <= b) {
        range.push(format(a, index));
        a = descending ? a - step : a + step;
        index++;
      }
      if (options.toRegex === true) {
        return toRegex(range, null, { wrap: false, options });
      }
      return range;
    };
    var fill = (start, end, step, options = {}) => {
      if (end == null && isValidValue(start)) {
        return [start];
      }
      if (!isValidValue(start) || !isValidValue(end)) {
        return invalidRange(start, end, options);
      }
      if (typeof step === "function") {
        return fill(start, end, 1, { transform: step });
      }
      if (isObject(step)) {
        return fill(start, end, 0, step);
      }
      let opts = { ...options };
      if (opts.capture === true) opts.wrap = true;
      step = step || opts.step || 1;
      if (!isNumber(step)) {
        if (step != null && !isObject(step)) return invalidStep(step, opts);
        return fill(start, end, 1, step);
      }
      if (isNumber(start) && isNumber(end)) {
        return fillNumbers(start, end, step, opts);
      }
      return fillLetters(start, end, Math.max(Math.abs(step), 1), opts);
    };
    module.exports = fill;
  }
});

// ../../node_modules/braces/lib/compile.js
var require_compile = __commonJS({
  "../../node_modules/braces/lib/compile.js"(exports, module) {
    "use strict";
    var fill = require_fill_range();
    var utils = require_utils();
    var compile = (ast, options = {}) => {
      const walk = (node, parent = {}) => {
        const invalidBlock = utils.isInvalidBrace(parent);
        const invalidNode = node.invalid === true && options.escapeInvalid === true;
        const invalid = invalidBlock === true || invalidNode === true;
        const prefix2 = options.escapeInvalid === true ? "\\" : "";
        let output = "";
        if (node.isOpen === true) {
          return prefix2 + node.value;
        }
        if (node.isClose === true) {
          console.log("node.isClose", prefix2, node.value);
          return prefix2 + node.value;
        }
        if (node.type === "open") {
          return invalid ? prefix2 + node.value : "(";
        }
        if (node.type === "close") {
          return invalid ? prefix2 + node.value : ")";
        }
        if (node.type === "comma") {
          return node.prev.type === "comma" ? "" : invalid ? node.value : "|";
        }
        if (node.value) {
          return node.value;
        }
        if (node.nodes && node.ranges > 0) {
          const args = utils.reduce(node.nodes);
          const range = fill(...args, { ...options, wrap: false, toRegex: true, strictZeros: true });
          if (range.length !== 0) {
            return args.length > 1 && range.length > 1 ? `(${range})` : range;
          }
        }
        if (node.nodes) {
          for (const child of node.nodes) {
            output += walk(child, node);
          }
        }
        return output;
      };
      return walk(ast);
    };
    module.exports = compile;
  }
});

// ../../node_modules/braces/lib/expand.js
var require_expand = __commonJS({
  "../../node_modules/braces/lib/expand.js"(exports, module) {
    "use strict";
    var fill = require_fill_range();
    var stringify = require_stringify();
    var utils = require_utils();
    var append = (queue = "", stash = "", enclose = false) => {
      const result = [];
      queue = [].concat(queue);
      stash = [].concat(stash);
      if (!stash.length) return queue;
      if (!queue.length) {
        return enclose ? utils.flatten(stash).map((ele) => `{${ele}}`) : stash;
      }
      for (const item of queue) {
        if (Array.isArray(item)) {
          for (const value of item) {
            result.push(append(value, stash, enclose));
          }
        } else {
          for (let ele of stash) {
            if (enclose === true && typeof ele === "string") ele = `{${ele}}`;
            result.push(Array.isArray(ele) ? append(item, ele, enclose) : item + ele);
          }
        }
      }
      return utils.flatten(result);
    };
    var expand = (ast, options = {}) => {
      const rangeLimit = options.rangeLimit === void 0 ? 1e3 : options.rangeLimit;
      const walk = (node, parent = {}) => {
        node.queue = [];
        let p = parent;
        let q = parent.queue;
        while (p.type !== "brace" && p.type !== "root" && p.parent) {
          p = p.parent;
          q = p.queue;
        }
        if (node.invalid || node.dollar) {
          q.push(append(q.pop(), stringify(node, options)));
          return;
        }
        if (node.type === "brace" && node.invalid !== true && node.nodes.length === 2) {
          q.push(append(q.pop(), ["{}"]));
          return;
        }
        if (node.nodes && node.ranges > 0) {
          const args = utils.reduce(node.nodes);
          if (utils.exceedsLimit(...args, options.step, rangeLimit)) {
            throw new RangeError("expanded array length exceeds range limit. Use options.rangeLimit to increase or disable the limit.");
          }
          let range = fill(...args, options);
          if (range.length === 0) {
            range = stringify(node, options);
          }
          q.push(append(q.pop(), range));
          node.nodes = [];
          return;
        }
        const enclose = utils.encloseBrace(node);
        let queue = node.queue;
        let block = node;
        while (block.type !== "brace" && block.type !== "root" && block.parent) {
          block = block.parent;
          queue = block.queue;
        }
        for (let i = 0; i < node.nodes.length; i++) {
          const child = node.nodes[i];
          if (child.type === "comma" && node.type === "brace") {
            if (i === 1) queue.push("");
            queue.push("");
            continue;
          }
          if (child.type === "close") {
            q.push(append(q.pop(), queue, enclose));
            continue;
          }
          if (child.value && child.type !== "open") {
            queue.push(append(queue.pop(), child.value));
            continue;
          }
          if (child.nodes) {
            walk(child, node);
          }
        }
        return queue;
      };
      return utils.flatten(walk(ast));
    };
    module.exports = expand;
  }
});

// ../../node_modules/braces/lib/constants.js
var require_constants = __commonJS({
  "../../node_modules/braces/lib/constants.js"(exports, module) {
    "use strict";
    module.exports = {
      MAX_LENGTH: 1e4,
      // Digits
      CHAR_0: "0",
      /* 0 */
      CHAR_9: "9",
      /* 9 */
      // Alphabet chars.
      CHAR_UPPERCASE_A: "A",
      /* A */
      CHAR_LOWERCASE_A: "a",
      /* a */
      CHAR_UPPERCASE_Z: "Z",
      /* Z */
      CHAR_LOWERCASE_Z: "z",
      /* z */
      CHAR_LEFT_PARENTHESES: "(",
      /* ( */
      CHAR_RIGHT_PARENTHESES: ")",
      /* ) */
      CHAR_ASTERISK: "*",
      /* * */
      // Non-alphabetic chars.
      CHAR_AMPERSAND: "&",
      /* & */
      CHAR_AT: "@",
      /* @ */
      CHAR_BACKSLASH: "\\",
      /* \ */
      CHAR_BACKTICK: "`",
      /* ` */
      CHAR_CARRIAGE_RETURN: "\r",
      /* \r */
      CHAR_CIRCUMFLEX_ACCENT: "^",
      /* ^ */
      CHAR_COLON: ":",
      /* : */
      CHAR_COMMA: ",",
      /* , */
      CHAR_DOLLAR: "$",
      /* . */
      CHAR_DOT: ".",
      /* . */
      CHAR_DOUBLE_QUOTE: '"',
      /* " */
      CHAR_EQUAL: "=",
      /* = */
      CHAR_EXCLAMATION_MARK: "!",
      /* ! */
      CHAR_FORM_FEED: "\f",
      /* \f */
      CHAR_FORWARD_SLASH: "/",
      /* / */
      CHAR_HASH: "#",
      /* # */
      CHAR_HYPHEN_MINUS: "-",
      /* - */
      CHAR_LEFT_ANGLE_BRACKET: "<",
      /* < */
      CHAR_LEFT_CURLY_BRACE: "{",
      /* { */
      CHAR_LEFT_SQUARE_BRACKET: "[",
      /* [ */
      CHAR_LINE_FEED: "\n",
      /* \n */
      CHAR_NO_BREAK_SPACE: "\xA0",
      /* \u00A0 */
      CHAR_PERCENT: "%",
      /* % */
      CHAR_PLUS: "+",
      /* + */
      CHAR_QUESTION_MARK: "?",
      /* ? */
      CHAR_RIGHT_ANGLE_BRACKET: ">",
      /* > */
      CHAR_RIGHT_CURLY_BRACE: "}",
      /* } */
      CHAR_RIGHT_SQUARE_BRACKET: "]",
      /* ] */
      CHAR_SEMICOLON: ";",
      /* ; */
      CHAR_SINGLE_QUOTE: "'",
      /* ' */
      CHAR_SPACE: " ",
      /*   */
      CHAR_TAB: "	",
      /* \t */
      CHAR_UNDERSCORE: "_",
      /* _ */
      CHAR_VERTICAL_LINE: "|",
      /* | */
      CHAR_ZERO_WIDTH_NOBREAK_SPACE: "\uFEFF"
      /* \uFEFF */
    };
  }
});

// ../../node_modules/braces/lib/parse.js
var require_parse = __commonJS({
  "../../node_modules/braces/lib/parse.js"(exports, module) {
    "use strict";
    var stringify = require_stringify();
    var {
      MAX_LENGTH,
      CHAR_BACKSLASH,
      /* \ */
      CHAR_BACKTICK,
      /* ` */
      CHAR_COMMA,
      /* , */
      CHAR_DOT,
      /* . */
      CHAR_LEFT_PARENTHESES,
      /* ( */
      CHAR_RIGHT_PARENTHESES,
      /* ) */
      CHAR_LEFT_CURLY_BRACE,
      /* { */
      CHAR_RIGHT_CURLY_BRACE,
      /* } */
      CHAR_LEFT_SQUARE_BRACKET,
      /* [ */
      CHAR_RIGHT_SQUARE_BRACKET,
      /* ] */
      CHAR_DOUBLE_QUOTE,
      /* " */
      CHAR_SINGLE_QUOTE,
      /* ' */
      CHAR_NO_BREAK_SPACE,
      CHAR_ZERO_WIDTH_NOBREAK_SPACE
    } = require_constants();
    var parse = (input, options = {}) => {
      if (typeof input !== "string") {
        throw new TypeError("Expected a string");
      }
      const opts = options || {};
      const max = typeof opts.maxLength === "number" ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
      if (input.length > max) {
        throw new SyntaxError(`Input length (${input.length}), exceeds max characters (${max})`);
      }
      const ast = { type: "root", input, nodes: [] };
      const stack = [ast];
      let block = ast;
      let prev = ast;
      let brackets = 0;
      const length = input.length;
      let index = 0;
      let depth = 0;
      let value;
      const advance = () => input[index++];
      const push = (node) => {
        if (node.type === "text" && prev.type === "dot") {
          prev.type = "text";
        }
        if (prev && prev.type === "text" && node.type === "text") {
          prev.value += node.value;
          return;
        }
        block.nodes.push(node);
        node.parent = block;
        node.prev = prev;
        prev = node;
        return node;
      };
      push({ type: "bos" });
      while (index < length) {
        block = stack[stack.length - 1];
        value = advance();
        if (value === CHAR_ZERO_WIDTH_NOBREAK_SPACE || value === CHAR_NO_BREAK_SPACE) {
          continue;
        }
        if (value === CHAR_BACKSLASH) {
          push({ type: "text", value: (options.keepEscaping ? value : "") + advance() });
          continue;
        }
        if (value === CHAR_RIGHT_SQUARE_BRACKET) {
          push({ type: "text", value: "\\" + value });
          continue;
        }
        if (value === CHAR_LEFT_SQUARE_BRACKET) {
          brackets++;
          let next;
          while (index < length && (next = advance())) {
            value += next;
            if (next === CHAR_LEFT_SQUARE_BRACKET) {
              brackets++;
              continue;
            }
            if (next === CHAR_BACKSLASH) {
              value += advance();
              continue;
            }
            if (next === CHAR_RIGHT_SQUARE_BRACKET) {
              brackets--;
              if (brackets === 0) {
                break;
              }
            }
          }
          push({ type: "text", value });
          continue;
        }
        if (value === CHAR_LEFT_PARENTHESES) {
          block = push({ type: "paren", nodes: [] });
          stack.push(block);
          push({ type: "text", value });
          continue;
        }
        if (value === CHAR_RIGHT_PARENTHESES) {
          if (block.type !== "paren") {
            push({ type: "text", value });
            continue;
          }
          block = stack.pop();
          push({ type: "text", value });
          block = stack[stack.length - 1];
          continue;
        }
        if (value === CHAR_DOUBLE_QUOTE || value === CHAR_SINGLE_QUOTE || value === CHAR_BACKTICK) {
          const open = value;
          let next;
          if (options.keepQuotes !== true) {
            value = "";
          }
          while (index < length && (next = advance())) {
            if (next === CHAR_BACKSLASH) {
              value += next + advance();
              continue;
            }
            if (next === open) {
              if (options.keepQuotes === true) value += next;
              break;
            }
            value += next;
          }
          push({ type: "text", value });
          continue;
        }
        if (value === CHAR_LEFT_CURLY_BRACE) {
          depth++;
          const dollar = prev.value && prev.value.slice(-1) === "$" || block.dollar === true;
          const brace = {
            type: "brace",
            open: true,
            close: false,
            dollar,
            depth,
            commas: 0,
            ranges: 0,
            nodes: []
          };
          block = push(brace);
          stack.push(block);
          push({ type: "open", value });
          continue;
        }
        if (value === CHAR_RIGHT_CURLY_BRACE) {
          if (block.type !== "brace") {
            push({ type: "text", value });
            continue;
          }
          const type = "close";
          block = stack.pop();
          block.close = true;
          push({ type, value });
          depth--;
          block = stack[stack.length - 1];
          continue;
        }
        if (value === CHAR_COMMA && depth > 0) {
          if (block.ranges > 0) {
            block.ranges = 0;
            const open = block.nodes.shift();
            block.nodes = [open, { type: "text", value: stringify(block) }];
          }
          push({ type: "comma", value });
          block.commas++;
          continue;
        }
        if (value === CHAR_DOT && depth > 0 && block.commas === 0) {
          const siblings = block.nodes;
          if (depth === 0 || siblings.length === 0) {
            push({ type: "text", value });
            continue;
          }
          if (prev.type === "dot") {
            block.range = [];
            prev.value += value;
            prev.type = "range";
            if (block.nodes.length !== 3 && block.nodes.length !== 5) {
              block.invalid = true;
              block.ranges = 0;
              prev.type = "text";
              continue;
            }
            block.ranges++;
            block.args = [];
            continue;
          }
          if (prev.type === "range") {
            siblings.pop();
            const before = siblings[siblings.length - 1];
            before.value += prev.value + value;
            prev = before;
            block.ranges--;
            continue;
          }
          push({ type: "dot", value });
          continue;
        }
        push({ type: "text", value });
      }
      do {
        block = stack.pop();
        if (block.type !== "root") {
          block.nodes.forEach((node) => {
            if (!node.nodes) {
              if (node.type === "open") node.isOpen = true;
              if (node.type === "close") node.isClose = true;
              if (!node.nodes) node.type = "text";
              node.invalid = true;
            }
          });
          const parent = stack[stack.length - 1];
          const index2 = parent.nodes.indexOf(block);
          parent.nodes.splice(index2, 1, ...block.nodes);
        }
      } while (stack.length > 0);
      push({ type: "eos" });
      return ast;
    };
    module.exports = parse;
  }
});

// ../../node_modules/braces/index.js
var require_braces = __commonJS({
  "../../node_modules/braces/index.js"(exports, module) {
    "use strict";
    var stringify = require_stringify();
    var compile = require_compile();
    var expand = require_expand();
    var parse = require_parse();
    var braces = (input, options = {}) => {
      let output = [];
      if (Array.isArray(input)) {
        for (const pattern of input) {
          const result = braces.create(pattern, options);
          if (Array.isArray(result)) {
            output.push(...result);
          } else {
            output.push(result);
          }
        }
      } else {
        output = [].concat(braces.create(input, options));
      }
      if (options && options.expand === true && options.nodupes === true) {
        output = [...new Set(output)];
      }
      return output;
    };
    braces.parse = (input, options = {}) => parse(input, options);
    braces.stringify = (input, options = {}) => {
      if (typeof input === "string") {
        return stringify(braces.parse(input, options), options);
      }
      return stringify(input, options);
    };
    braces.compile = (input, options = {}) => {
      if (typeof input === "string") {
        input = braces.parse(input, options);
      }
      return compile(input, options);
    };
    braces.expand = (input, options = {}) => {
      if (typeof input === "string") {
        input = braces.parse(input, options);
      }
      let result = expand(input, options);
      if (options.noempty === true) {
        result = result.filter(Boolean);
      }
      if (options.nodupes === true) {
        result = [...new Set(result)];
      }
      return result;
    };
    braces.create = (input, options = {}) => {
      if (input === "" || input.length < 3) {
        return [input];
      }
      return options.expand !== true ? braces.compile(input, options) : braces.expand(input, options);
    };
    module.exports = braces;
  }
});

// ../../node_modules/micromatch/node_modules/picomatch/lib/constants.js
var require_constants2 = __commonJS({
  "../../node_modules/micromatch/node_modules/picomatch/lib/constants.js"(exports, module) {
    "use strict";
    var path = __require("path");
    var WIN_SLASH = "\\\\/";
    var WIN_NO_SLASH = `[^${WIN_SLASH}]`;
    var DEFAULT_MAX_EXTGLOB_RECURSION = 0;
    var DOT_LITERAL = "\\.";
    var PLUS_LITERAL = "\\+";
    var QMARK_LITERAL = "\\?";
    var SLASH_LITERAL = "\\/";
    var ONE_CHAR = "(?=.)";
    var QMARK = "[^/]";
    var END_ANCHOR = `(?:${SLASH_LITERAL}|$)`;
    var START_ANCHOR = `(?:^|${SLASH_LITERAL})`;
    var DOTS_SLASH = `${DOT_LITERAL}{1,2}${END_ANCHOR}`;
    var NO_DOT = `(?!${DOT_LITERAL})`;
    var NO_DOTS = `(?!${START_ANCHOR}${DOTS_SLASH})`;
    var NO_DOT_SLASH = `(?!${DOT_LITERAL}{0,1}${END_ANCHOR})`;
    var NO_DOTS_SLASH = `(?!${DOTS_SLASH})`;
    var QMARK_NO_DOT = `[^.${SLASH_LITERAL}]`;
    var STAR = `${QMARK}*?`;
    var POSIX_CHARS = {
      DOT_LITERAL,
      PLUS_LITERAL,
      QMARK_LITERAL,
      SLASH_LITERAL,
      ONE_CHAR,
      QMARK,
      END_ANCHOR,
      DOTS_SLASH,
      NO_DOT,
      NO_DOTS,
      NO_DOT_SLASH,
      NO_DOTS_SLASH,
      QMARK_NO_DOT,
      STAR,
      START_ANCHOR
    };
    var WINDOWS_CHARS = {
      ...POSIX_CHARS,
      SLASH_LITERAL: `[${WIN_SLASH}]`,
      QMARK: WIN_NO_SLASH,
      STAR: `${WIN_NO_SLASH}*?`,
      DOTS_SLASH: `${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$)`,
      NO_DOT: `(?!${DOT_LITERAL})`,
      NO_DOTS: `(?!(?:^|[${WIN_SLASH}])${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$))`,
      NO_DOT_SLASH: `(?!${DOT_LITERAL}{0,1}(?:[${WIN_SLASH}]|$))`,
      NO_DOTS_SLASH: `(?!${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$))`,
      QMARK_NO_DOT: `[^.${WIN_SLASH}]`,
      START_ANCHOR: `(?:^|[${WIN_SLASH}])`,
      END_ANCHOR: `(?:[${WIN_SLASH}]|$)`
    };
    var POSIX_REGEX_SOURCE = {
      __proto__: null,
      alnum: "a-zA-Z0-9",
      alpha: "a-zA-Z",
      ascii: "\\x00-\\x7F",
      blank: " \\t",
      cntrl: "\\x00-\\x1F\\x7F",
      digit: "0-9",
      graph: "\\x21-\\x7E",
      lower: "a-z",
      print: "\\x20-\\x7E ",
      punct: "\\-!\"#$%&'()\\*+,./:;<=>?@[\\]^_`{|}~",
      space: " \\t\\r\\n\\v\\f",
      upper: "A-Z",
      word: "A-Za-z0-9_",
      xdigit: "A-Fa-f0-9"
    };
    module.exports = {
      DEFAULT_MAX_EXTGLOB_RECURSION,
      MAX_LENGTH: 1024 * 64,
      POSIX_REGEX_SOURCE,
      // regular expressions
      REGEX_BACKSLASH: /\\(?![*+?^${}(|)[\]])/g,
      REGEX_NON_SPECIAL_CHARS: /^[^@![\].,$*+?^{}()|\\/]+/,
      REGEX_SPECIAL_CHARS: /[-*+?.^${}(|)[\]]/,
      REGEX_SPECIAL_CHARS_BACKREF: /(\\?)((\W)(\3*))/g,
      REGEX_SPECIAL_CHARS_GLOBAL: /([-*+?.^${}(|)[\]])/g,
      REGEX_REMOVE_BACKSLASH: /(?:\[.*?[^\\]\]|\\(?=.))/g,
      // Replace globs with equivalent patterns to reduce parsing time.
      REPLACEMENTS: {
        __proto__: null,
        "***": "*",
        "**/**": "**",
        "**/**/**": "**"
      },
      // Digits
      CHAR_0: 48,
      /* 0 */
      CHAR_9: 57,
      /* 9 */
      // Alphabet chars.
      CHAR_UPPERCASE_A: 65,
      /* A */
      CHAR_LOWERCASE_A: 97,
      /* a */
      CHAR_UPPERCASE_Z: 90,
      /* Z */
      CHAR_LOWERCASE_Z: 122,
      /* z */
      CHAR_LEFT_PARENTHESES: 40,
      /* ( */
      CHAR_RIGHT_PARENTHESES: 41,
      /* ) */
      CHAR_ASTERISK: 42,
      /* * */
      // Non-alphabetic chars.
      CHAR_AMPERSAND: 38,
      /* & */
      CHAR_AT: 64,
      /* @ */
      CHAR_BACKWARD_SLASH: 92,
      /* \ */
      CHAR_CARRIAGE_RETURN: 13,
      /* \r */
      CHAR_CIRCUMFLEX_ACCENT: 94,
      /* ^ */
      CHAR_COLON: 58,
      /* : */
      CHAR_COMMA: 44,
      /* , */
      CHAR_DOT: 46,
      /* . */
      CHAR_DOUBLE_QUOTE: 34,
      /* " */
      CHAR_EQUAL: 61,
      /* = */
      CHAR_EXCLAMATION_MARK: 33,
      /* ! */
      CHAR_FORM_FEED: 12,
      /* \f */
      CHAR_FORWARD_SLASH: 47,
      /* / */
      CHAR_GRAVE_ACCENT: 96,
      /* ` */
      CHAR_HASH: 35,
      /* # */
      CHAR_HYPHEN_MINUS: 45,
      /* - */
      CHAR_LEFT_ANGLE_BRACKET: 60,
      /* < */
      CHAR_LEFT_CURLY_BRACE: 123,
      /* { */
      CHAR_LEFT_SQUARE_BRACKET: 91,
      /* [ */
      CHAR_LINE_FEED: 10,
      /* \n */
      CHAR_NO_BREAK_SPACE: 160,
      /* \u00A0 */
      CHAR_PERCENT: 37,
      /* % */
      CHAR_PLUS: 43,
      /* + */
      CHAR_QUESTION_MARK: 63,
      /* ? */
      CHAR_RIGHT_ANGLE_BRACKET: 62,
      /* > */
      CHAR_RIGHT_CURLY_BRACE: 125,
      /* } */
      CHAR_RIGHT_SQUARE_BRACKET: 93,
      /* ] */
      CHAR_SEMICOLON: 59,
      /* ; */
      CHAR_SINGLE_QUOTE: 39,
      /* ' */
      CHAR_SPACE: 32,
      /*   */
      CHAR_TAB: 9,
      /* \t */
      CHAR_UNDERSCORE: 95,
      /* _ */
      CHAR_VERTICAL_LINE: 124,
      /* | */
      CHAR_ZERO_WIDTH_NOBREAK_SPACE: 65279,
      /* \uFEFF */
      SEP: path.sep,
      /**
       * Create EXTGLOB_CHARS
       */
      extglobChars(chars) {
        return {
          "!": { type: "negate", open: "(?:(?!(?:", close: `))${chars.STAR})` },
          "?": { type: "qmark", open: "(?:", close: ")?" },
          "+": { type: "plus", open: "(?:", close: ")+" },
          "*": { type: "star", open: "(?:", close: ")*" },
          "@": { type: "at", open: "(?:", close: ")" }
        };
      },
      /**
       * Create GLOB_CHARS
       */
      globChars(win32) {
        return win32 === true ? WINDOWS_CHARS : POSIX_CHARS;
      }
    };
  }
});

// ../../node_modules/micromatch/node_modules/picomatch/lib/utils.js
var require_utils2 = __commonJS({
  "../../node_modules/micromatch/node_modules/picomatch/lib/utils.js"(exports) {
    "use strict";
    var path = __require("path");
    var win32 = process.platform === "win32";
    var {
      REGEX_BACKSLASH,
      REGEX_REMOVE_BACKSLASH,
      REGEX_SPECIAL_CHARS,
      REGEX_SPECIAL_CHARS_GLOBAL
    } = require_constants2();
    exports.isObject = (val) => val !== null && typeof val === "object" && !Array.isArray(val);
    exports.hasRegexChars = (str) => REGEX_SPECIAL_CHARS.test(str);
    exports.isRegexChar = (str) => str.length === 1 && exports.hasRegexChars(str);
    exports.escapeRegex = (str) => str.replace(REGEX_SPECIAL_CHARS_GLOBAL, "\\$1");
    exports.toPosixSlashes = (str) => str.replace(REGEX_BACKSLASH, "/");
    exports.removeBackslashes = (str) => {
      return str.replace(REGEX_REMOVE_BACKSLASH, (match) => {
        return match === "\\" ? "" : match;
      });
    };
    exports.supportsLookbehinds = () => {
      const segs = process.version.slice(1).split(".").map(Number);
      if (segs.length === 3 && segs[0] >= 9 || segs[0] === 8 && segs[1] >= 10) {
        return true;
      }
      return false;
    };
    exports.isWindows = (options) => {
      if (options && typeof options.windows === "boolean") {
        return options.windows;
      }
      return win32 === true || path.sep === "\\";
    };
    exports.escapeLast = (input, char, lastIdx) => {
      const idx = input.lastIndexOf(char, lastIdx);
      if (idx === -1) return input;
      if (input[idx - 1] === "\\") return exports.escapeLast(input, char, idx - 1);
      return `${input.slice(0, idx)}\\${input.slice(idx)}`;
    };
    exports.removePrefix = (input, state = {}) => {
      let output = input;
      if (output.startsWith("./")) {
        output = output.slice(2);
        state.prefix = "./";
      }
      return output;
    };
    exports.wrapOutput = (input, state = {}, options = {}) => {
      const prepend = options.contains ? "" : "^";
      const append = options.contains ? "" : "$";
      let output = `${prepend}(?:${input})${append}`;
      if (state.negated === true) {
        output = `(?:^(?!${output}).*$)`;
      }
      return output;
    };
  }
});

// ../../node_modules/micromatch/node_modules/picomatch/lib/scan.js
var require_scan = __commonJS({
  "../../node_modules/micromatch/node_modules/picomatch/lib/scan.js"(exports, module) {
    "use strict";
    var utils = require_utils2();
    var {
      CHAR_ASTERISK,
      /* * */
      CHAR_AT,
      /* @ */
      CHAR_BACKWARD_SLASH,
      /* \ */
      CHAR_COMMA,
      /* , */
      CHAR_DOT,
      /* . */
      CHAR_EXCLAMATION_MARK,
      /* ! */
      CHAR_FORWARD_SLASH,
      /* / */
      CHAR_LEFT_CURLY_BRACE,
      /* { */
      CHAR_LEFT_PARENTHESES,
      /* ( */
      CHAR_LEFT_SQUARE_BRACKET,
      /* [ */
      CHAR_PLUS,
      /* + */
      CHAR_QUESTION_MARK,
      /* ? */
      CHAR_RIGHT_CURLY_BRACE,
      /* } */
      CHAR_RIGHT_PARENTHESES,
      /* ) */
      CHAR_RIGHT_SQUARE_BRACKET
      /* ] */
    } = require_constants2();
    var isPathSeparator = (code) => {
      return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
    };
    var depth = (token) => {
      if (token.isPrefix !== true) {
        token.depth = token.isGlobstar ? Infinity : 1;
      }
    };
    var scan = (input, options) => {
      const opts = options || {};
      const length = input.length - 1;
      const scanToEnd = opts.parts === true || opts.scanToEnd === true;
      const slashes = [];
      const tokens = [];
      const parts = [];
      let str = input;
      let index = -1;
      let start = 0;
      let lastIndex = 0;
      let isBrace = false;
      let isBracket = false;
      let isGlob = false;
      let isExtglob = false;
      let isGlobstar = false;
      let braceEscaped = false;
      let backslashes = false;
      let negated = false;
      let negatedExtglob = false;
      let finished = false;
      let braces = 0;
      let prev;
      let code;
      let token = { value: "", depth: 0, isGlob: false };
      const eos = () => index >= length;
      const peek = () => str.charCodeAt(index + 1);
      const advance = () => {
        prev = code;
        return str.charCodeAt(++index);
      };
      while (index < length) {
        code = advance();
        let next;
        if (code === CHAR_BACKWARD_SLASH) {
          backslashes = token.backslashes = true;
          code = advance();
          if (code === CHAR_LEFT_CURLY_BRACE) {
            braceEscaped = true;
          }
          continue;
        }
        if (braceEscaped === true || code === CHAR_LEFT_CURLY_BRACE) {
          braces++;
          while (eos() !== true && (code = advance())) {
            if (code === CHAR_BACKWARD_SLASH) {
              backslashes = token.backslashes = true;
              advance();
              continue;
            }
            if (code === CHAR_LEFT_CURLY_BRACE) {
              braces++;
              continue;
            }
            if (braceEscaped !== true && code === CHAR_DOT && (code = advance()) === CHAR_DOT) {
              isBrace = token.isBrace = true;
              isGlob = token.isGlob = true;
              finished = true;
              if (scanToEnd === true) {
                continue;
              }
              break;
            }
            if (braceEscaped !== true && code === CHAR_COMMA) {
              isBrace = token.isBrace = true;
              isGlob = token.isGlob = true;
              finished = true;
              if (scanToEnd === true) {
                continue;
              }
              break;
            }
            if (code === CHAR_RIGHT_CURLY_BRACE) {
              braces--;
              if (braces === 0) {
                braceEscaped = false;
                isBrace = token.isBrace = true;
                finished = true;
                break;
              }
            }
          }
          if (scanToEnd === true) {
            continue;
          }
          break;
        }
        if (code === CHAR_FORWARD_SLASH) {
          slashes.push(index);
          tokens.push(token);
          token = { value: "", depth: 0, isGlob: false };
          if (finished === true) continue;
          if (prev === CHAR_DOT && index === start + 1) {
            start += 2;
            continue;
          }
          lastIndex = index + 1;
          continue;
        }
        if (opts.noext !== true) {
          const isExtglobChar = code === CHAR_PLUS || code === CHAR_AT || code === CHAR_ASTERISK || code === CHAR_QUESTION_MARK || code === CHAR_EXCLAMATION_MARK;
          if (isExtglobChar === true && peek() === CHAR_LEFT_PARENTHESES) {
            isGlob = token.isGlob = true;
            isExtglob = token.isExtglob = true;
            finished = true;
            if (code === CHAR_EXCLAMATION_MARK && index === start) {
              negatedExtglob = true;
            }
            if (scanToEnd === true) {
              while (eos() !== true && (code = advance())) {
                if (code === CHAR_BACKWARD_SLASH) {
                  backslashes = token.backslashes = true;
                  code = advance();
                  continue;
                }
                if (code === CHAR_RIGHT_PARENTHESES) {
                  isGlob = token.isGlob = true;
                  finished = true;
                  break;
                }
              }
              continue;
            }
            break;
          }
        }
        if (code === CHAR_ASTERISK) {
          if (prev === CHAR_ASTERISK) isGlobstar = token.isGlobstar = true;
          isGlob = token.isGlob = true;
          finished = true;
          if (scanToEnd === true) {
            continue;
          }
          break;
        }
        if (code === CHAR_QUESTION_MARK) {
          isGlob = token.isGlob = true;
          finished = true;
          if (scanToEnd === true) {
            continue;
          }
          break;
        }
        if (code === CHAR_LEFT_SQUARE_BRACKET) {
          while (eos() !== true && (next = advance())) {
            if (next === CHAR_BACKWARD_SLASH) {
              backslashes = token.backslashes = true;
              advance();
              continue;
            }
            if (next === CHAR_RIGHT_SQUARE_BRACKET) {
              isBracket = token.isBracket = true;
              isGlob = token.isGlob = true;
              finished = true;
              break;
            }
          }
          if (scanToEnd === true) {
            continue;
          }
          break;
        }
        if (opts.nonegate !== true && code === CHAR_EXCLAMATION_MARK && index === start) {
          negated = token.negated = true;
          start++;
          continue;
        }
        if (opts.noparen !== true && code === CHAR_LEFT_PARENTHESES) {
          isGlob = token.isGlob = true;
          if (scanToEnd === true) {
            while (eos() !== true && (code = advance())) {
              if (code === CHAR_LEFT_PARENTHESES) {
                backslashes = token.backslashes = true;
                code = advance();
                continue;
              }
              if (code === CHAR_RIGHT_PARENTHESES) {
                finished = true;
                break;
              }
            }
            continue;
          }
          break;
        }
        if (isGlob === true) {
          finished = true;
          if (scanToEnd === true) {
            continue;
          }
          break;
        }
      }
      if (opts.noext === true) {
        isExtglob = false;
        isGlob = false;
      }
      let base = str;
      let prefix2 = "";
      let glob = "";
      if (start > 0) {
        prefix2 = str.slice(0, start);
        str = str.slice(start);
        lastIndex -= start;
      }
      if (base && isGlob === true && lastIndex > 0) {
        base = str.slice(0, lastIndex);
        glob = str.slice(lastIndex);
      } else if (isGlob === true) {
        base = "";
        glob = str;
      } else {
        base = str;
      }
      if (base && base !== "" && base !== "/" && base !== str) {
        if (isPathSeparator(base.charCodeAt(base.length - 1))) {
          base = base.slice(0, -1);
        }
      }
      if (opts.unescape === true) {
        if (glob) glob = utils.removeBackslashes(glob);
        if (base && backslashes === true) {
          base = utils.removeBackslashes(base);
        }
      }
      const state = {
        prefix: prefix2,
        input,
        start,
        base,
        glob,
        isBrace,
        isBracket,
        isGlob,
        isExtglob,
        isGlobstar,
        negated,
        negatedExtglob
      };
      if (opts.tokens === true) {
        state.maxDepth = 0;
        if (!isPathSeparator(code)) {
          tokens.push(token);
        }
        state.tokens = tokens;
      }
      if (opts.parts === true || opts.tokens === true) {
        let prevIndex;
        for (let idx = 0; idx < slashes.length; idx++) {
          const n = prevIndex ? prevIndex + 1 : start;
          const i = slashes[idx];
          const value = input.slice(n, i);
          if (opts.tokens) {
            if (idx === 0 && start !== 0) {
              tokens[idx].isPrefix = true;
              tokens[idx].value = prefix2;
            } else {
              tokens[idx].value = value;
            }
            depth(tokens[idx]);
            state.maxDepth += tokens[idx].depth;
          }
          if (idx !== 0 || value !== "") {
            parts.push(value);
          }
          prevIndex = i;
        }
        if (prevIndex && prevIndex + 1 < input.length) {
          const value = input.slice(prevIndex + 1);
          parts.push(value);
          if (opts.tokens) {
            tokens[tokens.length - 1].value = value;
            depth(tokens[tokens.length - 1]);
            state.maxDepth += tokens[tokens.length - 1].depth;
          }
        }
        state.slashes = slashes;
        state.parts = parts;
      }
      return state;
    };
    module.exports = scan;
  }
});

// ../../node_modules/micromatch/node_modules/picomatch/lib/parse.js
var require_parse2 = __commonJS({
  "../../node_modules/micromatch/node_modules/picomatch/lib/parse.js"(exports, module) {
    "use strict";
    var constants2 = require_constants2();
    var utils = require_utils2();
    var {
      MAX_LENGTH,
      POSIX_REGEX_SOURCE,
      REGEX_NON_SPECIAL_CHARS,
      REGEX_SPECIAL_CHARS_BACKREF,
      REPLACEMENTS
    } = constants2;
    var expandRange = (args, options) => {
      if (typeof options.expandRange === "function") {
        return options.expandRange(...args, options);
      }
      args.sort();
      const value = `[${args.join("-")}]`;
      try {
        new RegExp(value);
      } catch (ex) {
        return args.map((v) => utils.escapeRegex(v)).join("..");
      }
      return value;
    };
    var syntaxError = (type, char) => {
      return `Missing ${type}: "${char}" - use "\\\\${char}" to match literal characters`;
    };
    var splitTopLevel = (input) => {
      const parts = [];
      let bracket = 0;
      let paren = 0;
      let quote = 0;
      let value = "";
      let escaped = false;
      for (const ch of input) {
        if (escaped === true) {
          value += ch;
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          value += ch;
          escaped = true;
          continue;
        }
        if (ch === '"') {
          quote = quote === 1 ? 0 : 1;
          value += ch;
          continue;
        }
        if (quote === 0) {
          if (ch === "[") {
            bracket++;
          } else if (ch === "]" && bracket > 0) {
            bracket--;
          } else if (bracket === 0) {
            if (ch === "(") {
              paren++;
            } else if (ch === ")" && paren > 0) {
              paren--;
            } else if (ch === "|" && paren === 0) {
              parts.push(value);
              value = "";
              continue;
            }
          }
        }
        value += ch;
      }
      parts.push(value);
      return parts;
    };
    var isPlainBranch = (branch) => {
      let escaped = false;
      for (const ch of branch) {
        if (escaped === true) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (/[?*+@!()[\]{}]/.test(ch)) {
          return false;
        }
      }
      return true;
    };
    var normalizeSimpleBranch = (branch) => {
      let value = branch.trim();
      let changed = true;
      while (changed === true) {
        changed = false;
        if (/^@\([^\\()[\]{}|]+\)$/.test(value)) {
          value = value.slice(2, -1);
          changed = true;
        }
      }
      if (!isPlainBranch(value)) {
        return;
      }
      return value.replace(/\\(.)/g, "$1");
    };
    var hasRepeatedCharPrefixOverlap = (branches) => {
      const values = branches.map(normalizeSimpleBranch).filter(Boolean);
      for (let i = 0; i < values.length; i++) {
        for (let j = i + 1; j < values.length; j++) {
          const a = values[i];
          const b = values[j];
          const char = a[0];
          if (!char || a !== char.repeat(a.length) || b !== char.repeat(b.length)) {
            continue;
          }
          if (a === b || a.startsWith(b) || b.startsWith(a)) {
            return true;
          }
        }
      }
      return false;
    };
    var parseRepeatedExtglob = (pattern, requireEnd = true) => {
      if (pattern[0] !== "+" && pattern[0] !== "*" || pattern[1] !== "(") {
        return;
      }
      let bracket = 0;
      let paren = 0;
      let quote = 0;
      let escaped = false;
      for (let i = 1; i < pattern.length; i++) {
        const ch = pattern[i];
        if (escaped === true) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          quote = quote === 1 ? 0 : 1;
          continue;
        }
        if (quote === 1) {
          continue;
        }
        if (ch === "[") {
          bracket++;
          continue;
        }
        if (ch === "]" && bracket > 0) {
          bracket--;
          continue;
        }
        if (bracket > 0) {
          continue;
        }
        if (ch === "(") {
          paren++;
          continue;
        }
        if (ch === ")") {
          paren--;
          if (paren === 0) {
            if (requireEnd === true && i !== pattern.length - 1) {
              return;
            }
            return {
              type: pattern[0],
              body: pattern.slice(2, i),
              end: i
            };
          }
        }
      }
    };
    var getStarExtglobSequenceOutput = (pattern) => {
      let index = 0;
      const chars = [];
      while (index < pattern.length) {
        const match = parseRepeatedExtglob(pattern.slice(index), false);
        if (!match || match.type !== "*") {
          return;
        }
        const branches = splitTopLevel(match.body).map((branch2) => branch2.trim());
        if (branches.length !== 1) {
          return;
        }
        const branch = normalizeSimpleBranch(branches[0]);
        if (!branch || branch.length !== 1) {
          return;
        }
        chars.push(branch);
        index += match.end + 1;
      }
      if (chars.length < 1) {
        return;
      }
      const source = chars.length === 1 ? utils.escapeRegex(chars[0]) : `[${chars.map((ch) => utils.escapeRegex(ch)).join("")}]`;
      return `${source}*`;
    };
    var repeatedExtglobRecursion = (pattern) => {
      let depth = 0;
      let value = pattern.trim();
      let match = parseRepeatedExtglob(value);
      while (match) {
        depth++;
        value = match.body.trim();
        match = parseRepeatedExtglob(value);
      }
      return depth;
    };
    var analyzeRepeatedExtglob = (body, options) => {
      if (options.maxExtglobRecursion === false) {
        return { risky: false };
      }
      const max = typeof options.maxExtglobRecursion === "number" ? options.maxExtglobRecursion : constants2.DEFAULT_MAX_EXTGLOB_RECURSION;
      const branches = splitTopLevel(body).map((branch) => branch.trim());
      if (branches.length > 1) {
        if (branches.some((branch) => branch === "") || branches.some((branch) => /^[*?]+$/.test(branch)) || hasRepeatedCharPrefixOverlap(branches)) {
          return { risky: true };
        }
      }
      for (const branch of branches) {
        const safeOutput = getStarExtglobSequenceOutput(branch);
        if (safeOutput) {
          return { risky: true, safeOutput };
        }
        if (repeatedExtglobRecursion(branch) > max) {
          return { risky: true };
        }
      }
      return { risky: false };
    };
    var parse = (input, options) => {
      if (typeof input !== "string") {
        throw new TypeError("Expected a string");
      }
      input = REPLACEMENTS[input] || input;
      const opts = { ...options };
      const max = typeof opts.maxLength === "number" ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
      let len = input.length;
      if (len > max) {
        throw new SyntaxError(`Input length: ${len}, exceeds maximum allowed length: ${max}`);
      }
      const bos = { type: "bos", value: "", output: opts.prepend || "" };
      const tokens = [bos];
      const capture = opts.capture ? "" : "?:";
      const win32 = utils.isWindows(options);
      const PLATFORM_CHARS = constants2.globChars(win32);
      const EXTGLOB_CHARS = constants2.extglobChars(PLATFORM_CHARS);
      const {
        DOT_LITERAL,
        PLUS_LITERAL,
        SLASH_LITERAL,
        ONE_CHAR,
        DOTS_SLASH,
        NO_DOT,
        NO_DOT_SLASH,
        NO_DOTS_SLASH,
        QMARK,
        QMARK_NO_DOT,
        STAR,
        START_ANCHOR
      } = PLATFORM_CHARS;
      const globstar = (opts2) => {
        return `(${capture}(?:(?!${START_ANCHOR}${opts2.dot ? DOTS_SLASH : DOT_LITERAL}).)*?)`;
      };
      const nodot = opts.dot ? "" : NO_DOT;
      const qmarkNoDot = opts.dot ? QMARK : QMARK_NO_DOT;
      let star = opts.bash === true ? globstar(opts) : STAR;
      if (opts.capture) {
        star = `(${star})`;
      }
      if (typeof opts.noext === "boolean") {
        opts.noextglob = opts.noext;
      }
      const state = {
        input,
        index: -1,
        start: 0,
        dot: opts.dot === true,
        consumed: "",
        output: "",
        prefix: "",
        backtrack: false,
        negated: false,
        brackets: 0,
        braces: 0,
        parens: 0,
        quotes: 0,
        globstar: false,
        tokens
      };
      input = utils.removePrefix(input, state);
      len = input.length;
      const extglobs = [];
      const braces = [];
      const stack = [];
      let prev = bos;
      let value;
      const eos = () => state.index === len - 1;
      const peek = state.peek = (n = 1) => input[state.index + n];
      const advance = state.advance = () => input[++state.index] || "";
      const remaining = () => input.slice(state.index + 1);
      const consume = (value2 = "", num = 0) => {
        state.consumed += value2;
        state.index += num;
      };
      const append = (token) => {
        state.output += token.output != null ? token.output : token.value;
        consume(token.value);
      };
      const negate = () => {
        let count = 1;
        while (peek() === "!" && (peek(2) !== "(" || peek(3) === "?")) {
          advance();
          state.start++;
          count++;
        }
        if (count % 2 === 0) {
          return false;
        }
        state.negated = true;
        state.start++;
        return true;
      };
      const increment = (type) => {
        state[type]++;
        stack.push(type);
      };
      const decrement = (type) => {
        state[type]--;
        stack.pop();
      };
      const push = (tok) => {
        if (prev.type === "globstar") {
          const isBrace = state.braces > 0 && (tok.type === "comma" || tok.type === "brace");
          const isExtglob = tok.extglob === true || extglobs.length && (tok.type === "pipe" || tok.type === "paren");
          if (tok.type !== "slash" && tok.type !== "paren" && !isBrace && !isExtglob) {
            state.output = state.output.slice(0, -prev.output.length);
            prev.type = "star";
            prev.value = "*";
            prev.output = star;
            state.output += prev.output;
          }
        }
        if (extglobs.length && tok.type !== "paren") {
          extglobs[extglobs.length - 1].inner += tok.value;
        }
        if (tok.value || tok.output) append(tok);
        if (prev && prev.type === "text" && tok.type === "text") {
          prev.value += tok.value;
          prev.output = (prev.output || "") + tok.value;
          return;
        }
        tok.prev = prev;
        tokens.push(tok);
        prev = tok;
      };
      const extglobOpen = (type, value2) => {
        const token = { ...EXTGLOB_CHARS[value2], conditions: 1, inner: "" };
        token.prev = prev;
        token.parens = state.parens;
        token.output = state.output;
        token.startIndex = state.index;
        token.tokensIndex = tokens.length;
        const output = (opts.capture ? "(" : "") + token.open;
        increment("parens");
        push({ type, value: value2, output: state.output ? "" : ONE_CHAR });
        push({ type: "paren", extglob: true, value: advance(), output });
        extglobs.push(token);
      };
      const extglobClose = (token) => {
        const literal = input.slice(token.startIndex, state.index + 1);
        const body = input.slice(token.startIndex + 2, state.index);
        const analysis = analyzeRepeatedExtglob(body, opts);
        if ((token.type === "plus" || token.type === "star") && analysis.risky) {
          const safeOutput = analysis.safeOutput ? (token.output ? "" : ONE_CHAR) + (opts.capture ? `(${analysis.safeOutput})` : analysis.safeOutput) : void 0;
          const open = tokens[token.tokensIndex];
          open.type = "text";
          open.value = literal;
          open.output = safeOutput || utils.escapeRegex(literal);
          for (let i = token.tokensIndex + 1; i < tokens.length; i++) {
            tokens[i].value = "";
            tokens[i].output = "";
            delete tokens[i].suffix;
          }
          state.output = token.output + open.output;
          state.backtrack = true;
          push({ type: "paren", extglob: true, value, output: "" });
          decrement("parens");
          return;
        }
        let output = token.close + (opts.capture ? ")" : "");
        let rest;
        if (token.type === "negate") {
          let extglobStar = star;
          if (token.inner && token.inner.length > 1 && token.inner.includes("/")) {
            extglobStar = globstar(opts);
          }
          if (extglobStar !== star || eos() || /^\)+$/.test(remaining())) {
            output = token.close = `)$))${extglobStar}`;
          }
          if (token.inner.includes("*") && (rest = remaining()) && /^\.[^\\/.]+$/.test(rest)) {
            const expression = parse(rest, { ...options, fastpaths: false }).output;
            output = token.close = `)${expression})${extglobStar})`;
          }
          if (token.prev.type === "bos") {
            state.negatedExtglob = true;
          }
        }
        push({ type: "paren", extglob: true, value, output });
        decrement("parens");
      };
      if (opts.fastpaths !== false && !/(^[*!]|[/()[\]{}"])/.test(input)) {
        let backslashes = false;
        let output = input.replace(REGEX_SPECIAL_CHARS_BACKREF, (m, esc, chars, first, rest, index) => {
          if (first === "\\") {
            backslashes = true;
            return m;
          }
          if (first === "?") {
            if (esc) {
              return esc + first + (rest ? QMARK.repeat(rest.length) : "");
            }
            if (index === 0) {
              return qmarkNoDot + (rest ? QMARK.repeat(rest.length) : "");
            }
            return QMARK.repeat(chars.length);
          }
          if (first === ".") {
            return DOT_LITERAL.repeat(chars.length);
          }
          if (first === "*") {
            if (esc) {
              return esc + first + (rest ? star : "");
            }
            return star;
          }
          return esc ? m : `\\${m}`;
        });
        if (backslashes === true) {
          if (opts.unescape === true) {
            output = output.replace(/\\/g, "");
          } else {
            output = output.replace(/\\+/g, (m) => {
              return m.length % 2 === 0 ? "\\\\" : m ? "\\" : "";
            });
          }
        }
        if (output === input && opts.contains === true) {
          state.output = input;
          return state;
        }
        state.output = utils.wrapOutput(output, state, options);
        return state;
      }
      while (!eos()) {
        value = advance();
        if (value === "\0") {
          continue;
        }
        if (value === "\\") {
          const next = peek();
          if (next === "/" && opts.bash !== true) {
            continue;
          }
          if (next === "." || next === ";") {
            continue;
          }
          if (!next) {
            value += "\\";
            push({ type: "text", value });
            continue;
          }
          const match = /^\\+/.exec(remaining());
          let slashes = 0;
          if (match && match[0].length > 2) {
            slashes = match[0].length;
            state.index += slashes;
            if (slashes % 2 !== 0) {
              value += "\\";
            }
          }
          if (opts.unescape === true) {
            value = advance();
          } else {
            value += advance();
          }
          if (state.brackets === 0) {
            push({ type: "text", value });
            continue;
          }
        }
        if (state.brackets > 0 && (value !== "]" || prev.value === "[" || prev.value === "[^")) {
          if (opts.posix !== false && value === ":") {
            const inner = prev.value.slice(1);
            if (inner.includes("[")) {
              prev.posix = true;
              if (inner.includes(":")) {
                const idx = prev.value.lastIndexOf("[");
                const pre = prev.value.slice(0, idx);
                const rest2 = prev.value.slice(idx + 2);
                const posix = POSIX_REGEX_SOURCE[rest2];
                if (posix) {
                  prev.value = pre + posix;
                  state.backtrack = true;
                  advance();
                  if (!bos.output && tokens.indexOf(prev) === 1) {
                    bos.output = ONE_CHAR;
                  }
                  continue;
                }
              }
            }
          }
          if (value === "[" && peek() !== ":" || value === "-" && peek() === "]") {
            value = `\\${value}`;
          }
          if (value === "]" && (prev.value === "[" || prev.value === "[^")) {
            value = `\\${value}`;
          }
          if (opts.posix === true && value === "!" && prev.value === "[") {
            value = "^";
          }
          prev.value += value;
          append({ value });
          continue;
        }
        if (state.quotes === 1 && value !== '"') {
          value = utils.escapeRegex(value);
          prev.value += value;
          append({ value });
          continue;
        }
        if (value === '"') {
          state.quotes = state.quotes === 1 ? 0 : 1;
          if (opts.keepQuotes === true) {
            push({ type: "text", value });
          }
          continue;
        }
        if (value === "(") {
          increment("parens");
          push({ type: "paren", value });
          continue;
        }
        if (value === ")") {
          if (state.parens === 0 && opts.strictBrackets === true) {
            throw new SyntaxError(syntaxError("opening", "("));
          }
          const extglob = extglobs[extglobs.length - 1];
          if (extglob && state.parens === extglob.parens + 1) {
            extglobClose(extglobs.pop());
            continue;
          }
          push({ type: "paren", value, output: state.parens ? ")" : "\\)" });
          decrement("parens");
          continue;
        }
        if (value === "[") {
          if (opts.nobracket === true || !remaining().includes("]")) {
            if (opts.nobracket !== true && opts.strictBrackets === true) {
              throw new SyntaxError(syntaxError("closing", "]"));
            }
            value = `\\${value}`;
          } else {
            increment("brackets");
          }
          push({ type: "bracket", value });
          continue;
        }
        if (value === "]") {
          if (opts.nobracket === true || prev && prev.type === "bracket" && prev.value.length === 1) {
            push({ type: "text", value, output: `\\${value}` });
            continue;
          }
          if (state.brackets === 0) {
            if (opts.strictBrackets === true) {
              throw new SyntaxError(syntaxError("opening", "["));
            }
            push({ type: "text", value, output: `\\${value}` });
            continue;
          }
          decrement("brackets");
          const prevValue = prev.value.slice(1);
          if (prev.posix !== true && prevValue[0] === "^" && !prevValue.includes("/")) {
            value = `/${value}`;
          }
          prev.value += value;
          append({ value });
          if (opts.literalBrackets === false || utils.hasRegexChars(prevValue)) {
            continue;
          }
          const escaped = utils.escapeRegex(prev.value);
          state.output = state.output.slice(0, -prev.value.length);
          if (opts.literalBrackets === true) {
            state.output += escaped;
            prev.value = escaped;
            continue;
          }
          prev.value = `(${capture}${escaped}|${prev.value})`;
          state.output += prev.value;
          continue;
        }
        if (value === "{" && opts.nobrace !== true) {
          increment("braces");
          const open = {
            type: "brace",
            value,
            output: "(",
            outputIndex: state.output.length,
            tokensIndex: state.tokens.length
          };
          braces.push(open);
          push(open);
          continue;
        }
        if (value === "}") {
          const brace = braces[braces.length - 1];
          if (opts.nobrace === true || !brace) {
            push({ type: "text", value, output: value });
            continue;
          }
          let output = ")";
          if (brace.dots === true) {
            const arr = tokens.slice();
            const range = [];
            for (let i = arr.length - 1; i >= 0; i--) {
              tokens.pop();
              if (arr[i].type === "brace") {
                break;
              }
              if (arr[i].type !== "dots") {
                range.unshift(arr[i].value);
              }
            }
            output = expandRange(range, opts);
            state.backtrack = true;
          }
          if (brace.comma !== true && brace.dots !== true) {
            const out = state.output.slice(0, brace.outputIndex);
            const toks = state.tokens.slice(brace.tokensIndex);
            brace.value = brace.output = "\\{";
            value = output = "\\}";
            state.output = out;
            for (const t of toks) {
              state.output += t.output || t.value;
            }
          }
          push({ type: "brace", value, output });
          decrement("braces");
          braces.pop();
          continue;
        }
        if (value === "|") {
          if (extglobs.length > 0) {
            extglobs[extglobs.length - 1].conditions++;
          }
          push({ type: "text", value });
          continue;
        }
        if (value === ",") {
          let output = value;
          const brace = braces[braces.length - 1];
          if (brace && stack[stack.length - 1] === "braces") {
            brace.comma = true;
            output = "|";
          }
          push({ type: "comma", value, output });
          continue;
        }
        if (value === "/") {
          if (prev.type === "dot" && state.index === state.start + 1) {
            state.start = state.index + 1;
            state.consumed = "";
            state.output = "";
            tokens.pop();
            prev = bos;
            continue;
          }
          push({ type: "slash", value, output: SLASH_LITERAL });
          continue;
        }
        if (value === ".") {
          if (state.braces > 0 && prev.type === "dot") {
            if (prev.value === ".") prev.output = DOT_LITERAL;
            const brace = braces[braces.length - 1];
            prev.type = "dots";
            prev.output += value;
            prev.value += value;
            brace.dots = true;
            continue;
          }
          if (state.braces + state.parens === 0 && prev.type !== "bos" && prev.type !== "slash") {
            push({ type: "text", value, output: DOT_LITERAL });
            continue;
          }
          push({ type: "dot", value, output: DOT_LITERAL });
          continue;
        }
        if (value === "?") {
          const isGroup = prev && prev.value === "(";
          if (!isGroup && opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
            extglobOpen("qmark", value);
            continue;
          }
          if (prev && prev.type === "paren") {
            const next = peek();
            let output = value;
            if (next === "<" && !utils.supportsLookbehinds()) {
              throw new Error("Node.js v10 or higher is required for regex lookbehinds");
            }
            if (prev.value === "(" && !/[!=<:]/.test(next) || next === "<" && !/<([!=]|\w+>)/.test(remaining())) {
              output = `\\${value}`;
            }
            push({ type: "text", value, output });
            continue;
          }
          if (opts.dot !== true && (prev.type === "slash" || prev.type === "bos")) {
            push({ type: "qmark", value, output: QMARK_NO_DOT });
            continue;
          }
          push({ type: "qmark", value, output: QMARK });
          continue;
        }
        if (value === "!") {
          if (opts.noextglob !== true && peek() === "(") {
            if (peek(2) !== "?" || !/[!=<:]/.test(peek(3))) {
              extglobOpen("negate", value);
              continue;
            }
          }
          if (opts.nonegate !== true && state.index === 0) {
            negate();
            continue;
          }
        }
        if (value === "+") {
          if (opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
            extglobOpen("plus", value);
            continue;
          }
          if (prev && prev.value === "(" || opts.regex === false) {
            push({ type: "plus", value, output: PLUS_LITERAL });
            continue;
          }
          if (prev && (prev.type === "bracket" || prev.type === "paren" || prev.type === "brace") || state.parens > 0) {
            push({ type: "plus", value });
            continue;
          }
          push({ type: "plus", value: PLUS_LITERAL });
          continue;
        }
        if (value === "@") {
          if (opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
            push({ type: "at", extglob: true, value, output: "" });
            continue;
          }
          push({ type: "text", value });
          continue;
        }
        if (value !== "*") {
          if (value === "$" || value === "^") {
            value = `\\${value}`;
          }
          const match = REGEX_NON_SPECIAL_CHARS.exec(remaining());
          if (match) {
            value += match[0];
            state.index += match[0].length;
          }
          push({ type: "text", value });
          continue;
        }
        if (prev && (prev.type === "globstar" || prev.star === true)) {
          prev.type = "star";
          prev.star = true;
          prev.value += value;
          prev.output = star;
          state.backtrack = true;
          state.globstar = true;
          consume(value);
          continue;
        }
        let rest = remaining();
        if (opts.noextglob !== true && /^\([^?]/.test(rest)) {
          extglobOpen("star", value);
          continue;
        }
        if (prev.type === "star") {
          if (opts.noglobstar === true) {
            consume(value);
            continue;
          }
          const prior = prev.prev;
          const before = prior.prev;
          const isStart = prior.type === "slash" || prior.type === "bos";
          const afterStar = before && (before.type === "star" || before.type === "globstar");
          if (opts.bash === true && (!isStart || rest[0] && rest[0] !== "/")) {
            push({ type: "star", value, output: "" });
            continue;
          }
          const isBrace = state.braces > 0 && (prior.type === "comma" || prior.type === "brace");
          const isExtglob = extglobs.length && (prior.type === "pipe" || prior.type === "paren");
          if (!isStart && prior.type !== "paren" && !isBrace && !isExtglob) {
            push({ type: "star", value, output: "" });
            continue;
          }
          while (rest.slice(0, 3) === "/**") {
            const after = input[state.index + 4];
            if (after && after !== "/") {
              break;
            }
            rest = rest.slice(3);
            consume("/**", 3);
          }
          if (prior.type === "bos" && eos()) {
            prev.type = "globstar";
            prev.value += value;
            prev.output = globstar(opts);
            state.output = prev.output;
            state.globstar = true;
            consume(value);
            continue;
          }
          if (prior.type === "slash" && prior.prev.type !== "bos" && !afterStar && eos()) {
            state.output = state.output.slice(0, -(prior.output + prev.output).length);
            prior.output = `(?:${prior.output}`;
            prev.type = "globstar";
            prev.output = globstar(opts) + (opts.strictSlashes ? ")" : "|$)");
            prev.value += value;
            state.globstar = true;
            state.output += prior.output + prev.output;
            consume(value);
            continue;
          }
          if (prior.type === "slash" && prior.prev.type !== "bos" && rest[0] === "/") {
            const end = rest[1] !== void 0 ? "|$" : "";
            state.output = state.output.slice(0, -(prior.output + prev.output).length);
            prior.output = `(?:${prior.output}`;
            prev.type = "globstar";
            prev.output = `${globstar(opts)}${SLASH_LITERAL}|${SLASH_LITERAL}${end})`;
            prev.value += value;
            state.output += prior.output + prev.output;
            state.globstar = true;
            consume(value + advance());
            push({ type: "slash", value: "/", output: "" });
            continue;
          }
          if (prior.type === "bos" && rest[0] === "/") {
            prev.type = "globstar";
            prev.value += value;
            prev.output = `(?:^|${SLASH_LITERAL}|${globstar(opts)}${SLASH_LITERAL})`;
            state.output = prev.output;
            state.globstar = true;
            consume(value + advance());
            push({ type: "slash", value: "/", output: "" });
            continue;
          }
          state.output = state.output.slice(0, -prev.output.length);
          prev.type = "globstar";
          prev.output = globstar(opts);
          prev.value += value;
          state.output += prev.output;
          state.globstar = true;
          consume(value);
          continue;
        }
        const token = { type: "star", value, output: star };
        if (opts.bash === true) {
          token.output = ".*?";
          if (prev.type === "bos" || prev.type === "slash") {
            token.output = nodot + token.output;
          }
          push(token);
          continue;
        }
        if (prev && (prev.type === "bracket" || prev.type === "paren") && opts.regex === true) {
          token.output = value;
          push(token);
          continue;
        }
        if (state.index === state.start || prev.type === "slash" || prev.type === "dot") {
          if (prev.type === "dot") {
            state.output += NO_DOT_SLASH;
            prev.output += NO_DOT_SLASH;
          } else if (opts.dot === true) {
            state.output += NO_DOTS_SLASH;
            prev.output += NO_DOTS_SLASH;
          } else {
            state.output += nodot;
            prev.output += nodot;
          }
          if (peek() !== "*") {
            state.output += ONE_CHAR;
            prev.output += ONE_CHAR;
          }
        }
        push(token);
      }
      while (state.brackets > 0) {
        if (opts.strictBrackets === true) throw new SyntaxError(syntaxError("closing", "]"));
        state.output = utils.escapeLast(state.output, "[");
        decrement("brackets");
      }
      while (state.parens > 0) {
        if (opts.strictBrackets === true) throw new SyntaxError(syntaxError("closing", ")"));
        state.output = utils.escapeLast(state.output, "(");
        decrement("parens");
      }
      while (state.braces > 0) {
        if (opts.strictBrackets === true) throw new SyntaxError(syntaxError("closing", "}"));
        state.output = utils.escapeLast(state.output, "{");
        decrement("braces");
      }
      if (opts.strictSlashes !== true && (prev.type === "star" || prev.type === "bracket")) {
        push({ type: "maybe_slash", value: "", output: `${SLASH_LITERAL}?` });
      }
      if (state.backtrack === true) {
        state.output = "";
        for (const token of state.tokens) {
          state.output += token.output != null ? token.output : token.value;
          if (token.suffix) {
            state.output += token.suffix;
          }
        }
      }
      return state;
    };
    parse.fastpaths = (input, options) => {
      const opts = { ...options };
      const max = typeof opts.maxLength === "number" ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
      const len = input.length;
      if (len > max) {
        throw new SyntaxError(`Input length: ${len}, exceeds maximum allowed length: ${max}`);
      }
      input = REPLACEMENTS[input] || input;
      const win32 = utils.isWindows(options);
      const {
        DOT_LITERAL,
        SLASH_LITERAL,
        ONE_CHAR,
        DOTS_SLASH,
        NO_DOT,
        NO_DOTS,
        NO_DOTS_SLASH,
        STAR,
        START_ANCHOR
      } = constants2.globChars(win32);
      const nodot = opts.dot ? NO_DOTS : NO_DOT;
      const slashDot = opts.dot ? NO_DOTS_SLASH : NO_DOT;
      const capture = opts.capture ? "" : "?:";
      const state = { negated: false, prefix: "" };
      let star = opts.bash === true ? ".*?" : STAR;
      if (opts.capture) {
        star = `(${star})`;
      }
      const globstar = (opts2) => {
        if (opts2.noglobstar === true) return star;
        return `(${capture}(?:(?!${START_ANCHOR}${opts2.dot ? DOTS_SLASH : DOT_LITERAL}).)*?)`;
      };
      const create = (str) => {
        switch (str) {
          case "*":
            return `${nodot}${ONE_CHAR}${star}`;
          case ".*":
            return `${DOT_LITERAL}${ONE_CHAR}${star}`;
          case "*.*":
            return `${nodot}${star}${DOT_LITERAL}${ONE_CHAR}${star}`;
          case "*/*":
            return `${nodot}${star}${SLASH_LITERAL}${ONE_CHAR}${slashDot}${star}`;
          case "**":
            return nodot + globstar(opts);
          case "**/*":
            return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${slashDot}${ONE_CHAR}${star}`;
          case "**/*.*":
            return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${slashDot}${star}${DOT_LITERAL}${ONE_CHAR}${star}`;
          case "**/.*":
            return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${DOT_LITERAL}${ONE_CHAR}${star}`;
          default: {
            const match = /^(.*?)\.(\w+)$/.exec(str);
            if (!match) return;
            const source2 = create(match[1]);
            if (!source2) return;
            return source2 + DOT_LITERAL + match[2];
          }
        }
      };
      const output = utils.removePrefix(input, state);
      let source = create(output);
      if (source && opts.strictSlashes !== true) {
        source += `${SLASH_LITERAL}?`;
      }
      return source;
    };
    module.exports = parse;
  }
});

// ../../node_modules/micromatch/node_modules/picomatch/lib/picomatch.js
var require_picomatch = __commonJS({
  "../../node_modules/micromatch/node_modules/picomatch/lib/picomatch.js"(exports, module) {
    "use strict";
    var path = __require("path");
    var scan = require_scan();
    var parse = require_parse2();
    var utils = require_utils2();
    var constants2 = require_constants2();
    var isObject = (val) => val && typeof val === "object" && !Array.isArray(val);
    var picomatch = (glob, options, returnState = false) => {
      if (Array.isArray(glob)) {
        const fns = glob.map((input) => picomatch(input, options, returnState));
        const arrayMatcher = (str) => {
          for (const isMatch of fns) {
            const state2 = isMatch(str);
            if (state2) return state2;
          }
          return false;
        };
        return arrayMatcher;
      }
      const isState = isObject(glob) && glob.tokens && glob.input;
      if (glob === "" || typeof glob !== "string" && !isState) {
        throw new TypeError("Expected pattern to be a non-empty string");
      }
      const opts = options || {};
      const posix = utils.isWindows(options);
      const regex = isState ? picomatch.compileRe(glob, options) : picomatch.makeRe(glob, options, false, true);
      const state = regex.state;
      delete regex.state;
      let isIgnored = () => false;
      if (opts.ignore) {
        const ignoreOpts = { ...options, ignore: null, onMatch: null, onResult: null };
        isIgnored = picomatch(opts.ignore, ignoreOpts, returnState);
      }
      const matcher = (input, returnObject = false) => {
        const { isMatch, match, output } = picomatch.test(input, regex, options, { glob, posix });
        const result = { glob, state, regex, posix, input, output, match, isMatch };
        if (typeof opts.onResult === "function") {
          opts.onResult(result);
        }
        if (isMatch === false) {
          result.isMatch = false;
          return returnObject ? result : false;
        }
        if (isIgnored(input)) {
          if (typeof opts.onIgnore === "function") {
            opts.onIgnore(result);
          }
          result.isMatch = false;
          return returnObject ? result : false;
        }
        if (typeof opts.onMatch === "function") {
          opts.onMatch(result);
        }
        return returnObject ? result : true;
      };
      if (returnState) {
        matcher.state = state;
      }
      return matcher;
    };
    picomatch.test = (input, regex, options, { glob, posix } = {}) => {
      if (typeof input !== "string") {
        throw new TypeError("Expected input to be a string");
      }
      if (input === "") {
        return { isMatch: false, output: "" };
      }
      const opts = options || {};
      const format = opts.format || (posix ? utils.toPosixSlashes : null);
      let match = input === glob;
      let output = match && format ? format(input) : input;
      if (match === false) {
        output = format ? format(input) : input;
        match = output === glob;
      }
      if (match === false || opts.capture === true) {
        if (opts.matchBase === true || opts.basename === true) {
          match = picomatch.matchBase(input, regex, options, posix);
        } else {
          match = regex.exec(output);
        }
      }
      return { isMatch: Boolean(match), match, output };
    };
    picomatch.matchBase = (input, glob, options, posix = utils.isWindows(options)) => {
      const regex = glob instanceof RegExp ? glob : picomatch.makeRe(glob, options);
      return regex.test(path.basename(input));
    };
    picomatch.isMatch = (str, patterns, options) => picomatch(patterns, options)(str);
    picomatch.parse = (pattern, options) => {
      if (Array.isArray(pattern)) return pattern.map((p) => picomatch.parse(p, options));
      return parse(pattern, { ...options, fastpaths: false });
    };
    picomatch.scan = (input, options) => scan(input, options);
    picomatch.compileRe = (state, options, returnOutput = false, returnState = false) => {
      if (returnOutput === true) {
        return state.output;
      }
      const opts = options || {};
      const prepend = opts.contains ? "" : "^";
      const append = opts.contains ? "" : "$";
      let source = `${prepend}(?:${state.output})${append}`;
      if (state && state.negated === true) {
        source = `^(?!${source}).*$`;
      }
      const regex = picomatch.toRegex(source, options);
      if (returnState === true) {
        regex.state = state;
      }
      return regex;
    };
    picomatch.makeRe = (input, options = {}, returnOutput = false, returnState = false) => {
      if (!input || typeof input !== "string") {
        throw new TypeError("Expected a non-empty string");
      }
      let parsed = { negated: false, fastpaths: true };
      if (options.fastpaths !== false && (input[0] === "." || input[0] === "*")) {
        parsed.output = parse.fastpaths(input, options);
      }
      if (!parsed.output) {
        parsed = parse(input, options);
      }
      return picomatch.compileRe(parsed, options, returnOutput, returnState);
    };
    picomatch.toRegex = (source, options) => {
      try {
        const opts = options || {};
        return new RegExp(source, opts.flags || (opts.nocase ? "i" : ""));
      } catch (err) {
        if (options && options.debug === true) throw err;
        return /$^/;
      }
    };
    picomatch.constants = constants2;
    module.exports = picomatch;
  }
});

// ../../node_modules/micromatch/node_modules/picomatch/index.js
var require_picomatch2 = __commonJS({
  "../../node_modules/micromatch/node_modules/picomatch/index.js"(exports, module) {
    "use strict";
    module.exports = require_picomatch();
  }
});

// ../../node_modules/micromatch/index.js
var require_micromatch = __commonJS({
  "../../node_modules/micromatch/index.js"(exports, module) {
    "use strict";
    var util = __require("util");
    var braces = require_braces();
    var picomatch = require_picomatch2();
    var utils = require_utils2();
    var isEmptyString = (v) => v === "" || v === "./";
    var hasBraces = (v) => {
      const index = v.indexOf("{");
      return index > -1 && v.indexOf("}", index) > -1;
    };
    var micromatch = (list, patterns, options) => {
      patterns = [].concat(patterns);
      list = [].concat(list);
      let omit = /* @__PURE__ */ new Set();
      let keep = /* @__PURE__ */ new Set();
      let items = /* @__PURE__ */ new Set();
      let negatives = 0;
      let onResult = (state) => {
        items.add(state.output);
        if (options && options.onResult) {
          options.onResult(state);
        }
      };
      for (let i = 0; i < patterns.length; i++) {
        let isMatch = picomatch(String(patterns[i]), { ...options, onResult }, true);
        let negated = isMatch.state.negated || isMatch.state.negatedExtglob;
        if (negated) negatives++;
        for (let item of list) {
          let matched = isMatch(item, true);
          let match = negated ? !matched.isMatch : matched.isMatch;
          if (!match) continue;
          if (negated) {
            omit.add(matched.output);
          } else {
            omit.delete(matched.output);
            keep.add(matched.output);
          }
        }
      }
      let result = negatives === patterns.length ? [...items] : [...keep];
      let matches = result.filter((item) => !omit.has(item));
      if (options && matches.length === 0) {
        if (options.failglob === true) {
          throw new Error(`No matches found for "${patterns.join(", ")}"`);
        }
        if (options.nonull === true || options.nullglob === true) {
          return options.unescape ? patterns.map((p) => p.replace(/\\/g, "")) : patterns;
        }
      }
      return matches;
    };
    micromatch.match = micromatch;
    micromatch.matcher = (pattern, options) => picomatch(pattern, options);
    micromatch.isMatch = (str, patterns, options) => picomatch(patterns, options)(str);
    micromatch.any = micromatch.isMatch;
    micromatch.not = (list, patterns, options = {}) => {
      patterns = [].concat(patterns).map(String);
      let result = /* @__PURE__ */ new Set();
      let items = [];
      let onResult = (state) => {
        if (options.onResult) options.onResult(state);
        items.push(state.output);
      };
      let matches = new Set(micromatch(list, patterns, { ...options, onResult }));
      for (let item of items) {
        if (!matches.has(item)) {
          result.add(item);
        }
      }
      return [...result];
    };
    micromatch.contains = (str, pattern, options) => {
      if (typeof str !== "string") {
        throw new TypeError(`Expected a string: "${util.inspect(str)}"`);
      }
      if (Array.isArray(pattern)) {
        return pattern.some((p) => micromatch.contains(str, p, options));
      }
      if (typeof pattern === "string") {
        if (isEmptyString(str) || isEmptyString(pattern)) {
          return false;
        }
        if (str.includes(pattern) || str.startsWith("./") && str.slice(2).includes(pattern)) {
          return true;
        }
      }
      return micromatch.isMatch(str, pattern, { ...options, contains: true });
    };
    micromatch.matchKeys = (obj, patterns, options) => {
      if (!utils.isObject(obj)) {
        throw new TypeError("Expected the first argument to be an object");
      }
      let keys = micromatch(Object.keys(obj), patterns, options);
      let res = {};
      for (let key of keys) res[key] = obj[key];
      return res;
    };
    micromatch.some = (list, patterns, options) => {
      let items = [].concat(list);
      for (let pattern of [].concat(patterns)) {
        let isMatch = picomatch(String(pattern), options);
        if (items.some((item) => isMatch(item))) {
          return true;
        }
      }
      return false;
    };
    micromatch.every = (list, patterns, options) => {
      let items = [].concat(list);
      for (let pattern of [].concat(patterns)) {
        let isMatch = picomatch(String(pattern), options);
        if (!items.every((item) => isMatch(item))) {
          return false;
        }
      }
      return true;
    };
    micromatch.all = (str, patterns, options) => {
      if (typeof str !== "string") {
        throw new TypeError(`Expected a string: "${util.inspect(str)}"`);
      }
      return [].concat(patterns).every((p) => picomatch(p, options)(str));
    };
    micromatch.capture = (glob, input, options) => {
      let posix = utils.isWindows(options);
      let regex = picomatch.makeRe(String(glob), { ...options, capture: true });
      let match = regex.exec(posix ? utils.toPosixSlashes(input) : input);
      if (match) {
        return match.slice(1).map((v) => v === void 0 ? "" : v);
      }
    };
    micromatch.makeRe = (...args) => picomatch.makeRe(...args);
    micromatch.scan = (...args) => picomatch.scan(...args);
    micromatch.parse = (patterns, options) => {
      let res = [];
      for (let pattern of [].concat(patterns || [])) {
        for (let str of braces(String(pattern), options)) {
          res.push(picomatch.parse(str, options));
        }
      }
      return res;
    };
    micromatch.braces = (pattern, options) => {
      if (typeof pattern !== "string") throw new TypeError("Expected a string");
      if (options && options.nobrace === true || !hasBraces(pattern)) {
        return [pattern];
      }
      return braces(pattern, options);
    };
    micromatch.braceExpand = (pattern, options) => {
      if (typeof pattern !== "string") throw new TypeError("Expected a string");
      return micromatch.braces(pattern, { ...options, expand: true });
    };
    micromatch.hasBraces = hasBraces;
    module.exports = micromatch;
  }
});

// ../../node_modules/fast-glob/out/utils/pattern.js
var require_pattern = __commonJS({
  "../../node_modules/fast-glob/out/utils/pattern.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isAbsolute = exports.partitionAbsoluteAndRelative = exports.removeDuplicateSlashes = exports.matchAny = exports.convertPatternsToRe = exports.makeRe = exports.getPatternParts = exports.expandBraceExpansion = exports.expandPatternsWithBraceExpansion = exports.isAffectDepthOfReadingPattern = exports.endsWithSlashGlobStar = exports.hasGlobStar = exports.getBaseDirectory = exports.isPatternRelatedToParentDirectory = exports.getPatternsOutsideCurrentDirectory = exports.getPatternsInsideCurrentDirectory = exports.getPositivePatterns = exports.getNegativePatterns = exports.isPositivePattern = exports.isNegativePattern = exports.convertToNegativePattern = exports.convertToPositivePattern = exports.isDynamicPattern = exports.isStaticPattern = void 0;
    var path = __require("path");
    var globParent = require_glob_parent();
    var micromatch = require_micromatch();
    var GLOBSTAR = "**";
    var ESCAPE_SYMBOL = "\\";
    var COMMON_GLOB_SYMBOLS_RE = /[*?]|^!/;
    var REGEX_CHARACTER_CLASS_SYMBOLS_RE = /\[[^[]*]/;
    var REGEX_GROUP_SYMBOLS_RE = /(?:^|[^!*+?@])\([^(]*\|[^|]*\)/;
    var GLOB_EXTENSION_SYMBOLS_RE = /[!*+?@]\([^(]*\)/;
    var BRACE_EXPANSION_SEPARATORS_RE = /,|\.\./;
    var DOUBLE_SLASH_RE = /(?!^)\/{2,}/g;
    function isStaticPattern(pattern, options = {}) {
      return !isDynamicPattern(pattern, options);
    }
    exports.isStaticPattern = isStaticPattern;
    function isDynamicPattern(pattern, options = {}) {
      if (pattern === "") {
        return false;
      }
      if (options.caseSensitiveMatch === false || pattern.includes(ESCAPE_SYMBOL)) {
        return true;
      }
      if (COMMON_GLOB_SYMBOLS_RE.test(pattern) || REGEX_CHARACTER_CLASS_SYMBOLS_RE.test(pattern) || REGEX_GROUP_SYMBOLS_RE.test(pattern)) {
        return true;
      }
      if (options.extglob !== false && GLOB_EXTENSION_SYMBOLS_RE.test(pattern)) {
        return true;
      }
      if (options.braceExpansion !== false && hasBraceExpansion(pattern)) {
        return true;
      }
      return false;
    }
    exports.isDynamicPattern = isDynamicPattern;
    function hasBraceExpansion(pattern) {
      const openingBraceIndex = pattern.indexOf("{");
      if (openingBraceIndex === -1) {
        return false;
      }
      const closingBraceIndex = pattern.indexOf("}", openingBraceIndex + 1);
      if (closingBraceIndex === -1) {
        return false;
      }
      const braceContent = pattern.slice(openingBraceIndex, closingBraceIndex);
      return BRACE_EXPANSION_SEPARATORS_RE.test(braceContent);
    }
    function convertToPositivePattern(pattern) {
      return isNegativePattern(pattern) ? pattern.slice(1) : pattern;
    }
    exports.convertToPositivePattern = convertToPositivePattern;
    function convertToNegativePattern(pattern) {
      return "!" + pattern;
    }
    exports.convertToNegativePattern = convertToNegativePattern;
    function isNegativePattern(pattern) {
      return pattern.startsWith("!") && pattern[1] !== "(";
    }
    exports.isNegativePattern = isNegativePattern;
    function isPositivePattern(pattern) {
      return !isNegativePattern(pattern);
    }
    exports.isPositivePattern = isPositivePattern;
    function getNegativePatterns(patterns) {
      return patterns.filter(isNegativePattern);
    }
    exports.getNegativePatterns = getNegativePatterns;
    function getPositivePatterns(patterns) {
      return patterns.filter(isPositivePattern);
    }
    exports.getPositivePatterns = getPositivePatterns;
    function getPatternsInsideCurrentDirectory(patterns) {
      return patterns.filter((pattern) => !isPatternRelatedToParentDirectory(pattern));
    }
    exports.getPatternsInsideCurrentDirectory = getPatternsInsideCurrentDirectory;
    function getPatternsOutsideCurrentDirectory(patterns) {
      return patterns.filter(isPatternRelatedToParentDirectory);
    }
    exports.getPatternsOutsideCurrentDirectory = getPatternsOutsideCurrentDirectory;
    function isPatternRelatedToParentDirectory(pattern) {
      return pattern.startsWith("..") || pattern.startsWith("./..");
    }
    exports.isPatternRelatedToParentDirectory = isPatternRelatedToParentDirectory;
    function getBaseDirectory(pattern) {
      return globParent(pattern, { flipBackslashes: false });
    }
    exports.getBaseDirectory = getBaseDirectory;
    function hasGlobStar(pattern) {
      return pattern.includes(GLOBSTAR);
    }
    exports.hasGlobStar = hasGlobStar;
    function endsWithSlashGlobStar(pattern) {
      return pattern.endsWith("/" + GLOBSTAR);
    }
    exports.endsWithSlashGlobStar = endsWithSlashGlobStar;
    function isAffectDepthOfReadingPattern(pattern) {
      const basename5 = path.basename(pattern);
      return endsWithSlashGlobStar(pattern) || isStaticPattern(basename5);
    }
    exports.isAffectDepthOfReadingPattern = isAffectDepthOfReadingPattern;
    function expandPatternsWithBraceExpansion(patterns) {
      return patterns.reduce((collection, pattern) => {
        return collection.concat(expandBraceExpansion(pattern));
      }, []);
    }
    exports.expandPatternsWithBraceExpansion = expandPatternsWithBraceExpansion;
    function expandBraceExpansion(pattern) {
      const patterns = micromatch.braces(pattern, { expand: true, nodupes: true, keepEscaping: true });
      patterns.sort((a, b) => a.length - b.length);
      return patterns.filter((pattern2) => pattern2 !== "");
    }
    exports.expandBraceExpansion = expandBraceExpansion;
    function getPatternParts(pattern, options) {
      let { parts } = micromatch.scan(pattern, Object.assign(Object.assign({}, options), { parts: true }));
      if (parts.length === 0) {
        parts = [pattern];
      }
      if (parts[0].startsWith("/")) {
        parts[0] = parts[0].slice(1);
        parts.unshift("");
      }
      return parts;
    }
    exports.getPatternParts = getPatternParts;
    function makeRe(pattern, options) {
      return micromatch.makeRe(pattern, options);
    }
    exports.makeRe = makeRe;
    function convertPatternsToRe(patterns, options) {
      return patterns.map((pattern) => makeRe(pattern, options));
    }
    exports.convertPatternsToRe = convertPatternsToRe;
    function matchAny(entry, patternsRe) {
      return patternsRe.some((patternRe) => patternRe.test(entry));
    }
    exports.matchAny = matchAny;
    function removeDuplicateSlashes(pattern) {
      return pattern.replace(DOUBLE_SLASH_RE, "/");
    }
    exports.removeDuplicateSlashes = removeDuplicateSlashes;
    function partitionAbsoluteAndRelative(patterns) {
      const absolute = [];
      const relative4 = [];
      for (const pattern of patterns) {
        if (isAbsolute2(pattern)) {
          absolute.push(pattern);
        } else {
          relative4.push(pattern);
        }
      }
      return [absolute, relative4];
    }
    exports.partitionAbsoluteAndRelative = partitionAbsoluteAndRelative;
    function isAbsolute2(pattern) {
      return path.isAbsolute(pattern);
    }
    exports.isAbsolute = isAbsolute2;
  }
});

// ../../node_modules/merge2/index.js
var require_merge2 = __commonJS({
  "../../node_modules/merge2/index.js"(exports, module) {
    "use strict";
    var Stream = __require("stream");
    var PassThrough = Stream.PassThrough;
    var slice = Array.prototype.slice;
    module.exports = merge2;
    function merge2() {
      const streamsQueue = [];
      const args = slice.call(arguments);
      let merging = false;
      let options = args[args.length - 1];
      if (options && !Array.isArray(options) && options.pipe == null) {
        args.pop();
      } else {
        options = {};
      }
      const doEnd = options.end !== false;
      const doPipeError = options.pipeError === true;
      if (options.objectMode == null) {
        options.objectMode = true;
      }
      if (options.highWaterMark == null) {
        options.highWaterMark = 64 * 1024;
      }
      const mergedStream = PassThrough(options);
      function addStream() {
        for (let i = 0, len = arguments.length; i < len; i++) {
          streamsQueue.push(pauseStreams(arguments[i], options));
        }
        mergeStream();
        return this;
      }
      function mergeStream() {
        if (merging) {
          return;
        }
        merging = true;
        let streams = streamsQueue.shift();
        if (!streams) {
          process.nextTick(endStream);
          return;
        }
        if (!Array.isArray(streams)) {
          streams = [streams];
        }
        let pipesCount = streams.length + 1;
        function next() {
          if (--pipesCount > 0) {
            return;
          }
          merging = false;
          mergeStream();
        }
        function pipe(stream) {
          function onend() {
            stream.removeListener("merge2UnpipeEnd", onend);
            stream.removeListener("end", onend);
            if (doPipeError) {
              stream.removeListener("error", onerror);
            }
            next();
          }
          function onerror(err) {
            mergedStream.emit("error", err);
          }
          if (stream._readableState.endEmitted) {
            return next();
          }
          stream.on("merge2UnpipeEnd", onend);
          stream.on("end", onend);
          if (doPipeError) {
            stream.on("error", onerror);
          }
          stream.pipe(mergedStream, { end: false });
          stream.resume();
        }
        for (let i = 0; i < streams.length; i++) {
          pipe(streams[i]);
        }
        next();
      }
      function endStream() {
        merging = false;
        mergedStream.emit("queueDrain");
        if (doEnd) {
          mergedStream.end();
        }
      }
      mergedStream.setMaxListeners(0);
      mergedStream.add = addStream;
      mergedStream.on("unpipe", function(stream) {
        stream.emit("merge2UnpipeEnd");
      });
      if (args.length) {
        addStream.apply(null, args);
      }
      return mergedStream;
    }
    function pauseStreams(streams, options) {
      if (!Array.isArray(streams)) {
        if (!streams._readableState && streams.pipe) {
          streams = streams.pipe(PassThrough(options));
        }
        if (!streams._readableState || !streams.pause || !streams.pipe) {
          throw new Error("Only readable stream can be merged.");
        }
        streams.pause();
      } else {
        for (let i = 0, len = streams.length; i < len; i++) {
          streams[i] = pauseStreams(streams[i], options);
        }
      }
      return streams;
    }
  }
});

// ../../node_modules/fast-glob/out/utils/stream.js
var require_stream = __commonJS({
  "../../node_modules/fast-glob/out/utils/stream.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.merge = void 0;
    var merge2 = require_merge2();
    function merge(streams) {
      const mergedStream = merge2(streams);
      streams.forEach((stream) => {
        stream.once("error", (error) => mergedStream.emit("error", error));
      });
      mergedStream.once("close", () => propagateCloseEventToSources(streams));
      mergedStream.once("end", () => propagateCloseEventToSources(streams));
      return mergedStream;
    }
    exports.merge = merge;
    function propagateCloseEventToSources(streams) {
      streams.forEach((stream) => stream.emit("close"));
    }
  }
});

// ../../node_modules/fast-glob/out/utils/string.js
var require_string = __commonJS({
  "../../node_modules/fast-glob/out/utils/string.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isEmpty = exports.isString = void 0;
    function isString(input) {
      return typeof input === "string";
    }
    exports.isString = isString;
    function isEmpty(input) {
      return input === "";
    }
    exports.isEmpty = isEmpty;
  }
});

// ../../node_modules/fast-glob/out/utils/index.js
var require_utils3 = __commonJS({
  "../../node_modules/fast-glob/out/utils/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.string = exports.stream = exports.pattern = exports.path = exports.fs = exports.errno = exports.array = void 0;
    var array = require_array();
    exports.array = array;
    var errno = require_errno();
    exports.errno = errno;
    var fs = require_fs();
    exports.fs = fs;
    var path = require_path();
    exports.path = path;
    var pattern = require_pattern();
    exports.pattern = pattern;
    var stream = require_stream();
    exports.stream = stream;
    var string = require_string();
    exports.string = string;
  }
});

// ../../node_modules/fast-glob/out/managers/tasks.js
var require_tasks = __commonJS({
  "../../node_modules/fast-glob/out/managers/tasks.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.convertPatternGroupToTask = exports.convertPatternGroupsToTasks = exports.groupPatternsByBaseDirectory = exports.getNegativePatternsAsPositive = exports.getPositivePatterns = exports.convertPatternsToTasks = exports.generate = void 0;
    var utils = require_utils3();
    function generate(input, settings) {
      const patterns = processPatterns(input, settings);
      const ignore = processPatterns(settings.ignore, settings);
      const positivePatterns = getPositivePatterns(patterns);
      const negativePatterns = getNegativePatternsAsPositive(patterns, ignore);
      const staticPatterns = positivePatterns.filter((pattern) => utils.pattern.isStaticPattern(pattern, settings));
      const dynamicPatterns = positivePatterns.filter((pattern) => utils.pattern.isDynamicPattern(pattern, settings));
      const staticTasks = convertPatternsToTasks(
        staticPatterns,
        negativePatterns,
        /* dynamic */
        false
      );
      const dynamicTasks = convertPatternsToTasks(
        dynamicPatterns,
        negativePatterns,
        /* dynamic */
        true
      );
      return staticTasks.concat(dynamicTasks);
    }
    exports.generate = generate;
    function processPatterns(input, settings) {
      let patterns = input;
      if (settings.braceExpansion) {
        patterns = utils.pattern.expandPatternsWithBraceExpansion(patterns);
      }
      if (settings.baseNameMatch) {
        patterns = patterns.map((pattern) => pattern.includes("/") ? pattern : `**/${pattern}`);
      }
      return patterns.map((pattern) => utils.pattern.removeDuplicateSlashes(pattern));
    }
    function convertPatternsToTasks(positive, negative, dynamic) {
      const tasks = [];
      const patternsOutsideCurrentDirectory = utils.pattern.getPatternsOutsideCurrentDirectory(positive);
      const patternsInsideCurrentDirectory = utils.pattern.getPatternsInsideCurrentDirectory(positive);
      const outsideCurrentDirectoryGroup = groupPatternsByBaseDirectory(patternsOutsideCurrentDirectory);
      const insideCurrentDirectoryGroup = groupPatternsByBaseDirectory(patternsInsideCurrentDirectory);
      tasks.push(...convertPatternGroupsToTasks(outsideCurrentDirectoryGroup, negative, dynamic));
      if ("." in insideCurrentDirectoryGroup) {
        tasks.push(convertPatternGroupToTask(".", patternsInsideCurrentDirectory, negative, dynamic));
      } else {
        tasks.push(...convertPatternGroupsToTasks(insideCurrentDirectoryGroup, negative, dynamic));
      }
      return tasks;
    }
    exports.convertPatternsToTasks = convertPatternsToTasks;
    function getPositivePatterns(patterns) {
      return utils.pattern.getPositivePatterns(patterns);
    }
    exports.getPositivePatterns = getPositivePatterns;
    function getNegativePatternsAsPositive(patterns, ignore) {
      const negative = utils.pattern.getNegativePatterns(patterns).concat(ignore);
      const positive = negative.map(utils.pattern.convertToPositivePattern);
      return positive;
    }
    exports.getNegativePatternsAsPositive = getNegativePatternsAsPositive;
    function groupPatternsByBaseDirectory(patterns) {
      const group = {};
      return patterns.reduce((collection, pattern) => {
        const base = utils.pattern.getBaseDirectory(pattern);
        if (base in collection) {
          collection[base].push(pattern);
        } else {
          collection[base] = [pattern];
        }
        return collection;
      }, group);
    }
    exports.groupPatternsByBaseDirectory = groupPatternsByBaseDirectory;
    function convertPatternGroupsToTasks(positive, negative, dynamic) {
      return Object.keys(positive).map((base) => {
        return convertPatternGroupToTask(base, positive[base], negative, dynamic);
      });
    }
    exports.convertPatternGroupsToTasks = convertPatternGroupsToTasks;
    function convertPatternGroupToTask(base, positive, negative, dynamic) {
      return {
        dynamic,
        positive,
        negative,
        base,
        patterns: [].concat(positive, negative.map(utils.pattern.convertToNegativePattern))
      };
    }
    exports.convertPatternGroupToTask = convertPatternGroupToTask;
  }
});

// ../../node_modules/@nodelib/fs.stat/out/providers/async.js
var require_async = __commonJS({
  "../../node_modules/@nodelib/fs.stat/out/providers/async.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.read = void 0;
    function read(path, settings, callback) {
      settings.fs.lstat(path, (lstatError, lstat) => {
        if (lstatError !== null) {
          callFailureCallback(callback, lstatError);
          return;
        }
        if (!lstat.isSymbolicLink() || !settings.followSymbolicLink) {
          callSuccessCallback(callback, lstat);
          return;
        }
        settings.fs.stat(path, (statError, stat) => {
          if (statError !== null) {
            if (settings.throwErrorOnBrokenSymbolicLink) {
              callFailureCallback(callback, statError);
              return;
            }
            callSuccessCallback(callback, lstat);
            return;
          }
          if (settings.markSymbolicLink) {
            stat.isSymbolicLink = () => true;
          }
          callSuccessCallback(callback, stat);
        });
      });
    }
    exports.read = read;
    function callFailureCallback(callback, error) {
      callback(error);
    }
    function callSuccessCallback(callback, result) {
      callback(null, result);
    }
  }
});

// ../../node_modules/@nodelib/fs.stat/out/providers/sync.js
var require_sync = __commonJS({
  "../../node_modules/@nodelib/fs.stat/out/providers/sync.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.read = void 0;
    function read(path, settings) {
      const lstat = settings.fs.lstatSync(path);
      if (!lstat.isSymbolicLink() || !settings.followSymbolicLink) {
        return lstat;
      }
      try {
        const stat = settings.fs.statSync(path);
        if (settings.markSymbolicLink) {
          stat.isSymbolicLink = () => true;
        }
        return stat;
      } catch (error) {
        if (!settings.throwErrorOnBrokenSymbolicLink) {
          return lstat;
        }
        throw error;
      }
    }
    exports.read = read;
  }
});

// ../../node_modules/@nodelib/fs.stat/out/adapters/fs.js
var require_fs2 = __commonJS({
  "../../node_modules/@nodelib/fs.stat/out/adapters/fs.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createFileSystemAdapter = exports.FILE_SYSTEM_ADAPTER = void 0;
    var fs = __require("fs");
    exports.FILE_SYSTEM_ADAPTER = {
      lstat: fs.lstat,
      stat: fs.stat,
      lstatSync: fs.lstatSync,
      statSync: fs.statSync
    };
    function createFileSystemAdapter(fsMethods) {
      if (fsMethods === void 0) {
        return exports.FILE_SYSTEM_ADAPTER;
      }
      return Object.assign(Object.assign({}, exports.FILE_SYSTEM_ADAPTER), fsMethods);
    }
    exports.createFileSystemAdapter = createFileSystemAdapter;
  }
});

// ../../node_modules/@nodelib/fs.stat/out/settings.js
var require_settings = __commonJS({
  "../../node_modules/@nodelib/fs.stat/out/settings.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var fs = require_fs2();
    var Settings = class {
      constructor(_options = {}) {
        this._options = _options;
        this.followSymbolicLink = this._getValue(this._options.followSymbolicLink, true);
        this.fs = fs.createFileSystemAdapter(this._options.fs);
        this.markSymbolicLink = this._getValue(this._options.markSymbolicLink, false);
        this.throwErrorOnBrokenSymbolicLink = this._getValue(this._options.throwErrorOnBrokenSymbolicLink, true);
      }
      _getValue(option, value) {
        return option !== null && option !== void 0 ? option : value;
      }
    };
    exports.default = Settings;
  }
});

// ../../node_modules/@nodelib/fs.stat/out/index.js
var require_out = __commonJS({
  "../../node_modules/@nodelib/fs.stat/out/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.statSync = exports.stat = exports.Settings = void 0;
    var async = require_async();
    var sync = require_sync();
    var settings_1 = require_settings();
    exports.Settings = settings_1.default;
    function stat(path, optionsOrSettingsOrCallback, callback) {
      if (typeof optionsOrSettingsOrCallback === "function") {
        async.read(path, getSettings(), optionsOrSettingsOrCallback);
        return;
      }
      async.read(path, getSettings(optionsOrSettingsOrCallback), callback);
    }
    exports.stat = stat;
    function statSync8(path, optionsOrSettings) {
      const settings = getSettings(optionsOrSettings);
      return sync.read(path, settings);
    }
    exports.statSync = statSync8;
    function getSettings(settingsOrOptions = {}) {
      if (settingsOrOptions instanceof settings_1.default) {
        return settingsOrOptions;
      }
      return new settings_1.default(settingsOrOptions);
    }
  }
});

// ../../node_modules/queue-microtask/index.js
var require_queue_microtask = __commonJS({
  "../../node_modules/queue-microtask/index.js"(exports, module) {
    var promise;
    module.exports = typeof queueMicrotask === "function" ? queueMicrotask.bind(typeof window !== "undefined" ? window : global) : (cb) => (promise || (promise = Promise.resolve())).then(cb).catch((err) => setTimeout(() => {
      throw err;
    }, 0));
  }
});

// ../../node_modules/run-parallel/index.js
var require_run_parallel = __commonJS({
  "../../node_modules/run-parallel/index.js"(exports, module) {
    module.exports = runParallel;
    var queueMicrotask2 = require_queue_microtask();
    function runParallel(tasks, cb) {
      let results, pending, keys;
      let isSync = true;
      if (Array.isArray(tasks)) {
        results = [];
        pending = tasks.length;
      } else {
        keys = Object.keys(tasks);
        results = {};
        pending = keys.length;
      }
      function done(err) {
        function end() {
          if (cb) cb(err, results);
          cb = null;
        }
        if (isSync) queueMicrotask2(end);
        else end();
      }
      function each(i, err, result) {
        results[i] = result;
        if (--pending === 0 || err) {
          done(err);
        }
      }
      if (!pending) {
        done(null);
      } else if (keys) {
        keys.forEach(function(key) {
          tasks[key](function(err, result) {
            each(key, err, result);
          });
        });
      } else {
        tasks.forEach(function(task, i) {
          task(function(err, result) {
            each(i, err, result);
          });
        });
      }
      isSync = false;
    }
  }
});

// ../../node_modules/@nodelib/fs.scandir/out/constants.js
var require_constants3 = __commonJS({
  "../../node_modules/@nodelib/fs.scandir/out/constants.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.IS_SUPPORT_READDIR_WITH_FILE_TYPES = void 0;
    var NODE_PROCESS_VERSION_PARTS = process.versions.node.split(".");
    if (NODE_PROCESS_VERSION_PARTS[0] === void 0 || NODE_PROCESS_VERSION_PARTS[1] === void 0) {
      throw new Error(`Unexpected behavior. The 'process.versions.node' variable has invalid value: ${process.versions.node}`);
    }
    var MAJOR_VERSION = Number.parseInt(NODE_PROCESS_VERSION_PARTS[0], 10);
    var MINOR_VERSION = Number.parseInt(NODE_PROCESS_VERSION_PARTS[1], 10);
    var SUPPORTED_MAJOR_VERSION = 10;
    var SUPPORTED_MINOR_VERSION = 10;
    var IS_MATCHED_BY_MAJOR = MAJOR_VERSION > SUPPORTED_MAJOR_VERSION;
    var IS_MATCHED_BY_MAJOR_AND_MINOR = MAJOR_VERSION === SUPPORTED_MAJOR_VERSION && MINOR_VERSION >= SUPPORTED_MINOR_VERSION;
    exports.IS_SUPPORT_READDIR_WITH_FILE_TYPES = IS_MATCHED_BY_MAJOR || IS_MATCHED_BY_MAJOR_AND_MINOR;
  }
});

// ../../node_modules/@nodelib/fs.scandir/out/utils/fs.js
var require_fs3 = __commonJS({
  "../../node_modules/@nodelib/fs.scandir/out/utils/fs.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createDirentFromStats = void 0;
    var DirentFromStats = class {
      constructor(name, stats) {
        this.name = name;
        this.isBlockDevice = stats.isBlockDevice.bind(stats);
        this.isCharacterDevice = stats.isCharacterDevice.bind(stats);
        this.isDirectory = stats.isDirectory.bind(stats);
        this.isFIFO = stats.isFIFO.bind(stats);
        this.isFile = stats.isFile.bind(stats);
        this.isSocket = stats.isSocket.bind(stats);
        this.isSymbolicLink = stats.isSymbolicLink.bind(stats);
      }
    };
    function createDirentFromStats(name, stats) {
      return new DirentFromStats(name, stats);
    }
    exports.createDirentFromStats = createDirentFromStats;
  }
});

// ../../node_modules/@nodelib/fs.scandir/out/utils/index.js
var require_utils4 = __commonJS({
  "../../node_modules/@nodelib/fs.scandir/out/utils/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.fs = void 0;
    var fs = require_fs3();
    exports.fs = fs;
  }
});

// ../../node_modules/@nodelib/fs.scandir/out/providers/common.js
var require_common = __commonJS({
  "../../node_modules/@nodelib/fs.scandir/out/providers/common.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.joinPathSegments = void 0;
    function joinPathSegments(a, b, separator) {
      if (a.endsWith(separator)) {
        return a + b;
      }
      return a + separator + b;
    }
    exports.joinPathSegments = joinPathSegments;
  }
});

// ../../node_modules/@nodelib/fs.scandir/out/providers/async.js
var require_async2 = __commonJS({
  "../../node_modules/@nodelib/fs.scandir/out/providers/async.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.readdir = exports.readdirWithFileTypes = exports.read = void 0;
    var fsStat = require_out();
    var rpl = require_run_parallel();
    var constants_1 = require_constants3();
    var utils = require_utils4();
    var common = require_common();
    function read(directory, settings, callback) {
      if (!settings.stats && constants_1.IS_SUPPORT_READDIR_WITH_FILE_TYPES) {
        readdirWithFileTypes(directory, settings, callback);
        return;
      }
      readdir(directory, settings, callback);
    }
    exports.read = read;
    function readdirWithFileTypes(directory, settings, callback) {
      settings.fs.readdir(directory, { withFileTypes: true }, (readdirError, dirents) => {
        if (readdirError !== null) {
          callFailureCallback(callback, readdirError);
          return;
        }
        const entries = dirents.map((dirent) => ({
          dirent,
          name: dirent.name,
          path: common.joinPathSegments(directory, dirent.name, settings.pathSegmentSeparator)
        }));
        if (!settings.followSymbolicLinks) {
          callSuccessCallback(callback, entries);
          return;
        }
        const tasks = entries.map((entry) => makeRplTaskEntry(entry, settings));
        rpl(tasks, (rplError, rplEntries) => {
          if (rplError !== null) {
            callFailureCallback(callback, rplError);
            return;
          }
          callSuccessCallback(callback, rplEntries);
        });
      });
    }
    exports.readdirWithFileTypes = readdirWithFileTypes;
    function makeRplTaskEntry(entry, settings) {
      return (done) => {
        if (!entry.dirent.isSymbolicLink()) {
          done(null, entry);
          return;
        }
        settings.fs.stat(entry.path, (statError, stats) => {
          if (statError !== null) {
            if (settings.throwErrorOnBrokenSymbolicLink) {
              done(statError);
              return;
            }
            done(null, entry);
            return;
          }
          entry.dirent = utils.fs.createDirentFromStats(entry.name, stats);
          done(null, entry);
        });
      };
    }
    function readdir(directory, settings, callback) {
      settings.fs.readdir(directory, (readdirError, names) => {
        if (readdirError !== null) {
          callFailureCallback(callback, readdirError);
          return;
        }
        const tasks = names.map((name) => {
          const path = common.joinPathSegments(directory, name, settings.pathSegmentSeparator);
          return (done) => {
            fsStat.stat(path, settings.fsStatSettings, (error, stats) => {
              if (error !== null) {
                done(error);
                return;
              }
              const entry = {
                name,
                path,
                dirent: utils.fs.createDirentFromStats(name, stats)
              };
              if (settings.stats) {
                entry.stats = stats;
              }
              done(null, entry);
            });
          };
        });
        rpl(tasks, (rplError, entries) => {
          if (rplError !== null) {
            callFailureCallback(callback, rplError);
            return;
          }
          callSuccessCallback(callback, entries);
        });
      });
    }
    exports.readdir = readdir;
    function callFailureCallback(callback, error) {
      callback(error);
    }
    function callSuccessCallback(callback, result) {
      callback(null, result);
    }
  }
});

// ../../node_modules/@nodelib/fs.scandir/out/providers/sync.js
var require_sync2 = __commonJS({
  "../../node_modules/@nodelib/fs.scandir/out/providers/sync.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.readdir = exports.readdirWithFileTypes = exports.read = void 0;
    var fsStat = require_out();
    var constants_1 = require_constants3();
    var utils = require_utils4();
    var common = require_common();
    function read(directory, settings) {
      if (!settings.stats && constants_1.IS_SUPPORT_READDIR_WITH_FILE_TYPES) {
        return readdirWithFileTypes(directory, settings);
      }
      return readdir(directory, settings);
    }
    exports.read = read;
    function readdirWithFileTypes(directory, settings) {
      const dirents = settings.fs.readdirSync(directory, { withFileTypes: true });
      return dirents.map((dirent) => {
        const entry = {
          dirent,
          name: dirent.name,
          path: common.joinPathSegments(directory, dirent.name, settings.pathSegmentSeparator)
        };
        if (entry.dirent.isSymbolicLink() && settings.followSymbolicLinks) {
          try {
            const stats = settings.fs.statSync(entry.path);
            entry.dirent = utils.fs.createDirentFromStats(entry.name, stats);
          } catch (error) {
            if (settings.throwErrorOnBrokenSymbolicLink) {
              throw error;
            }
          }
        }
        return entry;
      });
    }
    exports.readdirWithFileTypes = readdirWithFileTypes;
    function readdir(directory, settings) {
      const names = settings.fs.readdirSync(directory);
      return names.map((name) => {
        const entryPath = common.joinPathSegments(directory, name, settings.pathSegmentSeparator);
        const stats = fsStat.statSync(entryPath, settings.fsStatSettings);
        const entry = {
          name,
          path: entryPath,
          dirent: utils.fs.createDirentFromStats(name, stats)
        };
        if (settings.stats) {
          entry.stats = stats;
        }
        return entry;
      });
    }
    exports.readdir = readdir;
  }
});

// ../../node_modules/@nodelib/fs.scandir/out/adapters/fs.js
var require_fs4 = __commonJS({
  "../../node_modules/@nodelib/fs.scandir/out/adapters/fs.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createFileSystemAdapter = exports.FILE_SYSTEM_ADAPTER = void 0;
    var fs = __require("fs");
    exports.FILE_SYSTEM_ADAPTER = {
      lstat: fs.lstat,
      stat: fs.stat,
      lstatSync: fs.lstatSync,
      statSync: fs.statSync,
      readdir: fs.readdir,
      readdirSync: fs.readdirSync
    };
    function createFileSystemAdapter(fsMethods) {
      if (fsMethods === void 0) {
        return exports.FILE_SYSTEM_ADAPTER;
      }
      return Object.assign(Object.assign({}, exports.FILE_SYSTEM_ADAPTER), fsMethods);
    }
    exports.createFileSystemAdapter = createFileSystemAdapter;
  }
});

// ../../node_modules/@nodelib/fs.scandir/out/settings.js
var require_settings2 = __commonJS({
  "../../node_modules/@nodelib/fs.scandir/out/settings.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var path = __require("path");
    var fsStat = require_out();
    var fs = require_fs4();
    var Settings = class {
      constructor(_options = {}) {
        this._options = _options;
        this.followSymbolicLinks = this._getValue(this._options.followSymbolicLinks, false);
        this.fs = fs.createFileSystemAdapter(this._options.fs);
        this.pathSegmentSeparator = this._getValue(this._options.pathSegmentSeparator, path.sep);
        this.stats = this._getValue(this._options.stats, false);
        this.throwErrorOnBrokenSymbolicLink = this._getValue(this._options.throwErrorOnBrokenSymbolicLink, true);
        this.fsStatSettings = new fsStat.Settings({
          followSymbolicLink: this.followSymbolicLinks,
          fs: this.fs,
          throwErrorOnBrokenSymbolicLink: this.throwErrorOnBrokenSymbolicLink
        });
      }
      _getValue(option, value) {
        return option !== null && option !== void 0 ? option : value;
      }
    };
    exports.default = Settings;
  }
});

// ../../node_modules/@nodelib/fs.scandir/out/index.js
var require_out2 = __commonJS({
  "../../node_modules/@nodelib/fs.scandir/out/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Settings = exports.scandirSync = exports.scandir = void 0;
    var async = require_async2();
    var sync = require_sync2();
    var settings_1 = require_settings2();
    exports.Settings = settings_1.default;
    function scandir(path, optionsOrSettingsOrCallback, callback) {
      if (typeof optionsOrSettingsOrCallback === "function") {
        async.read(path, getSettings(), optionsOrSettingsOrCallback);
        return;
      }
      async.read(path, getSettings(optionsOrSettingsOrCallback), callback);
    }
    exports.scandir = scandir;
    function scandirSync(path, optionsOrSettings) {
      const settings = getSettings(optionsOrSettings);
      return sync.read(path, settings);
    }
    exports.scandirSync = scandirSync;
    function getSettings(settingsOrOptions = {}) {
      if (settingsOrOptions instanceof settings_1.default) {
        return settingsOrOptions;
      }
      return new settings_1.default(settingsOrOptions);
    }
  }
});

// ../../node_modules/reusify/reusify.js
var require_reusify = __commonJS({
  "../../node_modules/reusify/reusify.js"(exports, module) {
    "use strict";
    function reusify(Constructor) {
      var head = new Constructor();
      var tail = head;
      function get() {
        var current = head;
        if (current.next) {
          head = current.next;
        } else {
          head = new Constructor();
          tail = head;
        }
        current.next = null;
        return current;
      }
      function release(obj) {
        tail.next = obj;
        tail = obj;
      }
      return {
        get,
        release
      };
    }
    module.exports = reusify;
  }
});

// ../../node_modules/fastq/queue.js
var require_queue = __commonJS({
  "../../node_modules/fastq/queue.js"(exports, module) {
    "use strict";
    var reusify = require_reusify();
    function fastqueue(context, worker, _concurrency) {
      if (typeof context === "function") {
        _concurrency = worker;
        worker = context;
        context = null;
      }
      if (!(_concurrency >= 1)) {
        throw new Error("fastqueue concurrency must be equal to or greater than 1");
      }
      var cache = reusify(Task);
      var queueHead = null;
      var queueTail = null;
      var _running = 0;
      var errorHandler = null;
      var self = {
        push,
        drain: noop,
        saturated: noop,
        pause,
        paused: false,
        get concurrency() {
          return _concurrency;
        },
        set concurrency(value) {
          if (!(value >= 1)) {
            throw new Error("fastqueue concurrency must be equal to or greater than 1");
          }
          _concurrency = value;
          if (self.paused) return;
          for (; queueHead && _running < _concurrency; ) {
            _running++;
            release();
          }
        },
        running,
        resume,
        idle,
        length,
        getQueue,
        unshift,
        empty: noop,
        kill,
        killAndDrain,
        error,
        abort
      };
      return self;
      function running() {
        return _running;
      }
      function pause() {
        self.paused = true;
      }
      function length() {
        var current = queueHead;
        var counter = 0;
        while (current) {
          current = current.next;
          counter++;
        }
        return counter;
      }
      function getQueue() {
        var current = queueHead;
        var tasks = [];
        while (current) {
          tasks.push(current.value);
          current = current.next;
        }
        return tasks;
      }
      function resume() {
        if (!self.paused) return;
        self.paused = false;
        if (queueHead === null) {
          _running++;
          release();
          return;
        }
        for (; queueHead && _running < _concurrency; ) {
          _running++;
          release();
        }
      }
      function idle() {
        return _running === 0 && self.length() === 0;
      }
      function push(value, done) {
        var current = cache.get();
        current.context = context;
        current.release = release;
        current.value = value;
        current.callback = done || noop;
        current.errorHandler = errorHandler;
        if (_running >= _concurrency || self.paused) {
          if (queueTail) {
            queueTail.next = current;
            queueTail = current;
          } else {
            queueHead = current;
            queueTail = current;
            self.saturated();
          }
        } else {
          _running++;
          worker.call(context, current.value, current.worked);
        }
      }
      function unshift(value, done) {
        var current = cache.get();
        current.context = context;
        current.release = release;
        current.value = value;
        current.callback = done || noop;
        current.errorHandler = errorHandler;
        if (_running >= _concurrency || self.paused) {
          if (queueHead) {
            current.next = queueHead;
            queueHead = current;
          } else {
            queueHead = current;
            queueTail = current;
            self.saturated();
          }
        } else {
          _running++;
          worker.call(context, current.value, current.worked);
        }
      }
      function release(holder) {
        if (holder) {
          cache.release(holder);
        }
        var next = queueHead;
        if (next && _running <= _concurrency) {
          if (!self.paused) {
            if (queueTail === queueHead) {
              queueTail = null;
            }
            queueHead = next.next;
            next.next = null;
            worker.call(context, next.value, next.worked);
            if (queueTail === null) {
              self.empty();
            }
          } else {
            _running--;
          }
        } else if (--_running === 0) {
          self.drain();
        }
      }
      function kill() {
        queueHead = null;
        queueTail = null;
        self.drain = noop;
      }
      function killAndDrain() {
        queueHead = null;
        queueTail = null;
        self.drain();
        self.drain = noop;
      }
      function abort() {
        var current = queueHead;
        queueHead = null;
        queueTail = null;
        while (current) {
          var next = current.next;
          var callback = current.callback;
          var errorHandler2 = current.errorHandler;
          var val = current.value;
          var context2 = current.context;
          current.value = null;
          current.callback = noop;
          current.errorHandler = null;
          if (errorHandler2) {
            errorHandler2(new Error("abort"), val);
          }
          callback.call(context2, new Error("abort"));
          current.release(current);
          current = next;
        }
        self.drain = noop;
      }
      function error(handler) {
        errorHandler = handler;
      }
    }
    function noop() {
    }
    function Task() {
      this.value = null;
      this.callback = noop;
      this.next = null;
      this.release = noop;
      this.context = null;
      this.errorHandler = null;
      var self = this;
      this.worked = function worked(err, result) {
        var callback = self.callback;
        var errorHandler = self.errorHandler;
        var val = self.value;
        self.value = null;
        self.callback = noop;
        if (self.errorHandler) {
          errorHandler(err, val);
        }
        callback.call(self.context, err, result);
        self.release(self);
      };
    }
    function queueAsPromised(context, worker, _concurrency) {
      if (typeof context === "function") {
        _concurrency = worker;
        worker = context;
        context = null;
      }
      function asyncWrapper(arg, cb) {
        worker.call(this, arg).then(function(res) {
          cb(null, res);
        }, cb);
      }
      var queue = fastqueue(context, asyncWrapper, _concurrency);
      var pushCb = queue.push;
      var unshiftCb = queue.unshift;
      queue.push = push;
      queue.unshift = unshift;
      queue.drained = drained;
      return queue;
      function push(value) {
        var p = new Promise(function(resolve10, reject) {
          pushCb(value, function(err, result) {
            if (err) {
              reject(err);
              return;
            }
            resolve10(result);
          });
        });
        p.catch(noop);
        return p;
      }
      function unshift(value) {
        var p = new Promise(function(resolve10, reject) {
          unshiftCb(value, function(err, result) {
            if (err) {
              reject(err);
              return;
            }
            resolve10(result);
          });
        });
        p.catch(noop);
        return p;
      }
      function drained() {
        var p = new Promise(function(resolve10) {
          process.nextTick(function() {
            if (queue.idle()) {
              resolve10();
            } else {
              var previousDrain = queue.drain;
              queue.drain = function() {
                if (typeof previousDrain === "function") previousDrain();
                resolve10();
                queue.drain = previousDrain;
              };
            }
          });
        });
        return p;
      }
    }
    module.exports = fastqueue;
    module.exports.promise = queueAsPromised;
  }
});

// ../../node_modules/@nodelib/fs.walk/out/readers/common.js
var require_common2 = __commonJS({
  "../../node_modules/@nodelib/fs.walk/out/readers/common.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.joinPathSegments = exports.replacePathSegmentSeparator = exports.isAppliedFilter = exports.isFatalError = void 0;
    function isFatalError(settings, error) {
      if (settings.errorFilter === null) {
        return true;
      }
      return !settings.errorFilter(error);
    }
    exports.isFatalError = isFatalError;
    function isAppliedFilter(filter, value) {
      return filter === null || filter(value);
    }
    exports.isAppliedFilter = isAppliedFilter;
    function replacePathSegmentSeparator(filepath, separator) {
      return filepath.split(/[/\\]/).join(separator);
    }
    exports.replacePathSegmentSeparator = replacePathSegmentSeparator;
    function joinPathSegments(a, b, separator) {
      if (a === "") {
        return b;
      }
      if (a.endsWith(separator)) {
        return a + b;
      }
      return a + separator + b;
    }
    exports.joinPathSegments = joinPathSegments;
  }
});

// ../../node_modules/@nodelib/fs.walk/out/readers/reader.js
var require_reader = __commonJS({
  "../../node_modules/@nodelib/fs.walk/out/readers/reader.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var common = require_common2();
    var Reader = class {
      constructor(_root, _settings) {
        this._root = _root;
        this._settings = _settings;
        this._root = common.replacePathSegmentSeparator(_root, _settings.pathSegmentSeparator);
      }
    };
    exports.default = Reader;
  }
});

// ../../node_modules/@nodelib/fs.walk/out/readers/async.js
var require_async3 = __commonJS({
  "../../node_modules/@nodelib/fs.walk/out/readers/async.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var events_1 = __require("events");
    var fsScandir = require_out2();
    var fastq = require_queue();
    var common = require_common2();
    var reader_1 = require_reader();
    var AsyncReader = class extends reader_1.default {
      constructor(_root, _settings) {
        super(_root, _settings);
        this._settings = _settings;
        this._scandir = fsScandir.scandir;
        this._emitter = new events_1.EventEmitter();
        this._queue = fastq(this._worker.bind(this), this._settings.concurrency);
        this._isFatalError = false;
        this._isDestroyed = false;
        this._queue.drain = () => {
          if (!this._isFatalError) {
            this._emitter.emit("end");
          }
        };
      }
      read() {
        this._isFatalError = false;
        this._isDestroyed = false;
        setImmediate(() => {
          this._pushToQueue(this._root, this._settings.basePath);
        });
        return this._emitter;
      }
      get isDestroyed() {
        return this._isDestroyed;
      }
      destroy() {
        if (this._isDestroyed) {
          throw new Error("The reader is already destroyed");
        }
        this._isDestroyed = true;
        this._queue.killAndDrain();
      }
      onEntry(callback) {
        this._emitter.on("entry", callback);
      }
      onError(callback) {
        this._emitter.once("error", callback);
      }
      onEnd(callback) {
        this._emitter.once("end", callback);
      }
      _pushToQueue(directory, base) {
        const queueItem = { directory, base };
        this._queue.push(queueItem, (error) => {
          if (error !== null) {
            this._handleError(error);
          }
        });
      }
      _worker(item, done) {
        this._scandir(item.directory, this._settings.fsScandirSettings, (error, entries) => {
          if (error !== null) {
            done(error, void 0);
            return;
          }
          for (const entry of entries) {
            this._handleEntry(entry, item.base);
          }
          done(null, void 0);
        });
      }
      _handleError(error) {
        if (this._isDestroyed || !common.isFatalError(this._settings, error)) {
          return;
        }
        this._isFatalError = true;
        this._isDestroyed = true;
        this._emitter.emit("error", error);
      }
      _handleEntry(entry, base) {
        if (this._isDestroyed || this._isFatalError) {
          return;
        }
        const fullpath = entry.path;
        if (base !== void 0) {
          entry.path = common.joinPathSegments(base, entry.name, this._settings.pathSegmentSeparator);
        }
        if (common.isAppliedFilter(this._settings.entryFilter, entry)) {
          this._emitEntry(entry);
        }
        if (entry.dirent.isDirectory() && common.isAppliedFilter(this._settings.deepFilter, entry)) {
          this._pushToQueue(fullpath, base === void 0 ? void 0 : entry.path);
        }
      }
      _emitEntry(entry) {
        this._emitter.emit("entry", entry);
      }
    };
    exports.default = AsyncReader;
  }
});

// ../../node_modules/@nodelib/fs.walk/out/providers/async.js
var require_async4 = __commonJS({
  "../../node_modules/@nodelib/fs.walk/out/providers/async.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var async_1 = require_async3();
    var AsyncProvider = class {
      constructor(_root, _settings) {
        this._root = _root;
        this._settings = _settings;
        this._reader = new async_1.default(this._root, this._settings);
        this._storage = [];
      }
      read(callback) {
        this._reader.onError((error) => {
          callFailureCallback(callback, error);
        });
        this._reader.onEntry((entry) => {
          this._storage.push(entry);
        });
        this._reader.onEnd(() => {
          callSuccessCallback(callback, this._storage);
        });
        this._reader.read();
      }
    };
    exports.default = AsyncProvider;
    function callFailureCallback(callback, error) {
      callback(error);
    }
    function callSuccessCallback(callback, entries) {
      callback(null, entries);
    }
  }
});

// ../../node_modules/@nodelib/fs.walk/out/providers/stream.js
var require_stream2 = __commonJS({
  "../../node_modules/@nodelib/fs.walk/out/providers/stream.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var stream_1 = __require("stream");
    var async_1 = require_async3();
    var StreamProvider = class {
      constructor(_root, _settings) {
        this._root = _root;
        this._settings = _settings;
        this._reader = new async_1.default(this._root, this._settings);
        this._stream = new stream_1.Readable({
          objectMode: true,
          read: () => {
          },
          destroy: () => {
            if (!this._reader.isDestroyed) {
              this._reader.destroy();
            }
          }
        });
      }
      read() {
        this._reader.onError((error) => {
          this._stream.emit("error", error);
        });
        this._reader.onEntry((entry) => {
          this._stream.push(entry);
        });
        this._reader.onEnd(() => {
          this._stream.push(null);
        });
        this._reader.read();
        return this._stream;
      }
    };
    exports.default = StreamProvider;
  }
});

// ../../node_modules/@nodelib/fs.walk/out/readers/sync.js
var require_sync3 = __commonJS({
  "../../node_modules/@nodelib/fs.walk/out/readers/sync.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var fsScandir = require_out2();
    var common = require_common2();
    var reader_1 = require_reader();
    var SyncReader = class extends reader_1.default {
      constructor() {
        super(...arguments);
        this._scandir = fsScandir.scandirSync;
        this._storage = [];
        this._queue = /* @__PURE__ */ new Set();
      }
      read() {
        this._pushToQueue(this._root, this._settings.basePath);
        this._handleQueue();
        return this._storage;
      }
      _pushToQueue(directory, base) {
        this._queue.add({ directory, base });
      }
      _handleQueue() {
        for (const item of this._queue.values()) {
          this._handleDirectory(item.directory, item.base);
        }
      }
      _handleDirectory(directory, base) {
        try {
          const entries = this._scandir(directory, this._settings.fsScandirSettings);
          for (const entry of entries) {
            this._handleEntry(entry, base);
          }
        } catch (error) {
          this._handleError(error);
        }
      }
      _handleError(error) {
        if (!common.isFatalError(this._settings, error)) {
          return;
        }
        throw error;
      }
      _handleEntry(entry, base) {
        const fullpath = entry.path;
        if (base !== void 0) {
          entry.path = common.joinPathSegments(base, entry.name, this._settings.pathSegmentSeparator);
        }
        if (common.isAppliedFilter(this._settings.entryFilter, entry)) {
          this._pushToStorage(entry);
        }
        if (entry.dirent.isDirectory() && common.isAppliedFilter(this._settings.deepFilter, entry)) {
          this._pushToQueue(fullpath, base === void 0 ? void 0 : entry.path);
        }
      }
      _pushToStorage(entry) {
        this._storage.push(entry);
      }
    };
    exports.default = SyncReader;
  }
});

// ../../node_modules/@nodelib/fs.walk/out/providers/sync.js
var require_sync4 = __commonJS({
  "../../node_modules/@nodelib/fs.walk/out/providers/sync.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var sync_1 = require_sync3();
    var SyncProvider = class {
      constructor(_root, _settings) {
        this._root = _root;
        this._settings = _settings;
        this._reader = new sync_1.default(this._root, this._settings);
      }
      read() {
        return this._reader.read();
      }
    };
    exports.default = SyncProvider;
  }
});

// ../../node_modules/@nodelib/fs.walk/out/settings.js
var require_settings3 = __commonJS({
  "../../node_modules/@nodelib/fs.walk/out/settings.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var path = __require("path");
    var fsScandir = require_out2();
    var Settings = class {
      constructor(_options = {}) {
        this._options = _options;
        this.basePath = this._getValue(this._options.basePath, void 0);
        this.concurrency = this._getValue(this._options.concurrency, Number.POSITIVE_INFINITY);
        this.deepFilter = this._getValue(this._options.deepFilter, null);
        this.entryFilter = this._getValue(this._options.entryFilter, null);
        this.errorFilter = this._getValue(this._options.errorFilter, null);
        this.pathSegmentSeparator = this._getValue(this._options.pathSegmentSeparator, path.sep);
        this.fsScandirSettings = new fsScandir.Settings({
          followSymbolicLinks: this._options.followSymbolicLinks,
          fs: this._options.fs,
          pathSegmentSeparator: this._options.pathSegmentSeparator,
          stats: this._options.stats,
          throwErrorOnBrokenSymbolicLink: this._options.throwErrorOnBrokenSymbolicLink
        });
      }
      _getValue(option, value) {
        return option !== null && option !== void 0 ? option : value;
      }
    };
    exports.default = Settings;
  }
});

// ../../node_modules/@nodelib/fs.walk/out/index.js
var require_out3 = __commonJS({
  "../../node_modules/@nodelib/fs.walk/out/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Settings = exports.walkStream = exports.walkSync = exports.walk = void 0;
    var async_1 = require_async4();
    var stream_1 = require_stream2();
    var sync_1 = require_sync4();
    var settings_1 = require_settings3();
    exports.Settings = settings_1.default;
    function walk(directory, optionsOrSettingsOrCallback, callback) {
      if (typeof optionsOrSettingsOrCallback === "function") {
        new async_1.default(directory, getSettings()).read(optionsOrSettingsOrCallback);
        return;
      }
      new async_1.default(directory, getSettings(optionsOrSettingsOrCallback)).read(callback);
    }
    exports.walk = walk;
    function walkSync(directory, optionsOrSettings) {
      const settings = getSettings(optionsOrSettings);
      const provider = new sync_1.default(directory, settings);
      return provider.read();
    }
    exports.walkSync = walkSync;
    function walkStream(directory, optionsOrSettings) {
      const settings = getSettings(optionsOrSettings);
      const provider = new stream_1.default(directory, settings);
      return provider.read();
    }
    exports.walkStream = walkStream;
    function getSettings(settingsOrOptions = {}) {
      if (settingsOrOptions instanceof settings_1.default) {
        return settingsOrOptions;
      }
      return new settings_1.default(settingsOrOptions);
    }
  }
});

// ../../node_modules/fast-glob/out/readers/reader.js
var require_reader2 = __commonJS({
  "../../node_modules/fast-glob/out/readers/reader.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var path = __require("path");
    var fsStat = require_out();
    var utils = require_utils3();
    var Reader = class {
      constructor(_settings) {
        this._settings = _settings;
        this._fsStatSettings = new fsStat.Settings({
          followSymbolicLink: this._settings.followSymbolicLinks,
          fs: this._settings.fs,
          throwErrorOnBrokenSymbolicLink: this._settings.followSymbolicLinks
        });
      }
      _getFullEntryPath(filepath) {
        return path.resolve(this._settings.cwd, filepath);
      }
      _makeEntry(stats, pattern) {
        const entry = {
          name: pattern,
          path: pattern,
          dirent: utils.fs.createDirentFromStats(pattern, stats)
        };
        if (this._settings.stats) {
          entry.stats = stats;
        }
        return entry;
      }
      _isFatalError(error) {
        return !utils.errno.isEnoentCodeError(error) && !this._settings.suppressErrors;
      }
    };
    exports.default = Reader;
  }
});

// ../../node_modules/fast-glob/out/readers/stream.js
var require_stream3 = __commonJS({
  "../../node_modules/fast-glob/out/readers/stream.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var stream_1 = __require("stream");
    var fsStat = require_out();
    var fsWalk = require_out3();
    var reader_1 = require_reader2();
    var ReaderStream = class extends reader_1.default {
      constructor() {
        super(...arguments);
        this._walkStream = fsWalk.walkStream;
        this._stat = fsStat.stat;
      }
      dynamic(root, options) {
        return this._walkStream(root, options);
      }
      static(patterns, options) {
        const filepaths = patterns.map(this._getFullEntryPath, this);
        const stream = new stream_1.PassThrough({ objectMode: true });
        stream._write = (index, _enc, done) => {
          return this._getEntry(filepaths[index], patterns[index], options).then((entry) => {
            if (entry !== null && options.entryFilter(entry)) {
              stream.push(entry);
            }
            if (index === filepaths.length - 1) {
              stream.end();
            }
            done();
          }).catch(done);
        };
        for (let i = 0; i < filepaths.length; i++) {
          stream.write(i);
        }
        return stream;
      }
      _getEntry(filepath, pattern, options) {
        return this._getStat(filepath).then((stats) => this._makeEntry(stats, pattern)).catch((error) => {
          if (options.errorFilter(error)) {
            return null;
          }
          throw error;
        });
      }
      _getStat(filepath) {
        return new Promise((resolve10, reject) => {
          this._stat(filepath, this._fsStatSettings, (error, stats) => {
            return error === null ? resolve10(stats) : reject(error);
          });
        });
      }
    };
    exports.default = ReaderStream;
  }
});

// ../../node_modules/fast-glob/out/readers/async.js
var require_async5 = __commonJS({
  "../../node_modules/fast-glob/out/readers/async.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var fsWalk = require_out3();
    var reader_1 = require_reader2();
    var stream_1 = require_stream3();
    var ReaderAsync = class extends reader_1.default {
      constructor() {
        super(...arguments);
        this._walkAsync = fsWalk.walk;
        this._readerStream = new stream_1.default(this._settings);
      }
      dynamic(root, options) {
        return new Promise((resolve10, reject) => {
          this._walkAsync(root, options, (error, entries) => {
            if (error === null) {
              resolve10(entries);
            } else {
              reject(error);
            }
          });
        });
      }
      async static(patterns, options) {
        const entries = [];
        const stream = this._readerStream.static(patterns, options);
        return new Promise((resolve10, reject) => {
          stream.once("error", reject);
          stream.on("data", (entry) => entries.push(entry));
          stream.once("end", () => resolve10(entries));
        });
      }
    };
    exports.default = ReaderAsync;
  }
});

// ../../node_modules/fast-glob/out/providers/matchers/matcher.js
var require_matcher = __commonJS({
  "../../node_modules/fast-glob/out/providers/matchers/matcher.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_utils3();
    var Matcher = class {
      constructor(_patterns, _settings, _micromatchOptions) {
        this._patterns = _patterns;
        this._settings = _settings;
        this._micromatchOptions = _micromatchOptions;
        this._storage = [];
        this._fillStorage();
      }
      _fillStorage() {
        for (const pattern of this._patterns) {
          const segments = this._getPatternSegments(pattern);
          const sections = this._splitSegmentsIntoSections(segments);
          this._storage.push({
            complete: sections.length <= 1,
            pattern,
            segments,
            sections
          });
        }
      }
      _getPatternSegments(pattern) {
        const parts = utils.pattern.getPatternParts(pattern, this._micromatchOptions);
        return parts.map((part) => {
          const dynamic = utils.pattern.isDynamicPattern(part, this._settings);
          if (!dynamic) {
            return {
              dynamic: false,
              pattern: part
            };
          }
          return {
            dynamic: true,
            pattern: part,
            patternRe: utils.pattern.makeRe(part, this._micromatchOptions)
          };
        });
      }
      _splitSegmentsIntoSections(segments) {
        return utils.array.splitWhen(segments, (segment) => segment.dynamic && utils.pattern.hasGlobStar(segment.pattern));
      }
    };
    exports.default = Matcher;
  }
});

// ../../node_modules/fast-glob/out/providers/matchers/partial.js
var require_partial = __commonJS({
  "../../node_modules/fast-glob/out/providers/matchers/partial.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var matcher_1 = require_matcher();
    var PartialMatcher = class extends matcher_1.default {
      match(filepath) {
        const parts = filepath.split("/");
        const levels = parts.length;
        const patterns = this._storage.filter((info) => !info.complete || info.segments.length > levels);
        for (const pattern of patterns) {
          const section = pattern.sections[0];
          if (!pattern.complete && levels > section.length) {
            return true;
          }
          const match = parts.every((part, index) => {
            const segment = pattern.segments[index];
            if (segment.dynamic && segment.patternRe.test(part)) {
              return true;
            }
            if (!segment.dynamic && segment.pattern === part) {
              return true;
            }
            return false;
          });
          if (match) {
            return true;
          }
        }
        return false;
      }
    };
    exports.default = PartialMatcher;
  }
});

// ../../node_modules/fast-glob/out/providers/filters/deep.js
var require_deep = __commonJS({
  "../../node_modules/fast-glob/out/providers/filters/deep.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_utils3();
    var partial_1 = require_partial();
    var DeepFilter = class {
      constructor(_settings, _micromatchOptions) {
        this._settings = _settings;
        this._micromatchOptions = _micromatchOptions;
      }
      getFilter(basePath, positive, negative) {
        const matcher = this._getMatcher(positive);
        const negativeRe = this._getNegativePatternsRe(negative);
        return (entry) => this._filter(basePath, entry, matcher, negativeRe);
      }
      _getMatcher(patterns) {
        return new partial_1.default(patterns, this._settings, this._micromatchOptions);
      }
      _getNegativePatternsRe(patterns) {
        const affectDepthOfReadingPatterns = patterns.filter(utils.pattern.isAffectDepthOfReadingPattern);
        return utils.pattern.convertPatternsToRe(affectDepthOfReadingPatterns, this._micromatchOptions);
      }
      _filter(basePath, entry, matcher, negativeRe) {
        if (this._isSkippedByDeep(basePath, entry.path)) {
          return false;
        }
        if (this._isSkippedSymbolicLink(entry)) {
          return false;
        }
        const filepath = utils.path.removeLeadingDotSegment(entry.path);
        if (this._isSkippedByPositivePatterns(filepath, matcher)) {
          return false;
        }
        return this._isSkippedByNegativePatterns(filepath, negativeRe);
      }
      _isSkippedByDeep(basePath, entryPath) {
        if (this._settings.deep === Infinity) {
          return false;
        }
        return this._getEntryLevel(basePath, entryPath) >= this._settings.deep;
      }
      _getEntryLevel(basePath, entryPath) {
        const entryPathDepth = entryPath.split("/").length;
        if (basePath === "") {
          return entryPathDepth;
        }
        const basePathDepth = basePath.split("/").length;
        return entryPathDepth - basePathDepth;
      }
      _isSkippedSymbolicLink(entry) {
        return !this._settings.followSymbolicLinks && entry.dirent.isSymbolicLink();
      }
      _isSkippedByPositivePatterns(entryPath, matcher) {
        return !this._settings.baseNameMatch && !matcher.match(entryPath);
      }
      _isSkippedByNegativePatterns(entryPath, patternsRe) {
        return !utils.pattern.matchAny(entryPath, patternsRe);
      }
    };
    exports.default = DeepFilter;
  }
});

// ../../node_modules/fast-glob/out/providers/filters/entry.js
var require_entry = __commonJS({
  "../../node_modules/fast-glob/out/providers/filters/entry.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_utils3();
    var EntryFilter = class {
      constructor(_settings, _micromatchOptions) {
        this._settings = _settings;
        this._micromatchOptions = _micromatchOptions;
        this.index = /* @__PURE__ */ new Map();
      }
      getFilter(positive, negative) {
        const [absoluteNegative, relativeNegative] = utils.pattern.partitionAbsoluteAndRelative(negative);
        const patterns = {
          positive: {
            all: utils.pattern.convertPatternsToRe(positive, this._micromatchOptions)
          },
          negative: {
            absolute: utils.pattern.convertPatternsToRe(absoluteNegative, Object.assign(Object.assign({}, this._micromatchOptions), { dot: true })),
            relative: utils.pattern.convertPatternsToRe(relativeNegative, Object.assign(Object.assign({}, this._micromatchOptions), { dot: true }))
          }
        };
        return (entry) => this._filter(entry, patterns);
      }
      _filter(entry, patterns) {
        const filepath = utils.path.removeLeadingDotSegment(entry.path);
        if (this._settings.unique && this._isDuplicateEntry(filepath)) {
          return false;
        }
        if (this._onlyFileFilter(entry) || this._onlyDirectoryFilter(entry)) {
          return false;
        }
        const isMatched = this._isMatchToPatternsSet(filepath, patterns, entry.dirent.isDirectory());
        if (this._settings.unique && isMatched) {
          this._createIndexRecord(filepath);
        }
        return isMatched;
      }
      _isDuplicateEntry(filepath) {
        return this.index.has(filepath);
      }
      _createIndexRecord(filepath) {
        this.index.set(filepath, void 0);
      }
      _onlyFileFilter(entry) {
        return this._settings.onlyFiles && !entry.dirent.isFile();
      }
      _onlyDirectoryFilter(entry) {
        return this._settings.onlyDirectories && !entry.dirent.isDirectory();
      }
      _isMatchToPatternsSet(filepath, patterns, isDirectory) {
        const isMatched = this._isMatchToPatterns(filepath, patterns.positive.all, isDirectory);
        if (!isMatched) {
          return false;
        }
        const isMatchedByRelativeNegative = this._isMatchToPatterns(filepath, patterns.negative.relative, isDirectory);
        if (isMatchedByRelativeNegative) {
          return false;
        }
        const isMatchedByAbsoluteNegative = this._isMatchToAbsoluteNegative(filepath, patterns.negative.absolute, isDirectory);
        if (isMatchedByAbsoluteNegative) {
          return false;
        }
        return true;
      }
      _isMatchToAbsoluteNegative(filepath, patternsRe, isDirectory) {
        if (patternsRe.length === 0) {
          return false;
        }
        const fullpath = utils.path.makeAbsolute(this._settings.cwd, filepath);
        return this._isMatchToPatterns(fullpath, patternsRe, isDirectory);
      }
      _isMatchToPatterns(filepath, patternsRe, isDirectory) {
        if (patternsRe.length === 0) {
          return false;
        }
        const isMatched = utils.pattern.matchAny(filepath, patternsRe);
        if (!isMatched && isDirectory) {
          return utils.pattern.matchAny(filepath + "/", patternsRe);
        }
        return isMatched;
      }
    };
    exports.default = EntryFilter;
  }
});

// ../../node_modules/fast-glob/out/providers/filters/error.js
var require_error = __commonJS({
  "../../node_modules/fast-glob/out/providers/filters/error.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_utils3();
    var ErrorFilter = class {
      constructor(_settings) {
        this._settings = _settings;
      }
      getFilter() {
        return (error) => this._isNonFatalError(error);
      }
      _isNonFatalError(error) {
        return utils.errno.isEnoentCodeError(error) || this._settings.suppressErrors;
      }
    };
    exports.default = ErrorFilter;
  }
});

// ../../node_modules/fast-glob/out/providers/transformers/entry.js
var require_entry2 = __commonJS({
  "../../node_modules/fast-glob/out/providers/transformers/entry.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_utils3();
    var EntryTransformer = class {
      constructor(_settings) {
        this._settings = _settings;
      }
      getTransformer() {
        return (entry) => this._transform(entry);
      }
      _transform(entry) {
        let filepath = entry.path;
        if (this._settings.absolute) {
          filepath = utils.path.makeAbsolute(this._settings.cwd, filepath);
          filepath = utils.path.unixify(filepath);
        }
        if (this._settings.markDirectories && entry.dirent.isDirectory()) {
          filepath += "/";
        }
        if (!this._settings.objectMode) {
          return filepath;
        }
        return Object.assign(Object.assign({}, entry), { path: filepath });
      }
    };
    exports.default = EntryTransformer;
  }
});

// ../../node_modules/fast-glob/out/providers/provider.js
var require_provider = __commonJS({
  "../../node_modules/fast-glob/out/providers/provider.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var path = __require("path");
    var deep_1 = require_deep();
    var entry_1 = require_entry();
    var error_1 = require_error();
    var entry_2 = require_entry2();
    var Provider = class {
      constructor(_settings) {
        this._settings = _settings;
        this.errorFilter = new error_1.default(this._settings);
        this.entryFilter = new entry_1.default(this._settings, this._getMicromatchOptions());
        this.deepFilter = new deep_1.default(this._settings, this._getMicromatchOptions());
        this.entryTransformer = new entry_2.default(this._settings);
      }
      _getRootDirectory(task) {
        return path.resolve(this._settings.cwd, task.base);
      }
      _getReaderOptions(task) {
        const basePath = task.base === "." ? "" : task.base;
        return {
          basePath,
          pathSegmentSeparator: "/",
          concurrency: this._settings.concurrency,
          deepFilter: this.deepFilter.getFilter(basePath, task.positive, task.negative),
          entryFilter: this.entryFilter.getFilter(task.positive, task.negative),
          errorFilter: this.errorFilter.getFilter(),
          followSymbolicLinks: this._settings.followSymbolicLinks,
          fs: this._settings.fs,
          stats: this._settings.stats,
          throwErrorOnBrokenSymbolicLink: this._settings.throwErrorOnBrokenSymbolicLink,
          transform: this.entryTransformer.getTransformer()
        };
      }
      _getMicromatchOptions() {
        return {
          dot: this._settings.dot,
          matchBase: this._settings.baseNameMatch,
          nobrace: !this._settings.braceExpansion,
          nocase: !this._settings.caseSensitiveMatch,
          noext: !this._settings.extglob,
          noglobstar: !this._settings.globstar,
          posix: true,
          strictSlashes: false
        };
      }
    };
    exports.default = Provider;
  }
});

// ../../node_modules/fast-glob/out/providers/async.js
var require_async6 = __commonJS({
  "../../node_modules/fast-glob/out/providers/async.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var async_1 = require_async5();
    var provider_1 = require_provider();
    var ProviderAsync = class extends provider_1.default {
      constructor() {
        super(...arguments);
        this._reader = new async_1.default(this._settings);
      }
      async read(task) {
        const root = this._getRootDirectory(task);
        const options = this._getReaderOptions(task);
        const entries = await this.api(root, task, options);
        return entries.map((entry) => options.transform(entry));
      }
      api(root, task, options) {
        if (task.dynamic) {
          return this._reader.dynamic(root, options);
        }
        return this._reader.static(task.patterns, options);
      }
    };
    exports.default = ProviderAsync;
  }
});

// ../../node_modules/fast-glob/out/providers/stream.js
var require_stream4 = __commonJS({
  "../../node_modules/fast-glob/out/providers/stream.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var stream_1 = __require("stream");
    var stream_2 = require_stream3();
    var provider_1 = require_provider();
    var ProviderStream = class extends provider_1.default {
      constructor() {
        super(...arguments);
        this._reader = new stream_2.default(this._settings);
      }
      read(task) {
        const root = this._getRootDirectory(task);
        const options = this._getReaderOptions(task);
        const source = this.api(root, task, options);
        const destination = new stream_1.Readable({ objectMode: true, read: () => {
        } });
        source.once("error", (error) => destination.emit("error", error)).on("data", (entry) => destination.emit("data", options.transform(entry))).once("end", () => destination.emit("end"));
        destination.once("close", () => source.destroy());
        return destination;
      }
      api(root, task, options) {
        if (task.dynamic) {
          return this._reader.dynamic(root, options);
        }
        return this._reader.static(task.patterns, options);
      }
    };
    exports.default = ProviderStream;
  }
});

// ../../node_modules/fast-glob/out/readers/sync.js
var require_sync5 = __commonJS({
  "../../node_modules/fast-glob/out/readers/sync.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var fsStat = require_out();
    var fsWalk = require_out3();
    var reader_1 = require_reader2();
    var ReaderSync = class extends reader_1.default {
      constructor() {
        super(...arguments);
        this._walkSync = fsWalk.walkSync;
        this._statSync = fsStat.statSync;
      }
      dynamic(root, options) {
        return this._walkSync(root, options);
      }
      static(patterns, options) {
        const entries = [];
        for (const pattern of patterns) {
          const filepath = this._getFullEntryPath(pattern);
          const entry = this._getEntry(filepath, pattern, options);
          if (entry === null || !options.entryFilter(entry)) {
            continue;
          }
          entries.push(entry);
        }
        return entries;
      }
      _getEntry(filepath, pattern, options) {
        try {
          const stats = this._getStat(filepath);
          return this._makeEntry(stats, pattern);
        } catch (error) {
          if (options.errorFilter(error)) {
            return null;
          }
          throw error;
        }
      }
      _getStat(filepath) {
        return this._statSync(filepath, this._fsStatSettings);
      }
    };
    exports.default = ReaderSync;
  }
});

// ../../node_modules/fast-glob/out/providers/sync.js
var require_sync6 = __commonJS({
  "../../node_modules/fast-glob/out/providers/sync.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var sync_1 = require_sync5();
    var provider_1 = require_provider();
    var ProviderSync = class extends provider_1.default {
      constructor() {
        super(...arguments);
        this._reader = new sync_1.default(this._settings);
      }
      read(task) {
        const root = this._getRootDirectory(task);
        const options = this._getReaderOptions(task);
        const entries = this.api(root, task, options);
        return entries.map(options.transform);
      }
      api(root, task, options) {
        if (task.dynamic) {
          return this._reader.dynamic(root, options);
        }
        return this._reader.static(task.patterns, options);
      }
    };
    exports.default = ProviderSync;
  }
});

// ../../node_modules/fast-glob/out/settings.js
var require_settings4 = __commonJS({
  "../../node_modules/fast-glob/out/settings.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DEFAULT_FILE_SYSTEM_ADAPTER = void 0;
    var fs = __require("fs");
    var os = __require("os");
    var CPU_COUNT = Math.max(os.cpus().length, 1);
    exports.DEFAULT_FILE_SYSTEM_ADAPTER = {
      lstat: fs.lstat,
      lstatSync: fs.lstatSync,
      stat: fs.stat,
      statSync: fs.statSync,
      readdir: fs.readdir,
      readdirSync: fs.readdirSync
    };
    var Settings = class {
      constructor(_options = {}) {
        this._options = _options;
        this.absolute = this._getValue(this._options.absolute, false);
        this.baseNameMatch = this._getValue(this._options.baseNameMatch, false);
        this.braceExpansion = this._getValue(this._options.braceExpansion, true);
        this.caseSensitiveMatch = this._getValue(this._options.caseSensitiveMatch, true);
        this.concurrency = this._getValue(this._options.concurrency, CPU_COUNT);
        this.cwd = this._getValue(this._options.cwd, process.cwd());
        this.deep = this._getValue(this._options.deep, Infinity);
        this.dot = this._getValue(this._options.dot, false);
        this.extglob = this._getValue(this._options.extglob, true);
        this.followSymbolicLinks = this._getValue(this._options.followSymbolicLinks, true);
        this.fs = this._getFileSystemMethods(this._options.fs);
        this.globstar = this._getValue(this._options.globstar, true);
        this.ignore = this._getValue(this._options.ignore, []);
        this.markDirectories = this._getValue(this._options.markDirectories, false);
        this.objectMode = this._getValue(this._options.objectMode, false);
        this.onlyDirectories = this._getValue(this._options.onlyDirectories, false);
        this.onlyFiles = this._getValue(this._options.onlyFiles, true);
        this.stats = this._getValue(this._options.stats, false);
        this.suppressErrors = this._getValue(this._options.suppressErrors, false);
        this.throwErrorOnBrokenSymbolicLink = this._getValue(this._options.throwErrorOnBrokenSymbolicLink, false);
        this.unique = this._getValue(this._options.unique, true);
        if (this.onlyDirectories) {
          this.onlyFiles = false;
        }
        if (this.stats) {
          this.objectMode = true;
        }
        this.ignore = [].concat(this.ignore);
      }
      _getValue(option, value) {
        return option === void 0 ? value : option;
      }
      _getFileSystemMethods(methods = {}) {
        return Object.assign(Object.assign({}, exports.DEFAULT_FILE_SYSTEM_ADAPTER), methods);
      }
    };
    exports.default = Settings;
  }
});

// ../../node_modules/fast-glob/out/index.js
var require_out4 = __commonJS({
  "../../node_modules/fast-glob/out/index.js"(exports, module) {
    "use strict";
    var taskManager = require_tasks();
    var async_1 = require_async6();
    var stream_1 = require_stream4();
    var sync_1 = require_sync6();
    var settings_1 = require_settings4();
    var utils = require_utils3();
    async function FastGlob(source, options) {
      assertPatternsInput(source);
      const works = getWorks(source, async_1.default, options);
      const result = await Promise.all(works);
      return utils.array.flatten(result);
    }
    (function(FastGlob2) {
      FastGlob2.glob = FastGlob2;
      FastGlob2.globSync = sync;
      FastGlob2.globStream = stream;
      FastGlob2.async = FastGlob2;
      function sync(source, options) {
        assertPatternsInput(source);
        const works = getWorks(source, sync_1.default, options);
        return utils.array.flatten(works);
      }
      FastGlob2.sync = sync;
      function stream(source, options) {
        assertPatternsInput(source);
        const works = getWorks(source, stream_1.default, options);
        return utils.stream.merge(works);
      }
      FastGlob2.stream = stream;
      function generateTasks(source, options) {
        assertPatternsInput(source);
        const patterns = [].concat(source);
        const settings = new settings_1.default(options);
        return taskManager.generate(patterns, settings);
      }
      FastGlob2.generateTasks = generateTasks;
      function isDynamicPattern(source, options) {
        assertPatternsInput(source);
        const settings = new settings_1.default(options);
        return utils.pattern.isDynamicPattern(source, settings);
      }
      FastGlob2.isDynamicPattern = isDynamicPattern;
      function escapePath(source) {
        assertPatternsInput(source);
        return utils.path.escape(source);
      }
      FastGlob2.escapePath = escapePath;
      function convertPathToPattern(source) {
        assertPatternsInput(source);
        return utils.path.convertPathToPattern(source);
      }
      FastGlob2.convertPathToPattern = convertPathToPattern;
      let posix;
      (function(posix2) {
        function escapePath2(source) {
          assertPatternsInput(source);
          return utils.path.escapePosixPath(source);
        }
        posix2.escapePath = escapePath2;
        function convertPathToPattern2(source) {
          assertPatternsInput(source);
          return utils.path.convertPosixPathToPattern(source);
        }
        posix2.convertPathToPattern = convertPathToPattern2;
      })(posix = FastGlob2.posix || (FastGlob2.posix = {}));
      let win32;
      (function(win322) {
        function escapePath2(source) {
          assertPatternsInput(source);
          return utils.path.escapeWindowsPath(source);
        }
        win322.escapePath = escapePath2;
        function convertPathToPattern2(source) {
          assertPatternsInput(source);
          return utils.path.convertWindowsPathToPattern(source);
        }
        win322.convertPathToPattern = convertPathToPattern2;
      })(win32 = FastGlob2.win32 || (FastGlob2.win32 = {}));
    })(FastGlob || (FastGlob = {}));
    function getWorks(source, _Provider, options) {
      const patterns = [].concat(source);
      const settings = new settings_1.default(options);
      const tasks = taskManager.generate(patterns, settings);
      const provider = new _Provider(settings);
      return tasks.map(provider.read, provider);
    }
    function assertPatternsInput(input) {
      const source = [].concat(input);
      const isValidSource = source.every((item) => utils.string.isString(item) && !utils.string.isEmpty(item));
      if (!isValidSource) {
        throw new TypeError("Patterns must be a string (non empty) or an array of strings");
      }
    }
    module.exports = FastGlob;
  }
});

// src/detect/source-dir-detector.ts
function extsFor(language) {
  return EXTENSIONS[language] ?? [];
}
function extsWithFallback(language, fallbackTsForJs) {
  const base = extsFor(language);
  if (language === "javascript" && fallbackTsForJs) {
    return [...base, "ts", "tsx"];
  }
  return base;
}
function isTestPath(language, path) {
  const segments = path.split("/");
  for (const seg of segments) {
    if (TEST_DIR_KEYWORDS.includes(seg)) return true;
  }
  const patterns = TEST_FILE_PATTERNS[language] ?? [];
  return patterns.some((re) => re.test(path));
}
function topSegment(rel) {
  const parts = rel.split("/");
  return parts.length > 1 ? parts[0] : ".";
}
function isInsideRoot(root, candidate) {
  return isContainedIn(root, candidate, { allowRoot: true });
}
function detectSourceDirs(projectRoot, languages, opts) {
  const fallbackTsForJs = opts?.fallbackTsForJs ?? false;
  const out = {};
  for (const lang of languages) {
    const exts = extsWithFallback(lang, fallbackTsForJs);
    if (exts.length === 0) continue;
    const patterns = exts.map((e) => `**/*.${e}`);
    let files;
    try {
      files = import_fast_glob.default.sync(patterns, {
        cwd: projectRoot,
        dot: false,
        ignore: IGNORE_PATTERNS,
        followSymbolicLinks: false,
        suppressErrors: true
      });
    } catch {
      files = [];
    }
    files = files.filter((f) => isInsideRoot(projectRoot, f));
    if (files.length === 0) {
      continue;
    }
    const sourceFiles = [];
    const testFiles = [];
    for (const f of files) {
      if (isTestPath(lang, f)) testFiles.push(f);
      else sourceFiles.push(f);
    }
    const srcCluster = /* @__PURE__ */ new Map();
    for (const f of sourceFiles) {
      const k = topSegment(f);
      srcCluster.set(k, (srcCluster.get(k) ?? 0) + 1);
    }
    const testCluster = /* @__PURE__ */ new Map();
    for (const f of testFiles) {
      const k = topSegment(f);
      testCluster.set(k, (testCluster.get(k) ?? 0) + 1);
    }
    const source_dirs = [];
    const test_dirs = [];
    const srcSorted = [...srcCluster.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    for (const [seg] of srcSorted) source_dirs.push(seg);
    const testSet = /* @__PURE__ */ new Set();
    for (const [seg] of testCluster.entries()) {
      if (TEST_DIR_KEYWORDS.includes(seg)) testSet.add(seg);
    }
    let testDirHits = [];
    try {
      testDirHits = import_fast_glob.default.sync(
        TEST_DIR_KEYWORDS.map((k) => `**/${k}/**/*.${exts[0]}`),
        {
          cwd: projectRoot,
          dot: false,
          ignore: IGNORE_PATTERNS,
          followSymbolicLinks: false,
          suppressErrors: true
        }
      );
    } catch {
      testDirHits = [];
    }
    const testPrefixes = /* @__PURE__ */ new Set();
    for (const f of testDirHits) {
      const segs = f.split("/");
      for (let i = 0; i < segs.length; i++) {
        if (TEST_DIR_KEYWORDS.includes(segs[i])) {
          testPrefixes.add(segs.slice(0, i + 1).join("/"));
          break;
        }
      }
    }
    for (const p of testPrefixes) testSet.add(p);
    for (const seg of testSet) test_dirs.push(seg);
    test_dirs.sort();
    const totalFiles = sourceFiles.length + testFiles.length;
    const testRatio = totalFiles === 0 ? 0 : testFiles.length / totalFiles;
    const hasDedicatedTestDir = test_dirs.length > 0;
    const colocated = !hasDedicatedTestDir && testFiles.length > 0 && testRatio < 0.3;
    if (colocated) {
      for (const s of source_dirs) if (!test_dirs.includes(s)) test_dirs.push(s);
    }
    out[lang] = {
      source_dirs,
      test_dirs,
      colocated,
      file_count: files.length
    };
  }
  return out;
}
var import_fast_glob, IGNORE_PATTERNS, EXTENSIONS, TEST_FILE_PATTERNS, TEST_DIR_KEYWORDS;
var init_source_dir_detector = __esm({
  "src/detect/source-dir-detector.ts"() {
    "use strict";
    init_safe_write();
    import_fast_glob = __toESM(require_out4(), 1);
    IGNORE_PATTERNS = [
      "**/node_modules/**",
      "**/.venv/**",
      "**/venv/**",
      "**/__pycache__/**",
      "**/dist/**",
      "**/build/**",
      "**/.build/**",
      "**/target/**",
      "**/.next/**",
      "**/.nuxt/**",
      "**/coverage/**",
      "**/.git/**",
      "**/.massu/**",
      "**/.turbo/**",
      "**/.cache/**",
      "**/.pytest_cache/**",
      "**/.mypy_cache/**",
      "**/DerivedData/**",
      "**/Pods/**",
      // Secret-ish patterns
      "**/.env",
      "**/.env.*",
      "**/*.pem",
      "**/*.key",
      "**/.aws/**",
      "**/.ssh/**",
      "**/credentials.json",
      "**/*.p12",
      "**/*.pfx"
    ];
    EXTENSIONS = {
      python: ["py"],
      typescript: ["ts", "tsx"],
      javascript: ["js", "jsx", "mjs", "cjs"],
      rust: ["rs"],
      swift: ["swift"],
      go: ["go"],
      java: ["java", "kt"],
      ruby: ["rb"],
      // Plan 1.5.1 — closing CR-39 init gap for Phoenix + ASP.NET projects.
      elixir: ["ex", "exs"],
      csharp: ["cs"]
    };
    TEST_FILE_PATTERNS = {
      python: [/_test\.py$/, /test_[^/]*\.py$/],
      typescript: [/\.test\.tsx?$/, /\.spec\.tsx?$/],
      javascript: [/\.test\.[mc]?jsx?$/, /\.spec\.[mc]?jsx?$/],
      rust: [/tests\/.*\.rs$/],
      swift: [/Tests\//],
      go: [/_test\.go$/],
      java: [/Test[^/]*\.(java|kt)$/, /[^/]*Test\.(java|kt)$/],
      ruby: [/_spec\.rb$/, /_test\.rb$/],
      // Phoenix/ExUnit canonical: `test/**_test.exs`. ASP.NET / xUnit
      // canonical: `*Tests.cs` or `*.Tests/...`.
      elixir: [/_test\.exs$/, /\/test\//],
      csharp: [/Tests?\.cs$/, /\.Tests?\//]
    };
    TEST_DIR_KEYWORDS = ["tests", "test", "__tests__", "spec", "specs"];
  }
});

// src/detect/monorepo-detector.ts
import { readFileSync as readFileSync17, existsSync as existsSync21, statSync as statSync6, lstatSync as lstatSync2, readdirSync as readdirSync5 } from "fs";
import { join as join15, relative as relative3 } from "path";
import { parse as parseYaml3 } from "yaml";
import { parse as parseToml2 } from "smol-toml";
function safeReadText(path) {
  try {
    if (!existsSync21(path)) return null;
    const ls = lstatSync2(path);
    if (ls.isSymbolicLink()) return null;
    const st = statSync6(path);
    if (!st.isFile()) return null;
    return readFileSync17(path, "utf-8");
  } catch {
    return null;
  }
}
function firstManifestIn(dir) {
  for (const m of MANIFEST_PRIORITY) {
    if (existsSync21(join15(dir, m))) return m;
  }
  return null;
}
function manifestName(dir, manifest) {
  try {
    if (manifest === "package.json") {
      const raw = safeReadText(join15(dir, "package.json"));
      if (!raw) return null;
      const pkg = JSON.parse(raw);
      return typeof pkg.name === "string" ? pkg.name : null;
    }
    if (manifest === "pyproject.toml") {
      const raw = safeReadText(join15(dir, "pyproject.toml"));
      if (!raw) return null;
      const toml = parseToml2(raw);
      const project = toml.project;
      if (project && typeof project.name === "string") return project.name;
      const tool = toml.tool;
      const poetry = tool?.poetry;
      if (poetry && typeof poetry.name === "string") return poetry.name;
      return null;
    }
    if (manifest === "Cargo.toml") {
      const raw = safeReadText(join15(dir, "Cargo.toml"));
      if (!raw) return null;
      const toml = parseToml2(raw);
      const pkg = toml.package;
      if (pkg && typeof pkg.name === "string") return pkg.name;
      return null;
    }
    if (manifest === "go.mod") {
      const raw = safeReadText(join15(dir, "go.mod"));
      if (!raw) return null;
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("module ")) return trimmed.slice(7).trim();
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}
function pkgFromDir(root, dir) {
  const m = firstManifestIn(dir);
  if (!m) return null;
  return {
    path: relative3(root, dir).split(/[/\\]/).join("/"),
    name: manifestName(dir, m),
    manifest: m
  };
}
function listSubdirs2(dir) {
  try {
    return readdirSync5(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !IGNORED_DIRS2.has(e.name)).map((e) => join15(dir, e.name));
  } catch {
    return [];
  }
}
function genericWorkspaces(root) {
  const out = [];
  for (const parent of CONVENTIONAL_WORKSPACE_PARENTS) {
    const p = join15(root, parent);
    if (!existsSync21(p)) continue;
    for (const sub of listSubdirs2(p)) {
      const pkg = pkgFromDir(root, sub);
      if (pkg) out.push(pkg);
    }
  }
  return out;
}
function detectYarnWorkspaces(root) {
  const raw = safeReadText(join15(root, "package.json"));
  if (!raw) return null;
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }
  const ws = pkg.workspaces;
  if (!ws) return null;
  const globs = Array.isArray(ws) ? ws.filter((x) => typeof x === "string") : typeof ws === "object" && ws !== null && Array.isArray(ws.packages) ? ws.packages.filter((x) => typeof x === "string") : [];
  if (globs.length === 0) return null;
  return expandWorkspaceGlobs(root, globs);
}
function detectPnpmWorkspaces(root) {
  const raw = safeReadText(join15(root, "pnpm-workspace.yaml"));
  if (!raw) return null;
  try {
    const parsed = parseYaml3(raw);
    const list = Array.isArray(parsed?.packages) ? parsed.packages.filter((x) => typeof x === "string") : [];
    return expandWorkspaceGlobs(root, list);
  } catch {
    return null;
  }
}
function expandWorkspaceGlobs(root, globs) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const pattern of globs) {
    const parts = pattern.split("/");
    if (parts.length === 2 && (parts[1] === "*" || parts[1] === "**")) {
      const parent = join15(root, parts[0]);
      if (!existsSync21(parent)) continue;
      for (const sub of listSubdirs2(parent)) {
        const pkg = pkgFromDir(root, sub);
        if (pkg && !seen.has(pkg.path)) {
          seen.add(pkg.path);
          out.push(pkg);
        }
      }
      continue;
    }
    const direct = join15(root, pattern);
    if (existsSync21(direct)) {
      const pkg = pkgFromDir(root, direct);
      if (pkg && !seen.has(pkg.path)) {
        seen.add(pkg.path);
        out.push(pkg);
      }
    }
  }
  return out;
}
function hasTurbo(root) {
  return existsSync21(join15(root, "turbo.json"));
}
function hasNx(root) {
  return existsSync21(join15(root, "nx.json"));
}
function hasLerna(root) {
  return existsSync21(join15(root, "lerna.json"));
}
function hasBazel(root) {
  return existsSync21(join15(root, "WORKSPACE")) || existsSync21(join15(root, "WORKSPACE.bazel")) || existsSync21(join15(root, "MODULE.bazel"));
}
function detectMonorepo(projectRoot) {
  const nested = [];
  const pnpm = detectPnpmWorkspaces(projectRoot);
  const yarn = detectYarnWorkspaces(projectRoot);
  let primary = "single";
  let primaryPackages = [];
  if (hasTurbo(projectRoot)) {
    primary = "turbo";
    primaryPackages = pnpm ?? yarn ?? genericWorkspaces(projectRoot);
    if (pnpm && pnpm.length) {
      nested.push({ type: "pnpm", packages: pnpm, nested: [] });
    } else if (yarn && yarn.length) {
      nested.push({ type: "yarn", packages: yarn, nested: [] });
    }
  } else if (hasNx(projectRoot)) {
    primary = "nx";
    primaryPackages = yarn ?? pnpm ?? genericWorkspaces(projectRoot);
    if (pnpm && pnpm.length) nested.push({ type: "pnpm", packages: pnpm, nested: [] });
    else if (yarn && yarn.length) nested.push({ type: "yarn", packages: yarn, nested: [] });
  } else if (hasLerna(projectRoot)) {
    primary = "lerna";
    primaryPackages = yarn ?? pnpm ?? genericWorkspaces(projectRoot);
  } else if (pnpm && pnpm.length) {
    primary = "pnpm";
    primaryPackages = pnpm;
  } else if (yarn && yarn.length) {
    primary = "yarn";
    primaryPackages = yarn;
  } else if (hasBazel(projectRoot)) {
    primary = "bazel";
    primaryPackages = genericWorkspaces(projectRoot);
  } else {
    const gen = genericWorkspaces(projectRoot);
    if (gen.length > 0) {
      primary = "generic";
      primaryPackages = gen;
    } else {
      primary = "single";
      primaryPackages = [];
    }
  }
  return { type: primary, packages: primaryPackages, nested };
}
var MANIFEST_PRIORITY, IGNORED_DIRS2, CONVENTIONAL_WORKSPACE_PARENTS;
var init_monorepo_detector = __esm({
  "src/detect/monorepo-detector.ts"() {
    "use strict";
    MANIFEST_PRIORITY = [
      "package.json",
      "pyproject.toml",
      "Cargo.toml",
      "go.mod",
      "build.gradle",
      "pom.xml",
      "Gemfile",
      "Package.swift"
    ];
    IGNORED_DIRS2 = /* @__PURE__ */ new Set([
      "node_modules",
      ".venv",
      "venv",
      "__pycache__",
      "dist",
      "build",
      ".build",
      "target",
      ".next",
      ".nuxt",
      "coverage",
      ".git",
      ".massu",
      ".turbo",
      ".cache"
    ]);
    CONVENTIONAL_WORKSPACE_PARENTS = [
      "apps",
      "packages",
      "services",
      "libs",
      "modules"
    ];
  }
});

// src/detect/vr-command-map.ts
function prefix(dir, cmd) {
  if (!dir || dir === ".") return cmd;
  return `cd ${dir} && ${cmd}`;
}
function defaultsFor(language, fw, dir) {
  switch (language) {
    case "python": {
      const testFw = fw.test_framework ?? "pytest";
      return {
        test: testFw === "unittest" ? prefix(dir, "python3 -m unittest") : prefix(dir, "python3 -m pytest -q"),
        type: prefix(dir, "python3 -m mypy ."),
        build: null,
        syntax: prefix(dir, "python3 -m py_compile"),
        lint: prefix(dir, "python3 -m ruff check .")
      };
    }
    case "typescript": {
      const testFw = fw.test_framework ?? "vitest";
      return {
        test: prefix(dir, "npm test"),
        type: prefix(dir, "npx tsc --noEmit"),
        build: prefix(dir, "npm run build"),
        syntax: null,
        lint: prefix(dir, "npx eslint ."),
        // testFw currently only affects defaults; npm test is runner-agnostic
        ...testFw === "mocha" ? { test: prefix(dir, "npx mocha") } : {}
      };
    }
    case "javascript": {
      return {
        test: prefix(dir, "npm test"),
        type: null,
        build: prefix(dir, "npm run build"),
        syntax: null,
        lint: prefix(dir, "npx eslint .")
      };
    }
    case "rust": {
      return {
        test: prefix(dir, "cargo test"),
        type: prefix(dir, "cargo check"),
        build: prefix(dir, "cargo build"),
        syntax: null,
        lint: prefix(dir, "cargo clippy -- -D warnings")
      };
    }
    case "swift": {
      return {
        test: prefix(dir, "swift test"),
        type: prefix(dir, "swift build"),
        build: prefix(dir, "xcodebuild build"),
        syntax: null,
        lint: prefix(dir, "swiftlint")
      };
    }
    case "go": {
      return {
        test: prefix(dir, "go test ./..."),
        type: prefix(dir, "go vet ./..."),
        build: prefix(dir, "go build ./..."),
        syntax: null,
        lint: prefix(dir, "golangci-lint run")
      };
    }
    case "java": {
      return {
        test: prefix(dir, "mvn test"),
        type: prefix(dir, "mvn compile"),
        build: prefix(dir, "mvn package"),
        syntax: null,
        lint: null
      };
    }
    case "ruby": {
      return {
        test: prefix(dir, "bundle exec rspec"),
        type: null,
        build: null,
        syntax: prefix(dir, "ruby -c"),
        lint: prefix(dir, "bundle exec rubocop")
      };
    }
    default:
      return { test: null, type: null, build: null, syntax: null, lint: null };
  }
}
function getVRCommands(language, framework, dir, userOverrides) {
  const built = defaultsFor(language, framework, dir);
  if (!userOverrides) return built;
  return {
    test: userOverrides.test ?? built.test,
    type: userOverrides.type ?? built.type,
    build: userOverrides.build ?? built.build,
    syntax: userOverrides.syntax ?? built.syntax,
    lint: userOverrides.lint ?? built.lint
  };
}
var init_vr_command_map = __esm({
  "src/detect/vr-command-map.ts"() {
    "use strict";
  }
});

// src/detect/domain-inferrer.ts
import { existsSync as existsSync22, readdirSync as readdirSync6 } from "fs";
import { join as join16 } from "path";
function titleCase(s) {
  if (!s) return s;
  return s.split(/[-_\s]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}
function domainFromWorkspace(pkg) {
  const pathTail = pkg.path.split("/").pop() ?? pkg.path;
  const name = pkg.name ?? titleCase(pathTail);
  return {
    name,
    routers: [],
    pages: [],
    tables: [],
    allowedImportsFrom: []
  };
}
function topLevelSrcSubdirs(root, sourceDirs) {
  const effective = sourceDirs.length > 0 ? sourceDirs : ["src"];
  const seen = /* @__PURE__ */ new Set();
  for (const rel of effective) {
    const abs = join16(root, rel);
    if (!existsSync22(abs)) continue;
    try {
      for (const e of readdirSync6(abs, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (IGNORED_SUBDIRS.has(e.name)) continue;
        seen.add(e.name);
      }
    } catch {
    }
  }
  return Array.from(seen).sort();
}
function flattenSourceDirs(sourceDirs) {
  const flat = /* @__PURE__ */ new Set();
  for (const entry of Object.values(sourceDirs)) {
    if (!entry) continue;
    for (const dir of entry.source_dirs) {
      if (dir === "." || dir === "") continue;
      flat.add(dir);
    }
  }
  return Array.from(flat);
}
function inferDomains(projectRoot, monorepo, sourceDirs) {
  const domains = [];
  if (monorepo.type !== "single" && monorepo.packages.length > 0) {
    for (const pkg of monorepo.packages) {
      domains.push(domainFromWorkspace(pkg));
    }
  } else {
    const flat = flattenSourceDirs(sourceDirs);
    const subdirs = topLevelSrcSubdirs(projectRoot, flat);
    for (const s of subdirs) {
      domains.push({
        name: titleCase(s),
        routers: [],
        pages: [],
        tables: [],
        allowedImportsFrom: []
      });
    }
    if (domains.length === 0) {
      const langs = Object.keys(sourceDirs);
      for (const lang of langs.sort()) {
        domains.push({
          name: titleCase(lang),
          routers: [],
          pages: [],
          tables: [],
          allowedImportsFrom: []
        });
      }
    }
  }
  domains.sort((a, b) => a.name.localeCompare(b.name));
  const seen = /* @__PURE__ */ new Set();
  const dedup = [];
  for (const d of domains) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    dedup.push(d);
  }
  return dedup;
}
var IGNORED_SUBDIRS;
var init_domain_inferrer = __esm({
  "src/detect/domain-inferrer.ts"() {
    "use strict";
    IGNORED_SUBDIRS = /* @__PURE__ */ new Set([
      "node_modules",
      "__pycache__",
      "dist",
      "build",
      ".build",
      "target",
      ".next",
      ".git",
      ".massu",
      "coverage",
      "tests",
      "test",
      "__tests__"
    ]);
  }
});

// src/detect/regex-fallback.ts
import { existsSync as existsSync23, readdirSync as readdirSync7, readFileSync as readFileSync18, statSync as statSync7 } from "fs";
import { resolve as resolve8, join as join17, basename as basename4 } from "path";
function introspectPython(detection, projectRoot) {
  const sourceDir = resolveSourceDir(detection, "python", projectRoot);
  if (!sourceDir) return null;
  const routerFiles = sampleFiles(
    sourceDir,
    /\.py$/,
    (absPath, name) => /\/(routers?|api|endpoints?|views)\//.test(absPath) || /^(routers?|api|endpoints?)\.py$/.test(name)
  );
  const viewFiles = sampleFiles(sourceDir, /^views\.py$/);
  const fallbackFiles = routerFiles.length === 0 && viewFiles.length === 0 ? sampleFiles(sourceDir, /\.py$/) : [];
  const candidates = [...routerFiles, ...viewFiles, ...fallbackFiles].slice(
    0,
    MAX_SAMPLES_PER_ADAPTER
  );
  if (candidates.length === 0) return null;
  const authDeps = /* @__PURE__ */ new Map();
  const prefixBases = /* @__PURE__ */ new Map();
  const testAsyncPatterns = /* @__PURE__ */ new Map();
  for (const path of candidates) {
    const body = readSafe(path);
    if (body === null) continue;
    const authRegex = new RegExp(PY_AUTH_DEP_PATTERN, "gu");
    forEachMatch(authRegex, body, (m) => {
      const name = m[1];
      if (!authDeps.has(name)) authDeps.set(name, path);
    });
    const djangoAuthRegex = new RegExp(PY_DJANGO_AUTH_PATTERN, "gmu");
    forEachMatch(djangoAuthRegex, body, (m) => {
      const name = m[1];
      if (!authDeps.has(name)) authDeps.set(name, path);
    });
    const prefixRegex = new RegExp(PY_API_PREFIX_PATTERN, "gu");
    forEachMatch(prefixRegex, body, (m) => {
      const fullPrefix = m[1];
      const base = extractPrefixBase(fullPrefix);
      if (base && !prefixBases.has(base)) prefixBases.set(base, path);
    });
    const asyncRegex = new RegExp(PY_TEST_ASYNC_PATTERN, "gmu");
    forEachMatch(asyncRegex, body, (m) => {
      const pat = m[1].trim();
      if (!testAsyncPatterns.has(pat)) testAsyncPatterns.set(pat, path);
    });
  }
  const authDep = pickBestSingleton(authDeps);
  const apiPrefixBase = pickBestSingleton(prefixBases);
  const testAsyncPattern = pickBestSingleton(testAsyncPatterns);
  const result = {};
  const provenance = {};
  if (authDep) {
    result.auth_dep = authDep.value;
    provenance.auth_dep_source = relativeTo(projectRoot, authDep.source);
  }
  if (apiPrefixBase) {
    result.api_prefix_base = apiPrefixBase.value;
    provenance.api_prefix_base_source = relativeTo(projectRoot, apiPrefixBase.source);
  }
  if (testAsyncPattern) {
    result.test_async_pattern = testAsyncPattern.value;
    provenance.test_async_pattern_source = relativeTo(projectRoot, testAsyncPattern.source);
  }
  if (Object.keys(result).length === 0) return null;
  if (Object.keys(provenance).length > 0) result._provenance = provenance;
  return result;
}
function extractPrefixBase(prefix2) {
  if (!prefix2.startsWith("/")) return null;
  const stripped = prefix2.replace(/^\/+/, "");
  const firstSeg = stripped.split("/")[0];
  if (!firstSeg) return null;
  return "/" + firstSeg;
}
function introspectSwift(detection, projectRoot) {
  const sourceDir = resolveSourceDir(detection, "swift", projectRoot);
  if (!sourceDir) return null;
  const viewFiles = sampleFiles(
    sourceDir,
    /\.swift$/,
    (absPath, name) => /View\.swift$/.test(name) || /\/Views\//.test(absPath)
  );
  const fallbackFiles = viewFiles.length === 0 ? sampleFiles(sourceDir, /\.swift$/) : [];
  const candidates = [...viewFiles, ...fallbackFiles].slice(
    0,
    MAX_SAMPLES_PER_ADAPTER
  );
  if (candidates.length === 0) return null;
  const apiClasses = /* @__PURE__ */ new Map();
  const biometricPolicies = /* @__PURE__ */ new Map();
  for (const path of candidates) {
    const body = readSafe(path);
    if (body === null) continue;
    const apiRegex = /\b([A-Z][A-Za-z0-9_]*API)\s*(?:\(|\.shared|\b)/gu;
    forEachMatch(apiRegex, body, (m) => {
      const name = m[1];
      if (!apiClasses.has(name)) apiClasses.set(name, path);
    });
    const policyRegex = /\.(deviceOwnerAuthentication(?:WithBiometrics)?)\b/gu;
    forEachMatch(policyRegex, body, (m) => {
      const name = m[1];
      if (!biometricPolicies.has(name)) biometricPolicies.set(name, path);
    });
  }
  const apiClass = pickBestSingleton(apiClasses);
  const biometricPolicy = pickBestSingleton(biometricPolicies);
  const result = {};
  const provenance = {};
  if (apiClass) {
    result.api_client_class = apiClass.value;
    provenance.api_client_class_source = relativeTo(projectRoot, apiClass.source);
  }
  if (biometricPolicy) {
    result.biometric_policy = biometricPolicy.value;
    provenance.biometric_policy_source = relativeTo(projectRoot, biometricPolicy.source);
  }
  if (Object.keys(result).length === 0) return null;
  if (Object.keys(provenance).length > 0) result._provenance = provenance;
  return result;
}
function introspectTypeScript(detection, projectRoot) {
  const sourceDir = resolveSourceDir(detection, "typescript", projectRoot) ?? resolveSourceDir(detection, "javascript", projectRoot);
  if (!sourceDir) return null;
  const routerFiles = sampleFiles(
    sourceDir,
    /\.tsx?$/,
    (absPath, name) => /(router|trpc)/i.test(name) || /\/(routers|trpc|server\/api)\//.test(absPath)
  );
  const candidates = routerFiles.slice(0, MAX_SAMPLES_PER_ADAPTER);
  if (candidates.length === 0) return null;
  const builders = /* @__PURE__ */ new Map();
  const procedurePatterns = /* @__PURE__ */ new Map();
  for (const path of candidates) {
    const body = readSafe(path);
    if (body === null) continue;
    const builderRegex = /\b(createTRPCRouter|router|t\.router)\s*\(/gu;
    forEachMatch(builderRegex, body, (m) => {
      const name = m[1];
      if (!builders.has(name)) builders.set(name, path);
    });
    const procRegex = /\b([a-z]+Procedure)\b/gu;
    forEachMatch(procRegex, body, (m) => {
      const name = m[1];
      if (!procedurePatterns.has(name)) procedurePatterns.set(name, path);
    });
  }
  const builder = pickBestSingleton(builders);
  const proc = pickBestSingleton(procedurePatterns);
  const result = {};
  const provenance = {};
  if (builder) {
    result.trpc_router_builder = builder.value;
    provenance.trpc_router_builder_source = relativeTo(projectRoot, builder.source);
  }
  if (proc) {
    result.procedure_pattern = proc.value;
    provenance.procedure_pattern_source = relativeTo(projectRoot, proc.source);
  }
  if (Object.keys(result).length === 0) return null;
  if (Object.keys(provenance).length > 0) result._provenance = provenance;
  return result;
}
function resolveSourceDir(detection, lang, projectRoot) {
  const dirs = detection.sourceDirs;
  const info = dirs[lang];
  const list = info?.source_dirs ?? [];
  if (list.length > 0) {
    const first = list[0];
    const abs = resolve8(projectRoot, first);
    return existsSync23(abs) ? abs : null;
  }
  return existsSync23(projectRoot) ? projectRoot : null;
}
function sampleFiles(dir, nameRegex, pathFilter) {
  const out = [];
  const stack = [{ path: dir, depth: 0 }];
  while (stack.length > 0 && out.length < MAX_SAMPLES_PER_ADAPTER * 4) {
    const { path, depth } = stack.pop();
    if (depth > MAX_DIR_DEPTH) continue;
    let entries;
    try {
      entries = readdirSync7(path);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (entry === "node_modules") continue;
      if (entry === "__pycache__") continue;
      if (entry === "venv" || entry === ".venv") continue;
      if (entry === "dist" || entry === "build") continue;
      const child = join17(path, entry);
      let st;
      try {
        st = statSync7(child);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push({ path: child, depth: depth + 1 });
        continue;
      }
      if (!nameRegex.test(entry)) continue;
      if (pathFilter && !pathFilter(child, entry)) continue;
      if (st.size > MAX_FILE_BYTES) continue;
      out.push(child);
      if (out.length >= MAX_SAMPLES_PER_ADAPTER * 4) break;
    }
  }
  out.sort();
  return out.slice(0, MAX_SAMPLES_PER_ADAPTER * 2);
}
function readSafe(path) {
  try {
    const st = statSync7(path);
    if (st.size > MAX_FILE_BYTES) return null;
    return readFileSync18(path, "utf-8");
  } catch {
    return null;
  }
}
function forEachMatch(re, body, cb) {
  if (!re.global) return;
  re.lastIndex = 0;
  let count = 0;
  let m;
  while ((m = re.exec(body)) !== null) {
    cb(m);
    count++;
    if (count > 1e3) break;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
}
function pickBestSingleton(samples) {
  if (samples.size === 0) return null;
  if (samples.size >= 3) return null;
  const [firstKey, firstSource] = samples.entries().next().value;
  return { value: firstKey, source: firstSource };
}
function relativeTo(projectRoot, absPath) {
  if (absPath.startsWith(projectRoot + "/")) {
    return absPath.slice(projectRoot.length + 1);
  }
  return basename4(absPath);
}
var PY_AUTH_DEP_PATTERN, PY_DJANGO_AUTH_PATTERN, PY_API_PREFIX_PATTERN, PY_TEST_ASYNC_PATTERN, MAX_FILE_BYTES, MAX_SAMPLES_PER_ADAPTER, MAX_DIR_DEPTH;
var init_regex_fallback = __esm({
  "src/detect/regex-fallback.ts"() {
    "use strict";
    PY_AUTH_DEP_PATTERN = String.raw`\bDepends\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)`;
    PY_DJANGO_AUTH_PATTERN = String.raw`^@\s*([a-z_][a-z0-9_]*(?:_required|_login))\b`;
    PY_API_PREFIX_PATTERN = String.raw`\bAPIRouter\s*\(\s*[^)]*?prefix\s*=\s*["']([^"']+)["']`;
    PY_TEST_ASYNC_PATTERN = String.raw`^(@pytest\.mark\.asyncio(?:\s*\([^)]*\))?)`;
    MAX_FILE_BYTES = 256 * 1024;
    MAX_SAMPLES_PER_ADAPTER = 3;
    MAX_DIR_DEPTH = 6;
  }
});

// src/detect/adapters/parse-guard.ts
var MAX_AST_FILE_BYTES;
var init_parse_guard = __esm({
  "src/detect/adapters/parse-guard.ts"() {
    "use strict";
    MAX_AST_FILE_BYTES = 1 * 1024 * 1024;
  }
});

// src/detect/adapters/runner.ts
var init_runner = __esm({
  "src/detect/adapters/runner.ts"() {
    "use strict";
    init_parse_guard();
  }
});

// src/detect/adapters/query-helpers.ts
import { Query } from "web-tree-sitter";
var init_query_helpers = __esm({
  "src/detect/adapters/query-helpers.ts"() {
    "use strict";
  }
});

// src/detect/adapters/tree-sitter-loader.ts
import { Language, Parser } from "web-tree-sitter";
var init_tree_sitter_loader = __esm({
  "src/detect/adapters/tree-sitter-loader.ts"() {
    "use strict";
  }
});

// src/detect/adapters/python-fastapi.ts
import { Parser as Parser2 } from "web-tree-sitter";
var init_python_fastapi = __esm({
  "src/detect/adapters/python-fastapi.ts"() {
    "use strict";
    init_query_helpers();
    init_tree_sitter_loader();
    init_parse_guard();
  }
});

// src/detect/adapters/python-django.ts
import { Parser as Parser3 } from "web-tree-sitter";
var init_python_django = __esm({
  "src/detect/adapters/python-django.ts"() {
    "use strict";
    init_query_helpers();
    init_tree_sitter_loader();
    init_parse_guard();
  }
});

// src/detect/adapters/nextjs-trpc.ts
import { Parser as Parser4 } from "web-tree-sitter";
var init_nextjs_trpc = __esm({
  "src/detect/adapters/nextjs-trpc.ts"() {
    "use strict";
    init_query_helpers();
    init_tree_sitter_loader();
    init_parse_guard();
  }
});

// src/detect/adapters/swift-swiftui.ts
import { Parser as Parser5 } from "web-tree-sitter";
var init_swift_swiftui = __esm({
  "src/detect/adapters/swift-swiftui.ts"() {
    "use strict";
    init_query_helpers();
    init_tree_sitter_loader();
    init_parse_guard();
  }
});

// src/detect/adapters/python-flask.ts
import { Parser as Parser6 } from "web-tree-sitter";
var init_python_flask = __esm({
  "src/detect/adapters/python-flask.ts"() {
    "use strict";
    init_query_helpers();
    init_tree_sitter_loader();
    init_parse_guard();
  }
});

// src/detect/adapters/rails.ts
import { railsAdapter } from "@massu/adapter-rails";
var init_rails = __esm({
  "src/detect/adapters/rails.ts"() {
    "use strict";
  }
});

// src/detect/adapters/spring.ts
import { springAdapter } from "@massu/adapter-spring";
var init_spring = __esm({
  "src/detect/adapters/spring.ts"() {
    "use strict";
  }
});

// src/detect/codebase-introspector.ts
function introspect(detection, projectRoot) {
  const out = {};
  const languages = Array.from(
    new Set(detection.manifests.map((m) => m.language))
  );
  if (languages.includes("python")) {
    const python = introspectPython(detection, projectRoot);
    if (python !== null) out.python = python;
  }
  if (languages.includes("swift")) {
    const swift = introspectSwift(detection, projectRoot);
    if (swift !== null) out.swift = swift;
  }
  if (languages.includes("typescript") || languages.includes("javascript")) {
    const ts = introspectTypeScript(detection, projectRoot);
    if (ts !== null) out.typescript = ts;
  }
  return out;
}
var init_codebase_introspector = __esm({
  "src/detect/codebase-introspector.ts"() {
    "use strict";
    init_regex_fallback();
    init_runner();
    init_python_fastapi();
    init_python_django();
    init_nextjs_trpc();
    init_swift_swiftui();
    init_python_flask();
    init_rails();
    init_spring();
  }
});

// src/detect/index.ts
var detect_exports = {};
__export(detect_exports, {
  runDetection: () => runDetection
});
function dominantDir(lang, sourceDirs, monorepo) {
  const info = sourceDirs[lang];
  if (info && info.source_dirs.length > 0) return info.source_dirs[0];
  if (monorepo.packages.length > 0) return monorepo.packages[0].path;
  return ".";
}
async function runDetection(projectRoot, overrides, options) {
  const pkg = detectPackageManifests(projectRoot);
  const frameworks = detectFrameworks(pkg.manifests, overrides?.detection);
  const languages = Array.from(
    new Set(pkg.manifests.map((m) => m.language))
  );
  const fallbackTsForJs = languages.includes("javascript") && !languages.includes("typescript");
  const [sourceDirs, monorepo] = await Promise.all([
    Promise.resolve(detectSourceDirs(projectRoot, languages, { fallbackTsForJs })),
    Promise.resolve(detectMonorepo(projectRoot))
  ]);
  const domains = inferDomains(projectRoot, monorepo, sourceDirs);
  const verificationCommands = {};
  for (const lang of languages) {
    const fw = frameworks[lang] ?? {
      framework: null,
      version: null,
      test_framework: null,
      orm: null,
      ui_library: null,
      router: null
    };
    const dir = dominantDir(lang, sourceDirs, monorepo);
    const userOverride = overrides?.verification?.[lang];
    verificationCommands[lang] = getVRCommands(lang, fw, dir, userOverride);
  }
  const result = {
    projectRoot,
    manifests: pkg.manifests,
    frameworks,
    sourceDirs,
    monorepo,
    domains,
    verificationCommands,
    warnings: pkg.warnings
  };
  if (!options?.skipIntrospect) {
    result.detected = introspect(result, projectRoot);
  }
  return result;
}
var init_detect = __esm({
  "src/detect/index.ts"() {
    "use strict";
    init_package_detector();
    init_framework_detector();
    init_source_dir_detector();
    init_monorepo_detector();
    init_vr_command_map();
    init_domain_inferrer();
    init_codebase_introspector();
  }
});

// src/detect/drift.ts
var drift_exports = {};
__export(drift_exports, {
  computeFingerprint: () => computeFingerprint,
  detectDrift: () => detectDrift
});
import { createHash as createHash6 } from "crypto";
function summarizeDetection(det) {
  const languages = Array.from(new Set(det.manifests.map((m) => m.language))).sort();
  const frameworks = {};
  for (const lang of languages) {
    const fw = det.frameworks[lang];
    frameworks[lang] = {
      framework: fw?.framework ?? null,
      test_framework: fw?.test_framework ?? null,
      orm: fw?.orm ?? null
    };
  }
  const sourceDirs = {};
  for (const lang of languages) {
    const info = det.sourceDirs[lang];
    sourceDirs[lang] = [...info?.source_dirs ?? []].sort();
  }
  const manifests = [...det.manifests.map((m) => m.relativePath)].sort();
  const workspaces = [...det.monorepo.packages.map((p) => p.path)].sort();
  return {
    languages,
    frameworks,
    source_dirs: sourceDirs,
    manifests,
    monorepo: det.monorepo.type,
    workspaces
  };
}
function computeFingerprint(det) {
  const data = summarizeDetection(det);
  const stable = JSON.stringify(data, Object.keys(data).sort());
  return createHash6("sha256").update(stable).digest("hex");
}
function stringOf(v) {
  if (typeof v === "string") return v;
  if (v === null || v === void 0) return null;
  return String(v);
}
function detectDrift(currentConfig, actualDetection) {
  const changes = [];
  const configFw = currentConfig.framework && typeof currentConfig.framework === "object" ? currentConfig.framework : {};
  const configLanguages = configFw.languages && typeof configFw.languages === "object" ? configFw.languages : {};
  const detectedLanguages = Array.from(
    new Set(actualDetection.manifests.map((m) => m.language))
  );
  const configLangKeys = Object.keys(configLanguages).sort();
  const detectedLangKeys = [...detectedLanguages].sort();
  if (JSON.stringify(configLangKeys) !== JSON.stringify(detectedLangKeys)) {
    changes.push({
      field: "framework.languages",
      before: configLangKeys,
      after: detectedLangKeys
    });
  }
  for (const lang of detectedLanguages) {
    const detFw = actualDetection.frameworks[lang];
    const cfgEntry = configLanguages[lang];
    if (!cfgEntry) continue;
    const cfgFramework = stringOf(cfgEntry.framework);
    const detFramework = detFw?.framework ?? null;
    if (cfgFramework !== detFramework && detFramework !== null) {
      changes.push({
        field: `framework.languages.${lang}.framework`,
        before: cfgFramework,
        after: detFramework
      });
    }
    const cfgTest = stringOf(cfgEntry.test_framework);
    const detTest = detFw?.test_framework ?? null;
    if (cfgTest !== detTest && detTest !== null) {
      changes.push({
        field: `framework.languages.${lang}.test_framework`,
        before: cfgTest,
        after: detTest
      });
    }
  }
  const detectedManifestPaths = new Set(actualDetection.manifests.map((m) => m.relativePath));
  const declaredManifestPaths = /* @__PURE__ */ new Set();
  const canonical2 = currentConfig.canonical_paths;
  if (canonical2 && typeof canonical2.manifest_paths === "string") {
    for (const p of canonical2.manifest_paths.split(",").map((s) => s.trim())) {
      if (p) declaredManifestPaths.add(p);
    }
  }
  if (Array.isArray(currentConfig.manifests)) {
    for (const p of currentConfig.manifests) {
      if (typeof p === "string") declaredManifestPaths.add(p);
    }
  }
  if (declaredManifestPaths.size > 0) {
    const added = [...detectedManifestPaths].filter((p) => !declaredManifestPaths.has(p)).sort();
    const removed = [...declaredManifestPaths].filter((p) => !detectedManifestPaths.has(p)).sort();
    if (added.length > 0) {
      changes.push({ field: "manifests.added", before: [], after: added });
    }
    if (removed.length > 0) {
      changes.push({ field: "manifests.removed", before: removed, after: [] });
    }
  }
  const configWorkspaces = [];
  if (Array.isArray(currentConfig.monorepo?.workspaces)) {
    for (const w of currentConfig.monorepo.workspaces) {
      if (typeof w === "string") configWorkspaces.push(w);
    }
  }
  const detectedWorkspaces = actualDetection.monorepo.packages.map((p) => p.path).sort();
  if (configWorkspaces.length > 0) {
    const cfgSorted = [...configWorkspaces].sort();
    if (JSON.stringify(cfgSorted) !== JSON.stringify(detectedWorkspaces)) {
      changes.push({
        field: "monorepo.workspaces",
        before: cfgSorted,
        after: detectedWorkspaces
      });
    }
  }
  return { drifted: changes.length > 0, changes };
}
var init_drift = __esm({
  "src/detect/drift.ts"() {
    "use strict";
  }
});

// src/hooks/session-start.ts
init_memory_db();

// src/team-rule-sync.ts
import { existsSync as existsSync13, writeFileSync as writeFileSync6, unlinkSync as unlinkSync4, mkdirSync as mkdirSync8 } from "fs";
import { homedir as homedir6 } from "os";
import { join as join7, dirname as dirname10 } from "path";

// src/security/promotion-apply-mac.ts
init_memory_authorship();
import { createHmac as createHmac2, timingSafeEqual as timingSafeEqual2 } from "crypto";
import { homedir as homedir5 } from "os";
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
var TEAM_SHARED_PROMOTION_MIN_TIER = "team";
function entitledForTeamSharedPromotion(tier) {
  return tierLevel(tier) >= tierLevel(TEAM_SHARED_PROMOTION_MIN_TIER);
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

// src/rule-candidate-applier.ts
init_safe_write();

// src/lib/corrections-md.ts
var CORRECTION_RULE_BULLET = /^-\s+\*\*Rule\*\*:\s*(.+)$/;
function parseCorrectionRules(content) {
  const rules = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    const m = line.match(CORRECTION_RULE_BULLET);
    if (m && m[1].trim()) {
      rules.push(m[1].trim());
      continue;
    }
    if (line.startsWith("|") && line.endsWith("|")) {
      const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
      if (cells.length < 4) continue;
      if (cells[0] === "Date" || cells[0].startsWith("-")) continue;
      const prevention = cells[3];
      if (prevention && !prevention.startsWith("-") && !prevention.startsWith("<!--")) {
        rules.push(prevention);
      }
    }
  }
  return rules;
}

// src/rule-candidate-applier.ts
init_memory_authorship();
init_memory_index_region();
init_config();
init_memory_path();

// src/audit-trail.ts
init_config();

// src/rule-candidate-applier.ts
init_memory_db();
init_memory_origin();

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
init_rule_candidate_snapshot();
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
    if (existsSync13(candidatePath) || alreadyApplied(db, p.prompt_hash)) {
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
  return join7(projectRoot, ".massu", "rule-candidates", `${promptHash}.json`);
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
  if (existsSync13(candidatePath)) {
    try {
      unlinkSync4(candidatePath);
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
  if (!existsSync13(dir)) mkdirSync8(dir, { recursive: true });
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

// src/hooks/session-start.ts
init_memory_file_ingest();
init_config();
init_db_driver();
import { readFileSync as readFileSync19, existsSync as existsSync24 } from "fs";
import { join as join18, resolve as resolve9 } from "path";
import { parse as parseYaml4 } from "yaml";

// src/capability-advisor.ts
import { createHash as createHash4 } from "crypto";
import { existsSync as existsSync15, mkdirSync as mkdirSync9, readFileSync as readFileSync11, writeFileSync as writeFileSync7 } from "fs";
import { homedir as homedir7 } from "os";
import { dirname as dirname11, join as join9 } from "path";
function advisorStatePath(home = homedir7()) {
  return join9(home, ".massu", "advisor-state.json");
}
function readAdvisorState(home) {
  try {
    const p = advisorStatePath(home);
    if (!existsSync15(p)) return {};
    return JSON.parse(readFileSync11(p, "utf-8"));
  } catch {
    return {};
  }
}
function writeAdvisorState(state, home) {
  try {
    const p = advisorStatePath(home);
    mkdirSync9(dirname11(p), { recursive: true });
    writeFileSync7(p, JSON.stringify(state, null, 2), { mode: 384 });
  } catch {
  }
}
function fingerprintOf(parts) {
  return createHash4("sha256").update([...parts].sort().join("|")).digest("hex").slice(0, 16);
}
function shouldShow(input) {
  const entry = input.state[input.advisorId];
  if (!entry) return true;
  if (entry.dismissed) return false;
  if (entry.configured_at) return false;
  if (entry.last_fingerprint !== input.fingerprint) return true;
  if (!entry.last_shown_epoch) return true;
  const elapsedDays = (input.nowEpochSec - entry.last_shown_epoch) / 86400;
  return elapsedDays >= input.suggestIntervalDays;
}
function markShown(state, advisorId, fingerprint, nowEpochSec) {
  return {
    ...state,
    [advisorId]: {
      ...state[advisorId] ?? {},
      last_shown_epoch: nowEpochSec,
      last_fingerprint: fingerprint
    }
  };
}
async function runAdvisors(advisors, opts) {
  if (!opts.enabled) return "";
  const now = opts.nowEpochSec ?? Math.floor(Date.now() / 1e3);
  let state = readAdvisorState(opts.home);
  const blocks = [];
  for (const advisor of advisors) {
    try {
      if (advisor.isConfigured()) continue;
      const detection = await advisor.detect();
      if (!detection) continue;
      if (!shouldShow({
        state,
        advisorId: advisor.id,
        fingerprint: detection.fingerprint,
        nowEpochSec: now,
        suggestIntervalDays: opts.suggestIntervalDays
      })) {
        continue;
      }
      blocks.push(detection.render());
      state = markShown(state, advisor.id, detection.fingerprint, now);
    } catch {
    }
  }
  if (blocks.length === 0) return "";
  writeAdvisorState(state, opts.home);
  return blocks.join("\n\n");
}

// src/advisors/local-model-advisor.ts
init_consolidation_config();
var LOCAL_MODEL_ADVISOR_ID = "local-model-summaries";
var LOCAL_MODEL_REMEDY_KEYS = ["llmEndpoint", "llmModel"];
var CANDIDATE_ENDPOINTS = [
  { url: "http://localhost:11434", label: "Ollama" },
  { url: "http://localhost:1234", label: "LM Studio" },
  { url: "http://localhost:8300", label: "local OpenAI-compatible server" },
  { url: "http://localhost:8080", label: "local OpenAI-compatible server" }
];
var PROBE_BUDGET_MS = 800;
async function fetchJson(url, budgetMs) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) return null;
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
async function detectLocalModel(endpoints = CANDIDATE_ENDPOINTS, budgetMs = PROBE_BUDGET_MS) {
  for (const cand of endpoints) {
    const tags = await fetchJson(`${cand.url}/api/tags`, budgetMs);
    const ollamaModels = (tags?.models ?? []).map((m) => m?.name).filter((n) => typeof n === "string" && n.length > 0);
    if (ollamaModels.length > 0) {
      return { endpoint: cand.url, label: cand.label, models: ollamaModels };
    }
    const v1 = await fetchJson(`${cand.url}/v1/models`, budgetMs);
    const v1Models = (v1?.data ?? []).map((m) => m?.id).filter((n) => typeof n === "string" && n.length > 0);
    if (v1Models.length > 0) {
      return { endpoint: cand.url, label: cand.label, models: v1Models };
    }
  }
  return null;
}
function renderLocalModelOffer(finding) {
  const model = finding.models[0];
  const more = finding.models.length > 1 ? ` (and ${finding.models.length - 1} more)` : "";
  return [
    "\u{1F4A1} **Massu found a local AI model on your machine \u2014 you can make your memory noticeably better, for free.**",
    "",
    `**What I found:** ${finding.label} at \`${finding.endpoint}\`, running \`${model}\`${more}.`,
    "",
    "**What Massu does today (without it):** every few days, just before your raw chat transcripts are deleted, Massu distills each session into one permanent lesson. Right now it builds that lesson by *selecting* the most important lines that already exist. Nothing is invented, but it reads like clipped notes:",
    "",
    '> *"Login hangs with no terminal. Failed attempt: fail-fast on non-TTY \u2014 broke `echo key | massu login`. Fix: bounded 2s read."*',
    "",
    "**What changes if you turn this on:** the same facts get written as an explanation you will actually understand in six months:",
    "",
    '> *"`massu login` hung forever when run without a terminal, because it waited on input that never arrived. The first fix \u2014 refusing to run without a terminal \u2014 was wrong; it broke piping a key in. The working fix bounds the read to 2 seconds."*',
    "",
    "**Why it matters:** these lessons are what Massu hands back to you months later when you hit the same problem. Clearer lessons mean better recall. It affects **only** these summaries \u2014 finding duplicates, spotting mistakes you keep repeating, and deciding what to forget are all arithmetic, and are already at full strength.",
    "",
    "**Pros:** better-written memory; everything stays on your machine; free; no extra memory used while idle.",
    "**Cons:** your session text is sent to that local server while it writes the summary (it never leaves your machine, but it is a program you are choosing to trust); summarizing adds a few seconds at session end; a model can occasionally word a lesson imprecisely \u2014 which is why Massu never lets a generated summary override something *you* wrote, only sit alongside it.",
    "",
    '**To turn it on \u2014 just say "enable local summaries" and I will do it for you.** Or add this to `massu.config.yaml`:',
    "",
    "```yaml",
    "memory:",
    "  consolidation:",
    `    llmEndpoint: "${finding.endpoint}"`,
    `    llmModel: "${model}"`,
    "```",
    "",
    '**Not interested?** Say "don\'t suggest this again" (or set `memory.consolidation.suggestUpgrades: false`). Massu works completely without it.'
  ].join("\n");
}
var localModelAdvisor = {
  id: LOCAL_MODEL_ADVISOR_ID,
  remedyKeys: LOCAL_MODEL_REMEDY_KEYS,
  isConfigured() {
    const cfg = resolveConsolidationConfig();
    return Boolean(cfg.llmEndpoint && cfg.llmModel);
  },
  async detect() {
    const finding = await detectLocalModel();
    if (!finding) return null;
    return {
      // The fingerprint covers the endpoint AND the model list, so installing a
      // model later — or swapping an 8B for a 70B — re-triggers the offer.
      fingerprint: fingerprintOf([finding.endpoint, ...finding.models]),
      render: () => renderLocalModelOffer(finding)
    };
  }
};

// src/advisors/cross-repo-share-advisor.ts
init_config();
import { homedir as homedir9 } from "os";

// src/memory-repos-registry.ts
import {
  chmodSync as chmodSync5,
  existsSync as existsSync16,
  mkdirSync as mkdirSync10,
  readFileSync as readFileSync12,
  writeFileSync as writeFileSync8
} from "fs";
import { homedir as homedir8 } from "os";
import { dirname as dirname12, join as join10 } from "path";
var REPOS_REGISTRY_VERSION = 1;
function reposRegistryPath(home = homedir8()) {
  return join10(home, ".massu", "repos.json");
}
function emptyRegistry() {
  return { version: REPOS_REGISTRY_VERSION, repos: [] };
}
function readReposRegistry(home = homedir8()) {
  const p = reposRegistryPath(home);
  if (!existsSync16(p)) return emptyRegistry();
  try {
    const parsed = JSON.parse(readFileSync12(p, "utf-8"));
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

// src/advisors/cross-repo-share-advisor.ts
var CROSS_REPO_SHARE_ADVISOR_ID = "cross-repo-sharing";
var CROSS_REPO_SHARE_REMEDY_KEYS = ["memory.share.enabled", "memory.share.subscribe"];
function detectShareableRepos(home) {
  const repos = readReposRegistry(home).repos.filter((r) => r.share_enabled);
  if (repos.length === 0) return null;
  const labels = repos.map((r) => r.label);
  return {
    // Fingerprint covers the set of shareable repos, so registering a NEW repo
    // re-triggers the offer (the operator's setup changed).
    fingerprint: fingerprintOf(repos.map((r) => r.repo_id)),
    render: () => renderOffer(labels)
  };
}
function renderOffer(repoLabels) {
  const others = repoLabels.length === 1 ? `\`${repoLabels[0]}\`` : `${repoLabels.length} of your repos`;
  return [
    "\u{1F4A1} Massu can surface a decision from one of your repos in another \u2014 off by default, local-only, zero-network.",
    `   ${others} already share memory on this machine. To let THIS repo see their accepted decisions:`,
    "     1. add the repo label(s) to `memory.share.subscribe` in massu.config.yaml",
    "     2. run `massu memory review` at your next session \u2014 you accept each decision explicitly.",
    "   Nothing crosses without you accepting it, and nothing is ever an instruction. `massu memory share --help`."
  ].join("\n");
}
var crossRepoShareAdvisor = {
  id: CROSS_REPO_SHARE_ADVISOR_ID,
  remedyKeys: CROSS_REPO_SHARE_REMEDY_KEYS,
  isConfigured() {
    const share = getConfig().memory?.share;
    return Boolean(share?.enabled) || Array.isArray(share?.subscribe) && share.subscribe.length > 0;
  },
  async detect() {
    return detectShareableRepos(homedir9());
  }
};

// src/hooks/session-start.ts
init_consolidation_config();

// src/lib/pidLiveness.ts
import { spawnSync as spawnSync2 } from "child_process";
function isPidAlive(pid, opts = {}) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  const platform = opts.platformOverride ?? process.platform;
  if (platform === "win32") {
    return checkWindows(pid);
  }
  return checkPosix(pid, opts.killOverride);
}
function checkPosix(pid, killOverride) {
  try {
    if (killOverride) {
      killOverride(pid, 0);
    } else {
      process.kill(pid, 0);
    }
    return true;
  } catch (err) {
    const code = err.code;
    if (code === "EPERM") return true;
    return false;
  }
}
function checkWindows(pid) {
  try {
    const res = spawnSync2("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
      encoding: "utf-8",
      windowsHide: true
    });
    if (res.error || res.status !== 0) return false;
    const stdout = res.stdout || "";
    return new RegExp(`\\b${pid}\\b`).test(stdout);
  } catch {
    return false;
  }
}

// src/hooks/session-start.ts
init_hook_failure_signal();
async function main() {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input);
    const { session_id, source } = hookInput;
    const db = getMemoryDb();
    try {
      const gitBranch = await getGitBranch();
      createSession(db, session_id, { branch: gitBranch });
      const session = db.prepare("SELECT plan_file, task_id FROM sessions WHERE session_id = ?").get(session_id);
      if (session?.plan_file && !session.task_id) {
        const taskId = autoDetectTaskId(session.plan_file);
        if (taskId) linkSessionToTask(db, session_id, taskId);
      }
      const tokenBudget = getTokenBudget(source ?? "startup");
      const sessionCount = db.prepare("SELECT COUNT(*) as count FROM sessions").get();
      if (sessionCount.count <= 1 && (source === "startup" || !source)) {
        process.stdout.write(
          `=== MASSU AI: Active ===
Session memory, code intelligence, and governance are now active.
11 hooks monitoring this session. Type "${getConfig().toolPrefix ?? "massu"}_sync" to index your codebase.
=== END MASSU ===

`
        );
      }
      try {
        const memoryDir = getMemoryDir();
        if (memoryDir) backfillMemoryFiles(db, memoryDir, session_id);
      } catch (err) {
        recordHookFailure("session-start:memory-ingest", err);
      }
      try {
        const memoryDir = getMemoryDir();
        if (memoryDir) reconcileMemoryFileObservations(db, memoryDir);
      } catch (err) {
        recordHookFailure("session-start:reconcile", err);
      }
      try {
        const memoryDir = getMemoryDir();
        if (memoryDir) {
          const { renderMemoryFiles: renderMemoryFiles2 } = await Promise.resolve().then(() => (init_memory_renderer(), memory_renderer_exports));
          const { loadRenderCandidates: loadRenderCandidates2 } = await Promise.resolve().then(() => (init_memory_render_candidates(), memory_render_candidates_exports));
          renderMemoryFiles2(db, loadRenderCandidates2(db), { memoryDir });
        }
      } catch (_renderErr) {
      }
      const context = await buildContext(db, session_id, source ?? "startup", tokenBudget, session?.task_id ?? null);
      if (context.trim()) {
        process.stdout.write(context);
      }
      const driftBanner = await buildDriftBanner();
      if (driftBanner) {
        process.stdout.write(driftBanner);
      } else {
        const watcherBanner = buildWatcherBanner();
        if (watcherBanner) process.stdout.write(watcherBanner);
      }
      try {
        const consolidationCfg = resolveConsolidationConfig();
        const advisorBlock = await runAdvisors([localModelAdvisor, crossRepoShareAdvisor], {
          enabled: consolidationCfg.enabled && consolidationCfg.suggestUpgrades,
          suggestIntervalDays: consolidationCfg.suggestIntervalDays
        });
        if (advisorBlock) process.stdout.write(`
${advisorBlock}
`);
      } catch {
      }
      try {
        await pullTeamPromotions(db);
      } catch (_pullErr) {
      }
    } finally {
      db.close();
    }
  } catch (err) {
    recordHookFailure("session-start", err);
    try {
      process.stdout.write(
        "\u26A0\uFE0F  MASSU AI: DEGRADED \u2014 Massu is installed but failed to start.\n   This is a Massu bug, not a problem with your project.\n   Details: .massu/hook-failures.jsonl \xB7 Run `massu doctor` to diagnose.\n"
      );
    } catch {
    }
    process.exit(0);
  }
}
function getTokenBudget(source) {
  switch (source) {
    case "compact":
      return 4e3;
    case "startup":
      return 2e3;
    case "resume":
      return 1e3;
    case "clear":
      return 2e3;
    default:
      return 2e3;
  }
}
async function buildContext(db, sessionId, source, tokenBudget, taskId) {
  const sections = [];
  const failures = getFailedAttempts(db, void 0, 10);
  if (failures.length > 0) {
    let failText = "### Failed Attempts (DO NOT RETRY)\n";
    for (const f of failures) {
      const recurrence = f.recurrence_count > 1 ? ` (${f.recurrence_count}x)` : "";
      failText += `- ${f.title}${recurrence}
`;
    }
    sections.push({ text: failText, importance: 10 });
  }
  if (source === "compact") {
    const currentObs = getRecentObservations(db, 30, sessionId);
    if (currentObs.length > 0) {
      let currentText = "### Current Session Observations (restored after compaction)\n";
      for (const obs of currentObs) {
        currentText += `- [${obs.type}] ${obs.title}
`;
      }
      sections.push({ text: currentText, importance: 9 });
    }
  }
  const summaryCount = source === "compact" ? 5 : 3;
  const summaries = getSessionSummaries(db, summaryCount);
  if (summaries.length > 0) {
    for (const s of summaries) {
      let sumText = `### Session (${s.created_at.split("T")[0]})
`;
      if (s.request) sumText += `**Task**: ${s.request.slice(0, 200)}
`;
      if (s.completed) sumText += `**Completed**: ${s.completed.slice(0, 300)}
`;
      if (s.failed_attempts) sumText += `**Failed**: ${s.failed_attempts.slice(0, 200)}
`;
      const progress = safeParseJson(s.plan_progress);
      if (progress && Object.keys(progress).length > 0) {
        const total = Object.keys(progress).length;
        const complete = Object.values(progress).filter((v) => v === "complete").length;
        sumText += `**Plan**: ${complete}/${total} complete
`;
      }
      sections.push({ text: sumText, importance: 7 });
    }
  }
  if (taskId) {
    const progress = getCrossTaskProgress(db, taskId);
    if (Object.keys(progress).length > 0) {
      const total = Object.keys(progress).length;
      const complete = Object.values(progress).filter((v) => v === "complete").length;
      let progressText = `### Cross-Session Task Progress (${taskId})
`;
      progressText += `${complete}/${total} items complete
`;
      sections.push({ text: progressText, importance: 8 });
    }
  }
  const preventionRules = loadCorrectionsPreventionRules();
  if (preventionRules.length > 0) {
    let rulesText = "### Active Prevention Rules (from corrections.md)\n";
    for (const rule of preventionRules) {
      rulesText += `- ${rule}
`;
    }
    sections.push({ text: rulesText, importance: 9 });
  }
  try {
    const knowledgeDbPath = getResolvedPaths().knowledgeDbPath;
    if (existsSync24(knowledgeDbPath)) {
      const kdb = openDatabase2(knowledgeDbPath, { readonly: true, selfHeal: false });
      try {
        const stats = kdb.prepare(
          "SELECT COUNT(*) as doc_count, MAX(indexed_at) as last_indexed FROM knowledge_documents"
        ).get();
        if (stats.doc_count > 0 && stats.last_indexed) {
          const ageMs = Date.now() - new Date(stats.last_indexed).getTime();
          const ageHours = Math.round(ageMs / 36e5);
          if (ageHours > 24) {
            sections.push({
              text: `### Knowledge Index Status
Index has ${stats.doc_count} documents, last indexed ${ageHours}h ago. Consider re-indexing.
`,
              importance: 3
            });
          }
        } else if (stats.doc_count === 0) {
          sections.push({
            text: "### Knowledge Index Status\nKnowledge index is empty. Run knowledge indexing to populate it.\n",
            importance: 2
          });
        }
      } finally {
        kdb.close();
      }
    }
  } catch (_knowledgeErr) {
  }
  const recentObs = getRecentObservations(db, 20);
  if (recentObs.length > 0) {
    let obsText = "### Recent Observations\n";
    const sorted = [...recentObs].sort((a, b) => b.importance - a.importance);
    for (const obs of sorted) {
      obsText += `- [${obs.type}|imp:${obs.importance}] ${obs.title} (${obs.created_at.split("T")[0]})
`;
    }
    sections.push({ text: obsText, importance: 5 });
  }
  sections.sort((a, b) => b.importance - a.importance);
  let usedTokens = 0;
  const headerTokens = estimateTokens("=== Massu Memory: Previous Session Context ===\n\n=== END Massu Memory ===\n");
  usedTokens += headerTokens;
  const includedSections = [];
  for (const section of sections) {
    const sectionTokens = estimateTokens(section.text);
    if (usedTokens + sectionTokens <= tokenBudget) {
      includedSections.push(section.text);
      usedTokens += sectionTokens;
    }
  }
  if (includedSections.length === 0) return "";
  return `=== Massu Memory: Previous Session Context ===

${includedSections.join("\n")}
=== END Massu Memory ===
`;
}
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
async function getGitBranch() {
  try {
    const { spawnSync: spawnSync3 } = await import("child_process");
    const result = spawnSync3("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      timeout: 5e3
    });
    if (result.status !== 0 || result.error) return void 0;
    return result.stdout.trim();
  } catch (_e) {
    return void 0;
  }
}
function readStdin() {
  return new Promise((resolve10) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve10(data));
    setTimeout(() => resolve10(data), 3e3);
  });
}
async function buildDriftBanner() {
  try {
    if (process.env.MASSU_DRIFT_QUIET === "1") return "";
    if (watcherIsLiveAndFresh()) return "";
    const configPath = resolve9(process.cwd(), "massu.config.yaml");
    if (!existsSync24(configPath)) return "";
    const content = readFileSync19(configPath, "utf-8");
    const parsed = parseYaml4(content);
    if (!parsed || typeof parsed !== "object") return "";
    const det = parsed.detection;
    const storedFp = typeof det?.fingerprint === "string" ? det.fingerprint : null;
    if (!storedFp) return "";
    const [{ runDetection: runDetection2 }, { computeFingerprint: computeFingerprint2 }] = await Promise.all([
      Promise.resolve().then(() => (init_detect(), detect_exports)),
      Promise.resolve().then(() => (init_drift(), drift_exports))
    ]);
    const detection = await runDetection2(process.cwd(), void 0, { skipIntrospect: true });
    const currentFp = computeFingerprint2(detection);
    if (currentFp === storedFp) return "";
    return `=== Massu Config Drift ===
Detected stack has changed since last config refresh.
Fingerprint:  ${storedFp.slice(0, 16)}  ->  ${currentFp.slice(0, 16)}
Run: npx massu config refresh
(this will update massu.config.yaml AND any commands that need
 re-templating for your new stack)
Tip: set MASSU_DRIFT_QUIET=1 to suppress this banner during mid-migration.
=== END ===
`;
  } catch (_e) {
    return "";
  }
}
function safeParseJson(json) {
  try {
    return JSON.parse(json);
  } catch (_e) {
    return null;
  }
}
function getMemoryDir() {
  try {
    return getResolvedPaths().memoryDir;
  } catch (err) {
    recordHookFailure("session-start:getMemoryDir", err);
    return "";
  }
}
function loadCorrectionsPreventionRules() {
  try {
    const correctionsPath = join18(getResolvedPaths().memoryDir, "corrections.md");
    if (!existsSync24(correctionsPath)) return [];
    return parseCorrectionRules(readFileSync19(correctionsPath, "utf-8"));
  } catch (_e) {
    return [];
  }
}
function readWatchStateRaw(cwd) {
  try {
    const path = resolve9(cwd, ".massu", "watch-state.json");
    if (!existsSync24(path)) return null;
    const obj = JSON.parse(readFileSync19(path, "utf-8"));
    if (!obj || typeof obj !== "object") return null;
    return obj;
  } catch {
    return null;
  }
}
function watcherIsLiveAndFresh() {
  const state = readWatchStateRaw(process.cwd());
  if (!state) return false;
  if (typeof state.daemonPid !== "number" || state.daemonPid <= 0) return false;
  if (!isPidAlive(state.daemonPid)) return false;
  if (typeof state.lastRefreshAt !== "string") return false;
  const last = Date.parse(state.lastRefreshAt);
  if (!Number.isFinite(last)) return false;
  const ageMs = Date.now() - last;
  return ageMs >= 0 && ageMs < 24 * 60 * 60 * 1e3;
}
function buildWatcherBanner() {
  if (process.env.MASSU_DRIFT_QUIET === "1") return "";
  const state = readWatchStateRaw(process.cwd());
  if (!state) return "";
  if (typeof state.daemonPid !== "number" || state.daemonPid <= 0) return "";
  if (!isPidAlive(state.daemonPid)) return "";
  if (typeof state.lastRefreshAt !== "string") return "";
  const last = Date.parse(state.lastRefreshAt);
  if (!Number.isFinite(last)) return "";
  const ageMs = Date.now() - last;
  if (ageMs < 0 || ageMs >= 24 * 60 * 60 * 1e3) return "";
  const ageStr = formatAge(ageMs);
  return `=== Massu Watcher ===
[massu] watcher running, last refresh: ${ageStr} ago (pid ${state.daemonPid})
=== END ===
`;
}
function formatAge(ms) {
  const sec = Math.round(ms / 1e3);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  return `${hr}h`;
}
main();
/*! Bundled license information:

is-extglob/index.js:
  (*!
   * is-extglob <https://github.com/jonschlinkert/is-extglob>
   *
   * Copyright (c) 2014-2016, Jon Schlinkert.
   * Licensed under the MIT License.
   *)

is-glob/index.js:
  (*!
   * is-glob <https://github.com/jonschlinkert/is-glob>
   *
   * Copyright (c) 2014-2017, Jon Schlinkert.
   * Released under the MIT License.
   *)

is-number/index.js:
  (*!
   * is-number <https://github.com/jonschlinkert/is-number>
   *
   * Copyright (c) 2014-present, Jon Schlinkert.
   * Released under the MIT License.
   *)

to-regex-range/index.js:
  (*!
   * to-regex-range <https://github.com/micromatch/to-regex-range>
   *
   * Copyright (c) 2015-present, Jon Schlinkert.
   * Released under the MIT License.
   *)

fill-range/index.js:
  (*!
   * fill-range <https://github.com/jonschlinkert/fill-range>
   *
   * Copyright (c) 2014-present, Jon Schlinkert.
   * Licensed under the MIT License.
   *)

queue-microtask/index.js:
  (*! queue-microtask. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> *)

run-parallel/index.js:
  (*! run-parallel. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> *)
*/
