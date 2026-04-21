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
  | 'ruby';

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
    | 'Gemfile';
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

const MANIFEST_FILES = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'Cargo.toml',
  'Package.swift',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
];

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

function parsePackageJson(
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

function parsePyproject(
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

function parseRequirementsTxt(
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

function parsePipfile(
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

function parseCargoToml(
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

function parsePackageSwift(
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

function parseGoMod(
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

function parsePomXml(
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

function parseBuildGradle(
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

function parseGemfile(
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

function detectManifestsInDir(
  dir: string,
  root: string,
  warnings: DetectionWarning[]
): PackageManifest[] {
  const out: PackageManifest[] = [];
  for (const fname of MANIFEST_FILES) {
    const path = join(dir, fname);
    if (!existsSync(path)) continue;
    let m: PackageManifest | null = null;
    switch (fname) {
      case 'package.json':
        m = parsePackageJson(path, dir, root, warnings);
        break;
      case 'pyproject.toml':
        m = parsePyproject(path, dir, root, warnings);
        break;
      case 'requirements.txt':
        m = parseRequirementsTxt(path, dir, root, warnings);
        break;
      case 'Pipfile':
        m = parsePipfile(path, dir, root, warnings);
        break;
      case 'Cargo.toml':
        m = parseCargoToml(path, dir, root, warnings);
        break;
      case 'Package.swift':
        m = parsePackageSwift(path, dir, root, warnings);
        break;
      case 'go.mod':
        m = parseGoMod(path, dir, root, warnings);
        break;
      case 'pom.xml':
        m = parsePomXml(path, dir, root, warnings);
        break;
      case 'build.gradle':
      case 'build.gradle.kts':
        m = parseBuildGradle(path, dir, root, warnings);
        break;
      case 'Gemfile':
        m = parseGemfile(path, dir, root, warnings);
        break;
    }
    if (m !== null) out.push(m);
  }
  return out;
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
