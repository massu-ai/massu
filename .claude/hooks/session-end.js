#!/usr/bin/env node
import{createRequire as __cr}from"module";const require=__cr(import.meta.url);

// src/memory-db.ts
import Database from "better-sqlite3";
import { dirname as dirname2, basename } from "path";
import { existsSync as existsSync2, mkdirSync } from "fs";

// src/config.ts
import { resolve, dirname } from "path";
import { existsSync, readFileSync } from "fs";
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
  cloud: CloudConfigSchema
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
    cloud: parsed.cloud
  };
  return _config;
}
function getResolvedPaths() {
  const config = getConfig();
  const root = getProjectRoot();
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
    patternsDir: resolve(root, ".claude/patterns"),
    claudeMdPath: resolve(root, ".claude/CLAUDE.md"),
    docsMapPath: resolve(root, ".massu/docs-map.json"),
    helpSitePath: resolve(root, "../" + config.project.name + "-help"),
    memoryDbPath: resolve(root, ".massu/memory.db")
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
}
function enqueueSyncPayload(db, payload) {
  db.prepare("INSERT INTO pending_sync (payload) VALUES (?)").run(payload);
}
function dequeuePendingSync(db, limit = 10) {
  const stale = db.prepare(
    "SELECT id FROM pending_sync WHERE retry_count >= 10"
  ).all();
  if (stale.length > 0) {
    const ids = stale.map((s) => s.id);
    db.prepare(`DELETE FROM pending_sync WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
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
    "SELECT * FROM observations WHERE session_id = ? ORDER BY created_at_epoch ASC"
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
var PROJECT_ROOT = getProjectRoot();
function archiveAndRegenerate(db, sessionId) {
  const currentMdPath = resolve3(PROJECT_ROOT, ".claude/session-state/CURRENT.md");
  const archiveDir = resolve3(PROJECT_ROOT, ".claude/session-state/archive");
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

// src/cloud-sync.ts
var MAX_RETRIES = 3;
var RETRY_DELAYS = [1e3, 2e3, 4e3];
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
    filteredPayload.observations = payload.observations;
  }
  if (cloud.sync?.analytics !== false) {
    filteredPayload.analytics = payload.analytics;
  }
  if (cloud.sync?.audit !== false) {
    filteredPayload.audit = payload.audit;
  }
  let lastError = "";
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${cloud.apiKey}`
        },
        body: JSON.stringify(filteredPayload)
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
    "SELECT type, detail FROM observations WHERE session_id = ?"
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
import { createHash } from "crypto";

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
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
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
    "SELECT prompt_text, prompt_number FROM user_prompts WHERE session_id = ? ORDER BY prompt_number ASC"
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
        "SELECT * FROM observations WHERE session_id = ? ORDER BY created_at_epoch ASC"
      ).all(session_id);
      const prompts = db.prepare(
        "SELECT prompt_text FROM user_prompts WHERE session_id = ? ORDER BY prompt_number ASC"
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
        const syncPayload = buildSyncPayload(session_id, observations, summary);
        const result = await syncToCloud(db, syncPayload);
        if (!result.success && result.error) {
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
function buildSyncPayload(sessionId, observations, summary) {
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
    }))
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
