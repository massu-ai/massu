// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

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
const PatternRuleConfigSchema = z.object({
  pattern: z.string().default('**'),
  rules: z.array(z.string()).default([]),
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

// --- Paths Config ---
const PathsConfigSchema = z.object({
  source: z.string().default('src'),
  aliases: z.record(z.string(), z.string()).default({ '@': 'src' }),
  routers: z.string().optional(),
  routerRoot: z.string().optional(),
  pages: z.string().optional(),
  middleware: z.string().optional(),
  schema: z.string().optional(),
  components: z.string().optional(),
  hooks: z.string().optional(),
});

// --- Top-level Raw Config Schema ---
// This validates the raw YAML output, coercing types and providing defaults.
const RawConfigSchema = z.object({
  project: z.object({
    name: z.string().default('my-project'),
    root: z.string().default('auto'),
  }).default({ name: 'my-project', root: 'auto' }),
  framework: z.object({
    type: z.string().default('typescript'),
    router: z.string().default('none'),
    orm: z.string().default('none'),
    ui: z.string().default('none'),
  }).default({ type: 'typescript', router: 'none', orm: 'none', ui: 'none' }),
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
}).passthrough();

// --- Final Config interface (derived from Zod) ---
export interface Config {
  project: { name: string; root: string };
  framework: { type: string; router: string; orm: string; ui: string };
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

  // Validate with Zod — provides defaults and type coercion
  const parsed = RawConfigSchema.parse(rawYaml);

  // Resolve project root path
  const projectRoot = parsed.project.root === 'auto' || !parsed.project.root
    ? root
    : resolve(root, parsed.project.root);

  _config = {
    project: {
      name: parsed.project.name,
      root: projectRoot,
    },
    framework: parsed.framework,
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
