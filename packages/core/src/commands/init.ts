// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// @scanner-allow:large-file
// P-M-031 (plan-stage-d-medium-sweep): `massu init` is a single end-to-end
// install flow that must orchestrate detection → templating → .claude/
// scaffolding → MCP wiring → permissions seeding → first-run smoke test.
// Each phase is sequential and difficult to factor out without breaking
// the atomicity invariant (partial inits are worse than no init). 1823 LOC
// is structural; Check 21 prevents un-acknowledged growth above the cap.

/**
 * `massu init` — One-command, detection-driven project setup.
 *
 * Phase 3 rewrite (2026-04-19): replaces the JS/TS template copier (old
 * detectFramework/generateConfig path, root cause of multi-runtime stale-config drift)
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
import { execFileSync } from 'child_process';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { backfillMemoryFiles } from '../memory-file-ingest.ts';
import { getConfig, resetConfig } from '../config.ts';
import { installAll } from './install-commands.ts';
import { readSettingsLocal, writeSettingsLocalAtomic } from '../lib/settings-local.ts';
import { encodeMemoryDirName } from '../lib/memory-path.ts';
import { HOOK_TIMEOUTS } from '../lib/hook-timeouts.ts';
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
  /**
   * Plan 1.5.4: skip AST adapter introspection that surfaces under
   * `detected.<adapter-id>:` blocks. Default false (introspect runs);
   * set true via `--no-introspect` for fast sync-only init or when
   * the AST tier's grammar download isn't desirable.
   */
  skipIntrospect?: boolean;
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

  // P-H004 (plan-stage-c-high-batch): App Router / Pages Router fallback.
  // When pathsSource would default to 'src' but src/ doesn't exist, check
  // recognized framework conventions before failing validation. Fixes
  // `massu init` outright failure on fresh Next.js 14+ App Router repos
  // (have `app/` + `package.json`, no `src/`) and Pages Router (`pages/`).
  // Final fallback to '.' makes flat-layout projects work too.
  if (pathsSource === 'src' && !existsSync(resolve(projectRoot, 'src'))) {
    const fallbacks = ['app', 'pages', '.'];
    for (const fallback of fallbacks) {
      if (fallback === '.' || existsSync(resolve(projectRoot, fallback))) {
        pathsSource = fallback;
        break;
      }
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
 * Plan 1.5.1 §3 — variant template merge.
 *
 * Map from detected `framework.languages.<lang>.framework` value → variant
 * template directory under `packages/core/templates/`. Most detected
 * frameworks map 1:1 to a template dir of the same name, but a few have
 * naming divergence (e.g., detection emits `spring-boot` but the template
 * dir is `spring`; detection emits `chi` but the template dir is `go-chi`).
 *
 * The mapping is intentionally tight — only frameworks with an actual
 * variant template under `templates/` are listed. Adding a new framework
 * = one entry here + one templates/<id>/massu.config.yaml file. The
 * `manifest-registry-drift.test.ts` already gates the manifest side; the
 * `init-end-to-end.test.ts` gates this map.
 */
const FRAMEWORK_TO_TEMPLATE_ID: Record<string, string> = {
  rails: 'rails',
  phoenix: 'phoenix',
  'aspnet-core': 'aspnet',
  'spring-boot': 'spring',
  chi: 'go-chi',
  flask: 'python-flask',
};

/**
 * After `buildConfigFromDetection` produces a baseline config, look up the
 * variant template for the detected framework (if any) and selectively
 * merge fields. The variant wins on a small allowlist:
 *   - `framework.router`
 *   - `framework.orm`
 *   - `framework.ui`
 *   - `paths.source`
 *   - `verification.<lang>.{lint,syntax,test,type,build}` — variant lint
 *     is the canonical project-style command (rubocop, credo, etc.) and
 *     should not be overridden by the generic detection default.
 *
 * The variant template's `framework.type`, `framework.languages`,
 * `project.name`, `domains`, and `rules` are NOT merged — those come from
 * detection and reflect the actual repo state. Allowlist keeps the merge
 * precise; future fields require an explicit decision.
 */
export function applyVariantTemplate(
  config: Record<string, unknown>,
  templatesDir: string | null,
): Record<string, unknown> {
  if (!templatesDir) return config;
  const fw = config.framework as Record<string, unknown> | undefined;
  if (!fw) return config;
  const langs = fw.languages as Record<string, unknown> | undefined;
  if (!langs || typeof langs !== 'object') return config;

  // Find the first language that has a `framework` value with a known
  // variant template. Most projects have ONE primary language; in
  // monorepos the detection-driven primary is what we honor.
  let templateId: string | null = null;
  for (const langEntry of Object.values(langs)) {
    if (langEntry && typeof langEntry === 'object') {
      const fwName = (langEntry as Record<string, unknown>).framework;
      if (typeof fwName === 'string' && FRAMEWORK_TO_TEMPLATE_ID[fwName]) {
        templateId = FRAMEWORK_TO_TEMPLATE_ID[fwName];
        break;
      }
    }
  }
  if (templateId === null) return config;

  const templatePath = resolve(templatesDir, templateId, 'massu.config.yaml');
  if (!existsSync(templatePath)) return config;

  let template: Record<string, unknown>;
  try {
    // pattern-scanner-allow: yaml-parse — reason: this loads a per-framework
    // variant config-template shipped inside @massu/core. getConfig() reads
    // the project's massu.config.yaml from cwd; this is a SEPARATE file
    // (the template) that doesn't pass through that cache and isn't a Zod-
    // validated config — it's a partial override map.
    template = yamlParse(readFileSync(templatePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return config;
  }

  const out = { ...config };
  const tplFw = template.framework as Record<string, unknown> | undefined;
  const outFw = (out.framework as Record<string, unknown>) ?? {};
  if (tplFw) {
    if (typeof tplFw.router === 'string' && (!outFw.router || outFw.router === 'none')) {
      outFw.router = tplFw.router;
    }
    if (typeof tplFw.orm === 'string' && (!outFw.orm || outFw.orm === 'none')) {
      outFw.orm = tplFw.orm;
    }
    if (typeof tplFw.ui === 'string' && (!outFw.ui || outFw.ui === 'none')) {
      outFw.ui = tplFw.ui;
    }
  }
  out.framework = outFw;

  const tplPaths = template.paths as Record<string, unknown> | undefined;
  const outPaths = (out.paths as Record<string, unknown>) ?? {};
  if (tplPaths && typeof tplPaths.source === 'string' && tplPaths.source) {
    outPaths.source = tplPaths.source;
  }
  out.paths = outPaths;

  const tplVerify = template.verification as Record<string, Record<string, unknown>> | undefined;
  const outVerify = (out.verification as Record<string, Record<string, unknown>>) ?? {};
  if (tplVerify) {
    for (const [lang, tplLangVerify] of Object.entries(tplVerify)) {
      if (!tplLangVerify || typeof tplLangVerify !== 'object') continue;
      const outLangVerify = outVerify[lang] ?? {};
      // Variant wins on lint + syntax (canonical project commands like
      // rubocop, credo, golangci-lint that the generic detection layer
      // doesn't know to suggest). For test/type/build, prefer detection-
      // derived values when present (e.g., monorepo `cd packages/foo`
      // prefixing) and fall back to variant template otherwise.
      for (const key of ['lint', 'syntax']) {
        if (typeof tplLangVerify[key] === 'string' && tplLangVerify[key]) {
          outLangVerify[key] = tplLangVerify[key];
        }
      }
      for (const key of ['test', 'type', 'build']) {
        if (
          typeof tplLangVerify[key] === 'string' &&
          tplLangVerify[key] &&
          !outLangVerify[key]
        ) {
          outLangVerify[key] = tplLangVerify[key];
        }
      }
      outVerify[lang] = outLangVerify;
    }
  }
  if (Object.keys(outVerify).length > 0) {
    out.verification = outVerify;
  }

  return out;
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
    // pattern-scanner-allow: yaml-parse — reason: atomic-write post-validator. We just generated `content` and wrote it to a tmp path; before atomic rename to the final config path we re-parse to verify the bytes we serialized are valid YAML. Calling getConfig() here would re-read from cwd and miss the tmp file.
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
    // pattern-scanner-allow: yaml-parse — reason: see preceding comment block; getConfig() caches against process.cwd() and would either return a stale entry or fail to read a config at an arbitrary projectRoot.
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
    // Project-local install: `<project>/node_modules/@massu/core/templates`.
    resolve(cwd, 'node_modules/@massu/core/templates'),
    // Bundled cli.js layout: cli.js sits at `<package>/dist/cli.js`, so
    // templates live one level up at `<package>/templates`. (Plan 1.5.1
    // bug discovery: pre-existing layout assumed `dist/commands/init.js`
    // depth which never matched the bundled cli, so resolveTemplatesDir
    // returned null in production for both `--template` mode AND the
    // applyVariantTemplate path.)
    resolve(__dirname, '../templates'),
    // Legacy nested layouts retained as fallbacks (in case a future
    // build moves cli.js back into a subdirectory).
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

/**
 * Read the installer's OWN package.json version. The installer runs from
 * its compiled `dist/cli.js` (under npx cache or a global install); the
 * package.json sits one directory up from that. Used to pin downstream
 * MCP server invocations and hook commands so customers don't drift onto
 * unpinned `@massu/core` (which would resolve to the latest dist-tag on
 * every spawn and silently change behavior across versions).
 *
 * Hard error if the package.json can't be read or has no version field —
 * an unpinned write is a structural drift bug (P-002) and silently
 * falling back to an unversioned `@massu/core` is what we're closing.
 */
export function getInstallerVersion(): string {
  // Walk up from this module's compiled location to find package.json.
  // Compiled layout: <root>/dist/cli.js → ../package.json
  // TS source layout: <root>/src/commands/init.ts → ../../package.json
  const candidates = [
    resolve(__dirname, '../package.json'),
    resolve(__dirname, '../../package.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
        if (typeof pkg.version === 'string' && pkg.version.length > 0 && pkg.name === '@massu/core') {
          return pkg.version;
        }
      } catch { /* try next */ }
    }
  }
  throw new Error(
    'getInstallerVersion: could not resolve @massu/core package.json. ' +
      'This indicates a corrupt install. Re-install via `npx -y @massu/core init`.',
  );
}

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

  // P-002: pin the version so customers don't drift onto unpinned `@massu/core`
  // (which resolves to the latest dist-tag on every spawn). Closes the structural
  // class flagged by feedback_mcp_pin_version_in_mcp_json (precedent: 0b60916).
  //
  // CR-70 L3-1 SYMMETRY, amended by plan-2026-08-01 phase B: this emitter and
  // `hookCmd`/`buildHooksConfig` must share ONE launch mechanism. Both now read the SAME
  // `resolveMassuRuntimeCli(version)`, so they cannot diverge by construction. Previously
  // they were kept in step only by both hard-coding `npx` — which the drift-guard asserted
  // as a LITERAL, so it pinned an implementation detail rather than the property. Real
  // divergence was still reachable by hand-edit and was found live in one workspace
  // (a `bash -c` shim exporting a pinned Node bin dir onto PATH and
  // exec'ing npx at an older pin, as the server, vs
  // bare-npx hooks) — the asymmetry that masked the 2026-07-22 native-ABI incident.
  const version = getInstallerVersion();
  const shim = resolveMassuShim();
  servers.massu = shim !== null
    ? { type: 'stdio', command: shim, args: [version] }
    : { type: 'stdio', command: 'npx', args: ['-y', `@massu/core@${version}`] };

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

/**
 * @deprecated P-003 (1.9.4+): the path returned here is unsafe to bake into
 * settings.json — under npx, `__dirname` resolves to whatever cache directory
 * npx happens to use, which is invalidated on cache clear / upgrade / move.
 *
 * Retained only for backward compatibility with `buildHooksConfig(hooksDir)`
 * callers in existing tests. New code should NEVER consume the returned path
 * verbatim in a command line; use `hook-runner` invocations instead (see
 * `buildHooksConfig` which now ignores the argument).
 */
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

// ============================================================
// Massu runtime resolution (plan-2026-08-01, phase B)
// ============================================================
//
// WHY. `npx -y @massu/core@<v> …` costs ~0.86 s of npm BOOTSTRAP on each hook invocation.
// Measured interleaved, min-of-5, same host:
//
//     npx -y @massu/core@2.4.0   0.97 s
//     npx --offline -y ...       0.88 s   <- --offline recovers just 0.11 s
//     node <dist/cli.js>         0.11 s
//
// The cost is npm starting up, NOT the registry — so no npx flag fixes it; not invoking
// npx is what fixes it. Resolving once at INSTALL time and emitting an absolute `node`
// command makes a hook ~9x cheaper (re-measured post-implementation: 0.11 vs 1.07).
//
// THE PATH IS MASSU-OWNED AND VERSION-KEYED, deliberately NOT npm's `~/.npm/_npx/<hash>/`:
// that hash is content-derived, changes on a version bump, and npm may garbage-collect it.
// Version-keying also lets two differently-pinned repos coexist.
//
// FAIL-SAFE IS THE WHOLE DESIGN. Claude Code does not report a missing or failing hook
// command, so a wrong path kills the repo's hooks SILENTLY — the exact failure class this
// plan exists to end. node-direct is therefore an OPTIMISATION that must never produce a
// broken registration: the resolver hands back a path only after PROBING that it runs
// (CR-67 — success is not a receipt), and callers fall back to the always-works npx form on
// any doubt. A failed materialisation degrades to "slower", never to "dead".

/**
 * Root of the massu-owned, version-keyed runtime tree.
 *
 * `home` is INJECTABLE — the repo-wide convention (`credentials.ts`, `db-backup.ts`,
 * `memory-backup.ts`, `memory-authorship.ts`, `security/local-share-signer.ts`,
 * `shared-memory-transport.ts`, …). A default of `homedir()` keeps every production caller
 * unchanged while giving a test a root it can point somewhere harmless. See the note on
 * `massuShimPath` for the incident that made this non-optional.
 */
export function massuRuntimeDir(version: string, home: string = homedir()): string {
  return resolve(home, '.massu', 'runtime', version);
}

/** Where the CLI lands inside a materialised runtime. */
export function massuRuntimeCliPath(version: string, home: string = homedir()): string {
  return resolve(massuRuntimeDir(version, home), 'node_modules', '@massu', 'core', 'dist', 'cli.js');
}

/**
 * Return a VERIFIED-RUNNABLE absolute cli.js path for `version`, or `null`.
 *
 * Never throws, never installs. `null` means "use npx" — the safe default.
 * `MASSU_NO_NODE_DIRECT=1` forces npx (G11: a mitigation needs a named, provable OFF
 * switch). Tests set it so their result cannot depend on machine state.
 */
export function resolveMassuRuntimeCli(version: string, home: string = homedir()): string | null {
  if (process.env.MASSU_NO_NODE_DIRECT === '1') return null;
  const cli = massuRuntimeCliPath(version, home);
  if (!existsSync(cli)) return null;
  try {
    // EXISTENCE IS NOT RUNNABILITY: a truncated or partial install leaves the file present
    // and the hook dead. Probe before trusting it.
    execFileSync(process.execPath, [cli, '--version'], { stdio: 'ignore', timeout: 20_000 });
    return cli;
  } catch {
    return null;
  }
}

/**
 * Materialise the runtime for `version` if absent. Returns true only when the result
 * PROBES runnable. Never throws — a false return keeps the caller on npx.
 */
export function materializeMassuRuntime(version: string, home: string = homedir()): boolean {
  if (process.env.MASSU_NO_NODE_DIRECT === '1') return false;
  if (resolveMassuRuntimeCli(version, home) !== null) return true; // idempotent no-op
  const dir = massuRuntimeDir(version, home);
  try {
    mkdirSync(dir, { recursive: true });
    execFileSync(
      'npm',
      ['install', '--prefix', dir, `@massu/core@${version}`, '--no-audit', '--no-fund', '--loglevel=error'],
      { stdio: 'ignore', timeout: 300_000 },
    );
  } catch {
    return false; // network down, registry 404, disk full — each degrades to npx
  }
  // Re-probe: `npm install` exiting 0 is not proof the CLI runs (CR-67).
  return resolveMassuRuntimeCli(version, home) !== null;
}

// ------------------------------------------------------------------
// The VERSION-STABLE launcher shim
// ------------------------------------------------------------------
//
// WHY A SHIM AND NOT A BAKED PATH. P-003 (v1.9.4, `init-hook-paths-no-absolute.test.ts`)
// moved hooks to npx expressly to eliminate baked absolute paths, because such a path is
// "invalidated by cache clears, global-install relocations, or npx upgrades — silently
// 404-ing the hooks ... without any visible signal to the customer." Emitting
// `node ~/.massu/runtime/<version>/…/cli.js` would reintroduce exactly that: a probe at
// EMIT time says nothing about INVALIDATION AFTER EMIT, and deleting the runtime would
// silently kill the hooks of any repo pinned to it.
//
// The shim resolves that conflict rather than trading it away. Its path NEVER changes
// across version bumps, and it re-resolves AT FIRE TIME, falling back to npx when the
// runtime is absent. So a stale registration degrades to "slower" and self-heals the
// moment the runtime reappears — instead of dying.
//
// THREE FAIL-SAFE LAYERS, so no single missing artifact is fatal:
//   shim missing at EMIT     -> emit npx                     (today's behaviour)
//   runtime missing at FIRE  -> shim execs npx               (self-healing)
//   both present             -> fast path (~9x: 0.11 vs 1.07 s, measured)
//
// win32 is deliberately excluded: the shim is POSIX sh, so Windows keeps the npx form.

/**
 * Stable, version-independent shim path. Never changes across upgrades.
 *
 * `home` IS INJECTABLE, AND THAT IS LOAD-BEARING, NOT COSMETIC (2026-08-11).
 * This resolved `homedir()` unconditionally, so `installMassuShim()` could only ever write
 * into the operator's REAL home — and `massu-shim-drift-guard.test.ts` calls it in a
 * `beforeAll`. Running `npm test` therefore INSTALLED a live shim on the developer's
 * machine. Measured: `~/.massu/bin/massu-hook` carried an mtime from the middle of a test
 * run. That test already isolated HOME for RUNNING the shim ("so the real runtime tree is
 * never consulted") and missed the INSTALL — the write half is the one that gets missed.
 *
 * It also had a second-order effect that hid a dead gate: once the shim exists,
 * `resolveMassuShim()` is non-null, so `hookCmd` takes the shim branch and the
 * anti-vacuity plant aimed at the npx branch became INERT —
 * `init-hook-paths-no-absolute.test.ts` was reported DECORATION by the sweep. A test that
 * mutates the machine can silently change which code path every other test exercises.
 *
 * Same class as `d76ab2c8` (the memory-store root), which is why this is a parameter
 * rather than a new env var: `home = homedir()` is the convention already used by ~20
 * modules here, and a second mechanism beside them would be the N+1th.
 */
export function massuShimPath(home: string = homedir()): string {
  return resolve(home, '.massu', 'bin', 'massu-hook');
}

/**
 * The shim body. Resolves the runtime at FIRE time and falls back to npx.
 *
 * `exec` in both branches so stdin, stdout, stderr and the exit code pass through
 * untouched — a hook that swallowed its exit code or truncated stdout would be a new
 * silent-failure class (CR-70 L2-6, re-exec fidelity).
 */
export function massuShimBody(): string {
  return `#!/bin/sh
# massu launcher shim — GENERATED, do not edit. Recreated by \`massu install-hooks\`.
#
# usage: massu-hook <version> <subcommand...>
#
# Resolves the massu runtime AT FIRE TIME so a deleted/moved runtime degrades to npx
# instead of silently 404-ing the hook (the P-003 failure class). exec preserves stdin,
# stdout, stderr and the exit code.
set -u
if [ "$#" -lt 1 ]; then
  echo "massu-hook: missing <version> argument" >&2
  exit 2
fi
MASSU_VERSION="$1"
shift
MASSU_CLI="\${HOME}/.massu/runtime/\${MASSU_VERSION}/node_modules/@massu/core/dist/cli.js"
if [ -f "\$MASSU_CLI" ]; then
  exec node "\$MASSU_CLI" "\$@"
fi
exec npx -y "@massu/core@\${MASSU_VERSION}" "\$@"
`;
}

/**
 * Write (or refresh) the shim. Returns true only when it EXISTS AND EXECUTES.
 * Never throws — false simply keeps callers on npx.
 */
export function installMassuShim(home: string = homedir()): boolean {
  if (process.env.MASSU_NO_NODE_DIRECT === '1') return false;
  if (process.platform === 'win32') return false;
  const shim = massuShimPath(home);
  try {
    mkdirSync(dirname(shim), { recursive: true });
    writeFileSync(shim, massuShimBody(), 'utf-8');
    chmodSync(shim, 0o755);
  } catch {
    return false;
  }
  try {
    // WRITING IS NOT WORKING (CR-67). Run it: a bogus version must still exit non-fatally
    // via the npx branch, but `--help`-less probing would spawn npx, so probe the ARG
    // GUARD instead — no args must exit 2 with the usage line. That proves the file is
    // present, executable, and running our body, without touching the network.
    execFileSync(shim, [], { stdio: 'ignore', timeout: 10_000 });
    return false; // exit 0 with no args means this is NOT our shim
  } catch (e) {
    const status = (e as { status?: number }).status;
    return status === 2; // our guard fired => shim is live
  }
}

/** The shim path if it is present and executable, else null. */
export function resolveMassuShim(home: string = homedir()): string | null {
  if (process.env.MASSU_NO_NODE_DIRECT === '1') return null;
  if (process.platform === 'win32') return null;
  const shim = massuShimPath(home);
  if (!existsSync(shim)) return null;
  try {
    execFileSync(shim, [], { stdio: 'ignore', timeout: 10_000 });
    return null; // exit 0 on no args => not our shim
  } catch (e) {
    return (e as { status?: number }).status === 2 ? shim : null;
  }
}

/**
 * Build a single hook-command line.
 *
 * Emits `"<shim>" <version> hook-runner <name>` when the stable shim is live, otherwise
 * the historical `npx -y @massu/core@<version> hook-runner <name>`. Both forms end in
 * `hook-runner <name>`, which is what `massuHookIdentity` keys on — so switching between
 * them REPLACES the registration rather than adding a second (phase A).
 *
 * The version stays VISIBLE in the emitted command (rather than hidden in shim state) so
 * `.claude/settings.local.json` remains auditable at a glance and the shim stays stateless.
 */
function hookCmd(version: string, hookName: string, shim: string | null): string {
  if (shim !== null) return `"${shim}" ${version} hook-runner ${hookName}`;
  return `npx -y @massu/core@${version} hook-runner ${hookName}`;
}

// P-E-021 (plan-stage-e-low-info-sweep): single source of truth for hook
// timeouts. HOOK_TIMEOUTS imported above; this helper just provides a
// safe default for any future hook not in the table.
function getHookTimeout(name: string): number {
  return HOOK_TIMEOUTS[name] ?? 5;
}

/**
 * Build the canonical Claude Code hooks configuration. The legacy
 * `hooksDir` parameter is now ignored; we emit `hook-runner` invocations
 * instead of `node <abs-path>` (see P-003). The parameter is retained
 * for backward-compatible call sites (existing tests pass a dir).
 */
/**
 * `shim` is INJECTABLE so a caller can build EITHER command form on demand.
 *
 * It used to be resolved internally with no seam, which made the emitted form a function of
 * ambient machine state: shim present => the shim branch, shim absent => the npx branch.
 * A drift-guard over these commands then only ever saw ONE of the two shapes, and which one
 * depended on the developer's machine. That is how `init-hook-paths-no-absolute.test.ts`
 * became DECORATION — the anti-vacuity plant targeted the npx branch while every local run
 * took the shim branch, so the planted absolute path never reached a command and the guard
 * stayed GREEN (2026-08-11 sweep).
 *
 * The default preserves every production call site exactly (default parameters are
 * evaluated per call, so `resolveMassuShim()` still runs once per build, not at module
 * load). Passing `null` forces the npx form; passing a path forces the shim form.
 */
export function buildHooksConfig(
  _hooksDir?: string,
  // Resolve ONCE per build, not per hook: the probe spawns a process, and 16 probes would
  // reintroduce exactly the per-invocation cost this phase removes.
  shim: string | null = resolveMassuShim(),
): HooksConfig {
  const version = getInstallerVersion();
  return {
    SessionStart: [
      {
        hooks: [
          { type: 'command', command: hookCmd(version, 'session-start', shim), timeout: getHookTimeout('session-start') },
        ],
      },
    ],
    PreToolUse: [
      // P-E-019 (plan-stage-e-low-info-sweep): consolidated PreToolUse
      // gate. Single hook spawn covers BOTH security-gate (Bash
      // dangerous-pattern + Write/Edit protected-path + Python
      // dangerous-code) AND pre-delete-check (sentinel feature impact +
      // Python import graph). Cuts ~200ms of cold-start spawn overhead
      // per tool call. Matcher includes both Bash + Write so the single
      // hook fires once for every operation either check cares about.
      {
        matcher: 'Bash|Write|Edit',
        hooks: [
          { type: 'command', command: hookCmd(version, 'pre-tool-use-gate', shim), timeout: getHookTimeout('pre-tool-use-gate') },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          { type: 'command', command: hookCmd(version, 'post-tool-use', shim), timeout: getHookTimeout('post-tool-use') },
          { type: 'command', command: hookCmd(version, 'quality-event', shim), timeout: getHookTimeout('quality-event') },
          { type: 'command', command: hookCmd(version, 'cost-tracker', shim), timeout: getHookTimeout('cost-tracker') },
        ],
      },
      {
        matcher: 'Edit|Write',
        hooks: [
          { type: 'command', command: hookCmd(version, 'post-edit-context', shim), timeout: getHookTimeout('post-edit-context') },
          // Auto-learning pipeline — classifies failures and detects fixes on
          // file changes. See Phase 5-6 of the autodetect plan.
          { type: 'command', command: hookCmd(version, 'fix-detector', shim), timeout: getHookTimeout('fix-detector') },
          { type: 'command', command: hookCmd(version, 'classify-failure', shim), timeout: getHookTimeout('classify-failure') },
        ],
      },
      {
        matcher: 'Write',
        hooks: [
          // Incident + rule enforcement pipelines fire on Write-only (incidents
          // are authored as .md files; rules are enforced after new-file drops).
          { type: 'command', command: hookCmd(version, 'incident-pipeline', shim), timeout: getHookTimeout('incident-pipeline') },
          { type: 'command', command: hookCmd(version, 'rule-enforcement-pipeline', shim), timeout: getHookTimeout('rule-enforcement-pipeline') },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          { type: 'command', command: hookCmd(version, 'session-end', shim), timeout: getHookTimeout('session-end') },
          // Session-end auto-learning aggregation (failure-class roll-up).
          { type: 'command', command: hookCmd(version, 'auto-learning-pipeline', shim), timeout: getHookTimeout('auto-learning-pipeline') },
        ],
      },
    ],
    PreCompact: [
      {
        hooks: [
          { type: 'command', command: hookCmd(version, 'pre-compact', shim), timeout: getHookTimeout('pre-compact') },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          { type: 'command', command: hookCmd(version, 'user-prompt', shim), timeout: getHookTimeout('user-prompt') },
          { type: 'command', command: hookCmd(version, 'intent-suggester', shim), timeout: getHookTimeout('intent-suggester') },
          // plan-living-memory-slice-1 P3-002: automatic relevant-recall.
          // Injects a compact "🧠 Relevant memory" block; fails open (empty).
          { type: 'command', command: hookCmd(version, 'memory-recall', shim), timeout: getHookTimeout('memory-recall') },
        ],
      },
    ],
  };
}

/**
 * Deep-merge two hooks configurations. P-012 (1.9.4+) — mirrors the 1.8.0
 * permissions merge pattern; closes the structural class where wholesale
 * `settings.hooks = newConfig` silently destroyed customer-defined hooks
 * on every reinstall.
 *
 * Merge semantics:
 *   - Top-level keys (event names: SessionStart, PreToolUse, ...) are unioned.
 *   - For each event, hook-groups are merged by `matcher` (or "" if no matcher).
 *     This is the same identity key Claude Code uses for dispatch — two groups
 *     with the same matcher MUST be coalesced or the dispatcher will pick one
 *     and silently drop the other.
 *   - Within a merged group, hook entries are deduplicated by `command` string
 *     (exact match). Massu's own canonical entries are emitted first, then any
 *     customer entries that don't collide. This preserves customer hooks while
 *     keeping Massu's pipeline behavior deterministic.
 *
 * Massu canonical entries are identified by the `npx -y @massu/core@<version>
 * hook-runner ` prefix. ANY entry not matching that prefix is treated as
 * customer-defined and preserved verbatim across reinstalls — including
 * legacy entries from older `@massu/core` versions, which the customer can
 * clean up at their leisure.
 */
export function mergeHooksConfig(
  existing: HooksConfig,
  additions: HooksConfig,
): HooksConfig {
  const eventNames = new Set<string>([
    ...Object.keys(existing ?? {}),
    ...Object.keys(additions ?? {}),
  ]);

  const merged: HooksConfig = {};
  for (const event of eventNames) {
    const existingGroups = (existing?.[event] ?? []) as HookGroup[];
    const additionGroups = (additions?.[event] ?? []) as HookGroup[];

    // Index by matcher key (use "" sentinel for groups with no matcher).
    const byMatcher = new Map<string, HookGroup>();

    // Pass 1: seed with EXISTING groups (preserves customer order + structure).
    for (const group of existingGroups) {
      const key = group.matcher ?? '';
      const existingGroup = byMatcher.get(key);
      if (existingGroup) {
        // Two existing groups with same matcher — unusual but coalesce defensively.
        existingGroup.hooks = mergeHookEntries(existingGroup.hooks, group.hooks);
      } else {
        byMatcher.set(key, { ...group, hooks: [...(group.hooks ?? [])] });
      }
    }

    // Pass 2: merge ADDITIONS into the indexed groups.
    for (const group of additionGroups) {
      const key = group.matcher ?? '';
      const existingGroup = byMatcher.get(key);
      if (existingGroup) {
        existingGroup.hooks = mergeHookEntries(existingGroup.hooks, group.hooks);
      } else {
        byMatcher.set(key, { ...group, hooks: [...(group.hooks ?? [])] });
      }
    }

    merged[event] = Array.from(byMatcher.values());
  }
  return merged;
}

/**
 * The stable IDENTITY of a Massu-emitted hook registration, or `null` for any
 * entry Massu does not own.
 *
 * WHY THIS EXISTS (plan-2026-08-01, phase A). `mergeHookEntries` used to dedup by
 * EXACT COMMAND STRING. The emitted command embeds the version, so
 *
 *     npx -y @massu/core@1.16.2 hook-runner user-prompt
 *     npx -y @massu/core@2.4.0  hook-runner user-prompt
 *
 * were two different strings => two different hooks => BOTH kept. The command was
 * simultaneously the payload and the identity, so every payload change forged a new
 * identity and the installer ADDED where it meant to REPLACE. Measured consequences:
 * one workspace carried 1.15.5 x16 + 1.15.2 x15 with 15 hooks firing twice per event, and
 * the fleet stayed stranded on a pre-2.0.0 version because upgrading duplicated —
 * another accumulated 26,119 NODE_MODULE_VERSION failures as a result.
 * Incident (internal): 2026-08-01-installer-adds-hook-registrations-instead-of-replacing
 *
 * IDENTITY IS THE `hook-runner` SUBCOMMAND, which is a stable CLI contract (`cli.ts`
 * dispatches on exactly this token) rather than an incidental substring. It is invariant
 * under BOTH mutations this plan makes: a version bump AND the npx -> node-direct launch
 * change, since every form ends `... hook-runner <name>`.
 *
 * DEVIATION FROM THE PLAN'S D-1, recorded deliberately: D-1 specified an EXPLICIT identity
 * key written into the entry. Rejected at implementation on evidence — an enumeration of all
 * 345 hook entries on this machine found exactly two key sets (`command,type` and
 * `command,timeout,type`) and ZERO precedent for a non-standard field. Writing an unknown key
 * into `settings.local.json` risks Claude Code rejecting the block, which would silently kill
 * every hook in the repo — the exact catastrophic-and-silent failure this plan exists to end.
 * The subcommand token achieves the same replace-not-add property with no wire-format change.
 */
export function massuHookIdentity(command: string): string | null {
  // Must look like a Massu launcher: the npm spec (npx form) or a massu runtime path
  // (node-direct form, phase B). A customer command merely containing "hook-runner" is
  // NOT ours and must keep exact-command semantics.
  if (!/@massu\/core|[/\\]\.?massu[/\\]/.test(command)) return null;
  const m = /\bhook-runner\s+([A-Za-z0-9._-]+)/.exec(command);
  return m ? m[1] : null;
}

/**
 * Merge two arrays of hook entries.
 *
 * Massu-owned entries dedup by IDENTITY (the `hook-runner` name), so re-pinning a version
 * or changing the launch mechanism REPLACES rather than adds. Every other entry keeps the
 * historical exact-command semantics, so a customer's own hooks are never touched or
 * collapsed. Additions are taken first, so the freshly-emitted Massu entry wins and any
 * older-generation Massu entry for the same hook is dropped.
 */
function mergeHookEntries(
  existing: HookEntry[],
  additions: HookEntry[],
): HookEntry[] {
  const seenCommands = new Set<string>();
  const seenIdentities = new Set<string>();
  const result: HookEntry[] = [];

  const take = (entry: HookEntry): void => {
    if (!entry || typeof entry.command !== 'string') return;
    const identity = massuHookIdentity(entry.command);
    if (identity !== null) {
      // A Massu registration: one entry per hook name, whatever the command looks like.
      if (seenIdentities.has(identity)) return;
      seenIdentities.add(identity);
      seenCommands.add(entry.command);
      result.push(entry);
      return;
    }
    // Not ours — preserve verbatim, dedup only on an exact repeat.
    if (seenCommands.has(entry.command)) return;
    seenCommands.add(entry.command);
    result.push(entry);
  };

  // Additions go first so Massu's canonical pipeline order is deterministic.
  for (const entry of additions ?? []) take(entry);
  for (const entry of existing ?? []) take(entry);
  return result;
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

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  const settings = readSettingsLocal(claudeDir);

  // P-003: hooksDir argument is now unused (kept for legacy callers).
  // buildHooksConfig emits `npx -y @massu/core@<version> hook-runner` lines.
  const hooksConfig = buildHooksConfig(resolveHooksDir());

  // P-012: deep-merge with existing customer hooks instead of wholesale
  // replacement. Mirrors the 1.8.0 permissions-merge pattern (CR-39 trap class).
  const existingHooks = (settings.hooks as HooksConfig | undefined) ?? {};
  const mergedHooks = mergeHooksConfig(existingHooks, hooksConfig);

  let hookCount = 0;
  for (const groups of Object.values(mergedHooks)) {
    for (const group of groups) {
      hookCount += group.hooks.length;
    }
  }

  settings.hooks = mergedHooks;

  writeSettingsLocalAtomic(claudeDir, settings);

  return { installed: true, count: hookCount };
}

// ============================================================
// Memory Directory Initialization (preserved)
// ============================================================

export function initMemoryDir(projectRoot: string): { created: boolean; memoryMdCreated: boolean; migratedFromLegacy: boolean } {
  // P-004 / CR-39: encoding MUST match the reader at `config.ts:getResolvedPaths()`.
  // The legacy writer prepended an extra `-` (producing `--Users-foo-...`) which
  // orphaned MEMORY.md from the reader's canonical single-dash path. Shared helper
  // is the SoT — never re-derive inline.
  const encodedRoot = encodeMemoryDirName(projectRoot);
  const memoryDir = resolve(homedir(), `.claude/projects/${encodedRoot}/memory`);

  // Legacy-double-dash migration: if the customer was previously installed by
  // a buggy version (<1.9.4) that wrote to `--<root>`, detect that orphaned
  // sibling directory and move its contents into the canonical `-<root>` form.
  // Idempotent: skips if the legacy dir doesn't exist OR if it's already migrated.
  let migratedFromLegacy = false;
  const legacyDir = resolve(homedir(), `.claude/projects/-${encodedRoot}/memory`);
  if (existsSync(legacyDir) && !existsSync(memoryDir)) {
    try {
      mkdirSync(resolve(memoryDir, '..'), { recursive: true });
      renameSync(legacyDir, memoryDir);
      // Best-effort cleanup of the now-empty parent (only if empty).
      try {
        const legacyParent = resolve(legacyDir, '..');
        if (existsSync(legacyParent) && readdirSync(legacyParent).length === 0) {
          rmSync(legacyParent, { recursive: false });
        }
      } catch { /* best effort */ }
      migratedFromLegacy = true;
    } catch { /* best effort — if migration fails, the new canonical dir is still created below */ }
  }

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

  return { created, memoryMdCreated, migratedFromLegacy };
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
    else if (a === '--no-introspect') opts.skipIntrospect = true;
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
  // P-E-009 (plan-stage-e-low-info-sweep): surface the full detection
  // result (framework + router + ORM + UI) instead of just
  // "Typescript/next". Previously `Detected: Typescript/next` hid the
  // router/orm/ui slots the detector populated — customers couldn't
  // tell whether tRPC/Prisma/shadcn were recognized.
  const parts: string[] = [];
  const languages = Array.from(
    new Set(detection.manifests.map((m) => m.language))
  ) as SupportedLanguage[];
  for (const lang of languages) {
    const fw = detection.frameworks[lang];
    const dirs = detection.sourceDirs[lang]?.source_dirs ?? [];
    const dirSuffix = dirs.length > 0 ? ` in ${dirs.join(',')}` : '';
    const fwName = fw?.framework ?? 'no-framework';
    const slotParts: string[] = [];
    const router = (fw as { router?: string } | undefined)?.router;
    const orm = (fw as { orm?: string } | undefined)?.orm;
    const ui = (fw as { ui?: string } | undefined)?.ui;
    if (router && router !== 'none') slotParts.push(`router=${router}`);
    if (orm && orm !== 'none') slotParts.push(`orm=${orm}`);
    if (ui && ui !== 'none') slotParts.push(`ui=${ui}`);
    const slotSuffix = slotParts.length > 0 ? ` (${slotParts.join(', ')})` : '';
    parts.push(`${capitalize(lang)}/${fwName}${slotSuffix}${dirSuffix}`);
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

  // Build config + apply variant template + write atomically. Plan 1.5.1
  // §3: the framework-specific variant template under
  // packages/core/templates/<id>/massu.config.yaml supplies router,
  // paths.source, and verification.<lang>.lint that the generic
  // detection-derived baseline doesn't know to set. Pre-1.5.1 init
  // emitted configs with `router: none` even for clear-Rails / clear-
  // Phoenix / clear-Spring projects (CR-39 violation per the Plan 1.5.1
  // 5-fixture verification).
  const baseConfig = buildConfigFromDetection({ projectRoot, detection });
  const withVariant = applyVariantTemplate(baseConfig, resolveTemplatesDir());

  // Plan 1.5.4 §3: pipe AST adapter introspect output into the emitted
  // config under `detected.<adapter-id>:` blocks. introspectAsync runs
  // the AST adapter pipeline (using the real file sampler from
  // codebase-introspector.ts post-1.5.4); each adapter that returns
  // non-'none' confidence surfaces its conventions + provenance.
  // --no-introspect bypasses for users who want sync init.
  let config = withVariant;
  if (!opts.skipIntrospect) {
    try {
      const { introspectAsync } = await import('../detect/codebase-introspector.ts');
      const introspected = await introspectAsync(detection, projectRoot);
      const detectedBlocks: Record<string, unknown> = {};
      for (const [key, block] of Object.entries(introspected)) {
        // `introspected` includes language-keyed regex-fallback blocks
        // (`python`, `swift`, `typescript`) AND adapter-id-keyed AST
        // blocks. The AST blocks are the ones we want under
        // `detected.<adapter-id>:` — distinguishable by the presence of
        // a `_confidence` field on the block (the regex blocks don't
        // carry it). Filter for AST adapter outputs only.
        if (block && typeof block === 'object' && '_confidence' in (block as Record<string, unknown>)) {
          detectedBlocks[key] = block;
        }
      }
      if (Object.keys(detectedBlocks).length > 0) {
        config = { ...config, detected: detectedBlocks };
      }
    } catch (err) {
      // Non-fatal: AST introspect is enrichment, not core detection.
      // Log to stderr so operators see the warning if it matters.
      errLog(`warning: AST adapter introspection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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
  const { created: memDirCreated, memoryMdCreated, migratedFromLegacy } = initMemoryDir(projectRoot);
  if (memDirCreated) {
    log('  Created memory directory');
  }
  if (memoryMdCreated) {
    log('  Created initial MEMORY.md');
  }
  if (migratedFromLegacy) {
    log('  Migrated memory directory from legacy double-dash path (pre-1.9.4)');
  }

  // Backfill (best-effort, silent failure)
  (async () => {
    try {
      // Shared encode helper — must match `initMemoryDir` and `config.ts:getResolvedPaths()`.
      const encodedRoot = encodeMemoryDirName(projectRoot);
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
