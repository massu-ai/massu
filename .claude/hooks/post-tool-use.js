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
var DomainConfigSchema = z.object({
  name: z.string().default("Unknown"),
  routers: z.array(z.string()).default([]),
  pages: z.array(z.string()).default([]),
  tables: z.array(z.string()).default([]),
  allowedImportsFrom: z.array(z.string()).default([])
});
var PatternRuleConfigSchema = z.object({
  pattern: z.string().default("**"),
  rules: z.array(z.string()).default([])
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
var PathsConfigSchema = z.object({
  source: z.string().default("src"),
  aliases: z.record(z.string(), z.string()).default({ "@": "src" }),
  routers: z.string().optional(),
  routerRoot: z.string().optional(),
  pages: z.string().optional(),
  middleware: z.string().optional(),
  schema: z.string().optional(),
  components: z.string().optional(),
  hooks: z.string().optional()
});
var RawConfigSchema = z.object({
  project: z.object({
    name: z.string().default("my-project"),
    root: z.string().default("auto")
  }).default({ name: "my-project", root: "auto" }),
  framework: z.object({
    type: z.string().default("typescript"),
    router: z.string().default("none"),
    orm: z.string().default("none"),
    ui: z.string().default("none")
  }).default({ type: "typescript", router: "none", orm: "none", ui: "none" }),
  paths: PathsConfigSchema.default({ source: "src", aliases: { "@": "src" } }),
  toolPrefix: z.string().default("massu"),
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
  conventions: ConventionsConfigSchema
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
  const parsed = RawConfigSchema.parse(rawYaml);
  const projectRoot = parsed.project.root === "auto" || !parsed.project.root ? root : resolve(root, parsed.project.root);
  _config = {
    project: {
      name: parsed.project.name,
      root: projectRoot
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
    conventions: parsed.conventions
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
    memoryDir: resolve(homedir(), claudeDirName, "projects", root.replace(/\//g, "-"), "memory"),
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_po_session ON prompt_outcomes(session_id);
    CREATE INDEX IF NOT EXISTS idx_po_category ON prompt_outcomes(prompt_category);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      event_type TEXT NOT NULL CHECK(event_type IN ('code_change', 'rule_enforced', 'approval', 'review', 'commit', 'compaction')),
      actor TEXT NOT NULL DEFAULT 'ai' CHECK(actor IN ('ai', 'human', 'hook', 'agent')),
      model_id TEXT,
      file_path TEXT,
      change_type TEXT CHECK(change_type IN ('create', 'edit', 'delete')),
      rules_in_effect TEXT,
      approval_status TEXT CHECK(approval_status IN ('auto_approved', 'human_approved', 'pending', 'denied')),
      evidence TEXT,
      metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_al_session ON audit_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_al_file ON audit_log(file_path);
    CREATE INDEX IF NOT EXISTS idx_al_event ON audit_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_al_timestamp ON audit_log(timestamp DESC);
  `);
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
function deduplicateFailedAttempt(db, sessionId, title, detail, opts) {
  const existing = db.prepare(`
    SELECT id, recurrence_count FROM observations
    WHERE type = 'failed_attempt' AND title = ?
    ORDER BY created_at_epoch DESC LIMIT 1
  `).get(title);
  if (existing) {
    db.prepare("UPDATE observations SET recurrence_count = recurrence_count + 1, detail = COALESCE(?, detail) WHERE id = ?").run(detail, existing.id);
    return existing.id;
  }
  return addObservation(db, sessionId, "failed_attempt", title, detail, {
    ...opts,
    importance: 5
  });
}

// src/transcript-parser.ts
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// src/adr-generator.ts
var DEFAULT_DETECTION_PHRASES = ["chose", "decided", "switching to", "moving from", "going with"];
function getDetectionPhrases() {
  return getConfig().governance?.adr?.detection_phrases ?? DEFAULT_DETECTION_PHRASES;
}
function detectDecisionPatterns(text) {
  const phrases = getDetectionPhrases();
  const lower = text.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase));
}

// src/observation-extractor.ts
import { homedir as homedir2 } from "os";
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
function isNoisyToolCall(tc, seenReads2) {
  if (tc.toolName === "Glob" || tc.toolName === "Grep") return true;
  if (tc.toolName === "Read") {
    const filePath = tc.input.file_path ?? "";
    if (seenReads2.has(filePath)) return true;
    seenReads2.add(filePath);
    if (filePath.includes("node_modules")) return true;
  }
  if (tc.toolName === "Bash") {
    const cmd = (tc.input.command ?? "").trim();
    const trivialPatterns = /^(ls|pwd|echo|cat\s|head\s|tail\s|wc\s)/;
    if (trivialPatterns.test(cmd)) return true;
  }
  if (!tc.result || tc.result.trim() === "") return true;
  return false;
}
function classifyToolCall(tc) {
  const result = tc.result ?? "";
  switch (tc.toolName) {
    case "Write": {
      const filePath = tc.input.file_path ?? "unknown";
      const title = `Created/wrote: ${shortenPath(filePath)}`;
      return {
        type: "file_change",
        title,
        detail: null,
        visibility: classifyVisibility(title, filePath),
        opts: {
          filesInvolved: [filePath],
          importance: assignImportance("file_change"),
          originalTokens: estimateTokens(result),
          ...extractLinkedReferences(result + filePath)
        }
      };
    }
    case "Edit": {
      const filePath = tc.input.file_path ?? "unknown";
      const title = `Edited: ${shortenPath(filePath)}`;
      return {
        type: "file_change",
        title,
        detail: null,
        visibility: classifyVisibility(title, filePath),
        opts: {
          filesInvolved: [filePath],
          importance: assignImportance("file_change"),
          originalTokens: estimateTokens(result),
          ...extractLinkedReferences(result + filePath)
        }
      };
    }
    case "Read": {
      const filePath = tc.input.file_path ?? "unknown";
      const knowledgeSourceFiles = getConfig().conventions?.knowledgeSourceFiles ?? ["CLAUDE.md", "MEMORY.md", "corrections.md"];
      const plansDir = getResolvedPaths().plansDir;
      if (filePath.includes(plansDir) || knowledgeSourceFiles.some((f) => filePath.includes(f))) {
        const title = `Read: ${shortenPath(filePath)}`;
        return {
          type: "discovery",
          title,
          detail: null,
          visibility: classifyVisibility(title, filePath),
          opts: {
            filesInvolved: [filePath],
            importance: assignImportance("discovery"),
            originalTokens: estimateTokens(result)
          }
        };
      }
      return null;
    }
    case "Bash": {
      const cmd = (tc.input.command ?? "").trim();
      if (cmd.includes("git commit")) {
        const commitMsg = extractCommitMessage(cmd);
        const isfix = commitMsg.toLowerCase().includes("fix");
        const title = `Commit: ${commitMsg.slice(0, 150)}`;
        return {
          type: isfix ? "bugfix" : "feature",
          title,
          detail: cmd,
          visibility: classifyVisibility(title, cmd),
          opts: {
            importance: assignImportance(isfix ? "bugfix" : "feature"),
            originalTokens: estimateTokens(result)
          }
        };
      }
      if (cmd.includes("pattern-scanner")) {
        const passed = !result.includes("FAIL") && !result.includes("BLOCKED");
        const title = `Pattern Scanner: ${passed ? "PASS" : "FAIL"}`;
        const detail = result.slice(0, 500);
        return {
          type: "pattern_compliance",
          title,
          detail,
          visibility: classifyVisibility(title, detail),
          opts: {
            evidence: result.slice(0, 500),
            importance: assignImportance("pattern_compliance", passed ? "PASS" : "FAIL"),
            originalTokens: estimateTokens(result)
          }
        };
      }
      if (cmd.includes("npm test") || cmd.includes("vitest")) {
        const passed = !tc.isError && !result.includes("FAIL");
        const title = `Tests: ${passed ? "PASS" : "FAIL"}`;
        return {
          type: "vr_check",
          title,
          detail: cmd,
          visibility: classifyVisibility(title, cmd),
          opts: {
            vrType: "VR-TEST",
            evidence: result.slice(0, 500),
            importance: assignImportance("vr_check", passed ? "PASS" : "FAIL"),
            originalTokens: estimateTokens(result)
          }
        };
      }
      if (cmd.includes("npm run build") || cmd.includes("tsc --noEmit")) {
        const vrType = cmd.includes("tsc") ? "VR-TYPE" : "VR-BUILD";
        const passed = !tc.isError && !result.includes("error");
        const title = `${vrType}: ${passed ? "PASS" : "FAIL"}`;
        return {
          type: "vr_check",
          title,
          detail: cmd,
          visibility: classifyVisibility(title, cmd),
          opts: {
            vrType,
            evidence: result.slice(0, 500),
            importance: assignImportance("vr_check", passed ? "PASS" : "FAIL"),
            originalTokens: estimateTokens(result)
          }
        };
      }
      return null;
    }
    default:
      return null;
  }
}
function extractLinkedReferences(text) {
  const result = {};
  const crMatch = text.match(/CR-(\d+)/);
  if (crMatch) result.crRule = `CR-${crMatch[1]}`;
  const vrMatch = text.match(/VR-([A-Z_]+)/);
  if (vrMatch) result.vrType = `VR-${vrMatch[1]}`;
  const planMatch = text.match(/P(\d+)-(\d+)/);
  if (planMatch) result.planItem = `P${planMatch[1]}-${planMatch[2]}`;
  return result;
}
function extractCommitMessage(cmd) {
  const match = cmd.match(/-m\s+["'](.+?)["']/);
  if (match) return match[1];
  const heredocMatch = cmd.match(/<<['"]?EOF['"]?\s*\n?([\s\S]*?)EOF/);
  if (heredocMatch) return heredocMatch[1].trim().split("\n")[0];
  return "Unknown commit";
}
function shortenPath(filePath) {
  const root = getProjectRoot();
  if (filePath.startsWith(root + "/")) {
    return filePath.slice(root.length + 1);
  }
  const home = homedir2();
  if (filePath.startsWith(home + "/")) {
    return "~/" + filePath.slice(home.length + 1);
  }
  return filePath;
}
function classifyRealTimeToolCall(toolName, toolInput, toolResponse, seenReads2) {
  const tc = {
    toolName,
    toolUseId: "",
    input: toolInput,
    result: toolResponse,
    isError: false
  };
  if (isNoisyToolCall(tc, seenReads2)) return null;
  if (toolResponse && detectDecisionPatterns(toolResponse)) {
    const firstLine = toolResponse.split("\n")[0].slice(0, 200);
    const title = `Architecture decision: ${firstLine}`;
    const detail = toolResponse.slice(0, 1e3);
    return {
      type: "decision",
      title,
      detail,
      visibility: classifyVisibility(title, detail),
      opts: {
        importance: assignImportance("decision"),
        originalTokens: estimateTokens(toolResponse),
        ...extractLinkedReferences(toolResponse)
      }
    };
  }
  return classifyToolCall(tc);
}
function detectPlanProgress(toolResponse) {
  const results = [];
  const progressPattern = /(P\d+-\d+)\s*[:\-]?\s*(COMPLETE|PASS|DONE|complete|pass|done)/g;
  let match;
  while ((match = progressPattern.exec(toolResponse)) !== null) {
    results.push({ planItem: match[1], status: "complete" });
  }
  return results;
}

// src/audit-trail.ts
function logAuditEntry(db, entry) {
  db.prepare(`
    INSERT INTO audit_log (session_id, event_type, actor, model_id, file_path, change_type, rules_in_effect, approval_status, evidence, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.sessionId ?? null,
    entry.eventType,
    entry.actor,
    entry.modelId ?? null,
    entry.filePath ?? null,
    entry.changeType ?? null,
    entry.rulesInEffect ?? null,
    entry.approvalStatus ?? null,
    entry.evidence ?? null,
    entry.metadata ? JSON.stringify(entry.metadata) : null
  );
}

// src/regression-detector.ts
function calculateHealthScore(testsPassing, testsFailing, modificationsSinceTest, lastTested, lastModified) {
  let score = 100;
  if (testsFailing > 0) {
    score -= Math.min(40, testsFailing * 10);
  }
  if (modificationsSinceTest > 0) {
    score -= Math.min(30, modificationsSinceTest * 5);
  }
  if (lastModified && lastTested) {
    const modDate = new Date(lastModified).getTime();
    const testDate = new Date(lastTested).getTime();
    if (modDate > testDate) {
      const daysSinceTest = (modDate - testDate) / (1e3 * 60 * 60 * 24);
      score -= Math.min(20, Math.floor(daysSinceTest * 2));
    }
  } else if (lastModified && !lastTested) {
    score -= 30;
  }
  return Math.max(0, score);
}
function trackModification(db, featureKey) {
  const existing = db.prepare(
    "SELECT * FROM feature_health WHERE feature_key = ?"
  ).get(featureKey);
  if (existing) {
    db.prepare(`
      UPDATE feature_health
      SET last_modified = datetime('now'),
          modifications_since_test = modifications_since_test + 1,
          health_score = ?
      WHERE feature_key = ?
    `).run(
      calculateHealthScore(
        existing.tests_passing ?? 0,
        existing.tests_failing ?? 0,
        (existing.modifications_since_test ?? 0) + 1,
        existing.last_tested,
        (/* @__PURE__ */ new Date()).toISOString()
      ),
      featureKey
    );
  } else {
    db.prepare(`
      INSERT INTO feature_health
      (feature_key, last_modified, modifications_since_test, health_score, tests_passing, tests_failing)
      VALUES (?, datetime('now'), 1, 70, 0, 0)
    `).run(featureKey);
  }
}

// src/import-resolver.ts
import { readFileSync as readFileSync2, existsSync as existsSync3, statSync } from "fs";
import { resolve as resolve4, dirname as dirname3, join } from "path";

// src/security-utils.ts
import { resolve as resolve3, normalize } from "path";
function ensureWithinRoot(filePath, projectRoot) {
  const resolvedRoot = resolve3(projectRoot);
  const resolvedPath = resolve3(resolvedRoot, filePath);
  const normalizedPath = normalize(resolvedPath);
  const normalizedRoot = normalize(resolvedRoot);
  if (!normalizedPath.startsWith(normalizedRoot + "/") && normalizedPath !== normalizedRoot) {
    throw new Error(`Path traversal blocked: "${filePath}" resolves outside project root`);
  }
  return normalizedPath;
}
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function safeRegex(pattern, flags) {
  if (pattern.length > 500) return null;
  if (/(\([^)]*[+*}][^)]*\))[+*{]/.test(pattern)) return null;
  if (/\([^)]*\|[^)]*\)[+*]{1,2}/.test(pattern) && pattern.length > 100) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}
function globToSafeRegex(glob) {
  const escaped = glob.split("**").map(
    (segment) => segment.split("*").map((part) => escapeRegex(part)).join("[^/]*")
  ).join(".*");
  return new RegExp(`^${escaped}$`);
}
var MINIMUM_SEVERITY_WEIGHTS = {
  critical: 10,
  high: 5,
  medium: 2,
  low: 1
};
function enforceSeverityFloors(configWeights, defaults) {
  const result = { ...defaults };
  for (const [severity, configValue] of Object.entries(configWeights)) {
    const floor = MINIMUM_SEVERITY_WEIGHTS[severity] ?? 1;
    result[severity] = Math.max(configValue, floor);
  }
  return result;
}

// src/import-resolver.ts
function resolveImportPath(specifier, fromFile) {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
    return null;
  }
  let basePath;
  if (specifier.startsWith("@/")) {
    const paths = getResolvedPaths();
    basePath = resolve4(paths.pathAlias["@"] ?? paths.srcDir, specifier.slice(2));
  } else {
    basePath = resolve4(dirname3(fromFile), specifier);
  }
  if (existsSync3(basePath) && !isDirectory(basePath)) {
    return toRelative(basePath);
  }
  const resolvedPaths = getResolvedPaths();
  for (const ext of resolvedPaths.extensions) {
    const withExt = basePath + ext;
    if (existsSync3(withExt)) {
      return toRelative(withExt);
    }
  }
  for (const indexFile of resolvedPaths.indexFiles) {
    const indexPath = join(basePath, indexFile);
    if (existsSync3(indexPath)) {
      return toRelative(indexPath);
    }
  }
  return null;
}
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
function toRelative(absPath) {
  const root = getProjectRoot();
  if (absPath.startsWith(root)) {
    return absPath.slice(root.length + 1);
  }
  return absPath;
}

// src/validation-engine.ts
import { existsSync as existsSync4, readFileSync as readFileSync3 } from "fs";
function getValidationChecks() {
  return getConfig().governance?.validation?.checks ?? {
    rule_compliance: true,
    import_existence: true,
    naming_conventions: true
  };
}
function getCustomPatterns() {
  return getConfig().governance?.validation?.custom_patterns ?? [];
}
function validateFile(filePath, projectRoot) {
  const checks = [];
  const config = getConfig();
  const activeChecks = getValidationChecks();
  const customPatterns = getCustomPatterns();
  let absPath;
  try {
    absPath = ensureWithinRoot(filePath, projectRoot);
  } catch {
    checks.push({
      name: "path_traversal",
      severity: "critical",
      message: `Path traversal blocked: ${filePath}`,
      file: filePath
    });
    return checks;
  }
  if (!existsSync4(absPath)) {
    checks.push({
      name: "file_exists",
      severity: "error",
      message: `File not found: ${filePath}`,
      file: filePath
    });
    return checks;
  }
  const source = readFileSync3(absPath, "utf-8");
  const lines = source.split("\n");
  if (activeChecks.rule_compliance !== false) {
    for (const ruleSet of config.rules) {
      const rulePattern = globToSafeRegex(ruleSet.pattern);
      if (rulePattern.test(filePath)) {
        for (const rule of ruleSet.rules) {
          checks.push({
            name: "rule_applicable",
            severity: "info",
            message: `Rule applies: ${rule}`,
            file: filePath
          });
        }
      }
    }
  }
  if (activeChecks.import_existence !== false) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const importMatch = line.match(/^\s*import\s+.*from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const specifier = importMatch[1];
        if (specifier.startsWith(".") || specifier.startsWith("@/")) {
          const resolved = resolveImportPath(specifier, filePath);
          if (!resolved) {
            checks.push({
              name: "import_hallucination",
              severity: "error",
              message: `Import target does not exist: ${specifier}`,
              line: i + 1,
              file: filePath
            });
          }
        }
      }
    }
  }
  for (const customPattern of customPatterns) {
    const regex = safeRegex(customPattern.pattern);
    if (!regex) {
      checks.push({
        name: "config_warning",
        severity: "warning",
        message: `Custom pattern rejected (invalid or unsafe regex): ${customPattern.pattern.slice(0, 50)}`,
        file: filePath
      });
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        checks.push({
          name: "custom_pattern",
          severity: customPattern.severity,
          message: customPattern.message,
          line: i + 1,
          file: filePath
        });
      }
    }
  }
  if (config.dbAccessPattern) {
    const wrongPattern = config.dbAccessPattern === "ctx.db.{table}" ? /ctx\.prisma\./ : null;
    if (wrongPattern) {
      for (let i = 0; i < lines.length; i++) {
        if (wrongPattern.test(lines[i])) {
          checks.push({
            name: "db_access_pattern",
            severity: "error",
            message: `Wrong DB access pattern. Use ${config.dbAccessPattern}`,
            line: i + 1,
            file: filePath
          });
        }
      }
    }
  }
  return checks;
}
function storeValidationResult(db, filePath, checks, sessionId, validationType = "file_validation") {
  const errors = checks.filter((c) => c.severity === "error" || c.severity === "critical");
  const warnings = checks.filter((c) => c.severity === "warning");
  const passed = errors.length === 0;
  const rulesViolated = [...errors, ...warnings].map((c) => c.name).join(", ");
  db.prepare(`
    INSERT INTO validation_results (session_id, file_path, validation_type, passed, details, rules_violated)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sessionId ?? null,
    filePath,
    validationType,
    passed ? 1 : 0,
    JSON.stringify(checks),
    rulesViolated || null
  );
}

// src/security-scorer.ts
import { existsSync as existsSync5, readFileSync as readFileSync4 } from "fs";
var DEFAULT_SECURITY_PATTERNS = [
  {
    regex: /\bexec\s*\(\s*[`"'].*\$\{/,
    severity: "critical",
    description: "Potential command injection via template literal in exec()"
  },
  {
    regex: /publicProcedure\s*\.\s*mutation/,
    severity: "critical",
    description: "Mutation without authentication (publicProcedure)",
    fileFilter: /\.(ts|tsx)$/
  },
  {
    regex: /(password|secret|token|api_key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    severity: "critical",
    description: "Hardcoded credential or secret"
  },
  {
    regex: /\bdangerouslySetInnerHTML\b/,
    severity: "high",
    description: "XSS risk via dangerouslySetInnerHTML",
    fileFilter: /\.tsx$/
  },
  {
    regex: /\.raw\s*\(`/,
    severity: "high",
    description: "Raw SQL query with template literal (SQL injection risk)"
  },
  {
    regex: /eval\s*\(/,
    severity: "high",
    description: "Use of eval() - code injection risk"
  },
  {
    regex: /process\.env\.\w+.*\bconsole\.(log|info|debug)/,
    severity: "medium",
    description: "Environment variable logged to console"
  },
  {
    regex: /catch\s*\([^)]*\)\s*\{[^}]*res\.(json|send)\([^)]*err/,
    severity: "medium",
    description: "Error details exposed in response"
  },
  {
    regex: /Access-Control-Allow-Origin.*\*/,
    severity: "medium",
    description: "Overly permissive CORS (allows all origins)"
  },
  {
    regex: /new\s+URL\s*\(\s*(?:req|input|params|query)/,
    severity: "medium",
    description: "URL constructed from user input (SSRF risk)"
  },
  {
    regex: /JSON\.parse\s*\(\s*(?:req|input|body|params)/,
    severity: "low",
    description: "JSON.parse on user input without try/catch"
  },
  {
    regex: /prototype\s*:/,
    severity: "high",
    description: "Prototype key in object literal (prototype pollution risk)"
  }
];
var DEFAULT_SEVERITY_WEIGHTS = {
  critical: 25,
  high: 15,
  medium: 8,
  low: 3
};
function getSeverityWeights() {
  const configWeights = getConfig().security?.severity_weights;
  if (!configWeights) return DEFAULT_SEVERITY_WEIGHTS;
  return enforceSeverityFloors(configWeights, DEFAULT_SEVERITY_WEIGHTS);
}
function scoreFileSecurity(filePath, projectRoot) {
  let absPath;
  try {
    absPath = ensureWithinRoot(filePath, projectRoot);
  } catch {
    return {
      riskScore: 100,
      findings: [{
        pattern: "path_traversal",
        severity: "critical",
        line: 0,
        description: `Path traversal blocked: "${filePath}" resolves outside project root`
      }]
    };
  }
  if (!existsSync5(absPath)) {
    return { riskScore: 0, findings: [] };
  }
  let source;
  try {
    source = readFileSync4(absPath, "utf-8");
  } catch {
    return { riskScore: 0, findings: [] };
  }
  const findings = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of DEFAULT_SECURITY_PATTERNS) {
      if (pattern.fileFilter && !pattern.fileFilter.test(filePath)) continue;
      if (pattern.regex.test(line)) {
        findings.push({
          pattern: pattern.regex.source.slice(0, 50),
          severity: pattern.severity,
          line: i + 1,
          description: pattern.description
        });
      }
    }
  }
  const severityWeights = getSeverityWeights();
  let riskScore = 0;
  for (const finding of findings) {
    riskScore += severityWeights[finding.severity] ?? 0;
  }
  return {
    riskScore: Math.min(100, riskScore),
    findings
  };
}
function storeSecurityScore(db, sessionId, filePath, riskScore, findings) {
  db.prepare(`
    INSERT INTO security_scores
    (session_id, file_path, risk_score, findings)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, filePath, riskScore, JSON.stringify(findings));
}

// src/hooks/post-tool-use.ts
import { readFileSync as readFileSync5, existsSync as existsSync6 } from "fs";
import { join as join2 } from "path";
import { parse as parseYaml2 } from "yaml";
var seenReads = /* @__PURE__ */ new Set();
var currentSessionId = null;
async function main() {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input);
    const { session_id, tool_name, tool_input, tool_response } = hookInput;
    if (currentSessionId !== session_id) {
      seenReads.clear();
      currentSessionId = session_id;
    }
    const db = getMemoryDb();
    try {
      createSession(db, session_id);
      const observation = classifyRealTimeToolCall(tool_name, tool_input, tool_response, seenReads);
      if (!observation) {
        process.exit(0);
        return;
      }
      if (observation.type === "failed_attempt") {
        deduplicateFailedAttempt(db, session_id, observation.title, observation.detail, observation.opts);
      } else {
        addObservation(db, session_id, observation.type, observation.title, observation.detail, observation.opts);
      }
      if (tool_response) {
        const progress = detectPlanProgress(tool_response);
        if (progress.length > 0) {
          updatePlanProgress(db, session_id, progress);
        }
      }
      try {
        if (tool_name === "Edit" || tool_name === "Write") {
          const filePath = tool_input.file_path ?? "";
          logAuditEntry(db, {
            sessionId: session_id,
            eventType: "code_change",
            actor: "ai",
            filePath,
            changeType: tool_name === "Write" ? "create" : "edit"
          });
          if (filePath) {
            const featureMatch = filePath.match(/(?:routers|components|app\/\(([^)]+)\))\/([^/.]+)/);
            if (featureMatch) {
              const featureKey = featureMatch[1] ?? featureMatch[2];
              trackModification(db, featureKey);
            }
          }
        }
      } catch (_auditErr) {
      }
      try {
        if (tool_name === "Edit" || tool_name === "Write") {
          const filePath = tool_input.file_path ?? "";
          if (filePath && (filePath.endsWith(".ts") || filePath.endsWith(".tsx"))) {
            const projectRoot = hookInput.cwd;
            const checks = validateFile(filePath, projectRoot);
            const violations = checks.filter((c) => c.severity === "error" || c.severity === "critical");
            if (violations.length > 0) {
              storeValidationResult(db, filePath, checks, session_id);
            }
          }
        }
      } catch (_validationErr) {
      }
      try {
        if (tool_name === "Edit" || tool_name === "Write") {
          const filePath = tool_input.file_path ?? "";
          if (filePath && (filePath.includes("routers/") || filePath.includes("api/"))) {
            const projectRoot = hookInput.cwd;
            const { riskScore, findings } = scoreFileSecurity(filePath, projectRoot);
            if (findings.length > 0) {
              storeSecurityScore(db, session_id, filePath, riskScore, findings);
            }
          }
        }
      } catch (_securityErr) {
      }
      try {
        if (tool_name === "Edit" || tool_name === "Write") {
          const filePath = tool_input.file_path ?? "";
          if (filePath && filePath.endsWith("MEMORY.md") && filePath.includes("/memory/")) {
            const issues = checkMemoryFileIntegrity(filePath);
            if (issues.length > 0) {
              addObservation(
                db,
                session_id,
                "incident_near_miss",
                "MEMORY.md integrity issue detected",
                issues.join("; "),
                { importance: 4 }
              );
            }
          }
        }
      } catch (_memoryErr) {
      }
      try {
        if (tool_name === "Edit" || tool_name === "Write") {
          const filePath = tool_input.file_path ?? "";
          if (filePath && isKnowledgeSourceFile(filePath)) {
            addObservation(
              db,
              session_id,
              "discovery",
              "Knowledge source file modified - index may be stale",
              `Edited ${filePath.split("/").pop() ?? filePath}. Run knowledge re-index to update.`,
              { importance: 3 }
            );
          }
        }
      } catch (_knowledgeErr) {
      }
    } finally {
      db.close();
    }
  } catch (_e) {
  }
  process.exit(0);
}
function updatePlanProgress(db, sessionId, progress) {
  const existing = db.prepare(
    "SELECT id, plan_progress FROM session_summaries WHERE session_id = ? ORDER BY created_at_epoch DESC LIMIT 1"
  ).get(sessionId);
  if (existing) {
    try {
      const currentProgress = JSON.parse(existing.plan_progress);
      for (const p of progress) {
        currentProgress[p.planItem] = p.status;
      }
      db.prepare("UPDATE session_summaries SET plan_progress = ? WHERE id = ?").run(JSON.stringify(currentProgress), existing.id);
    } catch (_e) {
    }
  } else {
    const progressMap = {};
    for (const p of progress) {
      progressMap[p.planItem] = p.status;
    }
    addSummary(db, sessionId, { planProgress: progressMap });
  }
}
function readStdin() {
  return new Promise((resolve5) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve5(data));
    setTimeout(() => resolve5(data), 3e3);
  });
}
function readConventions(cwd) {
  const defaults = {
    knowledgeSourceFiles: ["CLAUDE.md", "MEMORY.md", "corrections.md"],
    claudeDirName: ".claude"
  };
  try {
    const projectRoot = cwd ?? process.cwd();
    const configPath = join2(projectRoot, "massu.config.yaml");
    if (!existsSync6(configPath)) return defaults;
    const content = readFileSync5(configPath, "utf-8");
    const parsed = parseYaml2(content);
    if (!parsed || typeof parsed !== "object") return defaults;
    const conventions = parsed.conventions;
    if (!conventions || typeof conventions !== "object") return defaults;
    return {
      knowledgeSourceFiles: Array.isArray(conventions.knowledgeSourceFiles) ? conventions.knowledgeSourceFiles : defaults.knowledgeSourceFiles,
      claudeDirName: typeof conventions.claudeDirName === "string" ? conventions.claudeDirName : defaults.claudeDirName
    };
  } catch {
    return defaults;
  }
}
function isKnowledgeSourceFile(filePath) {
  const basename2 = filePath.split("/").pop() ?? "";
  const conventions = readConventions();
  const knowledgeSourcePatterns = [
    ...conventions.knowledgeSourceFiles,
    "file-index.md",
    "knowledge-db.ts",
    "knowledge-indexer.ts",
    "knowledge-tools.ts"
  ];
  return knowledgeSourcePatterns.some((p) => basename2 === p) || filePath.includes("/memory/") || filePath.includes(conventions.claudeDirName + "/");
}
function checkMemoryFileIntegrity(filePath) {
  const issues = [];
  try {
    if (!existsSync6(filePath)) {
      issues.push("MEMORY.md file does not exist after write");
      return issues;
    }
    const content = readFileSync5(filePath, "utf-8");
    const lines = content.split("\n");
    const MAX_LINES = 200;
    if (lines.length > MAX_LINES) {
      issues.push(`MEMORY.md exceeds ${MAX_LINES} lines (currently ${lines.length}). Consider archiving old entries.`);
    }
    const requiredSections = ["# Massu Memory", "## Key Learnings", "## Common Gotchas"];
    for (const section of requiredSections) {
      if (!content.includes(section)) {
        issues.push(`Missing required section: "${section}"`);
      }
    }
  } catch (_e) {
  }
  return issues;
}
main();
