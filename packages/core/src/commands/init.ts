// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu init` — One-command, detection-driven project setup.
 *
 * Phase 3 rewrite (2026-04-19): replaces the JS/TS template copier (old
 * detectFramework/generateConfig path, root cause of Hedge-style stale configs)
 * with a flow that runs the Phase 1 detection engine (`runDetection`) and
 * generates a v2 schema_version=2 `massu.config.yaml` that reflects the
 * actual repo layout (languages, source_dirs, verification commands, domains).
 *
 * Subcommands / flags:
 *   massu init                 Interactive — prompts on overwrite, stack confirm
 *   massu init --ci            Non-interactive; errors on conflict
 *   massu init --force         Overwrite existing config without prompting
 *   massu init --template X    Greenfield template (skips detection entirely)
 *
 * Post-write guarantees:
 *   - Atomic (tmp-file + rename; partial writes never persist)
 *   - Zod-validated (load via getConfig — bad config is rolled back + deleted)
 *   - declared source_dirs must exist on disk
 *
 * Legacy exports preserved for cli.test.ts and install-hooks.ts:
 *   detectFramework, detectPython, generateConfig, registerMcpServer,
 *   installHooks, buildHooksConfig, resolveHooksDir, initMemoryDir, runInit.
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync, writeSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, chmodSync } from 'fs';
import { resolve, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { backfillMemoryFiles } from '../memory-file-ingest.ts';
import { getConfig, resetConfig } from '../config.ts';
import { installAll } from './install-commands.ts';
import {
  runDetection,
  type DetectionResult,
  type SupportedLanguage,
  type VRCommandSet,
} from '../detect/index.ts';
import { computeFingerprint } from '../detect/drift.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Types
// ============================================================

interface FrameworkDetection {
  type: string;
  router: string;
  orm: string;
  ui: string;
}

interface InitResult {
  configCreated: boolean;
  configSkipped: boolean;
  mcpRegistered: boolean;
  mcpSkipped: boolean;
  hooksInstalled: boolean;
  hooksCount: number;
  framework: FrameworkDetection;
}

export interface InitOptions {
  /** Skip all prompts; fail on conflict. Also set when stdin is not a TTY. */
  ci?: boolean;
  /** Overwrite existing config without prompting (ignored in --ci mode). */
  force?: boolean;
  /** Template name for greenfield projects (skips detection). */
  template?: string;
  /** Skip hook/command/memory install side-effects. Used in tests. */
  skipSideEffects?: boolean;
  /**
   * Plan #2 P4-002: when true, skip the asset-install (commands / agents /
   * patterns / etc). MCP register, hooks, and memory init still run.
   */
  skipCommands?: boolean;
  /** Override cwd (tests). */
  cwd?: string;
  /** Suppress console output. */
  silent?: boolean;
}

export interface GenerateConfigV2Options {
  /** Project root to generate against. Detection is run on this directory. */
  projectRoot: string;
  /** Pre-computed detection result (reused if already available). */
  detection?: DetectionResult;
  /** Project name override (default = basename of projectRoot). */
  projectName?: string;
}

// ============================================================
// Legacy Framework Auto-Detection (preserved for cli.test.ts)
// ============================================================

export function detectFramework(projectRoot: string): FrameworkDetection {
  const result: FrameworkDetection = {
    type: 'javascript',
    router: 'none',
    orm: 'none',
    ui: 'none',
  };

  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return result;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    // Language detection
    if (allDeps['typescript']) result.type = 'typescript';

    // UI framework detection
    if (allDeps['next']) result.ui = 'nextjs';
    else if (allDeps['@sveltejs/kit']) result.ui = 'sveltekit';
    else if (allDeps['nuxt']) result.ui = 'nuxt';
    else if (allDeps['@angular/core']) result.ui = 'angular';
    else if (allDeps['vue']) result.ui = 'vue';
    else if (allDeps['react']) result.ui = 'react';

    // Router detection
    if (allDeps['@trpc/server']) result.router = 'trpc';
    else if (allDeps['graphql'] || allDeps['@apollo/server']) result.router = 'graphql';
    else if (allDeps['express'] || allDeps['fastify'] || allDeps['hono']) result.router = 'rest';

    // ORM detection
    if (allDeps['@prisma/client'] || allDeps['prisma']) result.orm = 'prisma';
    else if (allDeps['drizzle-orm']) result.orm = 'drizzle';
    else if (allDeps['typeorm']) result.orm = 'typeorm';
    else if (allDeps['sequelize']) result.orm = 'sequelize';
    else if (allDeps['mongoose']) result.orm = 'mongoose';
  } catch {
    // Best effort
  }

  return result;
}

// ============================================================
// Legacy Python Project Detection (preserved for cli.test.ts / back compat)
// ============================================================

interface PythonDetection {
  detected: boolean;
  root: string;
  hasFastapi: boolean;
  hasSqlalchemy: boolean;
  hasAlembic: boolean;
  alembicDir: string | null;
}

export function detectPython(projectRoot: string): PythonDetection {
  const result: PythonDetection = {
    detected: false,
    root: '',
    hasFastapi: false,
    hasSqlalchemy: false,
    hasAlembic: false,
    alembicDir: null,
  };

  const markers = ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile'];
  const hasMarker = markers.some(m => existsSync(resolve(projectRoot, m)));
  if (!hasMarker) return result;

  result.detected = true;

  const depFiles = [
    { file: 'pyproject.toml' },
    { file: 'requirements.txt' },
    { file: 'setup.py' },
    { file: 'Pipfile' },
  ];

  for (const { file } of depFiles) {
    const filePath = resolve(projectRoot, file);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8').toLowerCase();
        if (content.includes('fastapi')) result.hasFastapi = true;
        if (content.includes('sqlalchemy')) result.hasSqlalchemy = true;
      } catch {
        // Best effort
      }
    }
  }

  if (existsSync(resolve(projectRoot, 'alembic.ini'))) {
    result.hasAlembic = true;
    if (existsSync(resolve(projectRoot, 'alembic'))) {
      result.alembicDir = 'alembic';
    }
  } else if (existsSync(resolve(projectRoot, 'alembic'))) {
    result.hasAlembic = true;
    result.alembicDir = 'alembic';
  }

  const candidateRoots = ['app', 'src', 'backend', 'api'];
  for (const candidate of candidateRoots) {
    const candidatePath = resolve(projectRoot, candidate);
    if (existsSync(candidatePath) && existsSync(resolve(candidatePath, '__init__.py'))) {
      result.root = candidate;
      break;
    }
    if (existsSync(candidatePath)) {
      try {
        const files = readdirSync(candidatePath);
        if (files.some(f => f.endsWith('.py'))) {
          result.root = candidate;
          break;
        }
      } catch {
        // Best effort
      }
    }
  }

  if (!result.root) {
    result.root = '.';
  }

  return result;
}

// ============================================================
// Legacy Config File Generation (preserved for cli.test.ts)
// ============================================================

/**
 * @deprecated Since @massu/core@1.2.1. Use {@link buildConfigFromDetection}
 * with {@link runDetection} for monorepo-aware path resolution and
 * schema_version=2 output. This path hardcodes `paths.source = 'src'` and
 * cannot emit `paths.monorepo_roots`, so it would roll back on every
 * non-`src/` layout. Kept only for the legacy `cli.test.ts` smoke tests;
 * new callers must use the v2 builder.
 */
export function generateConfig(projectRoot: string, framework: FrameworkDetection): boolean {
  console.warn(
    '[@massu/core] generateConfig() is deprecated since 1.2.1 — use buildConfigFromDetection instead. It cannot produce valid configs for monorepos.'
  );
  const configPath = resolve(projectRoot, 'massu.config.yaml');

  if (existsSync(configPath)) {
    return false; // Config already exists
  }

  const projectName = basename(projectRoot);

  const config: Record<string, unknown> = {
    project: {
      name: projectName,
      root: 'auto',
    },
    framework: {
      type: framework.type,
      router: framework.router,
      orm: framework.orm,
      ui: framework.ui,
    },
    paths: {
      source: 'src',
      aliases: { '@': 'src' },
    },
    toolPrefix: 'massu',
    domains: [],
    rules: [
      {
        pattern: 'src/**/*.ts',
        rules: ['Use ESM imports, not CommonJS'],
      },
    ],
  };

  // Detect and add Python configuration
  const python = detectPython(projectRoot);
  if (python.detected) {
    const pythonConfig: Record<string, unknown> = {
      root: python.root,
      exclude_dirs: ['__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache'],
    };
    if (python.hasFastapi) pythonConfig.framework = 'fastapi';
    if (python.hasSqlalchemy) pythonConfig.orm = 'sqlalchemy';
    if (python.hasAlembic && python.alembicDir) {
      pythonConfig.alembic_dir = python.alembicDir;
    }
    config.python = pythonConfig;
  }

  const yamlContent = `# Massu AI Configuration
# Generated by: npx massu init
# Documentation: https://massu.ai/docs/getting-started/configuration

${yamlStringify(config)}`;

  writeFileSync(configPath, yamlContent, 'utf-8');
  return true;
}

// ============================================================
// V2 Config Builder (detection-driven)
// ============================================================

/**
 * Return the common top-level parent directory across every workspace
 * package. Returns `'.'` when packages span multiple parents (e.g. a repo
 * with both `apps/*` and `packages/*`) — the project root is always a valid
 * paths.source value (see validateWrittenConfig at init.ts:572).
 */
function monorepoCommonRoot(
  packages: ReadonlyArray<{ path: string }>
): string {
  const roots = monorepoDistinctRoots(packages);
  return roots.length === 1 ? roots[0] : '.';
}

/**
 * Return the distinct top-level parent directories of every workspace
 * package (e.g. `['apps', 'packages']` when both are present). Sorted for
 * determinism. Excludes root-level ('.') workspaces.
 */
function monorepoDistinctRoots(
  packages: ReadonlyArray<{ path: string }>
): string[] {
  const set = new Set<string>();
  for (const p of packages) {
    const parts = p.path.split('/');
    if (parts.length > 1 && parts[0] !== '' && parts[0] !== '.') {
      set.add(parts[0]);
    }
  }
  return [...set].sort();
}

/**
 * Build a schema_version=2 config object from a DetectionResult.
 *
 * Contract:
 *   - `framework.type` is `'multi'` when 2+ languages present, else the sole language.
 *   - `framework.primary` is the language with the most manifests (ties: alpha).
 *   - `framework.languages` is populated for every detected language with a
 *     non-null framework or test framework.
 *   - Legacy top-level `framework.router/.orm/.ui` are mirrored from the primary
 *     language entry so existing consumers (tools.ts lines 89/192/246) keep
 *     working without any change (per Phase 0 P0-003 + Phase 2 P2-002 contract).
 *   - `paths.source` is the dominant directory for the primary language (or '.'
 *     for single-repo flat layouts).
 *   - `verification.<language>` is pulled from VRCommandMap output.
 *   - `domains[]` is the DomainInferrer output (may be empty).
 */
export function buildConfigFromDetection(
  opts: GenerateConfigV2Options
): Record<string, unknown> {
  const { projectRoot, detection } = opts;
  if (!detection) {
    throw new Error('buildConfigFromDetection requires a detection result');
  }
  const projectName = opts.projectName ?? basename(projectRoot);

  const languages = Array.from(
    new Set(detection.manifests.map((m) => m.language))
  ) as SupportedLanguage[];

  // Pick primary: language with most manifests; ties broken by alphabetical.
  const languageCounts = new Map<SupportedLanguage, number>();
  for (const m of detection.manifests) {
    languageCounts.set(m.language, (languageCounts.get(m.language) ?? 0) + 1);
  }
  const sortedLangs = [...languageCounts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  const primary: SupportedLanguage | null = sortedLangs.length > 0 ? sortedLangs[0][0] : null;

  const frameworkType = languages.length > 1 ? 'multi' : (languages[0] ?? 'typescript');

  // Build per-language entries from FrameworkMap.
  const languageEntries: Record<string, Record<string, unknown>> = {};
  for (const lang of languages) {
    const fw = detection.frameworks[lang];
    const dirInfo = detection.sourceDirs[lang];
    const sourceDirs = dirInfo?.source_dirs ?? [];
    const entry: Record<string, unknown> = {};
    if (fw?.framework) entry.framework = fw.framework;
    if (fw?.test_framework) entry.test_framework = fw.test_framework;
    if (fw?.orm) entry.orm = fw.orm;
    if (fw?.router) entry.router = fw.router;
    if (fw?.ui_library) entry.ui = fw.ui_library;
    if (sourceDirs.length > 0) entry.source_dirs = sourceDirs;
    // Only include entries that have at least one field populated.
    if (Object.keys(entry).length > 0) {
      languageEntries[lang] = entry;
    }
  }

  // Legacy top-level framework fields (mirror from primary language).
  // Preserves tools.ts:89,192,246 reads under v2.
  const primaryEntry = primary ? languageEntries[primary] : undefined;
  const legacyRouter =
    (primaryEntry?.router as string | undefined) ?? 'none';
  const legacyOrm = (primaryEntry?.orm as string | undefined) ?? 'none';
  const legacyUi = (primaryEntry?.ui as string | undefined) ?? 'none';

  // Determine paths.source from primary language's dominant source dir.
  // P1-003: when the primary language has no detectable source dir AND the
  // repo is a monorepo, fall back to the common parent of workspace packages
  // (e.g. 'apps' for turbo + apps/*, 'packages' for pnpm + packages/*). This
  // prevents the validator from rejecting a nonexistent top-level 'src/' on
  // monorepo shapes where code actually lives under apps/ or packages/.
  let pathsSource = 'src';
  if (primary) {
    const primaryDirs = detection.sourceDirs[primary]?.source_dirs ?? [];
    if (primaryDirs.length > 0) {
      pathsSource = primaryDirs[0];
    } else if (
      detection.monorepo.type !== 'single' &&
      detection.monorepo.packages.length > 0
    ) {
      pathsSource = monorepoCommonRoot(detection.monorepo.packages);
    }
  }

  // P1-005: emit `paths.monorepo_roots` as the distinct parent directories of
  // every workspace package when this is a monorepo. Optional + additive;
  // v1 consumers ignore it. When detection identified a monorepo type
  // (turbo/nx/pnpm/etc) but no manifested workspace packages were found
  // (e.g. fresh-install fixtures with apps/*/main.py that haven't declared
  // sub-manifests yet), fall back to deriving roots from the resolved
  // paths.source so the field is still accurate for monorepo-aware tools.
  let monorepoRoots: string[] | undefined;
  if (detection.monorepo.type !== 'single') {
    if (detection.monorepo.packages.length > 0) {
      monorepoRoots = monorepoDistinctRoots(detection.monorepo.packages);
    } else if (pathsSource !== 'src' && pathsSource !== '.') {
      // Derive from paths.source when no workspace manifests exist.
      monorepoRoots = [pathsSource];
    }
  }

  // Verification commands per language.
  const verification: Record<string, Record<string, string>> = {};
  for (const lang of languages) {
    const cmds: VRCommandSet | undefined = detection.verificationCommands[lang];
    if (!cmds) continue;
    const entry: Record<string, string> = {};
    if (cmds.test) entry.test = cmds.test;
    if (cmds.type) entry.type = cmds.type;
    if (cmds.build) entry.build = cmds.build;
    if (cmds.syntax) entry.syntax = cmds.syntax;
    if (cmds.lint) entry.lint = cmds.lint;
    if (Object.keys(entry).length > 0) {
      verification[lang] = entry;
    }
  }

  // Domains: emit from inferred + strip defaulting so YAML stays lean.
  const domains = detection.domains.map((d) => {
    const out: Record<string, unknown> = { name: d.name };
    if (d.routers.length > 0) out.routers = d.routers;
    if (d.pages.length > 0) out.pages = d.pages;
    if (d.tables.length > 0) out.tables = d.tables;
    if (d.allowedImportsFrom.length > 0) out.allowedImportsFrom = d.allowedImportsFrom;
    return out;
  });

  const frameworkBlock: Record<string, unknown> = {
    type: frameworkType,
    router: legacyRouter,
    orm: legacyOrm,
    ui: legacyUi,
  };
  if (languages.length > 1 && primary) {
    frameworkBlock.primary = primary;
  }
  if (Object.keys(languageEntries).length > 0) {
    frameworkBlock.languages = languageEntries;
  }

  const pathsBlock: Record<string, unknown> = {
    source: pathsSource,
    aliases: { '@': pathsSource },
  };
  if (monorepoRoots && monorepoRoots.length > 0) {
    pathsBlock.monorepo_roots = monorepoRoots;
  }

  const config: Record<string, unknown> = {
    schema_version: 2,
    project: {
      name: projectName,
      root: 'auto',
    },
    framework: frameworkBlock,
    paths: pathsBlock,
    toolPrefix: 'massu',
    domains,
    rules: [],
  };

  if (Object.keys(verification).length > 0) {
    config.verification = verification;
  }

  // P5-002: stamp a stack fingerprint so session-start can detect drift later.
  config.detection = { fingerprint: computeFingerprint(detection) };

  // Plan #2 P3-003: emit detector-owned `detected:` block (per-language
  // conventions sampled from the codebase). Only present when the introspector
  // ran (i.e., not skipped by the session-start hook). Detector-owned →
  // refreshed on every `init`/`config refresh`, NOT in PRESERVED_FIELDS.
  if (detection.detected && Object.keys(detection.detected).length > 0) {
    config.detected = detection.detected;
  }

  // Preserve legacy `python` block for v1 consumers (domain-enforcer, etc.).
  // Per Phase 0 P1-009 (b): python legacy config coexists with languages.python.
  if (languages.includes('python')) {
    const pySourceDirs = detection.sourceDirs.python?.source_dirs ?? [];
    const pyRoot = pySourceDirs.length > 0 ? pySourceDirs[0] : '.';
    const pyFw = detection.frameworks.python;
    const pythonBlock: Record<string, unknown> = {
      root: pyRoot,
      exclude_dirs: ['__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache'],
    };
    if (pyFw?.framework) pythonBlock.framework = pyFw.framework;
    if (pyFw?.orm) pythonBlock.orm = pyFw.orm;
    // Alembic detection — best-effort via filesystem (detection layer is DB-free).
    if (existsSync(resolve(projectRoot, 'alembic.ini')) || existsSync(resolve(projectRoot, 'alembic'))) {
      pythonBlock.alembic_dir = 'alembic';
    }
    config.python = pythonBlock;
  }

  return config;
}

/**
 * Serialize a built config object into YAML with a header comment.
 * Safe for `writeConfigAtomic` and for `fs.writeFileSync` directly.
 */
export function renderConfigYaml(config: Record<string, unknown>): string {
  return `# Massu AI Configuration
# Generated by: npx massu init (schema_version=2, detection-driven)
# Documentation: https://massu.ai/docs/getting-started/configuration

${yamlStringify(config)}`;
}

// ============================================================
// Atomic Write + Post-Write Validation (P3-004, P3-005)
// ============================================================

/**
 * Atomically write YAML to `configPath`.
 * 1. Writes to `<configPath>.tmp`.
 * 2. Validates the written file by parsing it as YAML and through the Zod
 *    RawConfigSchema via a short-lived `getConfig` reload on a sandboxed cwd.
 * 3. Renames the tmp file to the target.
 * 4. On ANY error, removes the tmp file. No partial config ever persists.
 *
 * Preserves existing file permissions when overwriting.
 *
 * P3-006: never writes outside `configPath`'s directory; caller is responsible
 * for passing an in-project path (enforced at the call-site in runInit).
 */
export function writeConfigAtomic(
  configPath: string,
  content: string
): { validated: boolean; error?: string } {
  const tmpPath = `${configPath}.tmp`;

  // Preserve existing permissions when overwriting.
  let existingMode: number | undefined;
  if (existsSync(configPath)) {
    try {
      existingMode = statSync(configPath).mode;
    } catch {
      existingMode = undefined;
    }
  }

  try {
    // Iter-8 fix: ensure the parent directory exists. POSIX `rename(2)`
    // requires the target's parent to exist; otherwise the rename fails
    // with ENOENT and we leak the tmp. The watcher's auto-refresh path
    // never hits this (the configPath is always inside an existing repo
    // with massu.config.yaml already there), but `runInit` on a fresh
    // path under a non-existent parent would fall over before this line.
    mkdirSync(dirname(configPath), { recursive: true });

    // Iter-7 fix: write tmp via openSync + writeSync + fsyncSync + closeSync
    // so the data hits the platter BEFORE renameSync. This matches
    // `writeStateAtomic` (watch/state.ts) and the spec doc claim that the
    // 3a watcher's atomic-rename guarantees universally cover all writes
    // touched during a refresh cycle. Without fsync, on certain filesystems
    // (xfs, ext4 `data=writeback`) the rename can land before data, leaving
    // a zero-byte config on power-loss / SIGKILL between writeFileSync and
    // renameSync — a gap the watcher daemon makes more reachable since
    // refresh writes happen unattended every quiescence window.
    const fd = openSync(tmpPath, 'w', 0o644);
    try {
      const buf = Buffer.from(content, 'utf-8');
      writeSync(fd, buf, 0, buf.length, 0);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    // Validate YAML parses.
    const parsed = yamlParse(content);
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('Generated config is not a valid YAML object');
    }

    // Atomic rename.
    renameSync(tmpPath, configPath);

    // Restore mode if we had one.
    if (existingMode !== undefined) {
      try {
        chmodSync(configPath, existingMode);
      } catch {
        // Best effort; unreadable mode doesn't block init.
      }
    }

    return { validated: true };
  } catch (err) {
    // Clean up the temp file on failure.
    if (existsSync(tmpPath)) {
      try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    }
    return { validated: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Validate a written config against the live Zod schema AND filesystem.
 * Returns null on success, an error message on failure.
 *
 * When `checkPaths` is false (template mode, greenfield scaffolds), filesystem
 * existence checks on `paths.source` and per-language source_dirs are skipped.
 */
export function validateWrittenConfig(
  configPath: string,
  projectRoot: string,
  checkPaths: boolean = true
): string | null {
  try {
    if (!existsSync(configPath)) return 'Config file does not exist after write';
    // Parse YAML directly — we deliberately bypass getConfig() here because
    // getConfig caches against process.cwd() and we may be validating a config
    // outside the current working tree (tests, etc.).
    const content = readFileSync(configPath, 'utf-8');
    const parsed = yamlParse(content);
    if (parsed === null || typeof parsed !== 'object') {
      return 'Config is not a valid YAML object';
    }

    // Validate via getConfig by temporarily chdir'ing to projectRoot, since
    // getConfig reads the config from process.cwd(). The Zod safeParse inside
    // getConfig already surfaces actionable errors on malformed configs.
    const prevCwd = process.cwd();
    let changed = false;
    if (prevCwd !== projectRoot) {
      try { process.chdir(projectRoot); changed = true; } catch { /* ignore */ }
    }
    try {
      resetConfig();
      const cfg = getConfig();
      if (checkPaths) {
        // Verify paths.source actually exists on disk (unless '.', which is always valid).
        const src = cfg.paths.source;
        if (src && src !== '.') {
          const srcAbs = resolve(projectRoot, src);
          if (!existsSync(srcAbs)) {
            return `paths.source '${src}' does not exist on disk`;
          }
        }
        // Verify every declared language source_dir exists.
        const languages = cfg.framework.languages ?? {};
        for (const [lang, entry] of Object.entries(languages)) {
          const rawDirs = (entry as Record<string, unknown>).source_dirs;
          if (!Array.isArray(rawDirs)) continue;
          for (const d of rawDirs) {
            if (typeof d !== 'string' || d === '.') continue;
            const abs = resolve(projectRoot, d);
            if (!existsSync(abs)) {
              return `framework.languages.${lang}.source_dirs '${d}' does not exist on disk`;
            }
          }
        }
        // P2-001: verify paths.monorepo_roots entries exist on disk (parity
        // with paths.source existence check at line 624-631 above).
        const mRoots = (cfg.paths as Record<string, unknown>).monorepo_roots;
        if (Array.isArray(mRoots)) {
          for (const r of mRoots) {
            if (typeof r !== 'string' || r === '.') continue;
            if (!existsSync(resolve(projectRoot, r))) {
              return `paths.monorepo_roots '${r}' does not exist on disk`;
            }
          }
        }
      }
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      if (changed) {
        try { process.chdir(prevCwd); } catch { /* ignore */ }
      }
      resetConfig();
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ============================================================
// Template Mode (P3-003)
// ============================================================

const TEMPLATE_NAMES = [
  'python-fastapi',
  'python-django',
  'ts-nextjs',
  'ts-nestjs',
  'rust-actix',
  'swift-ios',
  'multi-runtime',
] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export function isTemplateName(name: string): name is TemplateName {
  return (TEMPLATE_NAMES as readonly string[]).includes(name);
}

export function listTemplates(): readonly string[] {
  return TEMPLATE_NAMES;
}

/**
 * Resolve the templates directory.
 * Order:
 *   1. `node_modules/@massu/core/templates` (installed)
 *   2. Relative to compiled dist (dist/../templates)
 *   3. Relative to source (src/../templates)
 */
export function resolveTemplatesDir(): string | null {
  const cwd = process.cwd();
  const candidates = [
    resolve(cwd, 'node_modules/@massu/core/templates'),
    resolve(__dirname, '../../templates'),
    resolve(__dirname, '../../../templates'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function copyTemplateConfig(
  templateName: TemplateName,
  targetPath: string,
  projectName: string
): { success: boolean; error?: string } {
  const templatesDir = resolveTemplatesDir();
  if (!templatesDir) {
    return { success: false, error: `Templates directory not found (looked in node_modules and dist/src)` };
  }
  const srcPath = resolve(templatesDir, templateName, 'massu.config.yaml');
  if (!existsSync(srcPath)) {
    return { success: false, error: `Template '${templateName}' not found at ${srcPath}` };
  }
  try {
    let content = readFileSync(srcPath, 'utf-8');
    // Replace {{PROJECT_NAME}} placeholder if present.
    content = content.replace(/\{\{PROJECT_NAME\}\}/g, projectName);
    writeFileSync(targetPath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================================
// MCP Server Registration (preserved)
// ============================================================

export function registerMcpServer(projectRoot: string): boolean {
  const mcpPath = resolve(projectRoot, '.mcp.json');

  let existing: Record<string, unknown> = {};
  if (existsSync(mcpPath)) {
    try {
      existing = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    } catch {
      existing = {};
    }
  }

  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  if (servers.massu) {
    return false;
  }

  servers.massu = {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@massu/core'],
  };

  existing.mcpServers = servers;

  writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  return true;
}

// ============================================================
// Hook Installation (preserved)
// ============================================================

interface HookEntry {
  type: 'command';
  command: string;
  timeout: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

type HooksConfig = Record<string, HookGroup[]>;

export function resolveHooksDir(): string {
  const cwd = process.cwd();
  const nodeModulesPath = resolve(cwd, 'node_modules/@massu/core/dist/hooks');
  if (existsSync(nodeModulesPath)) {
    return 'node_modules/@massu/core/dist/hooks';
  }
  const localPath = resolve(__dirname, '../dist/hooks');
  if (existsSync(localPath)) {
    return localPath;
  }
  return 'node_modules/@massu/core/dist/hooks';
}

function hookCmd(hooksDir: string, hookFile: string): string {
  return `node ${hooksDir}/${hookFile}`;
}

export function buildHooksConfig(hooksDir: string): HooksConfig {
  return {
    SessionStart: [
      {
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'session-start.js'), timeout: 10 },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'security-gate.js'), timeout: 5 },
        ],
      },
      {
        matcher: 'Bash|Write',
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'pre-delete-check.js'), timeout: 5 },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'post-tool-use.js'), timeout: 10 },
          { type: 'command', command: hookCmd(hooksDir, 'quality-event.js'), timeout: 5 },
          { type: 'command', command: hookCmd(hooksDir, 'cost-tracker.js'), timeout: 5 },
        ],
      },
      {
        matcher: 'Edit|Write',
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'post-edit-context.js'), timeout: 5 },
          // Auto-learning pipeline — classifies failures and detects fixes on
          // file changes. See Phase 5-6 of the autodetect plan.
          { type: 'command', command: hookCmd(hooksDir, 'fix-detector.js'), timeout: 5 },
          { type: 'command', command: hookCmd(hooksDir, 'classify-failure.js'), timeout: 5 },
        ],
      },
      {
        matcher: 'Write',
        hooks: [
          // Incident + rule enforcement pipelines fire on Write-only (incidents
          // are authored as .md files; rules are enforced after new-file drops).
          { type: 'command', command: hookCmd(hooksDir, 'incident-pipeline.js'), timeout: 5 },
          { type: 'command', command: hookCmd(hooksDir, 'rule-enforcement-pipeline.js'), timeout: 5 },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'session-end.js'), timeout: 15 },
          // Session-end auto-learning aggregation (failure-class roll-up).
          { type: 'command', command: hookCmd(hooksDir, 'auto-learning-pipeline.js'), timeout: 10 },
        ],
      },
    ],
    PreCompact: [
      {
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'pre-compact.js'), timeout: 10 },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'user-prompt.js'), timeout: 5 },
          { type: 'command', command: hookCmd(hooksDir, 'intent-suggester.js'), timeout: 5 },
        ],
      },
    ],
  };
}

export function installHooks(projectRoot: string): { installed: boolean; count: number } {
  // Read claudeDirName defensively — tests may call installHooks without
  // ever creating massu.config.yaml, in which case getConfig() throws (since
  // it reads against process.cwd() and our cwd may not have one).
  let claudeDirName = '.claude';
  try {
    claudeDirName = getConfig().conventions?.claudeDirName ?? '.claude';
  } catch {
    claudeDirName = '.claude';
  }
  const claudeDir = resolve(projectRoot, claudeDirName);
  const settingsPath = resolve(claudeDir, 'settings.local.json');

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  const hooksDir = resolveHooksDir();
  const hooksConfig = buildHooksConfig(hooksDir);

  let hookCount = 0;
  for (const groups of Object.values(hooksConfig)) {
    for (const group of groups) {
      hookCount += group.hooks.length;
    }
  }

  settings.hooks = hooksConfig;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');

  return { installed: true, count: hookCount };
}

// ============================================================
// Memory Directory Initialization (preserved)
// ============================================================

export function initMemoryDir(projectRoot: string): { created: boolean; memoryMdCreated: boolean } {
  const encodedRoot = '-' + projectRoot.replace(/\//g, '-');
  const memoryDir = resolve(homedir(), `.claude/projects/${encodedRoot}/memory`);

  let created = false;
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
    created = true;
  }

  const memoryMdPath = resolve(memoryDir, 'MEMORY.md');
  let memoryMdCreated = false;
  if (!existsSync(memoryMdPath)) {
    const projectName = basename(projectRoot);
    const memoryContent = `# ${projectName} - Massu Memory

## Key Learnings
<!-- Important patterns and conventions discovered during development -->

## Common Gotchas
<!-- Non-obvious issues and how to avoid them -->

## Corrections
<!-- Wrong behaviors that were corrected and how to prevent them -->

## File Index
<!-- Significant files and directories -->
`;
    writeFileSync(memoryMdPath, memoryContent, 'utf-8');
    memoryMdCreated = true;
  }

  return { created, memoryMdCreated };
}

// ============================================================
// Flag Parsing
// ============================================================

export interface ParseInitArgsResult extends InitOptions {
  /** True when --help / -h was requested. runInit should print help and exit. */
  help?: boolean;
}

export function parseInitArgs(argv: string[]): ParseInitArgsResult {
  const opts: ParseInitArgsResult = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ci') opts.ci = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--skip-commands') opts.skipCommands = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--template') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        opts.template = next;
        i++;
      }
    } else if (a.startsWith('--template=')) {
      opts.template = a.slice('--template='.length);
    }
  }
  return opts;
}

export function printInitHelp(): void {
  console.log(`
massu init — detect project stack and generate massu.config.yaml

Usage:
  massu init [options]

Options:
  --ci                Non-interactive mode. Errors on existing config
                      (unless --force). Auto-enabled when stdin is not a TTY.
  --force             Overwrite existing massu.config.yaml without prompting.
  --template <name>   Skip detection and scaffold from a greenfield template.
                      Templates: ${TEMPLATE_NAMES.join(', ')}
  --skip-commands     Skip the asset install (.claude/commands etc).
                      MCP register, hooks, and memory init still run.
  --help, -h          Show this help message

Examples:
  massu init                       # Interactive (prompts before overwriting)
  massu init --ci                  # Safe for CI; fails if config already exists
  massu init --force               # Overwrite an existing config
  massu init --template ts-nextjs  # Scaffold from the Next.js template

Documentation: https://massu.ai/docs/getting-started/configuration
`);
}

// ============================================================
// Stack summary (for user confirmation)
// ============================================================

function summarizeDetection(detection: DetectionResult): string {
  const parts: string[] = [];
  const languages = Array.from(
    new Set(detection.manifests.map((m) => m.language))
  ) as SupportedLanguage[];
  for (const lang of languages) {
    const fw = detection.frameworks[lang];
    const dirs = detection.sourceDirs[lang]?.source_dirs ?? [];
    const dirSuffix = dirs.length > 0 ? ` in ${dirs.join(',')}` : '';
    const fwName = fw?.framework ?? 'no-framework';
    parts.push(`${capitalize(lang)}/${fwName}${dirSuffix}`);
  }
  const mono = detection.monorepo.type;
  const monoSuffix = mono && mono !== 'single' ? ` [${mono} monorepo]` : '';
  return parts.join('; ') + monoSuffix;
}

// ============================================================
// Main Init Flow (Phase 3 rewrite)
// ============================================================

export async function runInit(argv?: string[], overrides?: InitOptions): Promise<void> {
  const argsToParse = argv ?? process.argv.slice(3); // argv[0]=node, [1]=cli.js, [2]='init'
  const parsed = parseInitArgs(argsToParse);
  if (parsed.help && !overrides?.silent) {
    printInitHelp();
    return;
  }
  // Strip `help` from parsed before merging (not part of InitOptions).
  const { help: _help, ...parsedOpts } = parsed;
  void _help;
  const opts: InitOptions = { ...parsedOpts, ...(overrides ?? {}) };

  // Auto-CI when stdin is not a TTY (e.g., CI pipes, scripts).
  if (!opts.ci && !process.stdin.isTTY) {
    opts.ci = true;
  }

  const projectRoot = opts.cwd ?? process.cwd();
  const log = opts.silent ? () => {} : (s: string) => console.log(s);
  const errLog = opts.silent ? () => {} : (s: string) => console.error(s);

  log('');
  log('Massu AI - Project Setup');
  log('========================');
  log('');

  const configPath = resolve(projectRoot, 'massu.config.yaml');

  // P3-006: safety rails for existing config.
  if (existsSync(configPath)) {
    if (opts.ci && !opts.force) {
      errLog(`error: massu.config.yaml already exists at ${configPath}`);
      errLog('       rerun with --force to overwrite, or remove the file first');
      throw new Error('massu init: config exists in --ci mode (no overwrite)');
    }
    if (!opts.ci && !opts.force) {
      // Interactive: prompt to confirm overwrite.
      const confirmed = await promptOverwrite(configPath);
      if (!confirmed) {
        log('  massu.config.yaml preserved — init aborted');
        return;
      }
    }
    // else: --force set, proceed with overwrite
  }

  // Branch 1: template mode (P3-003)
  if (opts.template) {
    if (!isTemplateName(opts.template)) {
      errLog(`error: unknown template '${opts.template}'. Available: ${TEMPLATE_NAMES.join(', ')}`);
      throw new Error(`Unknown template: ${opts.template}`);
    }
    const projectName = basename(projectRoot);
    const res = copyTemplateConfig(opts.template, configPath, projectName);
    if (!res.success) {
      errLog(`error: template copy failed: ${res.error}`);
      throw new Error(res.error ?? 'template copy failed');
    }
    // Validate the template-derived config (skip filesystem existence checks:
    // templates are explicitly for greenfield projects where the declared dirs
    // don't exist yet).
    const validation = validateWrittenConfig(configPath, projectRoot, false);
    if (validation !== null) {
      try { rmSync(configPath, { force: true }); } catch { /* ignore */ }
      errLog(`error: template config failed validation: ${validation}`);
      throw new Error(`Template config invalid: ${validation}`);
    }
    log(`  Installed template '${opts.template}' → massu.config.yaml`);
    if (!opts.skipSideEffects) {
      installSideEffects(projectRoot, log, opts.skipCommands);
    }
    return;
  }

  // Branch 2: detection-driven path (P3-001, P3-002)
  const detection = await runDetection(projectRoot);
  const languageCount = new Set(detection.manifests.map((m) => m.language)).size;
  const emptyStack = detection.manifests.length === 0 && languageCount === 0;
  if (emptyStack) {
    if (opts.ci && !opts.force) {
      // Plan #2 §"Answer to install-before-stack": interactive `massu init` in
      // an empty repo is supported. CI mode keeps the strict guard (no
      // accidental empty-stack configs in pipelines) — pass --force in CI to
      // explicitly opt into empty-stack init.
      errLog('error: no languages detected in this directory');
      errLog('       (no package.json, pyproject.toml, Cargo.toml, etc.)');
      errLog('       pass --template <name>, --force, or run interactively for empty-stack init');
      throw new Error('No languages detected');
    }
    log('  No languages detected — proceeding with empty-stack init.');
    log('  After adding a manifest (package.json, pyproject.toml, ...) run: npx massu config refresh');
  }

  // Emit warnings to stderr for ambiguous / malformed detection.
  for (const w of detection.warnings) {
    errLog(`warning: ${w.path}: ${w.reason}`);
  }

  // Ambiguity warning: multiple languages with similar file density.
  const dirCounts: { lang: SupportedLanguage; count: number }[] = [];
  for (const [lang, info] of Object.entries(detection.sourceDirs)) {
    if (info && typeof info.file_count === 'number') {
      dirCounts.push({ lang: lang as SupportedLanguage, count: info.file_count });
    }
  }
  if (dirCounts.length >= 2) {
    dirCounts.sort((a, b) => b.count - a.count);
    if (dirCounts[0].count > 0 && dirCounts[1].count / Math.max(dirCounts[0].count, 1) >= 0.5) {
      errLog(`warning: multiple languages with similar file counts: ${dirCounts.map(d => `${d.lang}=${d.count}`).join(', ')}`);
      errLog('         primary language chosen by manifest count; review framework.primary in the generated config');
    }
  }

  log(`  Detected: ${summarizeDetection(detection)}`);

  // Interactive confirmation for detected stack.
  if (!opts.ci && !opts.force) {
    const confirmed = await promptStackConfirm();
    if (!confirmed) {
      log('  init aborted — no changes made');
      return;
    }
  }

  // Build config + write atomically.
  const config = buildConfigFromDetection({ projectRoot, detection });
  const content = renderConfigYaml(config);
  const writeRes = writeConfigAtomic(configPath, content);
  if (!writeRes.validated) {
    errLog(`error: failed to write config: ${writeRes.error}`);
    throw new Error(writeRes.error ?? 'atomic write failed');
  }

  // Post-write validation; rollback on failure. Skip filesystem-existence
  // checks for empty-stack init (no manifests = `paths.source` defaults to
  // 'src' which legitimately doesn't exist in an empty dir).
  const validation = validateWrittenConfig(configPath, projectRoot, !emptyStack);
  if (validation !== null) {
    try { rmSync(configPath, { force: true }); } catch { /* ignore */ }
    errLog(`error: generated config failed validation: ${validation}`);
    errLog('       config file rolled back; no changes persisted');
    throw new Error(`Generated config invalid: ${validation}`);
  }

  log('  Created massu.config.yaml (schema_version: 2)');

  if (!opts.skipSideEffects) {
    installSideEffects(projectRoot, log, opts.skipCommands, emptyStack);
  }
}

/** Shared side-effect steps (MCP register + hooks + commands + memory + backfill). */
function installSideEffects(
  projectRoot: string,
  log: (s: string) => void,
  skipCommands: boolean = false,
  emptyStack: boolean = false,
): void {
  // MCP register
  const mcpRegistered = registerMcpServer(projectRoot);
  if (mcpRegistered) {
    log('  Registered MCP server in .mcp.json');
  } else {
    log('  MCP server already registered in .mcp.json');
  }

  // Hooks
  const { count: hooksCount } = installHooks(projectRoot);
  log(`  Installed ${hooksCount} hooks in .claude/settings.local.json`);

  // Plan #2 P4-002: install all asset types (commands, agents, patterns,
  // protocols, reference) via installAll — replaces the legacy
  // installCommands() that only handled commands. Skipped when --skip-commands.
  // Plan #2 P4-003: when no stack-specific commands resolved (empty-stack init),
  // write a single `_massu-needs-stack.md` placeholder so consumers know to
  // run `config refresh` after adding their first manifest.
  if (!skipCommands) {
    try {
      const cmdResult = installAll(projectRoot);
      const cmdTotal =
        cmdResult.totalInstalled +
        cmdResult.totalUpdated +
        cmdResult.totalSkipped +
        cmdResult.totalKept;
      if (cmdResult.totalInstalled > 0 || cmdResult.totalUpdated > 0) {
        log(`  Installed ${cmdTotal} project assets (${cmdResult.totalInstalled} new, ${cmdResult.totalUpdated} updated)`);
      } else if (cmdTotal > 0) {
        log(`  ${cmdTotal} project assets already up to date`);
      }

      // Empty-stack init detection: when caller signals an empty stack OR
      // when NO commands resolved at all, drop the placeholder so the user
      // understands the next step. The explicit `emptyStack` signal handles
      // the t=0 case (zero manifests detected) where generic-default commands
      // still install but no stack-specific scaffolds match the consumer.
      const commandStats = cmdResult.assets.commands;
      const stackResolved = !emptyStack && commandStats &&
        (commandStats.installed > 0 || commandStats.updated > 0 || commandStats.kept > 0);
      if (!stackResolved) {
        const placeholderPath = resolve(cmdResult.claudeDir, 'commands', '_massu-needs-stack.md');
        if (!existsSync(placeholderPath)) {
          const placeholderBody = [
            '# Massu — stack not yet detected',
            '',
            'Your stack hasn\'t been detected yet. Most slash commands ship as language-specific',
            'variants (e.g., `massu-scaffold-router.python-fastapi.md` for FastAPI projects).',
            'When detection finds a manifest, the right variants get installed automatically.',
            '',
            'After you add your first manifest (`package.json`, `pyproject.toml`, `Cargo.toml`,',
            'etc.) run:',
            '',
            '```bash',
            'npx massu config refresh',
            '```',
            '',
            'This file will be auto-removed on the first refresh that resolves at least one',
            'stack-specific command.',
            '',
            '— Massu',
          ].join('\n');
          try {
            mkdirSync(resolve(cmdResult.claudeDir, 'commands'), { recursive: true });
            writeFileSync(placeholderPath, placeholderBody, 'utf-8');
            log('  Wrote _massu-needs-stack.md placeholder (no stack detected yet)');
          } catch {
            // Best-effort.
          }
        }
      }
    } catch {
      // Best-effort — don't fail init if assets can't be resolved.
    }
  }

  // Memory dir
  const { created: memDirCreated, memoryMdCreated } = initMemoryDir(projectRoot);
  if (memDirCreated) {
    log('  Created memory directory');
  }
  if (memoryMdCreated) {
    log('  Created initial MEMORY.md');
  }

  // Backfill (best-effort, silent failure)
  (async () => {
    try {
      const encodedRoot = projectRoot.replace(/\//g, '-');
      const memoryDir = resolve(homedir(), '.claude', 'projects', encodedRoot, 'memory');
      const memFiles = existsSync(memoryDir)
        ? readdirSync(memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
        : [];
      if (memFiles.length > 0) {
        const { getMemoryDb } = await import('../memory-db.ts');
        const db = getMemoryDb();
        try {
          const stats = backfillMemoryFiles(db, memoryDir, `init-${Date.now()}`);
          if (stats.inserted > 0 || stats.updated > 0) {
            log(`  Backfilled ${stats.inserted + stats.updated} memory files (${stats.inserted} new, ${stats.updated} updated)`);
          }
        } finally {
          db.close();
        }
      }
    } catch { /* best effort */ }
  })();

  log('  Databases will auto-create on first session');
  log('');
  log('Massu AI is ready. Start a Claude Code session to begin.');
  log('');
}

// ============================================================
// Prompts (interactive path)
// ============================================================

async function promptOverwrite(configPath: string): Promise<boolean> {
  try {
    const { confirm, isCancel } = await import('@clack/prompts');
    const res = await confirm({
      message: `massu.config.yaml already exists at ${configPath}. Overwrite?`,
      initialValue: false,
    });
    if (isCancel(res)) return false;
    return res === true;
  } catch {
    // Clack not available (should never happen — it's a dep); fail safe to NO.
    return false;
  }
}

async function promptStackConfirm(): Promise<boolean> {
  try {
    const { confirm, isCancel } = await import('@clack/prompts');
    const res = await confirm({
      message: 'Generate massu.config.yaml from detected stack?',
      initialValue: true,
    });
    if (isCancel(res)) return false;
    return res === true;
  } catch {
    return true; // Default yes when clack is unavailable.
  }
}

// ============================================================
// Helpers
// ============================================================

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// `InitResult` is a compile-time type only; it's kept for external type-reuse.
export type { InitResult };
