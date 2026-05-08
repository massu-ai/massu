// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Package Manifest Detector (P1-001)
 * ==================================
 *
 * Scans a project root for dependency-manifest files across 9 ecosystems and
 * returns a structured `PackageManifest[]`. Pure filesystem, pure function —
 * no DB handles, no network, no child processes.
 *
 * Supported manifests:
 *   - `package.json` (Node.js/TypeScript)
 *   - `pyproject.toml` (Python — poetry, pep621, setuptools)
 *   - `requirements.txt` (Python — plain)
 *   - `Pipfile` (Python — pipenv)
 *   - `Cargo.toml` (Rust)
 *   - `Package.swift` (Swift)
 *   - `go.mod` (Go)
 *   - `pom.xml` (Java — Maven)
 *   - `build.gradle` / `build.gradle.kts` (Java/Kotlin — Gradle)
 *   - `Gemfile` (Ruby)
 *
 * Monorepos: walks up to 2 levels deep into conventional workspace roots
 * (`apps/*`, `packages/*`, `services/*`, `libs/*`, `modules/*`) and returns
 * a manifest per workspace.
 *
 * Malformed files log a structured warning to the returned `warnings[]` and do
 * NOT throw, per CR-9.
 *
 * Usage:
 * ```ts
 * import { detectPackageManifests } from './detect/package-detector.ts';
 * const { manifests, warnings } = detectPackageManifests('/repo');
 * ```
 */

import { readFileSync, existsSync, statSync, lstatSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { parse as parseToml } from 'smol-toml';

export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'swift'
  | 'go'
  | 'java'
  | 'ruby'
  | 'elixir'
  | 'csharp';

export interface PackageManifest {
  /** Absolute path to the manifest file. */
  path: string;
  /** Path relative to projectRoot, forward-slash normalized. */
  relativePath: string;
  /** Workspace/package root directory (parent of manifest). */
  directory: string;
  /** Language this manifest belongs to. */
  language: SupportedLanguage;
  /** Runtime family (e.g., 'node', 'python3', 'cargo', 'xcode'). */
  runtime: string;
  /** Manifest-declared package name (best-effort; null when not present). */
  name: string | null;
  /** Declared version when available. */
  version: string | null;
  /** Runtime dependencies. */
  dependencies: string[];
  /** Dev / test / build dependencies. */
  devDependencies: string[];
  /** Script / task names declared (e.g., npm scripts, poetry scripts). */
  scripts: string[];
  /** Raw manifest type key. */
  manifestType:
    | 'package.json'
    | 'pyproject.toml'
    | 'requirements.txt'
    | 'Pipfile'
    | 'Cargo.toml'
    | 'Package.swift'
    | 'go.mod'
    | 'pom.xml'
    | 'build.gradle'
    | 'Gemfile'
    | 'mix.exs'
    | '*.csproj';
}

export interface DetectionWarning {
  path: string;
  reason: string;
}

export interface PackageDetectionResult {
  manifests: PackageManifest[];
  warnings: DetectionWarning[];
}

const WORKSPACE_DIRS = ['apps', 'packages', 'services', 'libs', 'modules'];

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
  '.pytest_cache',
  '.mypy_cache',
  'DerivedData',
  'Pods',
]);

// MANIFEST_FILES removed Plan 1.5.1. The canonical list lives at
// `manifest-registry.ts:getManifestPatterns()`. `detectManifestsInDir`
// (below) iterates the registry directly so adding a new manifest type
// requires only a single registry entry — no second list to keep in sync.

function safeRead(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    // lstatSync does NOT follow symlinks — required for accurate symlink detection.
    // statSync returns the target's stat, so .isSymbolicLink() would be false on
    // symlink-to-regular-file, bypassing the intended rejection.
    const ls = lstatSync(path);
    if (ls.isSymbolicLink()) return null;
    const st = statSync(path);
    if (!st.isFile()) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function normalizeRelative(root: string, path: string): string {
  const rel = relative(root, path);
  return rel.split(/[/\\]/).join('/');
}

export function parsePackageJson(
  path: string,
  directory: string,
  root: string,
  warnings: DetectionWarning[]
): PackageManifest | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    warnings.push({
      path,
      reason: `package.json JSON parse failed: ${(err as Error).message}`,
    });
    return null;
  }
  const deps = Object.keys(
    (pkg.dependencies as Record<string, string>) ?? {}
  );
  const devDeps = Object.keys(
    (pkg.devDependencies as Record<string, string>) ?? {}
  );
  const peer = Object.keys(
    (pkg.peerDependencies as Record<string, string>) ?? {}
  );
  // Classify TypeScript vs JavaScript based on typescript dep presence or tsconfig.
  const hasTs =
    deps.includes('typescript') ||
    devDeps.includes('typescript') ||
    existsSync(join(directory, 'tsconfig.json'));
  const language: SupportedLanguage = hasTs ? 'typescript' : 'javascript';
  const scripts = Object.keys(
    (pkg.scripts as Record<string, string>) ?? {}
  );
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language,
    runtime: 'node',
    name: typeof pkg.name === 'string' ? pkg.name : null,
    version: typeof pkg.version === 'string' ? pkg.version : null,
    dependencies: [...deps, ...peer],
    devDependencies: devDeps,
    scripts,
    manifestType: 'package.json',
  };
}

export function parsePyproject(
  path: string,
  directory: string,
  root: string,
  warnings: DetectionWarning[]
): PackageManifest | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  let toml: Record<string, unknown>;
  try {
    toml = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    warnings.push({
      path,
      reason: `pyproject.toml TOML parse failed: ${(err as Error).message}`,
    });
    return null;
  }
  const deps: string[] = [];
  const devDeps: string[] = [];
  const scripts: string[] = [];
  let name: string | null = null;
  let version: string | null = null;

  // PEP 621 [project] table
  const project = toml.project as Record<string, unknown> | undefined;
  if (project && typeof project === 'object') {
    if (typeof project.name === 'string') name = project.name;
    if (typeof project.version === 'string') version = project.version;
    const pd = project.dependencies;
    if (Array.isArray(pd)) {
      for (const d of pd) {
        if (typeof d === 'string') deps.push(normalizePyDep(d));
      }
    }
    const optDeps = project['optional-dependencies'] as
      | Record<string, unknown>
      | undefined;
    if (optDeps && typeof optDeps === 'object') {
      for (const grp of Object.values(optDeps)) {
        if (Array.isArray(grp)) {
          for (const d of grp) {
            if (typeof d === 'string') devDeps.push(normalizePyDep(d));
          }
        }
      }
    }
    const psScripts = project.scripts as Record<string, unknown> | undefined;
    if (psScripts && typeof psScripts === 'object') {
      scripts.push(...Object.keys(psScripts));
    }
  }

  // Poetry [tool.poetry]
  const tool = toml.tool as Record<string, unknown> | undefined;
  const poetry = tool?.poetry as Record<string, unknown> | undefined;
  if (poetry && typeof poetry === 'object') {
    if (!name && typeof poetry.name === 'string') name = poetry.name;
    if (!version && typeof poetry.version === 'string') version = poetry.version;
    const pdeps = poetry.dependencies as Record<string, unknown> | undefined;
    if (pdeps && typeof pdeps === 'object') {
      for (const k of Object.keys(pdeps)) {
        if (k !== 'python') deps.push(k);
      }
    }
    const groups = poetry.group as Record<string, unknown> | undefined;
    if (groups && typeof groups === 'object') {
      for (const grp of Object.values(groups)) {
        const grpObj = grp as Record<string, unknown> | undefined;
        const grpDeps = grpObj?.dependencies as
          | Record<string, unknown>
          | undefined;
        if (grpDeps && typeof grpDeps === 'object') {
          for (const k of Object.keys(grpDeps)) {
            if (k !== 'python') devDeps.push(k);
          }
        }
      }
    }
    // Legacy poetry dev-dependencies
    const legacyDev = poetry['dev-dependencies'] as
      | Record<string, unknown>
      | undefined;
    if (legacyDev && typeof legacyDev === 'object') {
      for (const k of Object.keys(legacyDev)) {
        if (k !== 'python') devDeps.push(k);
      }
    }
    const pScripts = poetry.scripts as Record<string, unknown> | undefined;
    if (pScripts && typeof pScripts === 'object') {
      scripts.push(...Object.keys(pScripts));
    }
  }

  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: 'python',
    runtime: 'python3',
    name,
    version,
    dependencies: deps,
    devDependencies: devDeps,
    scripts,
    manifestType: 'pyproject.toml',
  };
}

function normalizePyDep(spec: string): string {
  // Strip version specifiers, extras, markers.
  // Example: "fastapi[all]>=0.110,<0.120 ; python_version>='3.10'"
  //   → "fastapi"
  const semi = spec.split(';')[0];
  const extras = semi.split('[')[0];
  const name = extras.split(/[=<>!~ ]/)[0];
  return name.trim();
}

export function parseRequirementsTxt(
  path: string,
  directory: string,
  root: string,
  _warnings: DetectionWarning[]
): PackageManifest | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('-')) continue; // -r, -e, --index-url, etc.
    const name = normalizePyDep(trimmed);
    if (name) deps.push(name);
  }
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: 'python',
    runtime: 'python3',
    name: null,
    version: null,
    dependencies: deps,
    devDependencies: [],
    scripts: [],
    manifestType: 'requirements.txt',
  };
}

export function parsePipfile(
  path: string,
  directory: string,
  root: string,
  warnings: DetectionWarning[]
): PackageManifest | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  let toml: Record<string, unknown>;
  try {
    toml = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    warnings.push({
      path,
      reason: `Pipfile TOML parse failed: ${(err as Error).message}`,
    });
    return null;
  }
  const packages =
    (toml.packages as Record<string, unknown> | undefined) ?? {};
  const devPackages =
    (toml['dev-packages'] as Record<string, unknown> | undefined) ?? {};
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: 'python',
    runtime: 'python3',
    name: null,
    version: null,
    dependencies: Object.keys(packages),
    devDependencies: Object.keys(devPackages),
    scripts: [],
    manifestType: 'Pipfile',
  };
}

export function parseCargoToml(
  path: string,
  directory: string,
  root: string,
  warnings: DetectionWarning[]
): PackageManifest | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  let toml: Record<string, unknown>;
  try {
    toml = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    warnings.push({
      path,
      reason: `Cargo.toml TOML parse failed: ${(err as Error).message}`,
    });
    return null;
  }
  const pkg = toml.package as Record<string, unknown> | undefined;
  const deps = toml.dependencies as Record<string, unknown> | undefined;
  const devDeps = toml['dev-dependencies'] as
    | Record<string, unknown>
    | undefined;
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: 'rust',
    runtime: 'cargo',
    name: typeof pkg?.name === 'string' ? (pkg.name as string) : null,
    version: typeof pkg?.version === 'string' ? (pkg.version as string) : null,
    dependencies: deps ? Object.keys(deps) : [],
    devDependencies: devDeps ? Object.keys(devDeps) : [],
    scripts: [],
    manifestType: 'Cargo.toml',
  };
}

export function parsePackageSwift(
  path: string,
  directory: string,
  root: string,
  _warnings: DetectionWarning[]
): PackageManifest | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps: string[] = [];
  // .package(url: "https://github.com/foo/bar.git", ...) → extract "bar"
  const urlRe = /\.package\s*\(\s*(?:name\s*:\s*"([^"]+)"\s*,\s*)?url\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(raw)) !== null) {
    const explicitName = m[1];
    if (explicitName) {
      deps.push(explicitName);
      continue;
    }
    const url = m[2];
    const last = url.split('/').pop() ?? '';
    const clean = last.replace(/\.git$/, '').trim();
    if (clean) deps.push(clean);
  }
  // name: "MyLibrary"
  const nameMatch = /let\s+package\s*=\s*Package\s*\(\s*name\s*:\s*"([^"]+)"/.exec(
    raw
  );
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: 'swift',
    runtime: 'xcode',
    name: nameMatch ? nameMatch[1] : null,
    version: null,
    dependencies: deps,
    devDependencies: [],
    scripts: [],
    manifestType: 'Package.swift',
  };
}

export function parseGoMod(
  path: string,
  directory: string,
  root: string,
  _warnings: DetectionWarning[]
): PackageManifest | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps: string[] = [];
  let name: string | null = null;
  let inRequire = false;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('module ')) {
      name = line.slice('module '.length).trim();
      continue;
    }
    if (line === 'require (') {
      inRequire = true;
      continue;
    }
    if (inRequire) {
      if (line === ')') {
        inRequire = false;
        continue;
      }
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && !parts[0].startsWith('//')) deps.push(parts[0]);
      continue;
    }
    if (line.startsWith('require ')) {
      const parts = line.slice('require '.length).trim().split(/\s+/);
      if (parts[0]) deps.push(parts[0]);
    }
  }
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: 'go',
    runtime: 'go',
    name,
    version: null,
    dependencies: deps,
    devDependencies: [],
    scripts: [],
    manifestType: 'go.mod',
  };
}

export function parsePomXml(
  path: string,
  directory: string,
  root: string,
  _warnings: DetectionWarning[]
): PackageManifest | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps: string[] = [];
  const depRe = /<dependency>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<\/dependency>/g;
  let m: RegExpExecArray | null;
  while ((m = depRe.exec(raw)) !== null) deps.push(m[1].trim());
  const nameMatch = /<artifactId>([^<]+)<\/artifactId>/.exec(raw);
  const versionMatch = /<project[^>]*>[\s\S]*?<version>([^<]+)<\/version>/.exec(
    raw
  );
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: 'java',
    runtime: 'jvm',
    name: nameMatch ? nameMatch[1].trim() : null,
    version: versionMatch ? versionMatch[1].trim() : null,
    dependencies: deps,
    devDependencies: [],
    scripts: [],
    manifestType: 'pom.xml',
  };
}

export function parseBuildGradle(
  path: string,
  directory: string,
  root: string,
  _warnings: DetectionWarning[]
): PackageManifest | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps: string[] = [];
  const devDeps: string[] = [];
  // implementation 'group:artifact:version' | implementation("group:artifact:version")
  const re = /(implementation|api|runtimeOnly|compileOnly|testImplementation|testRuntimeOnly|androidTestImplementation)\s*[\("']+([^"'\)]+)[\)"']+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const scope = m[1];
    const coord = m[2];
    const parts = coord.split(':');
    const artifact = parts.length >= 2 ? parts[1] : parts[0];
    if (!artifact) continue;
    if (scope.toLowerCase().startsWith('test')) devDeps.push(artifact);
    else deps.push(artifact);
  }
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: 'java',
    runtime: 'jvm',
    name: null,
    version: null,
    dependencies: deps,
    devDependencies: devDeps,
    scripts: [],
    manifestType: 'build.gradle',
  };
}

export function parseGemfile(
  path: string,
  directory: string,
  root: string,
  _warnings: DetectionWarning[]
): PackageManifest | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps: string[] = [];
  const devDeps: string[] = [];
  let inDevGroup = false;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
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
    language: 'ruby',
    runtime: 'ruby',
    name: null,
    version: null,
    dependencies: deps,
    devDependencies: devDeps,
    scripts: [],
    manifestType: 'Gemfile',
  };
}

/**
 * Parse a `mix.exs` (Elixir / Mix) file. Plan 1.5.1 — closes CR-39
 * gap where Phoenix projects failed `npx massu init` with "no languages
 * detected" because the package-detector layer didn't recognize the
 * manifest. The AST adapter at `detect/adapters/phoenix.ts` was already
 * shipped in 1.5.0 and works correctly when given a SourceFile[] directly.
 *
 * mix.exs is Elixir source (not a declarative format), but for detection
 * purposes we extract `{:dep, "~> X.Y"}` style declarations via a regex
 * scan. False-positive risk is low (any `{:atom, ...}` pattern that's
 * NOT a dep is rare in mix.exs files outside the deps function).
 */
export function parseMixExs(
  path: string,
  directory: string,
  root: string,
  _warnings: DetectionWarning[],
): PackageManifest | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps: string[] = [];
  // Match `{:dep_name, ...}` — atom name as first tuple element.
  const depPattern = /\{\s*:([a-z][a-z0-9_]*)\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = depPattern.exec(raw)) !== null) {
    if (!deps.includes(m[1])) deps.push(m[1]);
  }
  // Best-effort `app: :name` extraction (the `def project` block usually
  // declares this).
  const appMatch = /\bapp\s*:\s*:([a-z][a-z0-9_]*)/.exec(raw);
  const name = appMatch ? appMatch[1] : null;
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: 'elixir',
    runtime: 'beam',
    name,
    version: null,
    dependencies: deps,
    devDependencies: [],
    scripts: [],
    manifestType: 'mix.exs',
  };
}

/**
 * Parse a `*.csproj` (C# / .NET project) file. Plan 1.5.1 — closes CR-39
 * gap where ASP.NET projects failed `npx massu init`. The AST adapter at
 * `detect/adapters/aspnet.ts` was already shipped in 1.5.0 and works
 * correctly.
 *
 * .csproj is XML; we use a lightweight regex scan rather than pulling
 * an XML parser because the only fields we need are `<PackageReference
 * Include="X" />` (deps) and the `Sdk="..."` attribute (framework hint).
 * Full XML parsing would be over-engineered for this surface and risks
 * adding a dependency for marginal gain.
 */
export function parseCsproj(
  path: string,
  directory: string,
  root: string,
  _warnings: DetectionWarning[],
): PackageManifest | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  const deps: string[] = [];
  // Match `<PackageReference Include="Foo.Bar" ... />` (Include attribute
  // value is the package id; the Version attribute is captured but we
  // discard it since runtime/build distinction isn't expressed via
  // this schema).
  const pkgRefPattern = /<PackageReference\s+[^>]*Include\s*=\s*"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = pkgRefPattern.exec(raw)) !== null) {
    if (!deps.includes(m[1])) deps.push(m[1]);
  }
  // The `<Project Sdk="Microsoft.NET.Sdk.Web">` attribute is a strong
  // ASP.NET Core indicator that doesn't appear as a PackageReference.
  // Surface it as a dep so framework-detector rules (which match against
  // the deps set) can fire on it. Same downstream consumer; no new
  // signal channel needed.
  const sdkMatch = /<Project\s+[^>]*Sdk\s*=\s*"([^"]+)"/i.exec(raw);
  if (sdkMatch && !deps.includes(sdkMatch[1])) {
    deps.push(sdkMatch[1]);
  }
  // Best-effort name from filename (Foo.csproj → "Foo").
  const fname = path.split(/[/\\]/).pop() ?? '';
  const name = fname.endsWith('.csproj') ? fname.slice(0, -'.csproj'.length) : null;
  return {
    path,
    relativePath: normalizeRelative(root, path),
    directory,
    language: 'csharp',
    runtime: 'dotnet',
    name,
    version: null,
    dependencies: deps,
    devDependencies: [],
    scripts: [],
    manifestType: '*.csproj',
  };
}

function detectManifestsInDir(
  dir: string,
  root: string,
  warnings: DetectionWarning[]
): PackageManifest[] {
  // Plan 1.5.1: dispatch via the canonical MANIFEST_REGISTRY (single
  // source-of-truth). The previous hand-rolled MANIFEST_FILES list +
  // switch statement led to drift with runner.ts:buildDetectionSignals
  // (Phoenix + ASP.NET were unreachable). Closed by registry.
  // Lazy import to avoid ESM cycle; getManifestRegistry() is itself
  // lazy-initialized.
  const { getManifestRegistry, matchManifestPattern } = registryModule;
  const out: PackageManifest[] = [];
  let dirEntries: string[] | null = null;
  for (const entry of getManifestRegistry()) {
    if (!entry.pattern.startsWith('*')) {
      // Exact-filename pattern: O(1) existence check.
      const path = join(dir, entry.pattern);
      if (!existsSync(path)) continue;
      const m = entry.parse(path, dir, root, warnings);
      if (m !== null) out.push(m);
    } else {
      // Extension-glob pattern: scan dir for matches. Lazy-readdir so
      // we pay the cost only when at least one glob entry exists.
      if (dirEntries === null) {
        try {
          dirEntries = readdirSync(dir);
        } catch {
          dirEntries = [];
        }
      }
      for (const fname of dirEntries) {
        if (!matchManifestPattern(fname, entry.pattern)) continue;
        const path = join(dir, fname);
        if (!existsSync(path)) continue;
        const m = entry.parse(path, dir, root, warnings);
        if (m !== null) out.push(m);
      }
    }
  }
  return out;
}

// Imported lazily-via-namespace to break the ESM cycle (manifest-registry
// imports parsers from THIS module). The namespace import is hoisted to
// the top of the module by ESM, but the named members are resolved on
// access — by the time `detectManifestsInDir` runs, the registry module's
// top-level evaluation has completed.
import * as registryModule from './manifest-registry.ts';

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
 * Scan a project root for dependency manifests.
 *
 * Walks projectRoot plus conventional workspace subtrees (`apps/*`,
 * `packages/*`, `services/*`, `libs/*`, `modules/*`) up to 2 levels deep.
 */
export function detectPackageManifests(
  projectRoot: string
): PackageDetectionResult {
  const warnings: DetectionWarning[] = [];
  const manifests: PackageManifest[] = [];

  // Level 0: projectRoot itself
  manifests.push(...detectManifestsInDir(projectRoot, projectRoot, warnings));

  // Level 1: workspace roots (apps/, packages/, services/, libs/, modules/)
  for (const ws of WORKSPACE_DIRS) {
    const wsRoot = join(projectRoot, ws);
    if (!existsSync(wsRoot)) continue;
    for (const sub of listSubdirs(wsRoot)) {
      manifests.push(...detectManifestsInDir(sub, projectRoot, warnings));
      // Level 2 (one nesting allowed, e.g., apps/ios/<target>)
      for (const sub2 of listSubdirs(sub)) {
        manifests.push(...detectManifestsInDir(sub2, projectRoot, warnings));
      }
    }
  }

  // Deduplicate by manifest path (rare, but a nested workspace dir equal to its
  // parent by coincidence could double-scan).
  const seen = new Set<string>();
  const dedup: PackageManifest[] = [];
  for (const m of manifests) {
    if (seen.has(m.path)) continue;
    seen.add(m.path);
    dedup.push(m);
  }

  return { manifests: dedup, warnings };
}
