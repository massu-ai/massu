// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tools.ts';
import { getConfig } from './config.ts';
import { existsSync, readFileSync } from 'fs';
import { ensureWithinRoot, enforceSeverityFloors } from './security-utils.ts';

// ============================================================
// Security Risk Scoring
// ============================================================

/** Prefix a base tool name with the configured tool prefix. */
function p(baseName: string): string {
  return `${getConfig().toolPrefix}_${baseName}`;
}

export interface SecurityFinding {
  pattern: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  line: number;
  description: string;
}

interface SecurityPattern {
  regex: RegExp;
  severity: SecurityFinding['severity'];
  description: string;
  fileFilter?: RegExp;
}

/** Default security patterns. Configurable via security.patterns in config. */
const DEFAULT_SECURITY_PATTERNS: SecurityPattern[] = [
  {
    regex: /\bexec\s*\(\s*[`"'].*\$\{/,
    severity: 'critical',
    description: 'Potential command injection via template literal in exec()',
  },
  {
    regex: /publicProcedure\s*\.\s*mutation/,
    severity: 'critical',
    description: 'Mutation without authentication (publicProcedure)',
    fileFilter: /\.(ts|tsx)$/,
  },
  {
    regex: /(password|secret|token|api_key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    severity: 'critical',
    description: 'Hardcoded credential or secret',
  },
  {
    regex: /\bdangerouslySetInnerHTML\b/,
    severity: 'high',
    description: 'XSS risk via dangerouslySetInnerHTML',
    fileFilter: /\.tsx$/,
  },
  {
    regex: /\.raw\s*\(`/,
    severity: 'high',
    description: 'Raw SQL query with template literal (SQL injection risk)',
  },
  {
    regex: /eval\s*\(/,
    severity: 'high',
    description: 'Use of eval() - code injection risk',
  },
  {
    regex: /process\.env\.\w+.*\bconsole\.(log|info|debug)/,
    severity: 'medium',
    description: 'Environment variable logged to console',
  },
  {
    regex: /catch\s*\([^)]*\)\s*\{[^}]*res\.(json|send)\([^)]*err/,
    severity: 'medium',
    description: 'Error details exposed in response',
  },
  {
    regex: /Access-Control-Allow-Origin.*\*/,
    severity: 'medium',
    description: 'Overly permissive CORS (allows all origins)',
  },
  {
    regex: /new\s+URL\s*\(\s*(?:req|input|params|query)/,
    severity: 'medium',
    description: 'URL constructed from user input (SSRF risk)',
  },
  {
    regex: /JSON\.parse\s*\(\s*(?:req|input|body|params)/,
    severity: 'low',
    description: 'JSON.parse on user input without try/catch',
  },
  {
    regex: /prototype\s*:/,
    severity: 'high',
    description: 'Prototype key in object literal (prototype pollution risk)',
  },
];

/** Default severity weights. Configurable via security.severity_weights */
const DEFAULT_SEVERITY_WEIGHTS: Record<string, number> = {
  critical: 25,
  high: 15,
  medium: 8,
  low: 3,
};

/**
 * Get severity weights from config or defaults.
 */
function getSeverityWeights(): Record<string, number> {
  const configWeights = getConfig().security?.severity_weights;
  if (!configWeights) return DEFAULT_SEVERITY_WEIGHTS;
  return enforceSeverityFloors(configWeights, DEFAULT_SEVERITY_WEIGHTS);
}

/**
 * Score security risk for a file.
 * Returns 0 (safe) to 100 (critical risk).
 */
export function scoreFileSecurity(filePath: string, projectRoot: string): {
  riskScore: number;
  findings: SecurityFinding[];
} {
  let absPath: string;
  try {
    absPath = ensureWithinRoot(filePath, projectRoot);
  } catch {
    return {
      riskScore: 100,
      findings: [{
        pattern: 'path_traversal',
        severity: 'critical',
        line: 0,
        description: `Path traversal blocked: "${filePath}" resolves outside project root`,
      }],
    };
  }
  if (!existsSync(absPath)) {
    return { riskScore: 0, findings: [] };
  }

  let source: string;
  try {
    source = readFileSync(absPath, 'utf-8');
  } catch {
    return { riskScore: 0, findings: [] };
  }

  const findings: SecurityFinding[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of DEFAULT_SECURITY_PATTERNS) {
      if (pattern.fileFilter && !pattern.fileFilter.test(filePath)) continue;
      if (pattern.regex.test(line)) {
        findings.push({
          pattern: pattern.regex.source.slice(0, 50),
          severity: pattern.severity,
          line: i + 1,
          description: pattern.description,
        });
      }
    }
  }

  // Calculate risk score
  const severityWeights = getSeverityWeights();
  let riskScore = 0;

  for (const finding of findings) {
    riskScore += severityWeights[finding.severity] ?? 0;
  }

  return {
    riskScore: Math.min(100, riskScore),
    findings,
  };
}

/**
 * Store security score for a file.
 */
export function storeSecurityScore(
  db: Database.Database,
  sessionId: string,
  filePath: string,
  riskScore: number,
  findings: SecurityFinding[]
): void {
  db.prepare(`
    INSERT INTO security_scores
    (session_id, file_path, risk_score, findings)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, filePath, riskScore, JSON.stringify(findings));
}

// ============================================================
// MCP Tool Definitions & Handlers
// ============================================================

export function getSecurityToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: p('security_score'),
      description: 'Security risk score for a file. Detects SQL injection, XSS, hardcoded secrets, auth gaps, and more.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File path relative to project root' },
          session_id: { type: 'string', description: 'Get scores for an entire session' },
        },
        required: [],
      },
    },
    {
      name: p('security_heatmap'),
      description: 'Security risk heat map. Files ranked by risk score with summary findings.',
      inputSchema: {
        type: 'object',
        properties: {
          threshold: { type: 'number', description: 'Show files above this risk score (default: 30)' },
        },
        required: [],
      },
    },
    {
      name: p('security_trend'),
      description: 'Security posture over time. Average risk scores and most improved/degraded areas.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Days to look back (default: 30)' },
        },
        required: [],
      },
    },
  ];
}

const SECURITY_BASE_NAMES = new Set(['security_score', 'security_heatmap', 'security_trend']);

export function isSecurityTool(name: string): boolean {
  const pfx = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;
  return SECURITY_BASE_NAMES.has(baseName);
}

export function handleSecurityToolCall(
  name: string,
  args: Record<string, unknown>,
  memoryDb: Database.Database
): ToolResult {
  try {
    const pfx = getConfig().toolPrefix + '_';
    const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;

    switch (baseName) {
      case 'security_score':
        return handleSecurityScore(args, memoryDb);
      case 'security_heatmap':
        return handleSecurityHeatmap(args, memoryDb);
      case 'security_trend':
        return handleSecurityTrend(args, memoryDb);
      default:
        return text(`Unknown security tool: ${name}`);
    }
  } catch (error) {
    return text(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}\n\nUsage: ${p('security_score')} { file_path: "src/..." }, ${p('security_heatmap')} { threshold: 30 }`);
  }
}

function handleSecurityScore(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const filePath = args.file_path as string | undefined;
  const sessionId = args.session_id as string | undefined;

  if (filePath) {
    const config = getConfig();
    const { riskScore, findings } = scoreFileSecurity(filePath, config.project.root);

    // Store the result
    const session = db.prepare(
      "SELECT session_id FROM sessions WHERE status = 'active' ORDER BY started_at_epoch DESC LIMIT 1"
    ).get() as { session_id: string } | undefined;
    if (session) {
      storeSecurityScore(db, session.session_id, filePath, riskScore, findings);
    }

    const lines = [
      `## Security Score: ${filePath}`,
      `Risk: **${riskScore}/100** ${riskScore === 0 ? '(clean)' : riskScore < 30 ? '(low risk)' : riskScore < 60 ? '(medium risk)' : '(HIGH RISK)'}`,
      '',
    ];

    if (findings.length > 0) {
      lines.push('### Findings');
      for (const f of findings) {
        lines.push(`- **[${f.severity.toUpperCase()}]** L${f.line}: ${f.description}`);
      }
    } else {
      lines.push(`No security findings detected (checked ${DEFAULT_SECURITY_PATTERNS.length} patterns including command injection, XSS, hardcoded secrets, and auth gaps).`);
    }

    return text(lines.join('\n'));
  }

  if (sessionId) {
    const scores = db.prepare(`
      SELECT file_path, risk_score, findings FROM security_scores
      WHERE session_id = ?
      ORDER BY risk_score DESC
    `).all(sessionId) as Array<Record<string, unknown>>;

    if (scores.length === 0) {
      return text(`No security scores for session ${sessionId.slice(0, 8)}... Security scores are generated when files are scanned. Try: ${p('security_score')} { file_path: "src/server/api/routers/example.ts" } to scan a file, or ${p('security_heatmap')} {} to see all scanned files.`);
    }

    const lines = [
      `## Security Scores for Session ${sessionId.slice(0, 12)}...`,
      '',
      '| File | Risk Score | Findings |',
      '|------|-----------|----------|',
    ];

    for (const s of scores) {
      const findingCount = JSON.parse(s.findings as string).length;
      lines.push(`| ${s.file_path} | ${s.risk_score} | ${findingCount} |`);
    }

    return text(lines.join('\n'));
  }

  return text(`Usage: ${p('security_score')} { file_path: "src/server/api/routers/example.ts" } to scan a file, or ${p('security_score')} { session_id: "..." } to see all scores for a session.`);
}

function handleSecurityHeatmap(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const threshold = (args.threshold as number) ?? 30;

  const files = db.prepare(`
    SELECT file_path, MAX(risk_score) as max_risk, COUNT(*) as scan_count
    FROM security_scores
    GROUP BY file_path
    HAVING max_risk >= ?
    ORDER BY max_risk DESC
    LIMIT 50
  `).all(threshold) as Array<Record<string, unknown>>;

  if (files.length === 0) {
    return text(`No files with risk score >= ${threshold}. ${threshold > 0 ? `Try lowering the threshold or scan files with ${p('security_score')} { file_path: "..." }.` : 'No security scans recorded yet. Scan files to build the heat map.'}`);
  }

  const lines = [
    `## Security Heat Map (threshold: ${threshold})`,
    `Files at risk: ${files.length}`,
    '',
    '| Risk | File | Scans |',
    '|------|------|-------|',
  ];

  for (const f of files) {
    const risk = f.max_risk as number;
    const indicator = risk >= 60 ? 'HIGH' : risk >= 30 ? 'MEDIUM' : 'LOW';
    lines.push(`| ${risk} [${indicator}] | ${f.file_path} | ${f.scan_count} |`);
  }

  return text(lines.join('\n'));
}

function handleSecurityTrend(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const days = (args.days as number) ?? 30;

  const rows = db.prepare(`
    SELECT date(created_at) as day,
           AVG(risk_score) as avg_risk,
           MAX(risk_score) as max_risk,
           COUNT(*) as files_scanned
    FROM security_scores
    WHERE created_at >= datetime('now', ?)
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all(`-${days} days`) as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    return text(`No security scan data in the last ${days} days. Security trends build as files are scanned across sessions. Try: ${p('security_score')} { file_path: "src/server/api/routers/example.ts" } to scan a file, or try a longer time range with { days: 90 }.`);
  }

  const lines = [
    `## Security Trend (${days} days)`,
    '',
    '| Date | Avg Risk | Max Risk | Files Scanned |',
    '|------|----------|----------|---------------|',
  ];

  for (const row of rows) {
    lines.push(
      `| ${row.day} | ${(row.avg_risk as number).toFixed(1)} | ${row.max_risk} | ${row.files_scanned} |`
    );
  }

  return text(lines.join('\n'));
}

function text(content: string): ToolResult {
  return { content: [{ type: 'text', text: content }] };
}
