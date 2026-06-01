#!/usr/bin/env node
import{createRequire as __cr}from"module";const require=__cr(import.meta.url);

// src/memory-db.ts
import Database from "better-sqlite3";
import { dirname as dirname2, basename } from "path";
import { existsSync as existsSync2, mkdirSync } from "fs";

// src/config.ts
import { resolve, dirname } from "path";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// src/lib/memory-path.ts
function encodeMemoryDirName(projectRoot) {
  return projectRoot.replace(/\//g, "-");
}

// src/config.ts
var DomainConfigSchema = z.object({
  name: z.string().default("Unknown"),
  routers: z.array(z.string()).default([]),
  pages: z.array(z.string()).default([]),
  tables: z.array(z.string()).default([]),
  allowedImportsFrom: z.array(z.string()).default([])
});
var PatternRuleConfigSchema = z.object({
  pattern: z.string().default("**"),
  rules: z.array(z.string()).default([]),
  language: z.string().optional()
});
var CostModelSchema = z.object({
  input_per_million: z.number(),
  output_per_million: z.number(),
  cache_read_per_million: z.number().optional(),
  cache_write_per_million: z.number().optional()
});
var AnalyticsConfigSchema = z.object({
  quality: z.object({
    weights: z.record(z.string(), z.number()).default({
      bug_found: -5,
      vr_failure: -10,
      incident: -20,
      cr_violation: -3,
      vr_pass: 2,
      clean_commit: 5,
      successful_verification: 3
    }),
    categories: z.array(z.string()).default(["security", "architecture", "coupling", "tests", "rule_compliance"])
  }).optional(),
  cost: z.object({
    models: z.record(z.string(), CostModelSchema).default({}),
    currency: z.string().default("USD")
  }).optional(),
  prompts: z.object({
    success_indicators: z.array(z.string()).default(["committed", "approved", "looks good", "perfect", "great", "thanks"]),
    failure_indicators: z.array(z.string()).default(["revert", "wrong", "that's not", "undo", "incorrect"]),
    max_turns_for_success: z.number().default(2)
  }).optional()
}).optional();
var CustomPatternSchema = z.object({
  pattern: z.string(),
  severity: z.string(),
  message: z.string()
});
var GovernanceConfigSchema = z.object({
  audit: z.object({
    formats: z.array(z.string()).default(["summary", "detailed", "soc2"]),
    retention_days: z.number().default(365),
    auto_log: z.record(z.string(), z.boolean()).default({
      code_changes: true,
      rule_enforcement: true,
      approvals: true,
      commits: true
    })
  }).optional(),
  validation: z.object({
    realtime: z.boolean().default(true),
    checks: z.record(z.string(), z.boolean()).default({
      rule_compliance: true,
      import_existence: true,
      naming_conventions: true
    }),
    custom_patterns: z.array(CustomPatternSchema).default([])
  }).optional(),
  adr: z.object({
    detection_phrases: z.array(z.string()).default(["chose", "decided", "switching to", "moving from", "going with"]),
    template: z.string().default("default"),
    storage: z.string().default("database"),
    output_dir: z.string().default("docs/adr")
  }).optional()
}).optional();
var SecurityPatternSchema = z.object({
  pattern: z.string(),
  severity: z.string(),
  category: z.string(),
  description: z.string()
});
var SecurityConfigSchema = z.object({
  patterns: z.array(SecurityPatternSchema).default([]),
  auto_score_on_edit: z.boolean().default(true),
  score_threshold_alert: z.number().default(50),
  severity_weights: z.record(z.string(), z.number()).optional(),
  restrictive_licenses: z.array(z.string()).optional(),
  dep_alternatives: z.record(z.string(), z.array(z.string())).optional(),
  dependencies: z.object({
    package_manager: z.string().default("npm"),
    blocked_packages: z.array(z.string()).default([]),
    preferred_packages: z.record(z.string(), z.string()).default({}),
    max_bundle_size_kb: z.number().default(500)
  }).optional()
}).optional();
var TeamConfigSchema = z.object({
  enabled: z.boolean().default(false),
  sync_backend: z.string().default("local"),
  developer_id: z.string().default("auto"),
  share_by_default: z.boolean().default(false),
  expertise_weights: z.object({
    session: z.number().default(20),
    observation: z.number().default(10)
  }).optional(),
  privacy: z.object({
    share_file_paths: z.boolean().default(true),
    share_code_snippets: z.boolean().default(false),
    share_observations: z.boolean().default(true)
  }).optional()
}).optional();
var RegressionConfigSchema = z.object({
  test_patterns: z.array(z.string()).default([
    "{dir}/__tests__/{name}.test.{ext}",
    "{dir}/{name}.spec.{ext}",
    "tests/{path}.test.{ext}"
  ]),
  test_runner: z.string().default("npm test"),
  health_thresholds: z.object({
    healthy: z.number().default(80),
    warning: z.number().default(50)
  }).optional()
}).optional();
var AutoLearningConfigSchema = z.object({
  enabled: z.boolean().default(true),
  incidentDir: z.string().default("docs/incidents"),
  memoryDir: z.string().default("memory"),
  memoryIndexFile: z.string().default("MEMORY.md"),
  enforcementHooksDir: z.string().default("scripts/hooks"),
  fixDetection: z.object({
    enabled: z.boolean().default(true),
    lookbackDays: z.number().default(7),
    signals: z.array(z.string()).default([
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
  failureClassification: z.object({
    enabled: z.boolean().default(true),
    thresholds: z.object({
      known: z.number().default(5),
      similar: z.number().default(3)
    }).default({}),
    scoring: z.object({
      diffPatternWeight: z.number().default(3),
      filePatternWeight: z.number().default(2),
      promptKeywordWeight: z.number().default(2)
    }).default({})
  }).default({}),
  pipeline: z.object({
    requireIncidentReport: z.boolean().default(true),
    requirePreventionRule: z.boolean().default(true),
    requireEnforcement: z.boolean().default(true)
  }).default({}),
  // plan-v0.2-interactive-rule-approval P-D-008 / P-D-009: project-configured
  // custom destinations for the rule-candidate funnel. The classifier matches
  // a candidate to one of these entries when none of the framework
  // destinations (pattern-scanner / claude-md-cr / corrections-md) apply.
  customDestinations: z.array(z.object({
    name: z.string(),
    path: z.string(),
    triggerKeywords: z.array(z.string()).default([]),
    template: z.string()
  })).default([])
}).optional();
var CloudConfigSchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string().optional(),
  endpoint: z.string().optional(),
  sync: z.object({
    memory: z.boolean().default(true),
    analytics: z.boolean().default(true),
    audit: z.boolean().default(true)
  }).default({ memory: true, analytics: true, audit: true })
}).optional();
var ConventionsConfigSchema = z.object({
  claudeDirName: z.string().default(".claude").refine(
    (s) => !s.includes("..") && !s.startsWith("/"),
    { message: 'claudeDirName must not contain ".." or start with "/"' }
  ),
  sessionStatePath: z.string().default(".claude/session-state/CURRENT.md").refine(
    (s) => !s.includes("..") && !s.startsWith("/"),
    { message: 'sessionStatePath must not contain ".." or start with "/"' }
  ),
  sessionArchivePath: z.string().default(".claude/session-state/archive").refine(
    (s) => !s.includes("..") && !s.startsWith("/"),
    { message: 'sessionArchivePath must not contain ".." or start with "/"' }
  ),
  knowledgeCategories: z.array(z.string()).default([
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
  knowledgeSourceFiles: z.array(z.string()).default(["CLAUDE.md", "MEMORY.md", "corrections.md"]),
  excludePatterns: z.array(z.string()).default(["/ARCHIVE/", "/SESSION-HISTORY/"])
}).optional();
var PythonDomainConfigSchema = z.object({
  name: z.string(),
  packages: z.array(z.string()),
  allowed_imports_from: z.array(z.string()).default([])
});
var PythonConfigSchema = z.object({
  root: z.string(),
  alembic_dir: z.string().optional(),
  domains: z.array(PythonDomainConfigSchema).default([]),
  exclude_dirs: z.array(z.string()).default(["__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache"])
}).optional();
var PathsConfigSchema = z.object({
  source: z.string().default("src"),
  aliases: z.record(z.string(), z.string()).default({ "@": "src" }),
  monorepo_roots: z.array(z.string()).optional(),
  routers: z.string().optional(),
  routerRoot: z.string().optional(),
  pages: z.string().optional(),
  middleware: z.string().optional(),
  schema: z.string().optional(),
  components: z.string().optional(),
  hooks: z.string().optional()
});
var LanguageFrameworkEntrySchema = z.object({
  framework: z.string().optional(),
  test_framework: z.string().optional(),
  test: z.string().optional(),
  runtime: z.string().optional(),
  orm: z.string().optional(),
  router: z.string().optional(),
  ui: z.string().optional()
}).passthrough();
var FrameworkConfigSchema = z.object({
  type: z.string().default("typescript"),
  primary: z.string().optional(),
  router: z.string().default("none"),
  orm: z.string().default("none"),
  ui: z.string().default("none"),
  languages: z.record(z.string(), LanguageFrameworkEntrySchema).optional()
}).passthrough();
var DetectedConfigSchema = z.object({}).passthrough().optional();
var VerificationEntrySchema = z.object({
  type: z.string().optional(),
  test: z.string().optional(),
  syntax: z.string().optional(),
  lint: z.string().optional(),
  build: z.string().optional()
}).passthrough();
var VerificationConfigSchema = z.record(z.string(), VerificationEntrySchema).optional();
var CanonicalPathsSchema = z.record(z.string(), z.string()).optional();
var VerificationTypesSchema = z.record(z.string(), z.string()).optional();
var DetectionRuleEntrySchema = z.object({
  signals: z.array(z.string()).default([]),
  priority: z.number().optional()
}).passthrough();
var DetectionConfigSchema = z.object({
  rules: z.record(
    z.string(),
    // language
    z.record(z.string(), DetectionRuleEntrySchema)
    // framework -> rule entry
  ).optional(),
  signal_weights: z.record(z.string(), z.number()).optional(),
  disable_builtin: z.boolean().optional()
}).passthrough().optional();
var WatchConfigSchema = z.object({
  debounce_ms: z.number().int().positive().default(3e3),
  storm_threshold: z.number().int().positive().default(50),
  deep_storm_threshold: z.number().int().positive().default(500),
  hard_timeout_ms: z.number().int().positive().default(3e5),
  scope: z.enum(["paths", "full"]).default("paths"),
  // Plan 3a hotfix 2026-05-02: refuse to start if the watch surface
  // exceeds this many files. Prevents the misconfig pattern where
  // `paths.source_dirs` includes `.` or otherwise expands to a 60K+
  // file tree, producing 30-100% steady CPU. Override via
  // `paths_full_root_opt_in: true` for users on small repos who genuinely
  // need root-level watching.
  max_watched_files: z.number().int().positive().default(1e4),
  paths_full_root_opt_in: z.boolean().default(false)
}).passthrough().optional();
var AdapterLocalPathSchema = z.string().refine((s) => !/^([A-Za-z]:[\\/]|[\\/])/.test(s), {
  message: "absolute paths are rejected; adapters.local entries must be relative to the massu.config.yaml directory"
}).refine((s) => !s.split(/[\\/]/).includes(".."), {
  message: "parent-directory traversal (`..`) is rejected; adapters.local entries must stay inside the project tree"
}).transform((s) => s.split(/[\\/]/).filter((part) => part !== "" && part !== ".").join("/"));
var AdaptersConfigSchema = z.object({
  enabled: z.boolean().default(false),
  local: z.array(AdapterLocalPathSchema).default([])
}).passthrough().optional();
var TelemetryConfigSchema = z.object({
  adapters: z.boolean().default(false)
}).passthrough().optional();
var LSPConfigSchema = z.object({
  enabled: z.boolean().default(false),
  servers: z.array(z.object({
    language: z.string(),
    command: z.string(),
    // F-014 (closed 2026-05-06): explicit opt-in to spawn SUID/SGID
    // binaries. Default false — argv[0] with the SUID bit is rejected
    // unless this is true. Decision is auditable in the YAML.
    allow_setuid: z.boolean().default(false),
    // F-015 (closed 2026-05-06): per-server RSS budget (MB). Watchdog
    // SIGKILLs the server after sustained breach. Default 1024 MB.
    // Set to 0 to disable the watchdog for this server.
    max_rss_mb: z.number().int().nonnegative().default(1024)
  })).default([]),
  autoDetect: z.object({
    viaPortScan: z.boolean().default(false)
  }).optional()
}).passthrough();
var RawConfigSchema = z.object({
  schema_version: z.union([z.literal(1), z.literal(2)]).default(1),
  project: z.object({
    name: z.string().default("my-project"),
    root: z.string().default("auto")
  }).default({ name: "my-project", root: "auto" }),
  framework: FrameworkConfigSchema.default({
    type: "typescript",
    router: "none",
    orm: "none",
    ui: "none"
  }),
  paths: PathsConfigSchema.default({ source: "src", aliases: { "@": "src" } }),
  toolPrefix: z.string().default("massu"),
  dbAccessPattern: z.string().optional(),
  knownMismatches: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  accessScopes: z.array(z.string()).optional(),
  domains: z.array(DomainConfigSchema).default([]),
  rules: z.array(PatternRuleConfigSchema).default([]),
  // P-M-036 (plan-stage-d-medium-sweep): customer-authored CR-style
  // governance rules. DISTINCT from `rules:` above (path-scoped lint hints
  // used by pattern-scanner). At config-refresh time these entries are
  // loaded into the `knowledge_rules` SQLite table with
  // `source = 'customer-config'` so `massu_knowledge_rule` and the
  // governance docs surface customer-defined rules alongside framework CRs.
  governance_rules: z.array(
    z.object({
      id: z.string().min(1, "governance_rules[].id is required"),
      title: z.string().min(1, "governance_rules[].title is required"),
      description: z.string().min(1, "governance_rules[].description is required"),
      vr_type: z.string().default("VR-CUSTOM"),
      reference_path: z.string().optional(),
      severity: z.enum(["critical", "high", "medium", "low", "info"]).default("medium")
    }).passthrough()
  ).default([]),
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
  // Plan 3a: file-watcher daemon tunables
  watch: WatchConfigSchema,
  // Plan 3c: third-party adapter registry kill-switch + signing override + local-path opt-in.
  adapters: AdaptersConfigSchema,
  // Plan 3c: anonymous adapter-discovery telemetry opt-in (default off).
  telemetry: TelemetryConfigSchema,
  // Plan 3b Phase 4: optional LSP enrichment of AST adapter results.
  lsp: LSPConfigSchema.optional()
}).passthrough();
var _config = null;
var _projectRoot = null;
function findProjectRoot() {
  const cwd = process.cwd();
  let dir = cwd;
  while (true) {
    if (existsSync(resolve(dir, "massu.config.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dir = cwd;
  while (true) {
    if (existsSync(resolve(dir, "package.json"))) {
      return dir;
    }
    if (existsSync(resolve(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
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
  const configPath = resolve(root, "massu.config.yaml");
  let rawYaml = {};
  if (existsSync(configPath)) {
    const content = readFileSync(configPath, "utf-8");
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
  const projectRoot = parsed.project.root === "auto" || !parsed.project.root ? root : resolve(root, parsed.project.root);
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
  if (!_config.cloud?.apiKey && process.env.MASSU_API_KEY) {
    _config.cloud = {
      enabled: true,
      sync: { memory: true, analytics: true, audit: true },
      ..._config.cloud,
      apiKey: process.env.MASSU_API_KEY
    };
  }
  return _config;
}
function getResolvedPaths() {
  const config = getConfig();
  const root = getProjectRoot();
  const claudeDirName = config.conventions?.claudeDirName ?? ".claude";
  return {
    codegraphDbPath: resolve(root, ".codegraph/codegraph.db"),
    dataDbPath: resolve(root, ".massu/data.db"),
    prismaSchemaPath: resolve(root, config.paths.schema ?? "prisma/schema.prisma"),
    rootRouterPath: resolve(root, config.paths.routerRoot ?? "src/server/api/root.ts"),
    routersDir: resolve(root, config.paths.routers ?? "src/server/api/routers"),
    srcDir: resolve(root, config.paths.source),
    pathAlias: Object.fromEntries(
      Object.entries(config.paths.aliases).map(([alias, target]) => [
        alias,
        resolve(root, target)
      ])
    ),
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    indexFiles: ["index.ts", "index.tsx", "index.js", "index.jsx"],
    patternsDir: resolve(root, claudeDirName, "patterns"),
    claudeMdPath: resolve(root, claudeDirName, "CLAUDE.md"),
    docsMapPath: resolve(root, ".massu/docs-map.json"),
    helpSitePath: resolve(root, "../" + config.project.name + "-help"),
    memoryDbPath: resolve(root, ".massu/memory.db"),
    knowledgeDbPath: resolve(root, ".massu/knowledge.db"),
    plansDir: resolve(root, "docs/plans"),
    docsDir: resolve(root, "docs"),
    claudeDir: resolve(root, claudeDirName),
    memoryDir: resolve(homedir(), claudeDirName, "projects", encodeMemoryDirName(root), "memory"),
    sessionStatePath: resolve(root, config.conventions?.sessionStatePath ?? `${claudeDirName}/session-state/CURRENT.md`),
    sessionArchivePath: resolve(root, config.conventions?.sessionArchivePath ?? `${claudeDirName}/session-state/archive`),
    mcpJsonPath: resolve(root, ".mcp.json"),
    settingsLocalPath: resolve(root, claudeDirName, "settings.local.json")
  };
}

// src/memory-db.ts
function getMemoryDb() {
  const dbPath = getResolvedPaths().memoryDbPath;
  const dir = dirname2(dbPath);
  if (!existsSync2(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initMemorySchema(db);
  return db;
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
    "rule_dismissed"
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
          'rule_candidate_emitted', 'rule_promoted', 'rule_dismissed'
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
        'rule_candidate_emitted', 'rule_promoted', 'rule_dismissed'
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
function drainTeamPromotions(db) {
  const rows = db.prepare(`
    SELECT prompt_hash, destination, draft_text, score, signals_json, content_hash, hardened, review_attestation_json
    FROM team_promotion_outbound ORDER BY created_at ASC LIMIT 1000
  `).all();
  if (rows.length === 0) return [];
  db.prepare("DELETE FROM team_promotion_outbound").run();
  return rows.map((r) => ({
    prompt_hash: r.prompt_hash,
    destination: r.destination,
    draft_text: r.draft_text,
    score: r.score ?? void 0,
    signals: safeJsonArray(r.signals_json),
    content_hash: r.content_hash,
    hardened: r.hardened === 1,
    review_attestation: r.review_attestation_json ? safeJsonParse(r.review_attestation_json) : void 0
  }));
}
function drainTeamRevocations(db) {
  const rows = db.prepare(
    `SELECT prompt_hash FROM team_revocation_outbound ORDER BY created_at ASC LIMIT 1000`
  ).all();
  if (rows.length === 0) return [];
  db.prepare("DELETE FROM team_revocation_outbound").run();
  return rows.map((r) => r.prompt_hash);
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
function safeJsonArray(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function safeJsonParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return void 0;
  }
}
function dequeuePendingSync(db, limit = 10) {
  const stale = db.prepare(
    "SELECT id, retry_count, last_error FROM pending_sync WHERE retry_count >= 10 LIMIT 10000"
  ).all();
  if (stale.length > 0) {
    const ids = stale.map((s) => s.id);
    db.prepare(`DELETE FROM pending_sync WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
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
function autoDetectTaskId(planFile) {
  if (!planFile) return null;
  const base = basename(planFile);
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
function addConversationTurn(db, sessionId, turnNumber, userPrompt, assistantResponse, toolCallsJson, toolCallCount, promptTokens, responseTokens) {
  const result = db.prepare(`
    INSERT INTO conversation_turns (session_id, turn_number, user_prompt, assistant_response, tool_calls_json, tool_call_count, prompt_tokens, response_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    turnNumber,
    userPrompt,
    assistantResponse ? assistantResponse.slice(0, 1e4) : null,
    toolCallsJson,
    toolCallCount,
    promptTokens,
    responseTokens
  );
  return Number(result.lastInsertRowid);
}
function addToolCallDetail(db, sessionId, turnNumber, toolName, inputSummary, inputSize, outputSize, success, filesInvolved) {
  db.prepare(`
    INSERT INTO tool_call_details (session_id, turn_number, tool_name, tool_input_summary, tool_input_size, tool_output_size, tool_success, files_involved)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    turnNumber,
    toolName,
    inputSummary ? inputSummary.slice(0, 500) : null,
    inputSize,
    outputSize,
    success ? 1 : 0,
    filesInvolved ? JSON.stringify(filesInvolved) : null
  );
}
function getLastProcessedLine(db, sessionId) {
  const row = db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(`last_processed_line:${sessionId}`);
  return row ? parseInt(row.value, 10) : 0;
}
function setLastProcessedLine(db, sessionId, lineNumber) {
  db.prepare("INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)").run(`last_processed_line:${sessionId}`, String(lineNumber));
}

// src/session-archiver.ts
import { existsSync as existsSync3, readFileSync as readFileSync2, writeFileSync, mkdirSync as mkdirSync2, renameSync } from "fs";
import { resolve as resolve3, dirname as dirname3 } from "path";

// src/session-state-generator.ts
function generateCurrentMd(db, sessionId) {
  const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
  if (!session) return "# Session State\n\nNo active session found.\n";
  const observations = db.prepare(
    "SELECT * FROM observations WHERE session_id = ? ORDER BY created_at_epoch ASC LIMIT 10000"
  ).all(sessionId);
  const summary = db.prepare(
    "SELECT * FROM session_summaries WHERE session_id = ? ORDER BY created_at_epoch DESC LIMIT 1"
  ).get(sessionId);
  const prompts = db.prepare(
    "SELECT prompt_text FROM user_prompts WHERE session_id = ? ORDER BY prompt_number ASC LIMIT 1"
  ).all(sessionId);
  const date = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  const firstPrompt = prompts[0]?.prompt_text ?? "Unknown task";
  const taskSummary = firstPrompt.slice(0, 100).replace(/\n/g, " ");
  const lines = [];
  lines.push(`# Session State - ${formatDate(date)}`);
  lines.push("");
  lines.push(`**Last Updated**: ${(/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19)} (auto-generated from massu-memory)`);
  lines.push(`**Status**: ${session.status === "active" ? "IN PROGRESS" : session.status.toUpperCase()} - ${taskSummary}`);
  lines.push(`**Task**: ${taskSummary}`);
  lines.push(`**Session ID**: ${sessionId}`);
  lines.push(`**Branch**: ${session.git_branch ?? "unknown"}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  const completedObs = observations.filter(
    (o) => ["feature", "bugfix", "refactor", "file_change"].includes(o.type)
  );
  if (completedObs.length > 0 || summary) {
    lines.push("## COMPLETED WORK");
    lines.push("");
    if (summary?.completed) {
      lines.push(summary.completed);
      lines.push("");
    }
    const filesCreated = observations.filter((o) => o.type === "file_change" && o.title.startsWith("Created")).map((o) => {
      const files = safeParseJson(o.files_involved, []);
      return files[0] ?? o.title.replace("Created/wrote: ", "");
    });
    if (filesCreated.length > 0) {
      lines.push("### Files Created");
      lines.push("");
      lines.push("| File | Purpose |");
      lines.push("|------|---------|");
      for (const f of filesCreated) {
        lines.push(`| \`${f}\` | |`);
      }
      lines.push("");
    }
    const filesModified = observations.filter((o) => o.type === "file_change" && o.title.startsWith("Edited")).map((o) => {
      const files = safeParseJson(o.files_involved, []);
      return files[0] ?? o.title.replace("Edited: ", "");
    });
    if (filesModified.length > 0) {
      lines.push("### Files Modified");
      lines.push("");
      lines.push("| File | Change |");
      lines.push("|------|--------|");
      for (const f of [...new Set(filesModified)]) {
        lines.push(`| \`${f}\` | |`);
      }
      lines.push("");
    }
  }
  const decisions = observations.filter((o) => o.type === "decision");
  if (decisions.length > 0) {
    lines.push("### Key Decisions");
    lines.push("");
    for (const d of decisions) {
      lines.push(`- ${d.title}`);
    }
    lines.push("");
  }
  const failures = observations.filter((o) => o.type === "failed_attempt");
  if (failures.length > 0) {
    lines.push("## FAILED ATTEMPTS (DO NOT RETRY)");
    lines.push("");
    for (const f of failures) {
      lines.push(`- ${f.title}`);
      if (f.detail) lines.push(`  ${f.detail.slice(0, 200)}`);
    }
    lines.push("");
  }
  const vrChecks = observations.filter((o) => o.type === "vr_check");
  if (vrChecks.length > 0) {
    lines.push("## VERIFICATION EVIDENCE");
    lines.push("");
    for (const v of vrChecks) {
      lines.push(`- ${v.title}`);
    }
    lines.push("");
  }
  if (summary?.next_steps) {
    lines.push("## PENDING");
    lines.push("");
    lines.push(summary.next_steps);
    lines.push("");
  }
  if (session.plan_file) {
    lines.push("## PLAN DOCUMENT");
    lines.push("");
    lines.push(`\`${session.plan_file}\``);
    if (summary?.plan_progress) {
      const progress = safeParseJson(summary.plan_progress, {});
      const total = Object.keys(progress).length;
      const complete = Object.values(progress).filter((v) => v === "complete").length;
      if (total > 0) {
        lines.push(`- Progress: ${complete}/${total} items complete`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
function formatDate(dateStr) {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];
  const [year, month, day] = dateStr.split("-").map(Number);
  return `${months[month - 1]} ${day}, ${year}`;
}
function safeParseJson(json, fallback) {
  try {
    return JSON.parse(json);
  } catch (_e) {
    return fallback;
  }
}

// src/session-archiver.ts
function archiveAndRegenerate(db, sessionId) {
  const resolved = getResolvedPaths();
  const currentMdPath = resolved.sessionStatePath;
  const archiveDir = resolved.sessionArchivePath;
  let archived = false;
  let archivePath;
  if (existsSync3(currentMdPath)) {
    const existingContent = readFileSync2(currentMdPath, "utf-8");
    if (existingContent.trim().length > 10) {
      const { date, slug } = extractArchiveInfo(existingContent);
      archivePath = resolve3(archiveDir, `${date}-${slug}.md`);
      if (!existsSync3(archiveDir)) {
        mkdirSync2(archiveDir, { recursive: true });
      }
      try {
        renameSync(currentMdPath, archivePath);
        archived = true;
      } catch (_e) {
        writeFileSync(archivePath, existingContent);
        archived = true;
      }
    }
  }
  const newContent = generateCurrentMd(db, sessionId);
  const dir = dirname3(currentMdPath);
  if (!existsSync3(dir)) {
    mkdirSync2(dir, { recursive: true });
  }
  writeFileSync(currentMdPath, newContent, "utf-8");
  return { archived, archivePath, newContent };
}
function extractArchiveInfo(content) {
  const dateMatch = content.match(/# Session State - (\w+ \d+, \d+)/);
  let date = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  if (dateMatch) {
    const parsed = new Date(dateMatch[1]);
    if (!isNaN(parsed.getTime())) {
      date = parsed.toISOString().split("T")[0];
    }
  }
  const isoMatch = content.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    date = isoMatch[1];
  }
  let slug = "session";
  const taskMatch = content.match(/\*\*Task\*\*:\s*(.+)/);
  if (taskMatch) {
    slug = taskMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  }
  if (slug === "session") {
    const statusMatch = content.match(/\*\*Status\*\*:\s*\w+\s*-\s*(.+)/);
    if (statusMatch) {
      slug = statusMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
    }
  }
  return { date, slug };
}

// src/transcript-parser.ts
import { createReadStream } from "fs";
import { createInterface } from "readline";
function parseEntry(raw) {
  const entryType = raw.type;
  if (!entryType) return null;
  const base = {
    type: ["user", "assistant", "system", "progress", "summary", "file-history-snapshot"].includes(entryType) ? entryType : "unknown",
    sessionId: raw.sessionId,
    gitBranch: raw.gitBranch,
    timestamp: raw.timestamp,
    uuid: raw.uuid
  };
  if (raw.isMeta) {
    base.isMeta = true;
  }
  if (entryType === "user" || entryType === "assistant") {
    const msgRaw = raw.message;
    if (msgRaw) {
      base.message = {
        role: msgRaw.role ?? entryType,
        content: normalizeContent(msgRaw.content)
      };
    }
  }
  if (entryType === "progress") {
    base.data = raw.data;
  }
  return base;
}
function normalizeContent(content) {
  if (!content) return [];
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.filter(
      (block) => typeof block === "object" && block !== null && "type" in block
    );
  }
  return [];
}
async function parseTranscriptFrom(filePath, startLine) {
  const entries = [];
  let lineNumber = 0;
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    lineNumber++;
    if (lineNumber <= startLine) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed);
      const entry = parseEntry(raw);
      if (entry) {
        entries.push(entry);
      }
    } catch (_e) {
      continue;
    }
  }
  return { entries, totalLines: lineNumber };
}
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// src/observation-extractor.ts
var PRIVATE_PATTERNS = [
  /\/Users\/\w+/,
  // Absolute macOS paths
  /\/home\/\w+/,
  // Absolute Linux paths
  /[A-Z]:\\/,
  // Windows paths
  /\b(api[_-]?key|secret|token|password|credential|dsn)\b/i,
  // Secrets
  /\b(STRIPE_|SUPABASE_|SENTRY_|AWS_|DATABASE_URL)\b/,
  // Env var names
  /\.(env|pem|key|cert)\b/,
  // Sensitive file extensions
  /Bearer\s+\S+/,
  // Auth tokens
  /sk_live_|sk_test_|whsec_/
  // Stripe keys
];
function classifyVisibility(title, detail) {
  const text = `${title} ${detail ?? ""}`;
  for (const pattern of PRIVATE_PATTERNS) {
    if (pattern.test(text)) return "private";
  }
  return "public";
}

// src/cloud-sync.ts
var MAX_RETRIES = 3;
var RETRY_DELAYS = [1e3, 2e3, 4e3];
var DEFAULT_CLOUD_REQUEST_TIMEOUT_MS = 2e3;
async function syncToCloud(db, payload) {
  const config = getConfig();
  const cloud = config.cloud;
  if (!cloud?.enabled) {
    return { success: true, synced: { sessions: 0, observations: 0, analytics: 0, audit: 0 } };
  }
  if (!cloud.apiKey) {
    return { success: false, synced: { sessions: 0, observations: 0, analytics: 0, audit: 0 }, error: "No API key configured" };
  }
  const endpoint = cloud.endpoint;
  if (!endpoint) {
    return { success: false, synced: { sessions: 0, observations: 0, analytics: 0, audit: 0 }, error: "No sync endpoint configured" };
  }
  const filteredPayload = {};
  if (cloud.sync?.memory !== false) {
    filteredPayload.sessions = payload.sessions;
    if (payload.observations) {
      let droppedPrivate = 0;
      filteredPayload.observations = payload.observations.filter((obs) => {
        if (classifyVisibility(obs.content ?? "", obs.content ?? "") === "private") {
          droppedPrivate += 1;
          return false;
        }
        if (obs.file_path && classifyVisibility(obs.file_path, obs.file_path) === "private") {
          droppedPrivate += 1;
          return false;
        }
        return true;
      });
      if (droppedPrivate > 0) {
        process.stderr.write(
          `[massu] cloud-sync: dropped ${droppedPrivate} private observation(s) (PRIVATE_PATTERNS match)
`
        );
      }
    }
  }
  if (cloud.sync?.analytics !== false) {
    filteredPayload.analytics = payload.analytics;
  }
  if (cloud.sync?.audit !== false) {
    filteredPayload.audit = payload.audit;
  }
  if (cloud.sync?.memory !== false) {
    if (payload.rule_promotions?.length) {
      let droppedPrivatePromos = 0;
      const safePromos = payload.rule_promotions.filter((p) => {
        if (classifyVisibility(p.draft_text ?? "", p.draft_text ?? "") === "private") {
          droppedPrivatePromos += 1;
          return false;
        }
        return true;
      });
      if (droppedPrivatePromos > 0) {
        process.stderr.write(
          `[massu] cloud-sync: dropped ${droppedPrivatePromos} team rule promotion(s) (PRIVATE_PATTERNS match in draft_text)
`
        );
      }
      if (safePromos.length) filteredPayload.rule_promotions = safePromos;
    }
    if (payload.rule_revocations?.length) filteredPayload.rule_revocations = payload.rule_revocations;
  }
  let lastError = "";
  const requestTimeoutMs = cloud.requestTimeoutMs ?? DEFAULT_CLOUD_REQUEST_TIMEOUT_MS;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${cloud.apiKey}`
        },
        body: JSON.stringify(filteredPayload),
        // P-H003: bounded request — AbortSignal.timeout fires AbortError when
        // the request stalls (DNS failure, TCP unreachable, slow server). Cleans
        // up before hook timeout kills the whole process.
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${response.statusText}`;
        if (response.status >= 400 && response.status < 500) {
          break;
        }
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        break;
      }
      const result = await response.json();
      return {
        success: true,
        synced: {
          sessions: result.synced?.sessions ?? 0,
          observations: result.synced?.observations ?? 0,
          analytics: result.synced?.analytics ?? 0,
          audit: 0
        }
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        break;
      }
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
    }
  }
  try {
    enqueueSyncPayload(db, JSON.stringify(payload));
  } catch (_e) {
  }
  return {
    success: false,
    synced: { sessions: 0, observations: 0, analytics: 0, audit: 0 },
    error: lastError
  };
}
async function drainSyncQueue(db) {
  const config = getConfig();
  if (!config.cloud?.enabled || !config.cloud?.apiKey) return;
  const pending = dequeuePendingSync(db, 10);
  for (const item of pending) {
    try {
      const payload = JSON.parse(item.payload);
      const result = await syncToCloud(db, payload);
      if (result.success) {
        removePendingSync(db, item.id);
      } else {
        incrementRetryCount(db, item.id, result.error ?? "Unknown error");
      }
    } catch (err) {
      incrementRetryCount(db, item.id, err instanceof Error ? err.message : String(err));
    }
  }
}
function sleep(ms) {
  return new Promise((resolve4) => setTimeout(resolve4, ms));
}

// src/team-rule-sync.ts
import { existsSync as existsSync4, writeFileSync as writeFileSync2, unlinkSync, mkdirSync as mkdirSync3 } from "fs";
import { join, dirname as dirname4 } from "path";

// src/license.ts
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
  const canonical = JSON.stringify(canonicalObj, [...payloadKeys].sort());
  try {
    const der = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(key.pubkeyBytes)]);
    const pubkey = createPublicKey({ key: der, format: "der", type: "spki" });
    const ok = cryptoVerify(
      null,
      Buffer.from(canonical, "utf-8"),
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
var LICENSE_PUBKEY_ED25519 = new Uint8Array([39, 136, 108, 146, 85, 233, 119, 252, 223, 226, 123, 155, 234, 168, 200, 150, 36, 249, 174, 6, 130, 146, 125, 196, 136, 224, 202, 150, 53, 228, 114, 15]);
var LICENSE_PUBKEY_FINGERPRINT_HEX = "18a63d64fdec9e5a368fc45feaa49bed6ced815967e582bc7b8af534f22a9475";
var KNOWN_LICENSE_PUBKEY_FINGERPRINTS = /* @__PURE__ */ new Set([
  "18a63d64fdec9e5a368fc45feaa49bed6ced815967e582bc7b8af534f22a9475"
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
  return process.env.MASSU_REQUIRE_SIGNED_LICENSE === "true";
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

// src/rule-candidate-hardened.ts
var TEAM_HARDENED_SHAREABLE_DESTINATIONS = [
  "pattern-scanner",
  "custom-destination"
];
function isHardenedShareableDestination(destination) {
  return TEAM_HARDENED_SHAREABLE_DESTINATIONS.includes(destination);
}

// src/rule-candidate-applier.ts
var TEAM_SHAREABLE_DESTINATIONS = [
  "corrections-md",
  "claude-md-cr"
];
function isTeamShareableDestination(destination) {
  return TEAM_SHAREABLE_DESTINATIONS.includes(destination);
}

// src/team-knowledge.ts
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
    if (!res.ok) return { ...ZERO };
    envelope = await res.json();
  } catch {
    return { ...ZERO };
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
    if (existsSync4(candidatePath) || alreadyApplied(db, p.prompt_hash)) {
      result.skipped += 1;
      continue;
    }
    materializeCandidate(db, projectRoot, candidatePath, p, signedOrgId);
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
  return join(projectRoot, ".massu", "rule-candidates", `${promptHash}.json`);
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
  if (existsSync4(candidatePath)) {
    try {
      unlinkSync(candidatePath);
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
function materializeCandidate(db, projectRoot, candidatePath, p, orgId) {
  const promptText = p.draft_text.replace(/\n+/g, " ").slice(0, 200) || `team rule ${p.prompt_hash}`;
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
  const dir = dirname4(candidatePath);
  if (!existsSync4(dir)) mkdirSync3(dir, { recursive: true });
  writeFileSync2(candidatePath, JSON.stringify(sidecar, null, 2), "utf-8");
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

// src/analytics.ts
var DEFAULT_WEIGHTS = {
  bug_found: -5,
  vr_failure: -10,
  incident: -20,
  cr_violation: -3,
  vr_pass: 2,
  clean_commit: 5,
  successful_verification: 3
};
var DEFAULT_CATEGORIES = ["security", "architecture", "coupling", "tests", "rule_compliance"];
function getWeights() {
  return getConfig().analytics?.quality?.weights ?? DEFAULT_WEIGHTS;
}
function getCategories() {
  return getConfig().analytics?.quality?.categories ?? DEFAULT_CATEGORIES;
}
function calculateQualityScore(db, sessionId) {
  const weights = getWeights();
  const categories = getCategories();
  const observations = db.prepare(
    "SELECT type, detail FROM observations WHERE session_id = ? LIMIT 10000"
  ).all(sessionId);
  let score = 50;
  const breakdown = Object.fromEntries(
    categories.map((c) => [c, 0])
  );
  for (const obs of observations) {
    const weight = weights[obs.type] ?? 0;
    score += weight;
    const desc = (obs.detail ?? "").toLowerCase();
    for (const category of categories) {
      if (desc.includes(category)) {
        breakdown[category] += weight;
      }
    }
  }
  return {
    score: Math.max(0, Math.min(100, score)),
    breakdown
  };
}
function storeQualityScore(db, sessionId, score, breakdown) {
  db.prepare(`
    INSERT INTO session_quality_scores
    (session_id, score, security_score, architecture_score, coupling_score, test_score, rule_compliance_score)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    score,
    breakdown.security ?? 0,
    breakdown.architecture ?? 0,
    breakdown.coupling ?? 0,
    breakdown.tests ?? 0,
    breakdown.rule_compliance ?? 0
  );
}
function backfillQualityScores(db) {
  const sessions = db.prepare(`
    SELECT DISTINCT s.session_id
    FROM sessions s
    LEFT JOIN session_quality_scores q ON s.session_id = q.session_id
    WHERE q.session_id IS NULL
    LIMIT 100000
  `).all();
  let backfilled = 0;
  for (const session of sessions) {
    const { score, breakdown } = calculateQualityScore(db, session.session_id);
    storeQualityScore(db, session.session_id, score, breakdown);
    backfilled++;
  }
  return backfilled;
}

// src/cost-tracker.ts
var DEFAULT_MODEL_PRICING = {
  "claude-opus-4-6": { input_per_million: 15, output_per_million: 75, cache_read_per_million: 1.5, cache_write_per_million: 18.75 },
  "claude-sonnet-4-6": { input_per_million: 3, output_per_million: 15, cache_read_per_million: 0.3, cache_write_per_million: 3.75 },
  "claude-sonnet-4-5": { input_per_million: 3, output_per_million: 15, cache_read_per_million: 0.3, cache_write_per_million: 3.75 },
  "claude-haiku-4-5-20251001": { input_per_million: 0.8, output_per_million: 4, cache_read_per_million: 0.08, cache_write_per_million: 1 },
  "default": { input_per_million: 3, output_per_million: 15, cache_read_per_million: 0.3, cache_write_per_million: 3.75 }
};
function getModelPricing() {
  return getConfig().analytics?.cost?.models ?? DEFAULT_MODEL_PRICING;
}
function getCurrency() {
  return getConfig().analytics?.cost?.currency ?? "USD";
}
function extractTokenUsage(entries) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let model = "unknown";
  for (const entry of entries) {
    const msg = entry.message;
    if (entry.type === "assistant" && msg?.usage) {
      const usage = msg.usage;
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      cacheReadTokens += usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0;
      cacheWriteTokens += usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0;
    }
    if (entry.type === "assistant" && msg?.model) {
      model = msg.model;
    }
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, model };
}
function calculateCost(usage) {
  const pricing = getModelPricing();
  const modelPricing = pricing[usage.model] ?? pricing["default"] ?? pricing["claude-sonnet-4-5"] ?? { input_per_million: 3, output_per_million: 15 };
  const inputCost = usage.inputTokens / 1e6 * modelPricing.input_per_million;
  const outputCost = usage.outputTokens / 1e6 * modelPricing.output_per_million;
  const cacheReadCost = usage.cacheReadTokens / 1e6 * (modelPricing.cache_read_per_million ?? 0);
  const cacheWriteCost = usage.cacheWriteTokens / 1e6 * (modelPricing.cache_write_per_million ?? 0);
  return {
    totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    currency: getCurrency()
  };
}
function storeSessionCost(db, sessionId, usage, cost) {
  const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  db.prepare(`
    INSERT INTO session_costs
    (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
     total_tokens, estimated_cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    usage.model,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    totalTokens,
    cost.totalCost
  );
}

// src/prompt-analyzer.ts
import { createHash as createHash2 } from "crypto";

// src/security-utils.ts
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function redactSensitiveContent(text) {
  return text.replace(/\b(sk-|ghp_|gho_|xoxb-|xoxp-|AKIA)[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_KEY]").replace(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, "Bearer [REDACTED_TOKEN]").replace(/:\/\/[^:]+:[^@\s]+@/g, "://[REDACTED_CREDENTIALS]@").replace(/(https?:\/\/[^\s]+[?&](?:token|key|secret|password|auth)=)[^\s&]*/gi, "$1[REDACTED]").replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]").replace(/(?:\/Users\/|\/home\/|C:\\Users\\)[^\s"'`]+/g, "[REDACTED_PATH]");
}

// src/prompt-analyzer.ts
var DEFAULT_SUCCESS_INDICATORS = ["committed", "approved", "looks good", "perfect", "great", "thanks"];
var DEFAULT_ABANDON_PATTERNS = /\b(nevermind|forget it|skip|let's move on|different|instead)\b/i;
function categorizePrompt(promptText) {
  const lower = promptText.toLowerCase();
  if (/\b(fix|bug|error|broken|issue|crash|fail)\b/.test(lower)) return "bugfix";
  if (/\b(refactor|rename|move|extract|cleanup|reorganize)\b/.test(lower)) return "refactor";
  if (/\b(what|how|why|where|when|explain|describe|tell me)\b/.test(lower)) return "question";
  if (/^\/\w+/.test(promptText.trim())) return "command";
  if (/\b(add|create|implement|build|new|feature)\b/.test(lower)) return "feature";
  return "feature";
}
function hashPrompt(promptText) {
  const normalized = promptText.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash2("sha256").update(normalized).digest("hex").slice(0, 16);
}
function detectOutcome(followUpPrompts, assistantResponses) {
  let correctionsNeeded = 0;
  let outcome = "success";
  const correctionPatterns = /\b(no|wrong|that's not|fix this|try again|revert|undo|incorrect|not what)\b/i;
  const config = getConfig();
  const successIndicators = config.analytics?.prompts?.success_indicators ?? DEFAULT_SUCCESS_INDICATORS;
  const escapedIndicators = successIndicators.map(escapeRegex);
  const successRegex = new RegExp(`\\b(${escapedIndicators.join("|")})\\b`, "i");
  for (const prompt of followUpPrompts) {
    if (correctionPatterns.test(prompt)) {
      correctionsNeeded++;
    }
    if (DEFAULT_ABANDON_PATTERNS.test(prompt)) {
      outcome = "abandoned";
      break;
    }
  }
  for (const response of assistantResponses) {
    if (/\b(error|failed|cannot|unable to)\b/i.test(response) && response.length < 200) {
      outcome = "failure";
    }
  }
  if (outcome === "abandoned") {
  } else if (correctionsNeeded >= 3) {
    outcome = "partial";
  } else if (correctionsNeeded > 0) {
    outcome = "partial";
  } else {
    for (const prompt of followUpPrompts) {
      if (successRegex.test(prompt)) {
        outcome = "success";
        break;
      }
    }
  }
  return {
    outcome,
    correctionsNeeded,
    followUpCount: followUpPrompts.length
  };
}
function analyzeSessionPrompts(db, sessionId) {
  const prompts = db.prepare(
    "SELECT prompt_text, prompt_number FROM user_prompts WHERE session_id = ? ORDER BY prompt_number ASC LIMIT 10000"
  ).all(sessionId);
  if (prompts.length === 0) return 0;
  let stored = 0;
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const followUps = prompts.slice(i + 1, i + 4).map((p) => p.prompt_text);
    const category = categorizePrompt(prompt.prompt_text);
    const hash = hashPrompt(prompt.prompt_text);
    const { outcome, correctionsNeeded, followUpCount } = detectOutcome(followUps, []);
    const existing = db.prepare(
      "SELECT id FROM prompt_outcomes WHERE session_id = ? AND prompt_hash = ?"
    ).get(sessionId, hash);
    if (existing) continue;
    const redactedText = redactSensitiveContent(prompt.prompt_text.slice(0, 2e3));
    db.prepare(`
      INSERT INTO prompt_outcomes
      (session_id, prompt_hash, prompt_text, prompt_category, word_count, outcome,
       corrections_needed, follow_up_prompts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      hash,
      redactedText,
      category,
      prompt.prompt_text.split(/\s+/).length,
      outcome,
      correctionsNeeded,
      followUpCount
    );
    stored++;
  }
  return stored;
}

// src/hooks/session-end.ts
async function main() {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input);
    const { session_id } = hookInput;
    const db = getMemoryDb();
    try {
      createSession(db, session_id);
      const observations = db.prepare(
        "SELECT * FROM observations WHERE session_id = ? ORDER BY created_at_epoch ASC LIMIT 10000"
      ).all(session_id);
      const prompts = db.prepare(
        "SELECT prompt_text FROM user_prompts WHERE session_id = ? ORDER BY prompt_number ASC LIMIT 10000"
      ).all(session_id);
      const summary = buildSummaryFromObservations(observations, prompts);
      addSummary(db, session_id, summary);
      try {
        await captureConversationData(db, session_id, hookInput.transcript_path);
      } catch (_captureErr) {
      }
      try {
        const { score, breakdown } = calculateQualityScore(db, session_id);
        if (score !== 50) {
          storeQualityScore(db, session_id, score, breakdown);
        }
        backfillQualityScores(db);
      } catch (_qualityErr) {
      }
      try {
        const { entries } = await parseTranscriptFrom(hookInput.transcript_path, 0);
        const tokenUsage = extractTokenUsage(entries);
        const cost = calculateCost(tokenUsage);
        storeSessionCost(db, session_id, tokenUsage, cost);
      } catch (_costErr) {
      }
      try {
        analyzeSessionPrompts(db, session_id);
      } catch (_promptErr) {
      }
      endSession(db, session_id, "completed");
      archiveAndRegenerate(db, session_id);
      try {
        await drainSyncQueue(db);
        const syncPayload = buildSyncPayload(db, session_id, observations, summary);
        const result = await syncToCloud(db, syncPayload);
        if (!result.success && result.error) {
        }
        try {
          await pullTeamPromotions(db);
        } catch (_pullErr) {
        }
      } catch (_syncErr) {
      }
    } finally {
      db.close();
    }
  } catch (_e) {
  }
  process.exit(0);
}
function buildSyncPayload(db, sessionId, observations, summary) {
  const cfg = getConfig().cloud;
  const willTransmit = !!cfg?.enabled && !!cfg?.apiKey && cfg?.sync?.memory !== false;
  const promotions = willTransmit ? drainTeamPromotions(db) : [];
  const revocations = willTransmit ? drainTeamRevocations(db) : [];
  return {
    sessions: [{
      local_session_id: sessionId,
      summary: summary.request ?? void 0,
      started_at: void 0,
      // Will be filled from session data if available
      ended_at: (/* @__PURE__ */ new Date()).toISOString(),
      turns: 0,
      tokens_used: 0,
      estimated_cost: 0,
      tools_used: []
    }],
    observations: observations.map((o, idx) => ({
      local_observation_id: `${sessionId}_obs_${idx}`,
      session_id: sessionId,
      type: o.type,
      content: o.title + (o.detail ? `: ${o.detail}` : ""),
      importance: o.importance ?? 3,
      file_path: void 0
    })),
    ...promotions.length > 0 ? {
      rule_promotions: promotions.map((p) => ({
        prompt_hash: p.prompt_hash,
        destination: p.destination,
        draft_text: p.draft_text,
        score: p.score,
        signals: p.signals,
        content_hash: p.content_hash,
        // PA3-004: hardened-destination publish carries the flag + attestation.
        ...p.hardened ? { hardened: true } : {},
        ...p.review_attestation !== void 0 ? { review_attestation: p.review_attestation } : {}
      }))
    } : {},
    ...revocations.length > 0 ? { rule_revocations: revocations.map((prompt_hash) => ({ prompt_hash })) } : {}
  };
}
function buildSummaryFromObservations(observations, prompts) {
  const request = prompts[0]?.prompt_text?.slice(0, 500) ?? void 0;
  const discoveries = observations.filter((o) => o.type === "discovery").map((o) => o.title).join("; ");
  const decisions = observations.filter((o) => o.type === "decision").map((o) => `- ${o.title}`).join("\n");
  const completed = observations.filter((o) => ["feature", "bugfix", "refactor"].includes(o.type)).map((o) => `- ${o.title}`).join("\n");
  const failedAttempts = observations.filter((o) => o.type === "failed_attempt").map((o) => `- ${o.title}`).join("\n");
  const lastTenPercent = observations.slice(Math.floor(observations.length * 0.9));
  const hasCompletion = completed.length > 0;
  const nextSteps = hasCompletion ? void 0 : lastTenPercent.map((o) => `- [${o.type}] ${o.title}`).join("\n");
  const filesCreated = [];
  const filesModified = [];
  for (const o of observations) {
    if (o.type !== "file_change") continue;
    const files = safeParseJson2(o.files_involved, []);
    const title = o.title;
    if (title.startsWith("Created") || title.startsWith("Created/wrote")) {
      filesCreated.push(...files);
    } else if (title.startsWith("Edited")) {
      filesModified.push(...files);
    }
  }
  const verificationResults = {};
  for (const o of observations) {
    if (o.type !== "vr_check") continue;
    const vrType = o.vr_type;
    const passed = o.title.includes("PASS");
    if (vrType) verificationResults[vrType] = passed ? "PASS" : "FAIL";
  }
  const planProgress = {};
  for (const o of observations) {
    if (!o.plan_item) continue;
    planProgress[o.plan_item] = "in_progress";
  }
  return {
    request,
    investigated: discoveries || void 0,
    decisions: decisions || void 0,
    completed: completed || void 0,
    failedAttempts: failedAttempts || void 0,
    nextSteps,
    filesCreated: [...new Set(filesCreated)],
    filesModified: [...new Set(filesModified)],
    verificationResults,
    planProgress
  };
}
function safeParseJson2(json, fallback) {
  try {
    return JSON.parse(json);
  } catch (_e) {
    return fallback;
  }
}
async function captureConversationData(db, sessionId, transcriptPath) {
  if (!transcriptPath) return;
  const lastLine = getLastProcessedLine(db, sessionId);
  const { entries, totalLines } = await parseTranscriptFrom(transcriptPath, lastLine);
  if (entries.length === 0) {
    setLastProcessedLine(db, sessionId, totalLines);
    return;
  }
  const turns = groupEntriesIntoTurns(entries);
  const insertTurns = db.transaction(() => {
    const existingMax = db.prepare(
      "SELECT MAX(turn_number) as max_turn FROM conversation_turns WHERE session_id = ?"
    ).get(sessionId);
    let turnNumber = (existingMax.max_turn ?? 0) + 1;
    for (const turn of turns) {
      const toolCallSummaries = turn.toolCalls.map((tc) => ({
        name: tc.toolName,
        input_summary: summarizeToolInput(tc.toolName, tc.input).slice(0, 200),
        is_error: tc.isError ?? false
      }));
      const assistantText = turn.assistantText?.slice(0, 1e4) ?? null;
      addConversationTurn(
        db,
        sessionId,
        turnNumber,
        turn.userPrompt,
        assistantText,
        toolCallSummaries.length > 0 ? JSON.stringify(toolCallSummaries) : null,
        turn.toolCalls.length,
        estimateTokens(turn.userPrompt),
        assistantText ? estimateTokens(assistantText) : 0
      );
      for (const tc of turn.toolCalls) {
        const inputStr = JSON.stringify(tc.input);
        const outputStr = tc.result ?? "";
        const files = extractFilesFromToolCall(tc.toolName, tc.input);
        addToolCallDetail(
          db,
          sessionId,
          turnNumber,
          tc.toolName,
          summarizeToolInput(tc.toolName, tc.input),
          inputStr.length,
          outputStr.length,
          !(tc.isError ?? false),
          files.length > 0 ? files : void 0
        );
      }
      turnNumber++;
    }
  });
  insertTurns();
  setLastProcessedLine(db, sessionId, totalLines);
}
function groupEntriesIntoTurns(entries) {
  const turns = [];
  let currentTurn = null;
  const toolUseMap = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (entry.type === "user" && entry.message && !entry.isMeta) {
      if (currentTurn) {
        turns.push(currentTurn);
      }
      const text = getTextFromBlocks(entry.message.content);
      if (text.trim()) {
        currentTurn = {
          userPrompt: text.trim(),
          assistantText: null,
          toolCalls: []
        };
      }
    } else if (entry.type === "assistant" && entry.message && currentTurn) {
      const text = getTextFromBlocks(entry.message.content);
      if (text.trim()) {
        currentTurn.assistantText = currentTurn.assistantText ? currentTurn.assistantText + "\n" + text.trim() : text.trim();
      }
      for (const block of entry.message.content) {
        if (block.type === "tool_use") {
          const tc = {
            toolName: block.name,
            toolUseId: block.id,
            input: block.input ?? {}
          };
          currentTurn.toolCalls.push(tc);
          toolUseMap.set(tc.toolUseId, tc);
        } else if (block.type === "tool_result") {
          const toolUseId = block.tool_use_id;
          const existing = toolUseMap.get(toolUseId);
          if (existing) {
            existing.result = getToolResultFromBlock(block);
            existing.isError = block.is_error ?? false;
          }
        }
      }
    }
  }
  if (currentTurn) {
    turns.push(currentTurn);
  }
  return turns;
}
function getTextFromBlocks(content) {
  return content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function getToolResultFromBlock(block) {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => typeof b === "object" && b !== null && b.type === "text").map((b) => b.text).join("\n");
  }
  return "";
}
function summarizeToolInput(toolName, input) {
  switch (toolName) {
    case "Read":
      return `Read ${input.file_path ?? ""}`;
    case "Write":
      return `Write ${input.file_path ?? ""}`;
    case "Edit":
      return `Edit ${input.file_path ?? ""}`;
    case "Bash":
      return `$ ${(input.command ?? "").slice(0, 200)}`;
    case "Grep":
      return `Grep "${input.pattern ?? ""}" in ${input.path ?? "."}`;
    case "Glob":
      return `Glob "${input.pattern ?? ""}" in ${input.path ?? "."}`;
    case "Task":
      return `Task: ${(input.description ?? "").slice(0, 100)}`;
    case "WebFetch":
      return `Fetch ${input.url ?? ""}`;
    case "WebSearch":
      return `Search "${input.query ?? ""}"`;
    default:
      return `${toolName}: ${JSON.stringify(input).slice(0, 200)}`;
  }
}
function extractFilesFromToolCall(toolName, input) {
  const filePath = input.file_path;
  if (filePath) return [filePath];
  const path = input.path;
  if (path && !path.startsWith(".") && toolName !== "Grep") return [path];
  return [];
}
function readStdin() {
  return new Promise((resolve4) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve4(data));
    setTimeout(() => resolve4(data), 5e3);
  });
}
main();
