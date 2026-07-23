// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Self-bootstrapping Node launcher (Layer 2, CR-70 / plan-2026-07-22-zero-onus-hook-node-bootstrap).
 *
 * THE BUG THIS CLOSES (incident 2026-07-22-native-abi-hooks-bare-node-launch):
 * the MCP server was hand-wrapped to a compatible Node while the 16 hooks ran BARE under
 * the machine default. When the machine default was below the Node floor (or carried a
 * mismatched native ABI), every hook crashed with ERR_DLOPEN_FAILED and massu degraded
 * silently — the failure surfaced only in .massu/hook-failures.jsonl.
 *
 * Layer 1 (2.0.0, CR-69) removed the native ABI for Node >= 22.13 by defaulting to
 * node:sqlite. This module closes the residual gap G-1: a sub-floor Node still breaks a
 * bare hook. At the SINGLE cli.ts chokepoint (above the dispatch switch — so it covers BOTH
 * the hook-runner path AND the MCP-server path of the one bin) we:
 *
 *   1. Fast-path when the running Node already meets the floor (a single version compare).
 *   2. Otherwise discover a compatible Node from a STRICT ABSOLUTE-PATH ALLOWLIST — never
 *      bare PATH / `which` (operator decision 2026-07-22: a `node` planted earlier in PATH
 *      would be re-exec'd with the customer's hooks).
 *   3. Re-exec under the discovered Node with full stdio + exit-code fidelity.
 *   4. Fail LOUD with a copy-paste remedy if no compatible Node exists — NEVER a silent
 *      crash, never a swallowed dlopen error, never exit 0.
 *
 * ZERO customer onus: the customer upgrades @massu/core; massu makes ITSELF run.
 *
 * SECURITY (L2-7, RESOLVED — strict absolute-path allowlist): Node discovery + re-exec is an
 * arbitrary-binary-execution surface. Discovery reads ONLY the absolute allowlist below and
 * NEVER `process.env.PATH` / `which`; every candidate must be an existing ABSOLUTE path;
 * re-exec uses spawnSync with an argv ARRAY (never a shell string, never `shell: true`).
 * Enforced by node-bootstrap-exec-safety.test.ts + pattern-scanner Check 47.
 */

import { existsSync, readdirSync, statSync, realpathSync } from 'fs';
import { spawnSync, execFileSync } from 'child_process';
import { homedir } from 'os';
import { isAbsolute, resolve, win32 as pathWin32 } from 'path';
// Import the floor from the LEAF SoT (zero non-fs imports), NOT from preflight.ts — this module
// runs to rescue a sub-floor Node, so it must not transitively pull in the DB-driver/config
// chain (a module-eval side effect there would crash the very rescuer). preflight.ts re-exports
// the same symbols, so this is still ONE SoT (CR-70 arch review 2026-07-22).
import { checkNodeVersion, MIN_NODE_MAJOR, MIN_NODE_MINOR } from './node-floor.ts';

/** Loop guard (R-1): set on the re-exec'd child so it never re-discovers/re-execs again. */
export const REEXEC_SENTINEL_ENV = 'MASSU_BOOTSTRAP_REEXEC';
/** Opt-out (L2-5): disables the *re-exec* for operators who pin their own Node. Does NOT
 * disable the *loud failure* — a sub-floor Node with the opt-out set still fails loud. */
export const OPT_OUT_ENV = 'MASSU_NO_NODE_BOOTSTRAP';

/**
 * L2-2 — the STRICT absolute-path allowlist of candidate Node binaries.
 *
 * Each pattern is either an absolute path or an absolute path with exactly ONE `*` segment
 * (a version dir or a `node@X` keg). We enumerate installed versions across the common version
 * managers (nvm, fnm, volta, asdf, n) plus Homebrew kegs. Version-manager INSTALL-DIR locations
 * are read from their canonical env pointers (`NVM_DIR`, `FNM_DIR`, `VOLTA_HOME`, `ASDF_DATA_DIR`,
 * `N_PREFIX`) when set, falling back to the default `~/…` layout — reading an explicit
 * install-DIR env var is NOT a `PATH`/`which` resolver read (it names a directory, it does not
 * search executables), so it does not weaken L2-7.
 *
 * We deliberately do NOT consult `fnm exec` / `volta which` / bare `PATH`: those resolve the
 * CURRENTLY-ACTIVE version, which is the very below-floor Node we are trying to escape — and
 * consulting a resolver is a `which`-class PATH read the security posture forbids. The install-dir
 * globs already enumerate EVERY installed version, which is strictly more complete for finding a
 * HIGHER one.
 *
 * HOME/env trust (CR-70 security review 2026-07-22): the home-relative patterns are included ONLY
 * when `home` is a non-empty ABSOLUTE path — an empty/relative HOME would otherwise resolve the
 * globs against CWD (a silent wrong-root, and a candidate the customer could not have installed).
 * The Homebrew absolute prefixes are always included. Candidate binaries are additionally
 * ownership-gated before they are executed (see `discoverCompatibleNode`).
 */
export function allowlistPatterns(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  // P2-001 (CR-70 Windows parity): win32 discovery uses a SEPARATE absolute-path allowlist keyed
  // to Windows install layouts + `.exe`. The `platform` param (P2-000 seam) — never the
  // `process.platform` global — is what lets the unit tests exercise this branch on a POSIX host.
  if (platform === 'win32') return windowsAllowlistPatterns(env);

  const patterns: string[] = [];
  const rawHome = env.HOME || homedir();
  const home = rawHome && isAbsolute(rawHome) ? rawHome : null;

  // Version-manager install dirs (each glob enumerates ALL installed versions). Prefer the
  // manager's own install-DIR env pointer; else the default home-relative layout.
  const addAbs = (dir: string | null | undefined, suffix: string) => {
    if (dir && isAbsolute(dir)) patterns.push(resolve(dir, suffix));
  };
  addAbs(env.NVM_DIR ?? (home && resolve(home, '.nvm')), 'versions/node/*/bin/node');
  addAbs(env.FNM_DIR ?? (home && resolve(home, '.local/share/fnm')), 'node-versions/*/installation/bin/node');
  addAbs(env.VOLTA_HOME ?? (home && resolve(home, '.volta')), 'tools/image/node/*/bin/node');
  addAbs(env.ASDF_DATA_DIR ?? (home && resolve(home, '.asdf')), 'installs/nodejs/*/bin/node');
  addAbs(env.N_PREFIX ?? (home && resolve(home, 'n')), 'bin/node'); // tj/n installs to $N_PREFIX/bin

  // Homebrew keg globs + canonical prefixes (always absolute; always included).
  patterns.push(
    '/opt/homebrew/opt/node@*/bin/node',
    '/usr/local/opt/node@*/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  );
  return patterns;
}

/**
 * The resolved absolute Windows install BASE DIRS for each version manager / install channel — the
 * SINGLE source both `windowsAllowlistRoots` (trust) and `windowsAllowlistPatterns` (discovery)
 * derive from, so the two can NEVER drift (a pattern whose root is absent from the trust set would
 * silently shrink discovery — architecture review ARCH-2). Each field is an absolute dir or null.
 *
 * Layouts VERIFIED-IN-LOOP 2026-07-22 against each manager's official docs (§CLAIM LEDGER W-1..W-6):
 *   - fnm: `FNM_DIR` is NOT reliably set on Windows → default `%APPDATA%\fnm`.
 *   - volta: `VOLTA_HOME` default `%LOCALAPPDATA%\Volta`.
 *   - Chocolatey / winget install the machine MSI → `C:\Program Files\nodejs` (there is NO
 *     `%ChocolateyInstall%\bin\node.exe` shim — REFUTED), so they need no separate pointer.
 * NEVER reads `env.PATH` / `env.Path` / `where.exe` (the Windows analogue of the forbidden `which`).
 */
function winManagerDirs(env: NodeJS.ProcessEnv): {
  userprofile: string | null;
  nvmHome: string | null;
  nvmSymlink: string | null;
  fnmDir: string | null;
  voltaHome: string | null;
  localappdata: string | null;
} {
  const abs = (d: string | null | undefined) => (d && pathWin32.isAbsolute(d) ? d : null);
  const appdata = abs(env.APPDATA);
  const localappdata = abs(env.LOCALAPPDATA);
  return {
    userprofile: abs(env.USERPROFILE),
    nvmHome: abs(env.NVM_HOME),
    nvmSymlink: abs(env.NVM_SYMLINK),
    fnmDir: abs(env.FNM_DIR) ?? (appdata ? `${appdata}\\fnm` : null),
    voltaHome: abs(env.VOLTA_HOME) ?? (localappdata ? `${localappdata}\\Volta` : null),
    localappdata,
  };
}

/**
 * P2-004 — the absolute Windows install ROOTS a discovered `node.exe` must be contained under to
 * be trusted (the win32 analogue of the POSIX uid/root ownership gate — there is no `getuid` on
 * win32). `isWindowsTrusted` requires the real resolved candidate to live under one of these.
 *
 * Residual limit (documented, §7 R-3): a process running AS the user can plant a `node.exe` under
 * the user's own install dirs (e.g. `%USERPROFILE%\scoop\...`) — the SAME "runs-as-you" bar the
 * POSIX ownership gate already accepts. This is NOT a world-writable location.
 */
function windowsAllowlistRoots(env: NodeJS.ProcessEnv): string[] {
  const d = winManagerDirs(env);
  const roots: string[] = [];
  for (const r of [d.userprofile, d.nvmHome, d.nvmSymlink, d.fnmDir, d.voltaHome, d.localappdata]) {
    if (r) roots.push(r);
  }
  // System MSI / winget / Chocolatey ALL resolve here (machine MSI → C:\Program Files\nodejs).
  roots.push('C:\\Program Files\\nodejs', 'C:\\Program Files (x86)\\nodejs');
  return roots;
}

/**
 * P2-001 — the STRICT absolute-path allowlist of candidate `node.exe` binaries on Windows. Each
 * pattern is an absolute path (or one with a single `*` version segment), derived SOLELY from
 * `winManagerDirs` (so every pattern's base dir is a trust root — no drift). fnm & volta on Windows
 * DROP the Unix `bin/` segment. NEVER `env.PATH` / `env.Path` / `where.exe`.
 */
function windowsAllowlistPatterns(env: NodeJS.ProcessEnv): string[] {
  const d = winManagerDirs(env);
  const patterns: string[] = [];
  const add = (dir: string | null, suffix: string) => {
    if (dir) patterns.push(`${dir}\\${suffix}`);
  };
  // nvm-windows: per-version %NVM_HOME%\v*\node.exe + the active %NVM_SYMLINK%\node.exe.
  add(d.nvmHome, 'v*\\node.exe');
  add(d.nvmSymlink, 'node.exe');
  add(d.fnmDir, 'node-versions\\v*\\installation\\node.exe'); // fnm omits bin/ on Windows
  add(d.voltaHome, 'tools\\image\\node\\*\\node.exe'); // volta omits bin/ on Windows
  // scoop: %USERPROFILE%\scoop\apps\{nodejs,nodejs-lts}\current\node.exe (`current` is a junction).
  add(d.userprofile, 'scoop\\apps\\nodejs\\current\\node.exe');
  add(d.userprofile, 'scoop\\apps\\nodejs-lts\\current\\node.exe');
  add(d.localappdata, 'Programs\\nodejs\\node.exe'); // user-scope Programs dir
  // System MSI / winget / Chocolatey (always absolute; always included).
  patterns.push('C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe');
  return patterns;
}

/**
 * Ownership gate (CR-70 security review): only ever EXECUTE (probe) a candidate that is owned by
 * the current user or root — a binary owned by some OTHER non-root user is one the customer could
 * not have installed themselves and must never be re-exec'd with their hooks. On platforms without
 * POSIX ownership (`process.getuid` undefined, e.g. win32) this is a no-op — but discovery is
 * Unix-only anyway (absolute-`/` candidates), so a win32 host discovers nothing and fails loud.
 */
function isOwnershipTrusted(candidate: string): boolean {
  const getuid = process.getuid;
  if (typeof getuid !== 'function') return true; // no POSIX ownership on this platform
  try {
    const uid = statSync(candidate).uid;
    return uid === 0 || uid === getuid.call(process);
  } catch {
    // SWALLOW-OK: an unstatable candidate is not a trusted candidate; skip it.
    return false;
  }
}

/**
 * P2-004 — Windows trust gate (the win32 sibling of `isOwnershipTrusted`; there is no POSIX
 * `getuid` on win32). Accept ONLY when the candidate's REAL path is CONTAINED under one of the
 * absolute Windows install roots (`windowsAllowlistRoots`) — a containment check, NOT a
 * world-writable location. Takes NO `platform` param: it is only ever called on the win32 branch
 * (its caller's ternary guards it), so its containment logic is platform-independent, and it uses
 * `path.win32.*` explicitly so it is correct even when run on a POSIX test host.
 *
 * SECURITY (security review, junction escape): `realpathSync` FOLLOWS junctions/symlinks before the
 * containment check — a junction planted inside a trusted root that redirects OUT (the Windows
 * analogue of the symlink the POSIX `statSync().uid` gate already defeats) resolves to its real
 * out-of-root target and is rejected. Production always reaches here AFTER `existsSync` (the file
 * exists → realpath succeeds); a non-existent candidate (unit tests) falls back to lexical resolve.
 * Containment is CASE-FOLDED — Windows paths are case-insensitive, so a differently-cased-but-valid
 * install pointer must not spuriously fail (else auto-recovery silently degrades to loud-fail).
 */
export function isWindowsTrusted(candidate: string, env: NodeJS.ProcessEnv): boolean {
  let resolved: string;
  try {
    resolved = pathWin32.resolve(realpathSync(candidate));
  } catch {
    // SWALLOW-OK: an unresolvable candidate (e.g. a synthetic path in a unit test) is checked
    // lexically; in production the existsSync gate precedes, so the real path is always resolved.
    resolved = pathWin32.resolve(candidate);
  }
  const target = resolved.toLowerCase();
  for (const root of windowsAllowlistRoots(env)) {
    const base = pathWin32.resolve(root).toLowerCase();
    if (target === base || target.startsWith(base + pathWin32.sep)) return true;
  }
  return false;
}

/**
 * Expand a pattern containing at most ONE `*` segment into concrete absolute paths. The `*`
 * matches a single path segment or a `prefix*` / `*suffix` fragment of one (e.g. `node@*`).
 * Non-existent parents / no matches → empty. No `*` → the literal path if it exists.
 */
export function expandSingleStarGlob(pattern: string): string[] {
  // P2-003 — split on BOTH separators so `\`-separated Windows patterns expand. `split(/[\\/]/)`
  // is a STRICT SUPERSET of `split('/')` (POSIX patterns carry no `\`, so this is byte-identical
  // on POSIX — proven by the unchanged drift-guard/exec-safety suites, §3 U-1). Internal joins
  // stay `/`: Node's `fs`/`existsSync`/`readdirSync` accept forward slashes on Windows.
  const parts = pattern.split(/[\\/]/);
  const starIdx = parts.findIndex((p) => p.includes('*'));
  if (starIdx === -1) {
    return existsSync(pattern) ? [pattern] : [];
  }
  const parentDir = parts.slice(0, starIdx).join('/') || '/';
  const seg = parts[starIdx];
  const rest = parts.slice(starIdx + 1).join('/');
  const [pre, post] = seg.split('*');
  let entries: string[];
  try {
    entries = readdirSync(parentDir);
  } catch {
    // SWALLOW-OK: a missing version-manager dir simply yields no candidates from this
    // pattern; the loud-fail backstop (L2-4) covers the case where NOTHING is found.
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.startsWith(pre) || !e.endsWith(post ?? '')) continue;
    out.push(rest ? `${parentDir}/${e}/${rest}` : `${parentDir}/${e}`);
  }
  return out;
}

/**
 * Probe a candidate Node's version by executing it (argv ARRAY, no shell). Returns the
 * bare `x.y.z` string or null if the binary is unusable.
 */
function probeNodeVersion(candidate: string): string | null {
  try {
    const out = execFileSync(candidate, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const v = out.trim();
    return /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    // SWALLOW-OK: a candidate that will not run (permissions, corrupt, wrong arch) is simply
    // not a candidate. The verdict is decided by the set of candidates that DO run.
    return null;
  }
}

/**
 * P2-002 — the platform-branched candidate-path acceptance predicate. The `platform` param
 * (P2-000 seam) is MANDATORY-with-default so tests inject `'win32'`/`'linux'` on any host.
 *   - non-win32 (default): `candidate.startsWith('/')` — the EXACT pre-change POSIX rule.
 *   - win32: fully-qualified only — a drive-letter root (`C:\…`/`C:/…`) OR a UNC root (`\\…`).
 *     REJECTS drive-relative `C:foo` (`path.win32.isAbsolute` already returns false for it) and any
 *     bare token (the `where.exe`-resolved `node` we must never trust). Uses `path.win32.*` so the
 *     verdict is correct even on a POSIX test host.
 */
export function isAcceptedCandidatePath(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') {
    return (
      pathWin32.isAbsolute(candidate) &&
      (/^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\'))
    );
  }
  return candidate.startsWith('/');
}

/**
 * L2-2 — discover the LOWEST-version compatible Node from the strict absolute-path allowlist
 * (stability over newest). Rejects any non-absolute / non-existent candidate. Reads ONLY the
 * allowlist — never `process.env.PATH` / `which` (Unix) / `where.exe` / `env.Path` (Windows).
 * Returns the absolute path, or null. `platform` (P2-000 seam) selects the Unix vs win32 discovery
 * behaviour and defaults to production `process.platform`.
 */
export function discoverCompatibleNode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const seen = new Set<string>();
  let best: { path: string; major: number; minor: number; patch: number } | null = null;

  for (const pattern of allowlistPatterns(env, platform)) {
    for (const candidate of expandSingleStarGlob(pattern)) {
      // Defence in depth: only ever probe an existing, fully-qualified ABSOLUTE path (POSIX `/` or
      // win32 drive/UNC) that the platform trust gate accepts.
      if (!isAcceptedCandidatePath(candidate, platform)) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (!existsSync(candidate)) continue;
      const trusted =
        platform === 'win32' ? isWindowsTrusted(candidate, env) : isOwnershipTrusted(candidate);
      if (!trusted) continue;

      const v = probeNodeVersion(candidate);
      if (!v) continue;
      if (!checkNodeVersion(`v${v}`).ok) continue;

      const [major, minor, patch] = v.split('.').map((n) => Number.parseInt(n, 10));
      const lower =
        best === null ||
        major < best.major ||
        (major === best.major && minor < best.minor) ||
        (major === best.major && minor === best.minor && patch < best.patch);
      if (lower) best = { path: candidate, major, minor, patch };
    }
  }
  return best?.path ?? null;
}

/**
 * L2-3 — re-exec the current entry under `nodePath` with full stdio + exit-code fidelity.
 * argv ARRAY, no shell; sets the loop-guard sentinel on the child. Returns the child's exit
 * code (or 1 if it was killed / produced no status) so the caller can mirror it (L2-6).
 */
export function reexecUnder(
  nodePath: string,
  selfEntry: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
): number {
  const result = spawnSync(nodePath, [selfEntry, ...argv], {
    stdio: 'inherit',
    env: { ...env, [REEXEC_SENTINEL_ENV]: '1' },
  });
  return result.status ?? 1;
}

/**
 * L2-4 — write the loud, copy-paste remedy to stderr. Reuses the preflight `checkNodeVersion`
 * message as the SoT requirement statement (no second remedy copy) and adds one install line.
 */
function writeLoudRemedy(
  floorMessage: string,
  stderr: (msg: string) => void,
): void {
  const floor = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`;
  // Platform-aware install line — discovery is Unix-only (absolute-`/` candidates), so on win32
  // we never auto-recover and MUST NOT print a `nvm`/`brew` remedy that does not apply there.
  const installLine =
    process.platform === 'win32'
      ? `    winget install OpenJS.NodeJS   # or download Node >= ${floor} from https://nodejs.org`
      : `    nvm install ${MIN_NODE_MAJOR}     # or: brew install node@${MIN_NODE_MAJOR}`;
  stderr(
    `\nmassu: ${floorMessage}\n` +
      `No compatible Node was found on this machine, so massu will not launch under a ` +
      `Node it cannot run on (that would crash your hooks silently).\n` +
      `Fix it once: install Node >= ${floor}, e.g.\n` +
      `${installLine}\n` +
      `then re-run. (Set ${OPT_OUT_ENV}=1 to skip auto-discovery if you pin your own Node.)\n\n`,
  );
}

/** Injectable seams — real process values by default; overridden only by unit tests. */
export interface BootstrapDeps {
  /** The running Node version (default process.version). */
  nodeVersion?: string;
  /** The entry file to re-run (default process.argv[1] — the cli.js being executed). */
  selfEntry?: string;
  /** Discovery function (default discoverCompatibleNode). */
  discover?: (env: NodeJS.ProcessEnv) => string | null;
  /** Re-exec function (default reexecUnder). Returns the child exit code. */
  reexec?: (nodePath: string, selfEntry: string, argv: string[], env: NodeJS.ProcessEnv) => number;
  /** stderr sink (default process.stderr.write). */
  stderr?: (msg: string) => void;
  /** process exit (default process.exit). */
  exit?: (code: number) => void;
}

/**
 * THE CHOKEPOINT (L2-1..L2-5). Call as the FIRST statement inside cli.ts main(), above the
 * dispatch switch. At/above floor → no-op fast path. Below floor → discover + re-exec, or
 * fail LOUD. Never returns after a re-exec or a loud fail (it exits).
 */
export function bootstrapNodeOrExit(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: BootstrapDeps = {},
): void {
  const nodeVersion = deps.nodeVersion ?? process.version;
  const stderr = deps.stderr ?? ((m: string) => void process.stderr.write(m));
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const check = checkNodeVersion(nodeVersion);

  // Loop guard (R-1): we are the re-exec'd child. Never discover/re-exec again.
  if (env[REEXEC_SENTINEL_ENV] === '1') {
    if (check.ok) return;
    // Landed on a still-incompatible Node (should be impossible — we only re-exec to a Node
    // that satisfies the floor). Fail loud rather than loop forever.
    writeLoudRemedy(check.message ?? '', stderr);
    exit(1);
    return;
  }

  // Fast path (L2-1): the running Node already meets the floor. Near-zero overhead.
  if (check.ok) return;

  // Below floor. Opt-out (L2-5) disables the re-exec but NOT the loud failure.
  if (env[OPT_OUT_ENV] === '1') {
    writeLoudRemedy(check.message ?? '', stderr);
    exit(1);
    return;
  }

  // L2-2/L2-3: discover a compatible Node and re-exec under it.
  const discover = deps.discover ?? discoverCompatibleNode;
  const nodePath = discover(env);
  if (!nodePath) {
    // L2-4: nothing found → loud copy-paste remedy, never a silent crash.
    writeLoudRemedy(check.message ?? '', stderr);
    exit(1);
    return;
  }

  const selfEntry = deps.selfEntry ?? process.argv[1];
  const reexec = deps.reexec ?? reexecUnder;
  const status = reexec(nodePath, selfEntry, argv, env);
  exit(status);
}
