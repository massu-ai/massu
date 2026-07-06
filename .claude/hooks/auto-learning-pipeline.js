#!/usr/bin/env node
import{createRequire as __cr}from"module";const require=__cr(import.meta.url);

// src/hooks/auto-learning-pipeline.ts
import { execFileSync } from "child_process";
import { existsSync as existsSync3, readFileSync as readFileSync3, unlinkSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// src/config.ts
import { resolve as resolve2, dirname } from "path";
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// src/credentials.ts
import { homedir } from "os";
import { resolve } from "path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  chmodSync
} from "fs";
var MASSU_ENV_API_KEY = "MASSU_API_KEY";
var MASSU_ENV_CLOUD_ENDPOINT = "MASSU_CLOUD_ENDPOINT";
var DEFAULT_CLOUD_ENDPOINT = "https://api.massu.ai/v1";
function credentialsDir(home = homedir()) {
  return resolve(home, ".massu");
}
function credentialsPath(home = homedir()) {
  return resolve(credentialsDir(home), "credentials");
}
function readUserCredentials(home = homedir()) {
  try {
    const p = credentialsPath(home);
    if (!existsSync(p)) return void 0;
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    const key = typeof parsed?.apiKey === "string" ? parsed.apiKey.trim() : "";
    return key.length > 0 ? key : void 0;
  } catch {
    return void 0;
  }
}
function isUnresolvedLiteral(v) {
  return /^\$\{[^}]+\}$/.test(v);
}
function resolveApiKey(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cfg = typeof opts.configApiKey === "string" ? opts.configApiKey.trim() : "";
  if (cfg.length > 0 && !isUnresolvedLiteral(cfg)) {
    return { apiKey: cfg, source: "config" };
  }
  const envRaw = env[MASSU_ENV_API_KEY];
  const envKey = typeof envRaw === "string" ? envRaw.trim() : "";
  if (envKey.length > 0) {
    return { apiKey: envKey, source: "env" };
  }
  const fileKey = readUserCredentials(home);
  if (fileKey) {
    return { apiKey: fileKey, source: "user-file" };
  }
  return { source: "none" };
}
function resolveEndpoint(opts = {}) {
  const env = opts.env ?? process.env;
  const cfg = typeof opts.configEndpoint === "string" ? opts.configEndpoint.trim() : "";
  if (cfg.length > 0) return cfg;
  const envRaw = env[MASSU_ENV_CLOUD_ENDPOINT];
  const envEp = typeof envRaw === "string" ? envRaw.trim() : "";
  if (envEp.length > 0) return envEp;
  return DEFAULT_CLOUD_ENDPOINT;
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
var _resolvedApiKeySource = "none";
var _projectRoot = null;
function findProjectRoot() {
  const cwd = process.cwd();
  let dir = cwd;
  while (true) {
    if (existsSync2(resolve2(dir, "massu.config.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dir = cwd;
  while (true) {
    if (existsSync2(resolve2(dir, "package.json"))) {
      return dir;
    }
    if (existsSync2(resolve2(dir, ".git"))) {
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
  const configPath = resolve2(root, "massu.config.yaml");
  let rawYaml = {};
  if (existsSync2(configPath)) {
    const content = readFileSync2(configPath, "utf-8");
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
  const projectRoot = parsed.project.root === "auto" || !parsed.project.root ? root : resolve2(root, parsed.project.root);
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
  const resolvedKey = resolveApiKey({ configApiKey: _config.cloud?.apiKey });
  _resolvedApiKeySource = resolvedKey.source;
  const resolvedEndpoint = resolveEndpoint({ configEndpoint: _config.cloud?.endpoint });
  if (resolvedKey.apiKey) {
    _config.cloud = {
      enabled: true,
      sync: { memory: true, analytics: true, audit: true },
      ..._config.cloud,
      apiKey: resolvedKey.apiKey,
      endpoint: resolvedEndpoint
    };
  } else if (_config.cloud) {
    _config.cloud = { ..._config.cloud, endpoint: _config.cloud.endpoint ?? resolvedEndpoint };
  }
  return _config;
}

// src/hooks/lib/write-hook-message.ts
function writeHookMessage(message) {
  process.stdout.write(JSON.stringify({ message }) + "\n");
}

// src/hooks/auto-learning-pipeline.ts
var MAX_FULL_DIFF_BYTES = 2 * 1024 * 1024;
function getSessionFlagPath(sessionId) {
  return join(tmpdir(), "massu-auto-learning", `fixes-${sessionId.slice(0, 12)}.jsonl`);
}
async function main() {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input);
    const config = getConfig();
    if (config.autoLearning?.enabled === false) {
      process.exit(0);
      return;
    }
    const root = getProjectRoot();
    const incidentDir = config.autoLearning?.incidentDir ?? "docs/incidents";
    const memoryDir = config.autoLearning?.memoryDir ?? "memory";
    const autoLearn = config.autoLearning;
    const flagPath = getSessionFlagPath(hookInput.session_id);
    let sessionFixes = [];
    if (existsSync3(flagPath)) {
      try {
        sessionFixes = readFileSync3(flagPath, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch {
      }
    }
    let uncommittedFix = false;
    try {
      const nameOnly = execFileSync("git", ["diff", "--name-only"], {
        cwd: root,
        timeout: 3e3,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024
      });
      if (nameOnly.trim()) {
        const shortstat = execFileSync("git", ["diff", "--shortstat"], {
          cwd: root,
          timeout: 2e3,
          encoding: "utf-8",
          maxBuffer: 64 * 1024
        });
        const insertions = parseInt(shortstat.match(/(\d+) insertion/)?.[1] ?? "0", 10);
        const deletions = parseInt(shortstat.match(/(\d+) deletion/)?.[1] ?? "0", 10);
        const estimatedBytes = (insertions + deletions) * 80;
        if (estimatedBytes <= MAX_FULL_DIFF_BYTES) {
          const fullDiff = execFileSync("git", ["diff"], {
            cwd: root,
            timeout: 5e3,
            encoding: "utf-8",
            maxBuffer: MAX_FULL_DIFF_BYTES
          });
          const fixPatterns = (fullDiff.match(/^\+.*(try|except|catch|guard|throw|raise|assert|validate|if.*null|if.*nil|if.*None|if.*undefined)/gm) || []).length;
          const removedBroken = (fullDiff.match(/^-.*(bug|broken|crash|wrong|incorrect|typo|fail|error|miss|stale)/gm) || []).length;
          if (fixPatterns > 3 || removedBroken > 1) {
            uncommittedFix = true;
          }
        }
      }
    } catch {
    }
    if (sessionFixes.length === 0 && !uncommittedFix) {
      cleanup(flagPath);
      process.exit(0);
      return;
    }
    const lines = [];
    lines.push("");
    lines.push("============================================================================");
    lines.push(" MASSU AUTO-LEARNING PIPELINE \u2014 ACTION REQUIRED BEFORE SESSION END");
    lines.push("============================================================================");
    if (sessionFixes.length > 0) {
      lines.push("");
      lines.push(`  ${sessionFixes.length} bug fix(es) detected during this session:`);
      lines.push("");
      const byFile = /* @__PURE__ */ new Map();
      for (const fix of sessionFixes) {
        const existing = byFile.get(fix.file) ?? [];
        existing.push(...fix.signals);
        byFile.set(fix.file, [...new Set(existing)]);
      }
      for (const [file, signals] of byFile) {
        lines.push(`    - ${file} (${signals.join(", ")})`);
      }
    }
    if (uncommittedFix) {
      lines.push("");
      lines.push("  Additional uncommitted fix patterns detected in git diff.");
    }
    lines.push("");
    lines.push("  Complete these steps before this session ends:");
    lines.push("");
    if (autoLearn?.pipeline?.requireIncidentReport !== false) {
      lines.push("  STEP 1: INCIDENT REPORT");
      lines.push(`    For each distinct bug fixed, create: ${incidentDir}/YYYY-MM-DD-<slug>.md`);
      lines.push("    Include: Date, Severity, Symptoms, Root Cause, Fix, Files Changed, Prevention Rules");
      lines.push("");
    }
    if (autoLearn?.pipeline?.requirePreventionRule !== false) {
      lines.push("  STEP 2: PREVENTION RULE");
      lines.push(`    For each incident, create: ${memoryDir}/feedback_<rule_name>.md`);
      lines.push("    Include frontmatter (name, description, type: feedback) + Why + How to apply");
      lines.push(`    Update ${config.autoLearning?.memoryIndexFile ?? "MEMORY.md"} index`);
      lines.push("");
    }
    if (autoLearn?.pipeline?.requireEnforcement !== false) {
      lines.push("  STEP 3: ENFORCEMENT PLACEMENT");
      lines.push("    For each new rule, determine enforcement layer(s):");
      lines.push("    a) If statically detectable \u2192 add to pattern-feedback hook");
      lines.push("    b) If about editing certain files \u2192 add to blast-radius hook");
      lines.push("    c) If about dangerous commands \u2192 add to dangerous-command hook");
      lines.push("    d) If critical \u2192 add to pre-commit hook");
      lines.push("    e) If needs runtime monitoring \u2192 create monitoring producer");
      lines.push("");
    }
    lines.push("  STEP 4: VERIFY");
    lines.push("    Test any new enforcement hooks to confirm they detect violations.");
    lines.push("");
    lines.push("============================================================================");
    lines.push("");
    writeHookMessage(lines.join("\n"));
    cleanup(flagPath);
  } catch {
  }
  process.exit(0);
}
function cleanup(flagPath) {
  try {
    if (existsSync3(flagPath)) unlinkSync(flagPath);
    const dir = join(tmpdir(), "massu-auto-learning");
    if (existsSync3(dir)) {
      const now = Date.now();
      for (const file of readdirSync(dir)) {
        const fullPath = join(dir, file);
        try {
          const stat = statSync(fullPath);
          if (now - stat.mtimeMs > 864e5) {
            unlinkSync(fullPath);
          }
        } catch {
        }
      }
    }
  } catch {
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
    setTimeout(() => resolve3(data), 5e3);
  });
}
main();
