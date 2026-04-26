// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P2-000 (2026-04-19): Strategy A chosen — extend config.ts in-place.
// Per Phase 0 artifact (.massu/agent-results/phase0-discovery.md)
// the CR-10 blast radius is 52 non-test consumers, with only 1 CHANGE callsite
// (tools.ts) and zero INVESTIGATE items. No file split. All schema v2 extensions
// live below and preserve the v1 `framework.{type,router,orm,ui}` access paths
// so existing consumers (tools.ts:89,192,246) keep working unchanged.
// ============================================================

import { resolve, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ============================================================
// Massu Configuration — Zod Schemas & Types
// ============================================================

// --- Domain Config ---
const DomainConfigSchema = z.object({
  name: z.string().default('Unknown'),
  routers: z.array(z.string()).default([]),
  pages: z.array(z.string()).default([]),
  tables: z.array(z.string()).default([]),
  allowedImportsFrom: z.array(z.string()).default([]),
});
export type DomainConfig = z.infer<typeof DomainConfigSchema>;

// --- Pattern Rule Config ---
// P2-003: optional `language` discriminator so rules can be scoped to a specific
// runtime (e.g., only apply to Python files). Rules without `language` continue
// to apply to all files for v1 backcompat.
const PatternRuleConfigSchema = z.object({
  pattern: z.string().default('**'),
  rules: z.array(z.string()).default([]),
  language: z.string().optional(),
});
export type PatternRuleConfig = z.infer<typeof PatternRuleConfigSchema>;

// --- Cost Model ---
const CostModelSchema = z.object({
  input_per_million: z.number(),
  output_per_million: z.number(),
  cache_read_per_million: z.number().optional(),
  cache_write_per_million: z.number().optional(),
});

// --- Analytics Config ---
const AnalyticsConfigSchema = z.object({
  quality: z.object({
    weights: z.record(z.string(), z.number()).default({
      bug_found: -5, vr_failure: -10, incident: -20, cr_violation: -3,
      vr_pass: 2, clean_commit: 5, successful_verification: 3,
    }),
    categories: z.array(z.string()).default(['security', 'architecture', 'coupling', 'tests', 'rule_compliance']),
  }).optional(),
  cost: z.object({
    models: z.record(z.string(), CostModelSchema).default({}),
    currency: z.string().default('USD'),
  }).optional(),
  prompts: z.object({
    success_indicators: z.array(z.string()).default(['committed', 'approved', 'looks good', 'perfect', 'great', 'thanks']),
    failure_indicators: z.array(z.string()).default(['revert', 'wrong', "that's not", 'undo', 'incorrect']),
    max_turns_for_success: z.number().default(2),
  }).optional(),
}).optional();
export type AnalyticsConfig = z.infer<typeof AnalyticsConfigSchema>;

// --- Custom Pattern (for validation) ---
const CustomPatternSchema = z.object({
  pattern: z.string(),
  severity: z.string(),
  message: z.string(),
});

// --- Governance Config ---
const GovernanceConfigSchema = z.object({
  audit: z.object({
    formats: z.array(z.string()).default(['summary', 'detailed', 'soc2']),
    retention_days: z.number().default(365),
    auto_log: z.record(z.string(), z.boolean()).default({
      code_changes: true, rule_enforcement: true, approvals: true, commits: true,
    }),
  }).optional(),
  validation: z.object({
    realtime: z.boolean().default(true),
    checks: z.record(z.string(), z.boolean()).default({
      rule_compliance: true, import_existence: true, naming_conventions: true,
    }),
    custom_patterns: z.array(CustomPatternSchema).default([]),
  }).optional(),
  adr: z.object({
    detection_phrases: z.array(z.string()).default(['chose', 'decided', 'switching to', 'moving from', 'going with']),
    template: z.string().default('default'),
    storage: z.string().default('database'),
    output_dir: z.string().default('docs/adr'),
  }).optional(),
}).optional();
export type GovernanceConfig = z.infer<typeof GovernanceConfigSchema>;

// --- Security Pattern ---
const SecurityPatternSchema = z.object({
  pattern: z.string(),
  severity: z.string(),
  category: z.string(),
  description: z.string(),
});

// --- Security Config ---
const SecurityConfigSchema = z.object({
  patterns: z.array(SecurityPatternSchema).default([]),
  auto_score_on_edit: z.boolean().default(true),
  score_threshold_alert: z.number().default(50),
  severity_weights: z.record(z.string(), z.number()).optional(),
  restrictive_licenses: z.array(z.string()).optional(),
  dep_alternatives: z.record(z.string(), z.array(z.string())).optional(),
  dependencies: z.object({
    package_manager: z.string().default('npm'),
    blocked_packages: z.array(z.string()).default([]),
    preferred_packages: z.record(z.string(), z.string()).default({}),
    max_bundle_size_kb: z.number().default(500),
  }).optional(),
}).optional();
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

// --- Team Config ---
const TeamConfigSchema = z.object({
  enabled: z.boolean().default(false),
  sync_backend: z.string().default('local'),
  developer_id: z.string().default('auto'),
  share_by_default: z.boolean().default(false),
  expertise_weights: z.object({
    session: z.number().default(20),
    observation: z.number().default(10),
  }).optional(),
  privacy: z.object({
    share_file_paths: z.boolean().default(true),
    share_code_snippets: z.boolean().default(false),
    share_observations: z.boolean().default(true),
  }).optional(),
}).optional();
export type TeamConfig = z.infer<typeof TeamConfigSchema>;

// --- Regression Config ---
const RegressionConfigSchema = z.object({
  test_patterns: z.array(z.string()).default([
    '{dir}/__tests__/{name}.test.{ext}',
    '{dir}/{name}.spec.{ext}',
    'tests/{path}.test.{ext}',
  ]),
  test_runner: z.string().default('npm test'),
  health_thresholds: z.object({
    healthy: z.number().default(80),
    warning: z.number().default(50),
  }).optional(),
}).optional();
export type RegressionConfig = z.infer<typeof RegressionConfigSchema>;

// --- Auto-Learning Config ---
const AutoLearningConfigSchema = z.object({
  enabled: z.boolean().default(true),
  incidentDir: z.string().default('docs/incidents'),
  memoryDir: z.string().default('memory'),
  memoryIndexFile: z.string().default('MEMORY.md'),
  enforcementHooksDir: z.string().default('scripts/hooks'),
  fixDetection: z.object({
    enabled: z.boolean().default(true),
    lookbackDays: z.number().default(7),
    signals: z.array(z.string()).default([
      'removed_broken_code',
      'added_error_handling',
      'method_name_correction',
      'auth_fix',
      'nil_handling_fix',
      'concurrency_fix',
      'async_pattern_fix',
      'added_missing_import',
    ]),
  }).default({}),
  failureClassification: z.object({
    enabled: z.boolean().default(true),
    thresholds: z.object({
      known: z.number().default(5),
      similar: z.number().default(3),
    }).default({}),
    scoring: z.object({
      diffPatternWeight: z.number().default(3),
      filePatternWeight: z.number().default(2),
      promptKeywordWeight: z.number().default(2),
    }).default({}),
  }).default({}),
  pipeline: z.object({
    requireIncidentReport: z.boolean().default(true),
    requirePreventionRule: z.boolean().default(true),
    requireEnforcement: z.boolean().default(true),
  }).default({}),
}).optional();
export type AutoLearningConfig = z.infer<typeof AutoLearningConfigSchema>;

// --- Cloud Config ---
const CloudConfigSchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string().optional(),
  endpoint: z.string().optional(),
  sync: z.object({
    memory: z.boolean().default(true),
    analytics: z.boolean().default(true),
    audit: z.boolean().default(true),
  }).default({ memory: true, analytics: true, audit: true }),
}).optional();
export type CloudConfig = z.infer<typeof CloudConfigSchema>;

// --- Conventions Config ---
const ConventionsConfigSchema = z.object({
  claudeDirName: z.string().default('.claude').refine(
    s => !s.includes('..') && !s.startsWith('/'),
    { message: 'claudeDirName must not contain ".." or start with "/"' }
  ),
  sessionStatePath: z.string().default('.claude/session-state/CURRENT.md').refine(
    s => !s.includes('..') && !s.startsWith('/'),
    { message: 'sessionStatePath must not contain ".." or start with "/"' }
  ),
  sessionArchivePath: z.string().default('.claude/session-state/archive').refine(
    s => !s.includes('..') && !s.startsWith('/'),
    { message: 'sessionArchivePath must not contain ".." or start with "/"' }
  ),
  knowledgeCategories: z.array(z.string()).default([
    'patterns', 'commands', 'incidents', 'reference', 'protocols',
    'checklists', 'playbooks', 'critical', 'scripts', 'status',
    'templates', 'loop-state', 'session-state', 'agents',
  ]),
  knowledgeSourceFiles: z.array(z.string()).default(['CLAUDE.md', 'MEMORY.md', 'corrections.md']),
  excludePatterns: z.array(z.string()).default(['/ARCHIVE/', '/SESSION-HISTORY/']),
}).optional();
export type ConventionsConfig = z.infer<typeof ConventionsConfigSchema>;

// --- Python Config ---
const PythonDomainConfigSchema = z.object({
  name: z.string(),
  packages: z.array(z.string()),
  allowed_imports_from: z.array(z.string()).default([]),
});

const PythonConfigSchema = z.object({
  root: z.string(),
  alembic_dir: z.string().optional(),
  domains: z.array(PythonDomainConfigSchema).default([]),
  exclude_dirs: z.array(z.string()).default(['__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache']),
}).optional();
export type PythonConfig = z.infer<typeof PythonConfigSchema>;

// --- Paths Config ---
// `monorepo_roots` (P1-005): optional, additive. Emitted by `init --ci` when
// `monorepo.type !== 'single'` and at least one workspace package exists.
// Downstream tools may consume it for monorepo-aware scanning. Existing v1
// configs omit it — `.optional()` preserves full back-compat.
const PathsConfigSchema = z.object({
  source: z.string().default('src'),
  aliases: z.record(z.string(), z.string()).default({ '@': 'src' }),
  monorepo_roots: z.array(z.string()).optional(),
  routers: z.string().optional(),
  routerRoot: z.string().optional(),
  pages: z.string().optional(),
  middleware: z.string().optional(),
  schema: z.string().optional(),
  components: z.string().optional(),
  hooks: z.string().optional(),
});

// --- P2-002: Multi-runtime per-language entry ---
// Each entry declares the framework + test framework + optional router/orm/ui
// used for that language slot. Used when `framework.type === 'multi'` via
// `framework.languages`.
const LanguageFrameworkEntrySchema = z.object({
  framework: z.string().optional(),
  test_framework: z.string().optional(),
  test: z.string().optional(),
  runtime: z.string().optional(),
  orm: z.string().optional(),
  router: z.string().optional(),
  ui: z.string().optional(),
}).passthrough();
export type LanguageFrameworkEntry = z.infer<typeof LanguageFrameworkEntrySchema>;

// --- P2-002: Framework schema (supports v1 single-language AND v2 multi-runtime) ---
// v1: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' }
// v2: { type: 'multi', primary: 'python', languages: { python: {...}, typescript: {...} } }
// Legacy top-level router/orm/ui keys are PRESERVED in both modes so that
// existing consumers (tools.ts:89,192,246) keep working without refactor.
const FrameworkConfigSchema = z.object({
  type: z.string().default('typescript'),
  primary: z.string().optional(),
  router: z.string().default('none'),
  orm: z.string().default('none'),
  ui: z.string().default('none'),
  languages: z.record(z.string(), LanguageFrameworkEntrySchema).optional(),
}).passthrough();
export type FrameworkConfig = z.infer<typeof FrameworkConfigSchema>;

// --- Codebase-aware templates (Plan #2): `detected:` block ---
// Detector-owned per-language conventions extracted from existing source files
// (auth dep names, common imports, biometric policies, etc.). Refreshed on
// every `init`/`config refresh` and consumed by the templating engine when
// installing slash commands. Free-form via `.passthrough()` so future detector
// fields don't break parsing of older configs.
const DetectedConfigSchema = z.object({}).passthrough().optional();
export type DetectedConfig = z.infer<typeof DetectedConfigSchema>;

// --- P2-004: Verification command map ---
// Map of language name -> command strings for each verification type.
// User entries take precedence over any Phase 1 auto-defaults.
const VerificationEntrySchema = z.object({
  type: z.string().optional(),
  test: z.string().optional(),
  syntax: z.string().optional(),
  lint: z.string().optional(),
  build: z.string().optional(),
}).passthrough();
export type VerificationEntry = z.infer<typeof VerificationEntrySchema>;

const VerificationConfigSchema = z.record(z.string(), VerificationEntrySchema).optional();
export type VerificationConfig = z.infer<typeof VerificationConfigSchema>;

// --- P2-005: Canonical paths extension (free-form string map) ---
const CanonicalPathsSchema = z.record(z.string(), z.string()).optional();
export type CanonicalPaths = z.infer<typeof CanonicalPathsSchema>;

// --- P2-006: VR-* types extension (user-declared verification types) ---
const VerificationTypesSchema = z.record(z.string(), z.string()).optional();
export type VerificationTypes = z.infer<typeof VerificationTypesSchema>;

// --- P2-008: Detection rules extension ---
// Users may add or override built-in detection patterns. Phase 1 detectors
// merge this with the inline DETECTION_RULES table.
const DetectionRuleEntrySchema = z.object({
  signals: z.array(z.string()).default([]),
  priority: z.number().optional(),
}).passthrough();

const DetectionConfigSchema = z.object({
  rules: z.record(
    z.string(), // language
    z.record(z.string(), DetectionRuleEntrySchema) // framework -> rule entry
  ).optional(),
  signal_weights: z.record(z.string(), z.number()).optional(),
  disable_builtin: z.boolean().optional(),
}).passthrough().optional();
export type DetectionConfig = z.infer<typeof DetectionConfigSchema>;

// --- Top-level Raw Config Schema ---
// This validates the raw YAML output, coercing types and providing defaults.
// P2-001: schema_version tracks the config shape version. Defaults to 1 so
// existing v1 configs (without the field) keep loading unchanged. New v2
// configs set `schema_version: 2` explicitly.
const RawConfigSchema = z.object({
  schema_version: z.union([z.literal(1), z.literal(2)]).default(1),
  project: z.object({
    name: z.string().default('my-project'),
    root: z.string().default('auto'),
  }).default({ name: 'my-project', root: 'auto' }),
  framework: FrameworkConfigSchema.default({
    type: 'typescript',
    router: 'none',
    orm: 'none',
    ui: 'none',
  }),
  paths: PathsConfigSchema.default({ source: 'src', aliases: { '@': 'src' } }),
  toolPrefix: z.string().default('massu'),
  dbAccessPattern: z.string().optional(),
  knownMismatches: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  accessScopes: z.array(z.string()).optional(),
  domains: z.array(DomainConfigSchema).default([]),
  rules: z.array(PatternRuleConfigSchema).default([]),
  analytics: AnalyticsConfigSchema,
  governance: GovernanceConfigSchema,
  security: SecurityConfigSchema,
  team: TeamConfigSchema,
  regression: RegressionConfigSchema,
  cloud: CloudConfigSchema,
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
}).passthrough();

// --- Final Config interface (derived from Zod) ---
// Legacy v1 access paths (framework.type/router/orm/ui) are preserved here so
// that existing consumers (tools.ts:89,192,246 etc.) keep working regardless
// of whether the config is v1 or v2 multi-runtime shape.
export interface Config {
  schema_version: 1 | 2;
  project: { name: string; root: string };
  framework: {
    type: string;
    router: string;
    orm: string;
    ui: string;
    primary?: string;
    languages?: Record<string, LanguageFrameworkEntry>;
  };
  paths: z.infer<typeof PathsConfigSchema>;
  toolPrefix: string;
  dbAccessPattern?: string;
  knownMismatches?: Record<string, Record<string, string>>;
  accessScopes?: string[];
  domains: DomainConfig[];
  rules: PatternRuleConfig[];
  analytics?: AnalyticsConfig;
  governance?: GovernanceConfig;
  security?: SecurityConfig;
  team?: TeamConfig;
  regression?: RegressionConfig;
  cloud?: CloudConfig;
  conventions?: ConventionsConfig;
  autoLearning?: AutoLearningConfig;
  python?: PythonConfig;
  // P2-004/005/006/008: optional v2 extensions
  verification?: VerificationConfig;
  canonical_paths?: CanonicalPaths;
  verification_types?: VerificationTypes;
  detection?: DetectionConfig;
  // Plan #2: detector-owned per-language conventions
  detected?: DetectedConfig;
}

let _config: Config | null = null;
let _projectRoot: string | null = null;

/**
 * Find the project root by walking up from cwd.
 * Prioritizes massu.config.yaml (searched all the way up),
 * then falls back to the nearest package.json or .git directory.
 */
function findProjectRoot(): string {
  const cwd = process.cwd();

  // First pass: look for massu.config.yaml all the way up
  let dir = cwd;
  while (true) {
    if (existsSync(resolve(dir, 'massu.config.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Second pass: fall back to nearest package.json or .git
  dir = cwd;
  while (true) {
    if (existsSync(resolve(dir, 'package.json'))) {
      return dir;
    }
    if (existsSync(resolve(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return cwd;
}

/**
 * Get the project root directory.
 */
export function getProjectRoot(): string {
  if (!_projectRoot) {
    _projectRoot = findProjectRoot();
  }
  return _projectRoot;
}

/**
 * Load and return the Massu configuration.
 * Searches for massu.config.yaml in the project root.
 * Uses Zod for runtime validation with sensible defaults.
 */
export function getConfig(): Config {
  if (_config) return _config;

  const root = getProjectRoot();
  const configPath = resolve(root, 'massu.config.yaml');

  let rawYaml: unknown = {};
  if (existsSync(configPath)) {
    const content = readFileSync(configPath, 'utf-8');
    rawYaml = parseYaml(content) ?? {};
  }

  // P2-007: Validate with Zod and surface actionable errors on failure.
  // Every Zod issue is translated into "<field path>: <message> (received <type>)"
  // lines, grouped under a single Error message that names massu.config.yaml.
  const result = RawConfigSchema.safeParse(rawYaml);
  if (!result.success) {
    const issues = result.error.issues.map(i => {
      const path = i.path.length > 0 ? i.path.join('.') : '(root)';
      const received = 'received' in i && i.received !== undefined
        ? ` (received ${JSON.stringify(i.received)})`
        : '';
      return `  - ${path}: ${i.message}${received}`;
    }).join('\n');
    throw new Error(
      `Invalid massu.config.yaml at ${configPath}:\n${issues}\n` +
      `Hint: run \`massu config refresh\` to regenerate a valid config or fix the listed fields manually.`
    );
  }
  const parsed = result.data;

  // Resolve project root path
  const projectRoot = parsed.project.root === 'auto' || !parsed.project.root
    ? root
    : resolve(root, parsed.project.root);

  // P2-002 backcompat: when `framework.type === 'multi'`, mirror router/orm/ui
  // from the primary language entry so that tools.ts:89,192,246 keep resolving.
  // User-provided top-level keys always win — only fall back to the primary
  // language when the top-level value is missing OR still the schema default
  // 'none' (meaning the user didn't set it explicitly).
  const fw = parsed.framework;
  let router = fw.router;
  let orm = fw.orm;
  let ui = fw.ui;
  if (fw.type === 'multi' && fw.primary && fw.languages) {
    const primaryEntry = fw.languages[fw.primary];
    if (primaryEntry) {
      if (router === 'none' && primaryEntry.router) router = primaryEntry.router;
      if (orm === 'none' && primaryEntry.orm) orm = primaryEntry.orm;
      if (ui === 'none' && primaryEntry.ui) ui = primaryEntry.ui;
    }
  }

  _config = {
    schema_version: parsed.schema_version,
    project: {
      name: parsed.project.name,
      root: projectRoot,
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
      ui,
    },
    paths: parsed.paths,
    toolPrefix: parsed.toolPrefix,
    dbAccessPattern: parsed.dbAccessPattern,
    knownMismatches: parsed.knownMismatches,
    accessScopes: parsed.accessScopes,
    domains: parsed.domains,
    rules: parsed.rules,
    analytics: parsed.analytics,
    governance: parsed.governance,
    security: parsed.security,
    team: parsed.team,
    regression: parsed.regression,
    cloud: parsed.cloud,
    conventions: parsed.conventions,
    autoLearning: parsed.autoLearning,
    python: parsed.python,
    verification: parsed.verification,
    canonical_paths: parsed.canonical_paths,
    verification_types: parsed.verification_types,
    detection: parsed.detection,
    detected: parsed.detected,
  };

  // Allow environment variable override for API key (security best practice)
  if (!_config.cloud?.apiKey && process.env.MASSU_API_KEY) {
    _config.cloud = {
      enabled: true,
      sync: { memory: true, analytics: true, audit: true },
      ..._config.cloud,
      apiKey: process.env.MASSU_API_KEY,
    };
  }

  return _config;
}

/**
 * Get resolved paths for common project locations.
 * Computed from the YAML config with sensible defaults.
 */
export function getResolvedPaths() {
  const config = getConfig();
  const root = getProjectRoot();
  const claudeDirName = config.conventions?.claudeDirName ?? '.claude';

  return {
    codegraphDbPath: resolve(root, '.codegraph/codegraph.db'),
    dataDbPath: resolve(root, '.massu/data.db'),
    prismaSchemaPath: resolve(root, config.paths.schema ?? 'prisma/schema.prisma'),
    rootRouterPath: resolve(root, config.paths.routerRoot ?? 'src/server/api/root.ts'),
    routersDir: resolve(root, config.paths.routers ?? 'src/server/api/routers'),
    srcDir: resolve(root, config.paths.source),
    pathAlias: Object.fromEntries(
      Object.entries(config.paths.aliases).map(([alias, target]) => [
        alias,
        resolve(root, target),
      ])
    ) as Record<string, string>,
    extensions: ['.ts', '.tsx', '.js', '.jsx'] as const,
    indexFiles: ['index.ts', 'index.tsx', 'index.js', 'index.jsx'] as const,
    patternsDir: resolve(root, claudeDirName, 'patterns'),
    claudeMdPath: resolve(root, claudeDirName, 'CLAUDE.md'),
    docsMapPath: resolve(root, '.massu/docs-map.json'),
    helpSitePath: resolve(root, '../' + config.project.name + '-help'),
    memoryDbPath: resolve(root, '.massu/memory.db'),
    knowledgeDbPath: resolve(root, '.massu/knowledge.db'),
    plansDir: resolve(root, 'docs/plans'),
    docsDir: resolve(root, 'docs'),
    claudeDir: resolve(root, claudeDirName),
    memoryDir: resolve(homedir(), claudeDirName, 'projects', root.replace(/\//g, '-'), 'memory'),
    sessionStatePath: resolve(root, config.conventions?.sessionStatePath ?? `${claudeDirName}/session-state/CURRENT.md`),
    sessionArchivePath: resolve(root, config.conventions?.sessionArchivePath ?? `${claudeDirName}/session-state/archive`),
    mcpJsonPath: resolve(root, '.mcp.json'),
    settingsLocalPath: resolve(root, claudeDirName, 'settings.local.json'),
  };
}

/**
 * Reset the cached config (useful for testing).
 */
export function resetConfig(): void {
  _config = null;
  _projectRoot = null;
}
