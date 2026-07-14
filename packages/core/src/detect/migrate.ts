// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Config migration logic (P7-003).
 *
 * Pure functions that upgrade legacy v1-shaped `massu.config.yaml` objects to
 * schema_version=2. Driven by the Phase 1 `DetectionResult` so the v2 output
 * reflects the actual runtime stack.
 *
 * User overrides ALWAYS win — this migrator never overwrites fields that the
 * user set explicitly in v1. The only thing that gets replaced is content
 * whose v1 value is a schema default ('typescript', 'none', 'src', etc.) AND
 * detection discovered a different value.
 *
 * Idempotence: passing a v2 config back in should be a no-op (beyond `schema_version`
 * normalization). The test suite asserts this.
 *
 * No filesystem I/O, no network, no child processes. Pure data in, pure data
 * out. Consumers (future `massu config upgrade` CLI, drift-repair flow) are
 * responsible for reading/writing the YAML.
 */

import type { DetectionResult, SupportedLanguage, VRCommandSet } from './index.ts';
import { copyUnknownKeys, preserveNestedSubkeys } from './passthrough.ts';

/**
 * Shape accepted for input. We intentionally use `Record<string, unknown>`
 * rather than the full `Config` Zod type — legacy configs may contain fields
 * that don't parse through the current schema (e.g., invalid enum values for
 * `framework.router` from a hand-customized config), and a strict shape would
 * reject the very configs we're trying to fix.
 */
export type AnyConfig = Record<string, unknown>;

/** Fields the migrator preserves verbatim when present on the v1 input. */
const PRESERVED_FIELDS: readonly string[] = [
  'rules',
  'domains',
  'canonical_paths',
  'verification_types',
  'detection',
  'accessScopes',
  'knownMismatches',
  'dbAccessPattern',
  'analytics',
  'governance',
  'security',
  'team',
  'regression',
  'cloud',
  'conventions',
  'autoLearning',
];

function getRecord(obj: unknown): Record<string, unknown> {
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    return obj as Record<string, unknown>;
  }
  return {};
}

function isNoneOrDefault(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v !== 'string') return false;
  return v === 'none' || v === '';
}

function chooseString(user: unknown, detected: string | null | undefined): string {
  // User wins unless it's falsey / 'none' and the detector has something concrete.
  if (typeof user === 'string' && !isNoneOrDefault(user)) return user;
  if (typeof detected === 'string' && detected !== '') return detected;
  if (typeof user === 'string') return user;
  return 'none';
}

function buildLanguageEntries(
  detection: DetectionResult
): Record<string, Record<string, unknown>> {
  const languages = Array.from(
    new Set(detection.manifests.map((m) => m.language))
  ) as SupportedLanguage[];
  const entries: Record<string, Record<string, unknown>> = {};
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
    if (Object.keys(entry).length > 0) {
      entries[lang] = entry;
    }
  }
  return entries;
}

function pickPrimary(detection: DetectionResult): SupportedLanguage | null {
  const counts = new Map<SupportedLanguage, number>();
  for (const m of detection.manifests) {
    counts.set(m.language, (counts.get(m.language) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  return sorted.length > 0 ? sorted[0][0] : null;
}

function buildVerificationBlock(
  detection: DetectionResult,
  userVerification: Record<string, Record<string, string>> | undefined
): Record<string, Record<string, string>> {
  const ver: Record<string, Record<string, string>> = {};
  const languages = Array.from(
    new Set(detection.manifests.map((m) => m.language))
  ) as SupportedLanguage[];
  for (const lang of languages) {
    const cmds: VRCommandSet | undefined = detection.verificationCommands[lang];
    if (!cmds) continue;
    const entry: Record<string, string> = {};
    if (cmds.test) entry.test = cmds.test;
    if (cmds.type) entry.type = cmds.type;
    if (cmds.build) entry.build = cmds.build;
    if (cmds.syntax) entry.syntax = cmds.syntax;
    if (cmds.lint) entry.lint = cmds.lint;
    if (Object.keys(entry).length > 0) ver[lang] = entry;
  }
  // Overlay user overrides — any user verification entry wins over detected.
  if (userVerification) {
    for (const [lang, userEntry] of Object.entries(userVerification)) {
      if (typeof userEntry !== 'object' || userEntry === null) continue;
      ver[lang] = { ...(ver[lang] ?? {}), ...userEntry };
    }
  }
  return ver;
}

/**
 * Migrate a v1-shaped (or malformed) config to v2, using `detection` as the
 * source of truth for the stack layout. User-authored overrides (rules,
 * domains, canonical_paths, etc.) are preserved unchanged.
 *
 * Idempotent: passing a valid v2 config back in returns an equivalent v2 config.
 */
export function migrateV1ToV2(
  v1Config: AnyConfig,
  detection: DetectionResult
): AnyConfig {
  const v1 = getRecord(v1Config);
  const v1Framework = getRecord(v1.framework);
  const v1Paths = getRecord(v1.paths);
  const v1Project = getRecord(v1.project);
  const v1Verification = v1.verification as
    | Record<string, Record<string, string>>
    | undefined;

  const languages = Array.from(
    new Set(detection.manifests.map((m) => m.language))
  ) as SupportedLanguage[];
  const languageEntries = buildLanguageEntries(detection);
  const primary = pickPrimary(detection);

  const frameworkType = languages.length > 1
    ? 'multi'
    : (languages[0] ?? (typeof v1Framework.type === 'string' ? v1Framework.type : 'typescript'));

  // Legacy top-level router/orm/ui: prefer user value; fall back to primary lang.
  const primaryEntry = primary ? languageEntries[primary] : undefined;
  const primaryRouter = primaryEntry?.router as string | undefined;
  const primaryOrm = primaryEntry?.orm as string | undefined;
  const primaryUi = primaryEntry?.ui as string | undefined;

  const legacyRouter = chooseString(v1Framework.router, primaryRouter);
  const legacyOrm = chooseString(v1Framework.orm, primaryOrm);
  const legacyUi = chooseString(v1Framework.ui, primaryUi);

  const framework: Record<string, unknown> = {
    type: frameworkType,
    router: legacyRouter,
    orm: legacyOrm,
    ui: legacyUi,
  };
  if (languages.length > 1 && primary) {
    framework.primary = primary;
  }
  if (Object.keys(languageEntries).length > 0) {
    framework.languages = languageEntries;
  }
  // P1-004: preserve any v1Framework subkey the explicit rebuild didn't emit
  // (e.g., a multi-runtime monorepo's `framework.{python, rust, swift, typescript}` language sub-blocks).
  preserveNestedSubkeys(v1Framework, framework);

  // Paths: preserve user-set fields; fill `source` from detection if user had 'src' default.
  // P1-003 (mirror of init.ts:367-390): when primary language has no source dir
  // AND this is a monorepo, fall back to the common parent of workspace packages
  // instead of leaving the nonexistent default 'src' in place.
  let pathsSource: string = typeof v1Paths.source === 'string' ? v1Paths.source : 'src';
  if (pathsSource === 'src' && primary) {
    const primaryDirs = detection.sourceDirs[primary]?.source_dirs ?? [];
    if (primaryDirs.length > 0) {
      pathsSource = primaryDirs[0];
    } else if (
      detection.monorepo?.type !== undefined &&
      detection.monorepo.type !== 'single' &&
      detection.monorepo.packages.length > 0
    ) {
      pathsSource = monorepoCommonRootMigrate(detection.monorepo.packages);
    }
  }
  const aliases = v1Paths.aliases && typeof v1Paths.aliases === 'object'
    ? (v1Paths.aliases as Record<string, string>)
    : { '@': pathsSource };
  const paths: Record<string, unknown> = {
    source: pathsSource,
    aliases,
  };
  // P1-005 mirror: emit monorepo_roots for upgraded v2 configs (additive,
  // only when monorepo + not already user-specified).
  if (
    detection.monorepo?.type !== undefined &&
    detection.monorepo.type !== 'single' &&
    detection.monorepo.packages.length > 0 &&
    !('monorepo_roots' in v1Paths)
  ) {
    const roots = monorepoDistinctRootsMigrate(detection.monorepo.packages);
    if (roots.length > 0) paths.monorepo_roots = roots;
  }
  for (const k of ['routers', 'routerRoot', 'pages', 'middleware', 'schema', 'components', 'hooks']) {
    if (typeof v1Paths[k] === 'string') paths[k] = v1Paths[k];
  }
  // P1-005: preserve any v1Paths subkey the explicit rebuild didn't emit
  // (e.g., a downstream consumer's 19 custom `paths.*` entries like adr, plans, monorepo_root).
  preserveNestedSubkeys(v1Paths, paths);

  const verification = buildVerificationBlock(detection, v1Verification);

  // P1-006: build project block with nested passthrough so custom subkeys
  // (e.g., a downstream consumer's `project.description`) survive the migration.
  const project: Record<string, unknown> = {
    name: typeof v1Project.name === 'string' ? v1Project.name : 'my-project',
    root: typeof v1Project.root === 'string' ? v1Project.root : 'auto',
  };
  preserveNestedSubkeys(v1Project, project);

  // Construct v2 output.
  const v2: AnyConfig = {
    schema_version: 2,
    project,
    framework,
    paths,
    toolPrefix: typeof v1.toolPrefix === 'string' ? v1.toolPrefix : 'massu',
  };

  // Preserve user-authored collections verbatim.
  for (const field of PRESERVED_FIELDS) {
    if (field in v1 && v1[field] !== undefined) {
      v2[field] = v1[field];
    }
  }

  // P1-001: preserve any v1 top-level key not already handled by the explicit
  // migrator. This is the generalization of PRESERVED_FIELDS — custom sections
  // like `services`, `workflow`, `north_stars` now pass through.
  //
  // `detection` is intentionally NOT in handledTopLevel: when a v2 config is
  // fed back in (idempotence check at migrate.ts:16), the existing `detection`
  // block round-trips via this passthrough path. It gets re-stamped with a
  // fresh fingerprint by the caller at config-upgrade.ts:96-99 right after
  // migrateV1ToV2 returns. Any future v2-only top-level key added here must
  // either appear in this list (with explicit handling above) or round-trip
  // through this passthrough — never add a v2-only key that does neither.
  // (A-006 architecture-review follow-up.)
  const handledTopLevel = new Set<string>([
    'schema_version', 'project', 'framework', 'paths', 'toolPrefix',
    'verification', 'python', ...PRESERVED_FIELDS,
  ]);
  copyUnknownKeys(v1, v2, handledTopLevel);

  // Ensure domains / rules exist as arrays (v2 requires them).
  if (!Array.isArray(v2.domains)) {
    v2.domains = [];
  }
  if (!Array.isArray(v2.rules)) {
    v2.rules = [];
  }

  if (Object.keys(verification).length > 0) {
    v2.verification = verification;
  }

  // Preserve/update the v1 `python` sub-block when python is detected.
  if (languages.includes('python')) {
    const existing = getRecord(v1.python);
    const pyFw = detection.frameworks.python;
    const pySourceDirs = detection.sourceDirs.python?.source_dirs ?? [];
    const pyRoot =
      typeof existing.root === 'string' && existing.root !== ''
        ? existing.root
        : (pySourceDirs.length > 0 ? pySourceDirs[0] : '.');
    const pythonBlock: Record<string, unknown> = {
      root: pyRoot,
      exclude_dirs: Array.isArray(existing.exclude_dirs)
        ? existing.exclude_dirs
        : ['__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache'],
    };
    if (existing.domains !== undefined) pythonBlock.domains = existing.domains;
    if (existing.alembic_dir !== undefined) pythonBlock.alembic_dir = existing.alembic_dir;
    if (pyFw?.framework && existing.framework === undefined) {
      pythonBlock.framework = pyFw.framework;
    } else if (existing.framework !== undefined) {
      pythonBlock.framework = existing.framework;
    }
    if (pyFw?.orm && existing.orm === undefined) {
      pythonBlock.orm = pyFw.orm;
    } else if (existing.orm !== undefined) {
      pythonBlock.orm = existing.orm;
    }
    // P1-007: preserve any v1 python subkey not already handled above
    // (e.g., `python.test_framework`, `python.database`).
    preserveNestedSubkeys(v1.python, pythonBlock);
    v2.python = pythonBlock;
  } else if (v1.python !== undefined) {
    // Preserve even if detection didn't find python (e.g. non-monorepo-with-python).
    v2.python = v1.python;
  }

  return v2;
}

/**
 * Return the common top-level parent directory across every workspace
 * package (mirror of init.ts:monorepoCommonRoot). Returns `'.'` when
 * packages span multiple parents.
 */
function monorepoCommonRootMigrate(
  packages: ReadonlyArray<{ path: string }>
): string {
  const roots = monorepoDistinctRootsMigrate(packages);
  return roots.length === 1 ? roots[0] : '.';
}

/**
 * Return the distinct top-level parent directories of every workspace
 * package (mirror of init.ts:monorepoDistinctRoots). Sorted for determinism.
 */
function monorepoDistinctRootsMigrate(
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
