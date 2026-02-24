// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './tools.ts';
import { createHash } from 'crypto';
import { getConfig } from './config.ts';
import { escapeRegex, redactSensitiveContent } from './security-utils.ts';

// ============================================================
// Prompt Effectiveness Analysis
// ============================================================

/** Prefix a base tool name with the configured tool prefix. */
function p(baseName: string): string {
  return `${getConfig().toolPrefix}_${baseName}`;
}

/** Default success/failure indicators. Can be overridden via config.analytics.prompts */
const DEFAULT_SUCCESS_INDICATORS = ['committed', 'approved', 'looks good', 'perfect', 'great', 'thanks'];
const DEFAULT_FAILURE_INDICATORS = ['revert', 'wrong', "that's not", 'undo', 'incorrect'];
const DEFAULT_ABANDON_PATTERNS = /\b(nevermind|forget it|skip|let's move on|different|instead)\b/i;

/**
 * Categorize a prompt by its intent.
 */
export function categorizePrompt(promptText: string): string {
  const lower = promptText.toLowerCase();

  if (/\b(fix|bug|error|broken|issue|crash|fail)\b/.test(lower)) return 'bugfix';
  if (/\b(refactor|rename|move|extract|cleanup|reorganize)\b/.test(lower)) return 'refactor';
  if (/\b(what|how|why|where|when|explain|describe|tell me)\b/.test(lower)) return 'question';
  if (/^\/\w+/.test(promptText.trim())) return 'command';
  if (/\b(add|create|implement|build|new|feature)\b/.test(lower)) return 'feature';

  return 'feature'; // Default to feature for implementation requests
}

/**
 * Hash a prompt for deduplication/comparison.
 * Normalizes whitespace and lowercases before hashing.
 */
export function hashPrompt(promptText: string): string {
  const normalized = promptText.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Detect outcome from subsequent conversation context.
 * Heuristic based on what follows a prompt.
 */
export function detectOutcome(
  followUpPrompts: string[],
  assistantResponses: string[]
): { outcome: string; correctionsNeeded: number; followUpCount: number } {
  let correctionsNeeded = 0;
  let outcome = 'success';

  const correctionPatterns = /\b(no|wrong|that's not|fix this|try again|revert|undo|incorrect|not what)\b/i;

  const config = getConfig();
  const successIndicators = config.analytics?.prompts?.success_indicators ?? DEFAULT_SUCCESS_INDICATORS;
  // Escape regex special chars from config-provided indicators to prevent ReDoS
  const escapedIndicators = successIndicators.map(escapeRegex);
  const successRegex = new RegExp(`\\b(${escapedIndicators.join('|')})\\b`, 'i');

  for (const prompt of followUpPrompts) {
    if (correctionPatterns.test(prompt)) {
      correctionsNeeded++;
    }
    if (DEFAULT_ABANDON_PATTERNS.test(prompt)) {
      outcome = 'abandoned';
      break;
    }
  }

  // Check assistant responses for failure signals
  for (const response of assistantResponses) {
    if (/\b(error|failed|cannot|unable to)\b/i.test(response) && response.length < 200) {
      outcome = 'failure';
    }
  }

  // Determine final outcome
  if (outcome === 'abandoned') {
    // Keep abandoned
  } else if (correctionsNeeded >= 3) {
    outcome = 'partial';
  } else if (correctionsNeeded > 0) {
    outcome = 'partial';
  } else {
    // Check for success signals in follow-ups
    for (const prompt of followUpPrompts) {
      if (successRegex.test(prompt)) {
        outcome = 'success';
        break;
      }
    }
  }

  return {
    outcome,
    correctionsNeeded,
    followUpCount: followUpPrompts.length,
  };
}

/**
 * Analyze prompts from a session and store outcomes.
 */
export function analyzeSessionPrompts(db: Database.Database, sessionId: string): number {
  const prompts = db.prepare(
    'SELECT prompt_text, prompt_number FROM user_prompts WHERE session_id = ? ORDER BY prompt_number ASC'
  ).all(sessionId) as Array<{ prompt_text: string; prompt_number: number }>;

  if (prompts.length === 0) return 0;

  let stored = 0;
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const followUps = prompts.slice(i + 1, i + 4).map(p => p.prompt_text);

    const category = categorizePrompt(prompt.prompt_text);
    const hash = hashPrompt(prompt.prompt_text);
    const { outcome, correctionsNeeded, followUpCount } = detectOutcome(followUps, []);

    // Check if already analyzed
    const existing = db.prepare(
      'SELECT id FROM prompt_outcomes WHERE session_id = ? AND prompt_hash = ?'
    ).get(sessionId, hash);
    if (existing) continue;

    // Redact sensitive content (API keys, emails, tokens, paths) before storage
    const redactedText = redactSensitiveContent(prompt.prompt_text.slice(0, 2000));

    db.prepare(`
      INSERT INTO prompt_outcomes
      (session_id, prompt_hash, prompt_text, prompt_category, word_count, outcome,
       corrections_needed, follow_up_prompts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, hash, redactedText, category,
      prompt.prompt_text.split(/\s+/).length, outcome,
      correctionsNeeded, followUpCount
    );
    stored++;
  }

  return stored;
}

// ============================================================
// MCP Tool Definitions & Handlers
// ============================================================

export function getPromptToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: p('prompt_effectiveness'),
      description: 'Prompt effectiveness statistics by category. Shows success rates, average corrections needed, and best-performing prompt patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Filter by category: feature, bugfix, refactor, question, command',
          },
          days: { type: 'number', description: 'Days to look back (default: 30)' },
        },
        required: [],
      },
    },
    {
      name: p('prompt_suggestions'),
      description: 'Suggest improvements for a prompt based on past outcomes. Finds similar prompts ranked by success rate.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The prompt text to analyze' },
        },
        required: ['prompt'],
      },
    },
  ];
}

const PROMPT_BASE_NAMES = new Set(['prompt_effectiveness', 'prompt_suggestions']);

export function isPromptTool(name: string): boolean {
  const pfx = getConfig().toolPrefix + '_';
  const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;
  return PROMPT_BASE_NAMES.has(baseName);
}

export function handlePromptToolCall(
  name: string,
  args: Record<string, unknown>,
  memoryDb: Database.Database
): ToolResult {
  try {
    const pfx = getConfig().toolPrefix + '_';
    const baseName = name.startsWith(pfx) ? name.slice(pfx.length) : name;

    switch (baseName) {
      case 'prompt_effectiveness':
        return handleEffectiveness(args, memoryDb);
      case 'prompt_suggestions':
        return handleSuggestions(args, memoryDb);
      default:
        return text(`Unknown prompt tool: ${name}`);
    }
  } catch (error) {
    return text(`Error in ${name}: ${error instanceof Error ? error.message : String(error)}\n\nUsage: ${p('prompt_effectiveness')} { days: 30 }, ${p('prompt_suggestions')} { prompt: "..." }`);
  }
}

function handleEffectiveness(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const category = args.category as string | undefined;
  const days = (args.days as number) ?? 30;

  let sql = `
    SELECT prompt_category,
           COUNT(*) as total,
           SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
           SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) as partials,
           SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failures,
           SUM(CASE WHEN outcome = 'abandoned' THEN 1 ELSE 0 END) as abandoned,
           AVG(corrections_needed) as avg_corrections,
           AVG(word_count) as avg_word_count
    FROM prompt_outcomes
    WHERE created_at >= datetime('now', ?)
  `;
  const params: (string | number)[] = [`-${days} days`];

  if (category) {
    sql += ' AND prompt_category = ?';
    params.push(category);
  }

  sql += ' GROUP BY prompt_category ORDER BY total DESC';

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    return text(`No prompt outcomes found in the last ${days} days. Prompt analysis runs automatically at session end. Try a longer time range: ${p('prompt_effectiveness')} { days: 90 }, or use ${p('prompt_suggestions')} { prompt: "your text" } to analyze a prompt directly.`);
  }

  const lines = [
    `## Prompt Effectiveness (${days} days)`,
    '',
    '| Category | Total | Success % | Partial | Failed | Abandoned | Avg Corrections | Avg Words |',
    '|----------|-------|-----------|---------|--------|-----------|-----------------|-----------|',
  ];

  for (const row of rows) {
    const total = row.total as number;
    const successRate = total > 0 ? Math.round(((row.successes as number) / total) * 100) : 0;
    lines.push(
      `| ${row.prompt_category} | ${total} | ${successRate}% | ${row.partials} | ${row.failures} | ${row.abandoned} | ${(row.avg_corrections as number).toFixed(1)} | ${Math.round(row.avg_word_count as number)} |`
    );
  }

  return text(lines.join('\n'));
}

function handleSuggestions(args: Record<string, unknown>, db: Database.Database): ToolResult {
  const prompt = args.prompt as string;
  if (!prompt) return text(`Usage: ${p('prompt_suggestions')} { prompt: "your prompt text here" } - Analyzes a prompt and suggests improvements based on past outcomes.`);

  const category = categorizePrompt(prompt);
  const wordCount = prompt.split(/\s+/).length;

  // Find successful prompts in the same category with similar length
  const similar = db.prepare(`
    SELECT prompt_text, outcome, corrections_needed, word_count
    FROM prompt_outcomes
    WHERE prompt_category = ? AND outcome = 'success'
    ORDER BY ABS(word_count - ?) ASC
    LIMIT 5
  `).all(category, wordCount) as Array<{
    prompt_text: string;
    outcome: string;
    corrections_needed: number;
    word_count: number;
  }>;

  const lines = [
    `## Prompt Analysis`,
    `Category: ${category}`,
    `Word count: ${wordCount}`,
    '',
  ];

  // Suggestions based on patterns
  if (wordCount < 10) {
    lines.push('**Suggestion**: Short prompts often need follow-up corrections. Consider adding more context about:');
    lines.push('- Expected behavior or output');
    lines.push('- Specific files or components to modify');
    lines.push('- Constraints or patterns to follow');
    lines.push('');
  }

  if (similar.length > 0) {
    lines.push('### Successful Similar Prompts');
    for (const s of similar) {
      lines.push(`- [${s.word_count} words] ${s.prompt_text.slice(0, 150)}...`);
    }
  } else {
    lines.push('No similar successful prompts found in this category.');
  }

  // Category-specific stats
  const stats = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
           AVG(corrections_needed) as avg_corrections
    FROM prompt_outcomes WHERE prompt_category = ?
  `).get(category) as { total: number; successes: number; avg_corrections: number };

  if (stats.total > 0) {
    lines.push('');
    lines.push(`### Category Stats: ${category}`);
    lines.push(`- Success rate: ${Math.round((stats.successes / stats.total) * 100)}%`);
    lines.push(`- Avg corrections needed: ${stats.avg_corrections.toFixed(1)}`);
  }

  return text(lines.join('\n'));
}

function text(content: string): ToolResult {
  return { content: [{ type: 'text', text: content }] };
}
