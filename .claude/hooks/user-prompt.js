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
    CREATE TABLE IF NOT EXISTS rule_promotion_events_outbound (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_hash TEXT NOT NULL,
      event_type TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rpe_outbound_created ON rule_promotion_events_outbound(created_at);
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
var FUNNEL_EVENT_OUTBOX_CAP = 2e4;
function enqueueRulePromotionEvent(db, ev) {
  try {
    db.prepare(`
      INSERT INTO rule_promotion_events_outbound
        (prompt_hash, event_type, metadata_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      ev.prompt_hash,
      ev.event_type,
      JSON.stringify(ev.metadata ?? {}),
      ev.created_at
    );
    db.prepare(`
      DELETE FROM rule_promotion_events_outbound
      WHERE id NOT IN (
        SELECT id FROM rule_promotion_events_outbound ORDER BY id DESC LIMIT ?
      )
    `).run(FUNNEL_EVENT_OUTBOX_CAP);
  } catch {
  }
}
function assignImportance(type, vrResult) {
  switch (type) {
    case "decision":
    case "failed_attempt":
      return 5;
    case "cr_violation":
    case "incident_near_miss":
      return 4;
    case "vr_check":
      return vrResult === "PASS" ? 2 : 4;
    case "pattern_compliance":
      return vrResult === "PASS" ? 2 : 4;
    case "feature":
    case "bugfix":
      return 3;
    case "refactor":
      return 2;
    case "file_change":
    case "discovery":
      return 1;
    default:
      return 3;
  }
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
function addObservation(db, sessionId, type, title, detail, opts) {
  const now = /* @__PURE__ */ new Date();
  const importance = opts?.importance ?? assignImportance(type, opts?.evidence?.includes("PASS") ? "PASS" : void 0);
  const result = db.prepare(`
    INSERT INTO observations (session_id, type, title, detail, files_involved, plan_item, cr_rule, vr_type, evidence, importance, original_tokens, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    type,
    title,
    detail,
    JSON.stringify(opts?.filesInvolved ?? []),
    opts?.planItem ?? null,
    opts?.crRule ?? null,
    opts?.vrType ?? null,
    opts?.evidence ?? null,
    importance,
    opts?.originalTokens ?? 0,
    now.toISOString(),
    Math.floor(now.getTime() / 1e3)
  );
  return Number(result.lastInsertRowid);
}
function addUserPrompt(db, sessionId, text, promptNumber) {
  const now = /* @__PURE__ */ new Date();
  db.prepare(`
    INSERT INTO user_prompts (session_id, prompt_text, prompt_number, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, text, promptNumber, now.toISOString(), Math.floor(now.getTime() / 1e3));
}
function linkSessionToTask(db, sessionId, taskId) {
  db.prepare("UPDATE sessions SET task_id = ? WHERE session_id = ?").run(taskId, sessionId);
}

// src/hooks/user-prompt.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, writeFileSync, readFileSync as readFileSync2, readdirSync, openSync, fstatSync, readSync, closeSync } from "fs";
import { join } from "path";

// src/rule-candidate-detector.ts
var CORRECTION_DISMISSAL_PATTERN = /\b(nevermind|never\s+mind|forget\s+it|ignore\s+(that|it)|actually\s+you('?re|\s+were)\s+right|on\s+second\s+thought|no\s+wait|scratch\s+that|disregard|abandon\s+(that|it))\b/i;
var RULE_CANDIDATE_THRESHOLD = 60;
var STRONG_CORRECTION_PHRASES = [
  "that's wrong",
  "thats wrong",
  "that is wrong",
  "incorrect",
  "you broke",
  "you missed",
  "this is wrong",
  "should be",
  "not what i asked",
  "not what i wanted"
];
var NEGATION_TOKENS = /\b(no|not|never|don't|dont|wrong|incorrect)\b/i;
var INSTRUCTION_TOKENS = /\b(instead|use\s+\w+|make\s+it|should\s+be|actually|change\s+\w+)\b/i;
var SIGNAL_BASE_WEIGHTS = {
  strong_correction_phrase: 40,
  negation_plus_instruction: 30,
  prior_edit_or_write: 25,
  bugfix_or_refactor_category: 15,
  prompt_length_gt_10: 10,
  running_correction_streak: 15,
  short_length_floor: -50,
  slash_command_excluded: -100,
  dismissal_phrase_excluded: -100
};
function hasNegationPlusInstructionWithinWindow(prompt, windowWords) {
  const words = prompt.split(/\s+/);
  const negIdx = [];
  const instIdx = [];
  for (let i = 0; i < words.length; i++) {
    if (NEGATION_TOKENS.test(words[i])) negIdx.push(i);
    const slice = words.slice(i, i + 3).join(" ");
    if (INSTRUCTION_TOKENS.test(slice)) instIdx.push(i);
  }
  for (const n of negIdx) {
    for (const inst of instIdx) {
      if (Math.abs(n - inst) <= windowWords) return true;
    }
  }
  return false;
}
function applyDismissal(base, dismissalCount) {
  if (dismissalCount >= 5) return 0;
  if (dismissalCount > 0 && base > 0) return Math.max(0, base - dismissalCount * 10);
  return base;
}
function scoreCorrectionPrompt(inputs) {
  const { prompt, priorAssistantTurn, priorOutcomes, category, blacklist } = inputs;
  const promptLower = prompt.toLowerCase();
  const trimmed = prompt.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const signals = [];
  const addSignal = (name, evidence) => {
    const baseWeight = SIGNAL_BASE_WEIGHTS[name];
    const applied = applyDismissal(baseWeight, blacklist?.get(name) ?? 0);
    signals.push({ name, baseWeight, applied, evidence });
  };
  if (/^\/\w+/.test(trimmed)) {
    addSignal("slash_command_excluded", "starts with /");
    return { score: SIGNAL_BASE_WEIGHTS.slash_command_excluded, signals, emitCandidate: false };
  }
  if (CORRECTION_DISMISSAL_PATTERN.test(prompt)) {
    addSignal("dismissal_phrase_excluded", "matched CORRECTION_DISMISSAL_PATTERN");
    return { score: SIGNAL_BASE_WEIGHTS.dismissal_phrase_excluded, signals, emitCandidate: false };
  }
  if (words.length < 4) {
    addSignal("short_length_floor", `${words.length} words < 4`);
  }
  for (const phrase of STRONG_CORRECTION_PHRASES) {
    if (promptLower.includes(phrase)) {
      addSignal("strong_correction_phrase", `matched "${phrase}"`);
      break;
    }
  }
  if (hasNegationPlusInstructionWithinWindow(prompt, 8)) {
    addSignal("negation_plus_instruction", "negation + instructional token within 8-word window");
  }
  if (priorAssistantTurn?.hadEditOrWrite) {
    addSignal("prior_edit_or_write", "prior assistant turn contained Edit/Write/Bash");
  }
  if (category === "bugfix" || category === "refactor") {
    addSignal("bugfix_or_refactor_category", `category=${category}`);
  }
  if (words.length > 10) {
    addSignal("prompt_length_gt_10", `${words.length} words > 10`);
  }
  if (priorOutcomes && priorOutcomes.lastCorrectionsNeeded >= 1) {
    addSignal("running_correction_streak", `lastCorrectionsNeeded=${priorOutcomes.lastCorrectionsNeeded}`);
  }
  const score = signals.reduce((sum, s) => sum + s.applied, 0);
  return {
    score,
    signals,
    emitCandidate: score >= RULE_CANDIDATE_THRESHOLD
  };
}

// src/prompt-analyzer.ts
import { createHash } from "crypto";
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
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// src/license.ts
import { createHash as createHash2 } from "crypto";

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
    const keyHash = createHash2("sha256").update(apiKey).digest("hex");
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

// src/auto-learning-entitlement.ts
var AUTO_LEARNING_MIN_TIER = "pro";
function entitledForAutoLearning(tier) {
  return tierLevel(tier) >= tierLevel(AUTO_LEARNING_MIN_TIER);
}
function autoLearningUpgradeMessage(currentTier) {
  return `Auto-learning (rule-candidate detection + /massu-rule promotion) is a Pro feature. Your tier: ${currentTier.toUpperCase()}. Upgrade at https://massu.ai/pricing`;
}
var TEAM_SHARED_PROMOTION_MIN_TIER = "team";
function entitledForTeamSharedPromotion(tier) {
  return tierLevel(tier) >= tierLevel(TEAM_SHARED_PROMOTION_MIN_TIER);
}

// src/hooks/user-prompt.ts
async function main() {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input);
    const { session_id, prompt } = hookInput;
    if (!prompt || !prompt.trim()) {
      process.exit(0);
      return;
    }
    const db = getMemoryDb();
    try {
      const gitBranch = await getGitBranch();
      createSession(db, session_id, { branch: gitBranch });
      const planFileMatch = prompt.match(/([^\s]+docs\/plans\/[^\s]+\.md)/);
      if (planFileMatch) {
        const planFile = planFileMatch[1];
        db.prepare("UPDATE sessions SET plan_file = ? WHERE session_id = ?").run(planFile, session_id);
        const taskId = autoDetectTaskId(planFile);
        if (taskId) {
          linkSessionToTask(db, session_id, taskId);
        }
      }
      const countResult = db.prepare(
        "SELECT COUNT(*) as count FROM user_prompts WHERE session_id = ?"
      ).get(session_id);
      const promptNumber = countResult.count + 1;
      addUserPrompt(db, session_id, prompt.trim(), promptNumber);
      try {
        const fileRefs = extractFileReferences(prompt);
        if (fileRefs.length > 0) {
          const knowledgeDbPath = getResolvedPaths().knowledgeDbPath;
          if (knowledgeDbPath && existsSync3(knowledgeDbPath)) {
            const BetterSqlite3Ctor = (await import("better-sqlite3")).default;
            const kdb = new BetterSqlite3Ctor(knowledgeDbPath, { readonly: true });
            try {
              const placeholders = fileRefs.map(() => "?").join(",");
              const matches = kdb.prepare(
                `SELECT DISTINCT file_path FROM knowledge_documents WHERE file_path IN (${placeholders}) LIMIT 10000`
              ).all(...fileRefs);
              if (matches.length > 0) {
                addObservation(
                  db,
                  session_id,
                  "discovery",
                  `Knowledge entries exist for referenced files`,
                  `Files with knowledge context: ${matches.map((m) => m.file_path).join(", ")}`,
                  { importance: 2 }
                );
              }
            } finally {
              kdb.close();
            }
          }
        }
      } catch (_knowledgeErr) {
      }
      try {
        const significantSignals = ["fix", "implement", "migrate", "refactor", "debug", "decision", "chose", "architecture", "redesign", "rewrite"];
        const promptLower = prompt.toLowerCase();
        const signalCount = significantSignals.filter((s) => promptLower.includes(s)).length;
        if (signalCount >= 2) {
          const memoryFileCount = db.prepare(
            "SELECT COUNT(*) as count FROM observations WHERE session_id = ? AND title LIKE '[memory-file] %'"
          ).get(session_id);
          if (memoryFileCount.count === 0) {
            process.stderr.write(
              "\n[MEMORY REMINDER] Significant work detected but no memory files have been written.\nConsider saving learnings to memory/*.md files for future sessions.\n\n"
            );
          }
        }
      } catch (_memoryNagErr) {
      }
      try {
        const priorTurn = detectPriorAssistantTurn(hookInput.transcript_path);
        const lastOutcome = db.prepare(
          "SELECT corrections_needed FROM prompt_outcomes WHERE session_id = ? ORDER BY id DESC LIMIT 1"
        ).get(session_id);
        const blacklist = readSignalBlacklist(db);
        const scoreResult = scoreCorrectionPrompt({
          prompt,
          priorAssistantTurn: { hadEditOrWrite: priorTurn.hadEditOrWrite },
          priorOutcomes: lastOutcome ? { lastCorrectionsNeeded: lastOutcome.corrections_needed } : void 0,
          category: categorizePrompt(prompt),
          blacklist
        });
        const candidateDir = join(hookInput.cwd, ".massu", "rule-candidates");
        if (scoreResult.emitCandidate) {
          const cachedTier = getCachedTierReadOnly(db);
          if (entitledForAutoLearning(cachedTier)) {
            mkdirSync2(candidateDir, { recursive: true });
            const promptHash = hashPrompt(prompt);
            const candidatePath = join(candidateDir, `${promptHash}.json`);
            if (!existsSync3(candidatePath)) {
              writeFileSync(candidatePath, JSON.stringify({
                prompt,
                prompt_hash: promptHash,
                score: scoreResult.score,
                signals: scoreResult.signals,
                prior_turn_files: priorTurn.files,
                timestamp: (/* @__PURE__ */ new Date()).toISOString(),
                session_id
              }, null, 2));
              if (entitledForTeamSharedPromotion(cachedTier)) {
                enqueueRulePromotionEvent(db, {
                  prompt_hash: promptHash,
                  event_type: "proposed",
                  created_at: (/* @__PURE__ */ new Date()).toISOString(),
                  metadata: {
                    score: scoreResult.score,
                    signal_count: scoreResult.signals.length,
                    category: categorizePrompt(prompt)
                  }
                });
              }
            }
          } else {
            const nudgePath = join(candidateDir, ".last-tier-nudge");
            if (!existsSync3(nudgePath)) {
              mkdirSync2(candidateDir, { recursive: true });
              process.stderr.write(
                `
[RULE CANDIDATE] ${autoLearningUpgradeMessage(cachedTier)}

`
              );
              writeFileSync(nudgePath, (/* @__PURE__ */ new Date()).toISOString());
            }
          }
        }
        if (existsSync3(candidateDir)) {
          const candidates = readdirSync(candidateDir).filter(
            (f) => f.endsWith(".json") && !f.startsWith(".")
          );
          const candidateCount = candidates.length;
          const surfacedPath = join(candidateDir, ".last-surfaced");
          let lastSurfaced = 0;
          if (existsSync3(surfacedPath)) {
            const raw = readFileSync2(surfacedPath, "utf-8").trim();
            const parsed = parseInt(raw, 10);
            if (!Number.isNaN(parsed)) lastSurfaced = parsed;
          }
          if (candidateCount > lastSurfaced) {
            process.stderr.write(
              `
[RULE CANDIDATE] ${candidateCount} rule candidate(s) pending (\`/massu-rule list\`)

`
            );
            writeFileSync(surfacedPath, String(candidateCount));
          }
        }
      } catch (candidateErr) {
        try {
          const dir = join(hookInput.cwd, ".massu", "rule-candidates");
          if (!existsSync3(dir)) mkdirSync2(dir, { recursive: true });
          const logPath = join(dir, ".detector-failures.jsonl");
          const pre = existsSync3(logPath) ? readFileSync2(logPath, "utf-8") : "";
          const sep = pre && !pre.endsWith("\n") ? "\n" : "";
          writeFileSync(logPath, pre + sep + JSON.stringify({
            session_id,
            // Security review (plan-2026-05-27): log the prompt HASH, never a
            // raw prompt excerpt — the failure log must not persist PII/secrets.
            prompt_hash: hashPrompt(prompt),
            error: candidateErr instanceof Error ? candidateErr.message : String(candidateErr),
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          }) + "\n", "utf-8");
        } catch {
        }
      }
    } finally {
      db.close();
    }
  } catch (_e) {
  }
  process.exit(0);
}
function detectPriorAssistantTurn(transcriptPath) {
  try {
    if (!transcriptPath || !existsSync3(transcriptPath)) {
      return { hadEditOrWrite: false, files: [] };
    }
    if (!transcriptPath.includes("/.claude/projects/")) {
      return { hadEditOrWrite: false, files: [] };
    }
    const fd = openSync(transcriptPath, "r");
    let buf;
    try {
      const stats = fstatSync(fd);
      const readLen = Math.min(stats.size, 200 * 1024);
      const offset = stats.size - readLen;
      buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, offset);
    } finally {
      closeSync(fd);
    }
    const lines = buf.toString("utf-8").split("\n").filter(Boolean);
    const files = [];
    let hadEditOrWrite = false;
    let foundAssistant = false;
    const WRITE_BASH = /\b(sed\s+-i|tee\s|printf\s.*?>|cat\s+<<.*?>|>>?\s*['"\w/.-]+)/;
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry = null;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      if (entry.type === "user" && foundAssistant) break;
      if (entry.type !== "assistant") continue;
      foundAssistant = true;
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block;
        if (b.type !== "tool_use") continue;
        const name = String(b.name ?? "");
        if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
          hadEditOrWrite = true;
          const fp = b.input?.file_path;
          if (typeof fp === "string") files.push(fp);
        } else if (name === "Bash") {
          const cmd = String(b.input?.command ?? "");
          if (WRITE_BASH.test(cmd)) hadEditOrWrite = true;
        }
      }
    }
    return { hadEditOrWrite, files: [...new Set(files)] };
  } catch (_e) {
    return { hadEditOrWrite: false, files: [] };
  }
}
function readSignalBlacklist(db) {
  try {
    const rows = db.prepare(
      "SELECT signal, dismissal_count FROM prompt_outcomes_signal_blacklist LIMIT 10000"
    ).all();
    return new Map(rows.map((r) => [r.signal, r.dismissal_count]));
  } catch (_e) {
    return /* @__PURE__ */ new Map();
  }
}
function extractFileReferences(prompt) {
  const filePattern = /(?:^|\s)((?:src|packages|lib)\/[\w./-]+\.(?:ts|tsx|js|jsx|md))/g;
  const matches = [];
  let match;
  while ((match = filePattern.exec(prompt)) !== null) {
    matches.push(match[1]);
  }
  return [...new Set(matches)];
}
async function getGitBranch() {
  try {
    const { spawnSync } = await import("child_process");
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      timeout: 5e3
    });
    if (result.status !== 0 || result.error) return void 0;
    return result.stdout.trim();
  } catch (_e) {
    return void 0;
  }
}
function readStdin() {
  return new Promise((resolve3) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve3(data));
    setTimeout(() => resolve3(data), 3e3);
  });
}
main();
