// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Monorepo Detector (P1-004)
 * ==========================
 *
 * Detects the presence and kind of monorepo layout at `projectRoot`:
 *   - turbo       (turbo.json)
 *   - nx          (nx.json)
 *   - lerna       (lerna.json)
 *   - pnpm        (pnpm-workspace.yaml)
 *   - yarn        (package.json `workspaces`)
 *   - bazel       (WORKSPACE / WORKSPACE.bazel / MODULE.bazel)
 *   - generic     (any of apps/*, packages/*, services/*, libs/*, modules/*
 *                  subdirs with their own manifests)
 *   - single      (no monorepo signals)
 *
 * Nested schemes: when the outer has a primary manager AND an inner scheme is
 * present (e.g., turbo-outer + pnpm-inner), `nested[]` lists the inner scheme.
 *
 * Usage:
 * ```ts
 * import { detectMonorepo } from './detect/monorepo-detector.ts';
 * const info = detectMonorepo('/repo');
 * ```
 */

import { readFileSync, existsSync, statSync, lstatSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';

export type MonorepoKind =
  | 'turbo'
  | 'nx'
  | 'lerna'
  | 'pnpm'
  | 'yarn'
  | 'bazel'
  | 'generic'
  | 'single';

export interface WorkspacePackage {
  /** Path relative to projectRoot, forward-slash normalized. */
  path: string;
  /** Name from the manifest (null if not present). */
  name: string | null;
  /** The manifest file that declares the workspace. */
  manifest:
    | 'package.json'
    | 'pyproject.toml'
    | 'Cargo.toml'
    | 'go.mod'
    | 'build.gradle'
    | 'pom.xml'
    | 'Gemfile'
    | 'Package.swift'
    | 'unknown';
}

export interface MonorepoInfo {
  type: MonorepoKind;
  /** Workspace packages discovered. Empty for 'single'. */
  packages: WorkspacePackage[];
  /** Secondary monorepo schemes nested inside the primary. */
  nested: MonorepoInfo[];
}

const MANIFEST_PRIORITY: WorkspacePackage['manifest'][] = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'build.gradle',
  'pom.xml',
  'Gemfile',
  'Package.swift',
];

const IGNORED_DIRS = new Set([
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  '.build',
  'target',
  '.next',
  '.nuxt',
  'coverage',
  '.git',
  '.massu',
  '.turbo',
  '.cache',
]);

const CONVENTIONAL_WORKSPACE_PARENTS = [
  'apps',
  'packages',
  'services',
  'libs',
  'modules',
];

function safeReadText(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    // Reject symlinks — defence in depth against manifest-forged escape paths
    // or credential exposure via symlinked files (parity with package-detector.ts).
    // lstatSync does NOT follow symlinks; statSync would return the target's stat.
    const ls = lstatSync(path);
    if (ls.isSymbolicLink()) return null;
    const st = statSync(path);
    if (!st.isFile()) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function firstManifestIn(dir: string): WorkspacePackage['manifest'] | null {
  for (const m of MANIFEST_PRIORITY) {
    if (existsSync(join(dir, m))) return m;
  }
  return null;
}

function manifestName(dir: string, manifest: WorkspacePackage['manifest']): string | null {
  try {
    if (manifest === 'package.json') {
      const raw = safeReadText(join(dir, 'package.json'));
      if (!raw) return null;
      const pkg = JSON.parse(raw) as { name?: unknown };
      return typeof pkg.name === 'string' ? pkg.name : null;
    }
    if (manifest === 'pyproject.toml') {
      const raw = safeReadText(join(dir, 'pyproject.toml'));
      if (!raw) return null;
      const toml = parseToml(raw) as Record<string, unknown>;
      const project = toml.project as Record<string, unknown> | undefined;
      if (project && typeof project.name === 'string') return project.name;
      const tool = toml.tool as Record<string, unknown> | undefined;
      const poetry = tool?.poetry as Record<string, unknown> | undefined;
      if (poetry && typeof poetry.name === 'string') return poetry.name;
      return null;
    }
    if (manifest === 'Cargo.toml') {
      const raw = safeReadText(join(dir, 'Cargo.toml'));
      if (!raw) return null;
      const toml = parseToml(raw) as Record<string, unknown>;
      const pkg = toml.package as Record<string, unknown> | undefined;
      if (pkg && typeof pkg.name === 'string') return pkg.name;
      return null;
    }
    if (manifest === 'go.mod') {
      const raw = safeReadText(join(dir, 'go.mod'));
      if (!raw) return null;
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('module ')) return trimmed.slice(7).trim();
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

function pkgFromDir(root: string, dir: string): WorkspacePackage | null {
  const m = firstManifestIn(dir);
  if (!m) return null;
  return {
    path: relative(root, dir).split(/[/\\]/).join('/'),
    name: manifestName(dir, m),
    manifest: m,
  };
}

function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Collect generic conventional workspaces (any manifested package under
 * apps/*, packages/*, services/*, libs/*, modules/*).
 */
function genericWorkspaces(root: string): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  for (const parent of CONVENTIONAL_WORKSPACE_PARENTS) {
    const p = join(root, parent);
    if (!existsSync(p)) continue;
    for (const sub of listSubdirs(p)) {
      const pkg = pkgFromDir(root, sub);
      if (pkg) out.push(pkg);
    }
  }
  return out;
}

function detectYarnWorkspaces(root: string): WorkspacePackage[] | null {
  const raw = safeReadText(join(root, 'package.json'));
  if (!raw) return null;
  let pkg: { workspaces?: unknown };
  try {
    pkg = JSON.parse(raw) as { workspaces?: unknown };
  } catch {
    return null;
  }
  const ws = pkg.workspaces;
  if (!ws) return null;
  // Can be array of strings OR { packages: [...] }
  const globs: string[] = Array.isArray(ws)
    ? (ws.filter((x) => typeof x === 'string') as string[])
    : typeof ws === 'object' && ws !== null &&
        Array.isArray((ws as { packages?: unknown }).packages)
      ? (((ws as { packages: unknown[] }).packages).filter((x) => typeof x === 'string') as string[])
      : [];
  if (globs.length === 0) return null;
  return expandWorkspaceGlobs(root, globs);
}

function detectPnpmWorkspaces(root: string): WorkspacePackage[] | null {
  const raw = safeReadText(join(root, 'pnpm-workspace.yaml'));
  if (!raw) return null;
  try {
    const parsed = parseYaml(raw) as { packages?: unknown } | null;
    const list = Array.isArray(parsed?.packages)
      ? (parsed!.packages as unknown[]).filter((x) => typeof x === 'string') as string[]
      : [];
    return expandWorkspaceGlobs(root, list);
  } catch {
    return null;
  }
}

function expandWorkspaceGlobs(root: string, globs: string[]): WorkspacePackage[] {
  // Minimal brace/star expansion: support `foo/*` and `foo/**` by one level only.
  // For simplicity and no-dep, expand each pattern manually.
  const out: WorkspacePackage[] = [];
  const seen = new Set<string>();
  for (const pattern of globs) {
    // Handle `apps/*`, `packages/*`, `services/*`, `apps/**`
    const parts = pattern.split('/');
    if (parts.length === 2 && (parts[1] === '*' || parts[1] === '**')) {
      const parent = join(root, parts[0]);
      if (!existsSync(parent)) continue;
      for (const sub of listSubdirs(parent)) {
        const pkg = pkgFromDir(root, sub);
        if (pkg && !seen.has(pkg.path)) {
          seen.add(pkg.path);
          out.push(pkg);
        }
      }
      continue;
    }
    // Direct path (no glob)
    const direct = join(root, pattern);
    if (existsSync(direct)) {
      const pkg = pkgFromDir(root, direct);
      if (pkg && !seen.has(pkg.path)) {
        seen.add(pkg.path);
        out.push(pkg);
      }
    }
  }
  return out;
}

function hasTurbo(root: string): boolean {
  return existsSync(join(root, 'turbo.json'));
}
function hasNx(root: string): boolean {
  return existsSync(join(root, 'nx.json'));
}
function hasLerna(root: string): boolean {
  return existsSync(join(root, 'lerna.json'));
}
function hasBazel(root: string): boolean {
  return (
    existsSync(join(root, 'WORKSPACE')) ||
    existsSync(join(root, 'WORKSPACE.bazel')) ||
    existsSync(join(root, 'MODULE.bazel'))
  );
}

/**
 * Detect the monorepo layout (or lack thereof) at `projectRoot`.
 */
export function detectMonorepo(projectRoot: string): MonorepoInfo {
  const nested: MonorepoInfo[] = [];

  const pnpm = detectPnpmWorkspaces(projectRoot);
  const yarn = detectYarnWorkspaces(projectRoot);

  // Determine primary by priority: turbo > nx > lerna > pnpm > yarn > bazel > generic > single
  let primary: MonorepoKind = 'single';
  let primaryPackages: WorkspacePackage[] = [];

  if (hasTurbo(projectRoot)) {
    primary = 'turbo';
    // Turbo reuses an underlying manager's workspaces list.
    primaryPackages = pnpm ?? yarn ?? genericWorkspaces(projectRoot);
    // Record nested inner scheme (the actual workspace manager)
    if (pnpm && pnpm.length) {
      nested.push({ type: 'pnpm', packages: pnpm, nested: [] });
    } else if (yarn && yarn.length) {
      nested.push({ type: 'yarn', packages: yarn, nested: [] });
    }
  } else if (hasNx(projectRoot)) {
    primary = 'nx';
    primaryPackages = yarn ?? pnpm ?? genericWorkspaces(projectRoot);
    if (pnpm && pnpm.length) nested.push({ type: 'pnpm', packages: pnpm, nested: [] });
    else if (yarn && yarn.length) nested.push({ type: 'yarn', packages: yarn, nested: [] });
  } else if (hasLerna(projectRoot)) {
    primary = 'lerna';
    primaryPackages = yarn ?? pnpm ?? genericWorkspaces(projectRoot);
  } else if (pnpm && pnpm.length) {
    primary = 'pnpm';
    primaryPackages = pnpm;
  } else if (yarn && yarn.length) {
    primary = 'yarn';
    primaryPackages = yarn;
  } else if (hasBazel(projectRoot)) {
    primary = 'bazel';
    primaryPackages = genericWorkspaces(projectRoot);
  } else {
    const gen = genericWorkspaces(projectRoot);
    if (gen.length > 0) {
      primary = 'generic';
      primaryPackages = gen;
    } else {
      primary = 'single';
      primaryPackages = [];
    }
  }

  return { type: primary, packages: primaryPackages, nested };
}
