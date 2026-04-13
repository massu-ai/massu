#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// PostToolUse Hook: Incident-to-Rule Pipeline
// When a new incident report is written, automatically triggers
// the next step: deriving a prevention rule.
//
// Part of the Auto-Learning Pipeline:
//   Fix Detected → [Incident Report] → RULE DERIVATION → Enforcement
//
// Triggers on: Write to docs/incidents/*.md (configurable)
// Must complete in <500ms.
// ============================================================

import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import { getProjectRoot, getConfig } from '../config.ts';
import { getMemoryDb, scoreFailureClasses, appendIncidentToFailureClass, addFailureClass } from '../memory-db.ts';

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: { file_path?: string; content?: string };
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const filePath = hookInput.tool_input?.file_path;

    if (!filePath) {
      process.exit(0);
      return;
    }

    const config = getConfig();
    if (config.autoLearning?.enabled === false) {
      process.exit(0);
      return;
    }

    const root = getProjectRoot();
    const incidentDir = config.autoLearning?.incidentDir ?? 'docs/incidents';
    const memoryDir = config.autoLearning?.memoryDir ?? 'memory';
    // Only trigger on incident report files
    const relPath = filePath.startsWith(root + '/') ? filePath.slice(root.length + 1) : filePath;
    if (!relPath.startsWith(incidentDir) || !relPath.endsWith('.md')) {
      process.exit(0);
      return;
    }

    if (!existsSync(filePath)) {
      process.exit(0);
      return;
    }

    // Extract title from the incident report
    const content = readFileSync(filePath, 'utf-8');
    const titleMatch = content.match(/^#\s+(.+)/m);
    const title = titleMatch?.[1] ?? basename(filePath, '.md');

    // Check if a corresponding rule already exists
    const slug = basename(filePath, '.md')
      .replace(/^\d{4}-\d{2}-\d{2}-?/, '')
      .toLowerCase();

    const memoryDirAbs = resolve(root, memoryDir);
    let hasExistingRule = false;
    if (existsSync(memoryDirAbs)) {
      const ruleFiles = readdirSync(memoryDirAbs).filter(f => f.startsWith('feedback_'));
      for (const ruleFile of ruleFiles) {
        if (ruleFile.toLowerCase().includes(slug.slice(0, 20))) {
          hasExistingRule = true;
          break;
        }
      }
    }

    if (hasExistingRule) {
      // Rule already exists — no action needed
      process.exit(0);
      return;
    }

    // Check if incident has prevention rules section
    const hasPrevention = /## Prevention Rules|## Prevention|## Rules/i.test(content);

    if (config.autoLearning?.pipeline?.requirePreventionRule === false) {
      process.exit(0);
      return;
    }

    // Output rule derivation instructions
    const lines: string[] = [];
    lines.push('');
    lines.push('============================================================================');
    lines.push(' AUTO-LEARNING: Incident Report Created — Rule Derivation Required');
    lines.push('============================================================================');
    lines.push('');
    lines.push(`  Incident: ${title}`);
    lines.push(`  File: ${filePath}`);
    lines.push('');

    if (!hasPrevention) {
      lines.push('  No "## Prevention Rules" section found in the incident report.');
      lines.push('  Add one first, then proceed with rule derivation.');
      lines.push('');
    }

    lines.push('  DERIVE A PREVENTION RULE:');
    lines.push(`    a) Read the incident root cause and prevention rules`);
    lines.push(`    b) Create: ${memoryDir}/feedback_<rule_name>.md`);
    lines.push('       Template:');
    lines.push('       ---');
    lines.push('       name: <Rule Name>');
    lines.push('       description: <one-line description>');
    lines.push('       type: feedback');
    lines.push('       ---');
    lines.push('       <Rule statement>');
    lines.push('       **Why:** <Root cause from incident>');
    lines.push('       **How to apply:** <Concrete steps>');
    lines.push('');
    lines.push(`    c) Add one-line entry to ${config.autoLearning?.memoryIndexFile ?? 'MEMORY.md'}`);
    lines.push('');
    lines.push('  This step is MANDATORY per the auto-learning pipeline.');
    lines.push('============================================================================');
    lines.push('');

    console.log(lines.join('\n'));

    // ============================================================
    // Taxonomy Update: Score incident against failure classes
    // If KNOWN match → append incident to existing class
    // If NEW → create stub entry with needs_review=true
    // ============================================================
    try {
      const taxonomyConfig = config.autoLearning?.failureClassification;
      if (taxonomyConfig?.enabled !== false) {
        const db = getMemoryDb();
        try {
          const thresholds = taxonomyConfig?.thresholds ?? { known: 5, similar: 3 };
          const scoringWeights = taxonomyConfig?.scoring;

          // Extract incident number from filename (e.g., "incident-042.md" → "42")
          const incidentNumMatch = basename(filePath, '.md').match(/(\d+)/);
          const incidentId = incidentNumMatch ? incidentNumMatch[1] : basename(filePath, '.md');

          // Score incident content against taxonomy
          const bestMatch = scoreFailureClasses(db, content, filePath, title, scoringWeights);

          if (bestMatch && bestMatch.score >= thresholds.similar) {
            // Known or similar — append incident to existing class
            appendIncidentToFailureClass(db, bestMatch.name, incidentId);
          } else {
            // New pattern — create stub entry for review
            const stubName = `auto_${slug.replace(/[^a-z0-9_]/g, '_').slice(0, 50)}`;
            addFailureClass(db, {
              name: stubName,
              description: `Auto-created from incident ${incidentId}: ${title.slice(0, 100)}`,
              incidents: [incidentId],
              needsReview: true,
            });
          }
        } finally {
          db.close();
        }
      }
    } catch {
      // Best-effort: taxonomy update failure must not block the pipeline
    }
  } catch {
    // Best-effort: never block Claude Code
  }
  process.exit(0);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 3000);
  });
}

main();
