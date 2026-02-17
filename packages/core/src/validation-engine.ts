// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tools.ts';
import { getConfig } from './config.ts';
import { resolveImportPath } from './import-resolver.ts';
import { existsSync, readFileSync } from 'fs';
import { ensureWithinRoot, globToSafeRegex, safeRegex } from './security-utils.ts';

// ============================================================
// AI Output Validation Engine
// ============================================================

/** Prefix a base tool name with the configured tool prefix. */
function p(baseName: string): string {
  return `${getConfig().toolPrefix}_${baseName}`;
}

export interface ValidationCheck {
  name: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  line?: number;
  file?: string;
}

/**
 * Get validation checks from config, or defaults.
 * Derives pattern checks from the project's configured rules.
 */
function getValidationChecks(): Record<string, boolean> {
  return getConfig().governance?.validation?.checks ?? {
    rule_compliance: true,
    import_existence: true,
    naming_conventions: true,
  };
}

/**
 * Get custom validation patterns from config.
 */
function getCustomPatterns(): Array<{ pattern: string; severity: string; message: string }> {
  return getConfig().governance?.validation?.custom_patterns ?? [];
}

/**
 * Validate a file against configured rules and custom patterns.
 */
export function validateFile(
  filePath: string,
  projectRoot: string
): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const config = getConfig();
  const activeChecks = getValidationChecks();
  const customPatterns = getCustomPatterns();

  let absPath: string;
  try {
    absPath = ensureWithinRoot(filePath, projectRoot);
  } catch {
    checks.push({
      name: 'path_traversal',
      severity: 'critical',
      message: `Path traversal blocked: ${filePath}`,
      file: filePath,
    });
    return checks;
  }
  if (!existsSync(absPath)) {
    checks.push({
      name: 'file_exists',
      severity: 'error',
      message: `File not found: ${filePath}`,
      file: filePath,
    });
    return checks;
  }

  const source = readFileSync(absPath, 'utf-8');
  const lines = source.split('\n');

  // Rule compliance check - uses project rules
  if (activeChecks.rule_compliance !== false) {
    // Check rules from config
    for (const ruleSet of config.rules) {
      const rulePattern = globToSafeRegex(ruleSet.pattern);
      if (rulePattern.test(filePath)) {
        for (const rule of ruleSet.rules) {
          // Rules are human-readable; we can't automatically enforce all of them,
          // but we can check for patterns that indicate violations
          checks.push({
            name: 'rule_applicable',
            severity: 'info',
            message: `Rule applies: ${rule}`,
            file: filePath,
          });
        }
      }
    }
  }

  // Import existence check
  if (activeChecks.import_existence !== false) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const importMatch = line.match(/^\s*import\s+.*from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const specifier = importMatch[1];
        // Only check relative imports
        if (specifier.startsWith('.') || specifier.startsWith('@/')) {
          const resolved = resolveImportPath(specifier, filePath);
          if (!resolved) {
            checks.push({
              name: 'import_hallucination',
              severity: 'error',
              message: `Import target does not exist: ${specifier}`,
              line: i + 1,
              file: filePath,
            });
          }
        }
      }
    }
  }

  // Custom patterns check - uses safeRegex to prevent ReDoS from config
  for (const customPattern of customPatterns) {
    const regex = safeRegex(customPattern.pattern);
    if (!regex) {
      checks.push({
        name: 'config_warning',
        severity: 'warning',
        message: `Custom pattern rejected (invalid or unsafe regex): ${customPattern.pattern.slice(0, 50)}`,
        file: filePath,
      });
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        checks.push({
          name: 'custom_pattern',
          severity: customPattern.severity as 'info' | 'warning' | 'error' | 'critical',
          message: customPattern.message,
          line: i + 1,
          file: filePath,
        });
      }
    }
  }

  // DB access pattern check (if configured)
  if (config.dbAccessPattern) {
    const wrongPattern = config.dbAccessPattern === 'ctx.db.{table}'
      ? /ctx\.prisma\./
      : null;
    if (wrongPattern) {
      for (let i = 0; i < lines.length; i++) {
        if (wrongPattern.test(lines[i])) {
          checks.push({
            name: 'db_access_pattern',
            severity: 'error',
            message: `Wrong DB access pattern. Use ${config.dbAccessPattern}`,
            line: i + 1,
            file: filePath,
          });
        }
      }
    }
  }

  return checks;
}

/**
 * Store validation results.
 */
export function storeValidationResult(
  db: Database.Database,
  filePath: string,
  checks: ValidationCheck[],
  sessionId?: string,
  validationType = 'file_validation'
): void {
  const errors = checks.filter(c => c.severity === 'error' || c.severity === 'critical');
  const warnings = checks.filter(c => c.severity === 'warning');
  const passed = errors.length === 0;
  const rulesViolated = [...errors, ...warnings].map(c => c.name).join(', ');

  db.prepare(`
    INSERT INTO validation_results (session_id, file_path, validation_type, passed, details, rules_violated)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sessionId ?? null, filePath, validationType,
    passed ? 1 : 0, JSON.stringify(checks), rulesViolated || null
  );
}

// ============================================================
// MCP Tool Definitions & Handlers
// ============================================================

export function getValidationToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: p('validation_check'),
      description: 'Validate a file against project rules and custom patterns. Checks import existence, rule compliance, DB access patterns, and custom patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File path relative to project root' },
          session_id: { type: 'string', description: 'Session ID for tracking (optional)' },
        },
        required: ['file'],
      },
    },
    {
      name: p('validation_report'),
      description: 'Validation summary across recent sessions. Shows error/warning trends and most-violated rules.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Days to look back (default: 7)' },
        },
        required: [],
      },
    },
  ];
}

const VALIDATION_BASE_NAMES = new Set(['validation_check', 'validation_report']);

export function isValidationTool(name: string): boolean {
  const pfx = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;
  return VALIDATION_BASE_NAMES.has(baseName);
}

export function handleValidationToolCall(
  name: string,
  args: Record<string, unknown>,
  memoryDb: Database.Database
): ToolResult {
  try {
    const pfx = getConfig().toolPrefix + '_';
    const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;

    switch (baseName) {
      case 'validation_check':
        return handleValidateFile(args, memoryDb);
      case 'validation_report':
        return handleValidationReport(args, memoryDb);
      default:
        return text(`Unknown validation tool: ${name}`);
    }
  } catch (error) {
    return text(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}\n\nUsage: ${p('validation_check')} { file: "src/path/file.ts" }, ${p('validation_report')} { days: 7 }`);
  }
}

function handleValidateFile(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const file = args.file as string;
  if (!file) return text(`Usage: ${p('validation_check')} { file: "src/path/file.ts" } - Validate a file against project rules and custom patterns.`);

  const config = getConfig();
  const checks = validateFile(file, config.project.root);

  // Store results
  storeValidationResult(db, file, checks, args.session_id as string | undefined);

  if (checks.length === 0) {
    return text(`## Validation: ${file}\n\nNo issues found. File passes all configured validation checks.`);
  }

  const errors = checks.filter(c => c.severity === 'error' || c.severity === 'critical');
  const warnings = checks.filter(c => c.severity === 'warning');
  const info = checks.filter(c => c.severity === 'info');

  const lines = [
    `## Validation: ${file}`,
    `Errors: ${errors.length} | Warnings: ${warnings.length} | Info: ${info.length}`,
    '',
  ];

  if (errors.length > 0) {
    lines.push('### Errors');
    for (const check of errors) {
      const loc = check.line ? `:${check.line}` : '';
      lines.push(`- [${check.severity.toUpperCase()}] ${check.name}${loc}: ${check.message}`);
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('### Warnings');
    for (const check of warnings) {
      const loc = check.line ? `:${check.line}` : '';
      lines.push(`- [WARN] ${check.name}${loc}: ${check.message}`);
    }
    lines.push('');
  }

  if (info.length > 0) {
    lines.push('### Info');
    for (const check of info) {
      lines.push(`- ${check.name}: ${check.message}`);
    }
  }

  return text(lines.join('\n'));
}

function handleValidationReport(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const days = (args.days as number) ?? 7;

  const results = db.prepare(`
    SELECT file_path, passed, rules_violated, created_at
    FROM validation_results
    WHERE created_at >= datetime('now', ?)
    ORDER BY created_at DESC
  `).all(`-${days} days`) as Array<Record<string, unknown>>;

  if (results.length === 0) {
    return text(`No validation results found in the last ${days} days. Run ${p('validation_check')} { file: "src/path/to/file.ts" } on specific files to generate validation data, or try a longer time range with { days: 90 }.`);
  }

  const passedCount = results.filter(r => r.passed === 1).length;
  const failedCount = results.filter(r => r.passed === 0).length;

  const lines = [
    `## Validation Report (${days} days)`,
    `Files validated: ${results.length}`,
    `Passed: ${passedCount}`,
    `Failed: ${failedCount}`,
    '',
    '### Failed Validations',
    '| File | Rules Violated | Date |',
    '|------|----------------|------|',
  ];

  const failedResults = results.filter(r => r.passed === 0);
  for (const r of failedResults.slice(0, 30)) {
    const filename = (r.file_path as string).split('/').pop();
    const rules = (r.rules_violated as string) ?? '-';
    lines.push(`| ${filename} | ${rules.slice(0, 60)} | ${(r.created_at as string).slice(0, 10)} |`);
  }

  if (failedResults.length > 30) {
    lines.push(`... and ${failedResults.length - 30} more`);
  }

  return text(lines.join('\n'));
}

function text(content: string): ToolResult {
  return { content: [{ type: 'text', text: content }] };
}
