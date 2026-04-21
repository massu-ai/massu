#!/usr/bin/env node
import{createRequire as __cr}from"module";const require=__cr(import.meta.url);

// src/hooks/fix-detector.ts
import { execSync } from "child_process";
import { existsSync as existsSync2, appendFileSync, mkdirSync, readFileSync as readFileSync2 } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
  }).default({})
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
  detection: DetectionConfigSchema
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
    framework: {
      type: fw.type,
      router,
      orm,
      ui,
      primary: fw.primary,
      languages: fw.languages
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
    detection: parsed.detection
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

// src/hooks/fix-detector.ts
var FIX_HEURISTICS = [
  {
    name: "removed_broken_code",
    test: (diff) => /^-.*\b(bug|broken|wrong|incorrect|typo|crash|error|fail|miss|stale)\b/m.test(diff)
  },
  {
    name: "added_error_handling",
    test: (diff) => {
      const added = (diff.match(/^\+.*(try|except|catch|guard|if.*nil|if.*None|validate|assert|raise|throw)/gm) || []).length;
      return added > 2;
    }
  },
  {
    name: "method_name_correction",
    test: (diff) => {
      const removed = diff.match(/^-.*\.([a-z_]+)\(/m);
      const added = diff.match(/^\+.*\.([a-z_]+)\(/m);
      return !!(removed && added && removed[1] !== added[1]);
    }
  },
  {
    name: "auth_fix",
    test: (diff) => /^\+.*(token|auth|header|X-Service|Bearer|credential)/im.test(diff)
  },
  {
    name: "nil_handling_fix",
    test: (diff) => /^\+.*(= nil|= None|\.isNil|is None|!= nil|is not None|guard let|if let|optional)/m.test(diff) && /^-/m.test(diff)
  },
  {
    name: "concurrency_fix",
    test: (diff) => /^\+.*(timeout|semaphore|lock|mutex|throttle|rate.limit|max_conn)/im.test(diff)
  },
  {
    name: "async_pattern_fix",
    test: (diff) => /^\+.*(@MainActor|async with|asyncio\.timeout|\.await)/.test(diff) && /^-/m.test(diff)
  },
  {
    name: "added_missing_import",
    test: (diff) => /^\+.*(import|from.*import|require)/.test(diff) && !/^-.*(import|from.*import|require)/m.test(diff)
  }
];
function getSessionFlagPath(sessionId) {
  const dir = join(tmpdir(), "massu-auto-learning");
  if (!existsSync2(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, `fixes-${sessionId.slice(0, 12)}.jsonl`);
}
async function main() {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input);
    const filePath = hookInput.tool_input?.file_path;
    if (!filePath || !existsSync2(filePath)) {
      process.exit(0);
      return;
    }
    if (!/\.(py|swift|ts|tsx|js|jsx|rs|go|rb|sh)$/.test(filePath)) {
      process.exit(0);
      return;
    }
    const config = getConfig();
    const incidentDir = config.autoLearning?.incidentDir ?? "docs/incidents";
    const memoryDir = config.autoLearning?.memoryDir ?? "memory";
    if (filePath.includes(incidentDir) || filePath.includes(memoryDir) || filePath.includes("MEMORY.md")) {
      process.exit(0);
      return;
    }
    if (config.autoLearning?.enabled === false || config.autoLearning?.fixDetection?.enabled === false) {
      process.exit(0);
      return;
    }
    const root = getProjectRoot();
    let diff = "";
    try {
      diff = execSync(`git diff -- "${filePath}"`, { cwd: root, timeout: 3e3, encoding: "utf-8" });
      if (!diff) {
        diff = execSync(`git diff HEAD -- "${filePath}"`, { cwd: root, timeout: 3e3, encoding: "utf-8" });
      }
    } catch {
      process.exit(0);
      return;
    }
    if (!diff) {
      process.exit(0);
      return;
    }
    const enabledSignals = new Set(config.autoLearning?.fixDetection?.signals ?? FIX_HEURISTICS.map((h) => h.name));
    const detected = [];
    for (const heuristic of FIX_HEURISTICS) {
      if (enabledSignals.has(heuristic.name) && heuristic.test(diff)) {
        detected.push(heuristic.name);
      }
    }
    if (detected.length === 0) {
      process.exit(0);
      return;
    }
    const signal = {
      file: filePath,
      signals: detected,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    const flagPath = getSessionFlagPath(hookInput.session_id);
    appendFileSync(flagPath, JSON.stringify(signal) + "\n");
    const lines = readFileSync2(flagPath, "utf-8").split("\n").filter(Boolean);
    if (lines.length === 1) {
      console.log(
        `[Massu Auto-Learning] Bug fix detected in ${filePath} (signals: ${detected.join(", ")}). The auto-learning pipeline will prompt you at session end to create an incident report, derive a prevention rule, and add enforcement.`
      );
    }
  } catch {
  }
  process.exit(0);
}
function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve2(data));
    setTimeout(() => resolve2(data), 3e3);
  });
}
main();
