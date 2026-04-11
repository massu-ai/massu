#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// PostToolUse Hook: Rule-to-Enforcement Pipeline
// When a new prevention rule (feedback_*.md) is written,
// automatically triggers the final step: enforcement placement.
//
// Part of the Auto-Learning Pipeline:
//   Fix Detected → Incident Report → Rule Derived → [ENFORCEMENT]
//
// Triggers on: Write to memory/feedback_*.md (configurable)
// Must complete in <500ms.
// ============================================================

import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, resolve } from 'path';
import { getProjectRoot, getConfig } from '../config.ts';

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
    const memoryDir = config.autoLearning?.memoryDir ?? 'memory';
    const enforcementDir = config.autoLearning?.enforcementHooksDir ?? 'scripts/hooks';
    // Only trigger on feedback rule files
    const relPath = filePath.startsWith(root + '/') ? filePath.slice(root.length + 1) : filePath;
    const fileName = basename(filePath);

    // Match feedback_*.md in either relative or absolute memory paths
    if (!fileName.startsWith('feedback_') || !fileName.endsWith('.md')) {
      process.exit(0);
      return;
    }

    // Must be in a memory-like directory
    const claudeDir = config.conventions?.claudeDirName ?? '.claude';
    if (!relPath.includes(memoryDir) && !relPath.includes('memory/') && !relPath.includes(claudeDir + '/')) {
      process.exit(0);
      return;
    }

    if (!existsSync(filePath)) {
      process.exit(0);
      return;
    }

    if (config.autoLearning?.pipeline?.requireEnforcement === false) {
      process.exit(0);
      return;
    }

    // Extract rule details from the file
    const content = readFileSync(filePath, 'utf-8');
    const nameMatch = content.match(/^name:\s*(.+)/m);
    const descMatch = content.match(/^description:\s*(.+)/m);
    const ruleName = nameMatch?.[1]?.trim() ?? fileName;
    const ruleDesc = descMatch?.[1]?.trim() ?? '';

    // Check if this rule already has enforcement in any hook file
    const enforcementDirAbs = resolve(root, enforcementDir);
    let hasEnforcement = false;
    if (existsSync(enforcementDirAbs)) {
      const hookFiles = readdirSync(enforcementDirAbs).filter(f => f.endsWith('.sh') || f.endsWith('.ts') || f.endsWith('.js'));
      for (const hookFile of hookFiles) {
        try {
          const hookContent = readFileSync(resolve(enforcementDirAbs, hookFile), 'utf-8');
          if (hookContent.includes(fileName)) {
            hasEnforcement = true;
            break;
          }
        } catch { /* ignore read errors */ }
      }
    }

    if (hasEnforcement) {
      // Already has enforcement — no action needed
      process.exit(0);
      return;
    }

    // Output enforcement placement instructions
    const lines: string[] = [];
    lines.push('');
    lines.push('============================================================================');
    lines.push(' AUTO-LEARNING: New Rule Created — Enforcement Placement Required');
    lines.push('============================================================================');
    lines.push('');
    lines.push(`  Rule: ${ruleName}`);
    lines.push(`  File: ${filePath}`);
    if (ruleDesc) {
      lines.push(`  Description: ${ruleDesc}`);
    }
    lines.push('');
    lines.push('  This rule has NO automated enforcement yet. Add it now.');
    lines.push('');
    lines.push('  ANALYZE the rule and determine enforcement layer(s):');
    lines.push('');
    lines.push('  1. STATICALLY DETECTABLE? (grep/regex can find violations in code)');
    lines.push(`     → Add check to: ${enforcementDir}/pattern-feedback hook`);
    lines.push(`     → Also add to pre-commit hook if critical`);
    lines.push('');
    lines.push('  2. ABOUT EDITING CERTAIN FILES? (auth, infra, routers, etc.)');
    lines.push(`     → Add warning to: ${enforcementDir}/blast-radius hook`);
    lines.push('');
    lines.push('  3. ABOUT DANGEROUS COMMANDS? (kill, rm, destructive ops)');
    lines.push(`     → Add block to: ${enforcementDir}/dangerous-command hook`);
    lines.push('');
    lines.push('  4. NEEDS RUNTIME MONITORING? (can only be detected at runtime)');
    lines.push('     → Create a monitoring/audit producer');
    lines.push('');
    lines.push('  5. AI-GUIDANCE ONLY? (philosophy, process, judgment calls)');
    lines.push('     → Memory rule is sufficient (already created)');
    lines.push('');
    lines.push('  AFTER adding enforcement, test the hook to verify it detects violations.');
    lines.push('');
    lines.push('  This step is MANDATORY per the auto-learning pipeline.');
    lines.push('============================================================================');
    lines.push('');

    console.log(lines.join('\n'));
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
