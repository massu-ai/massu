#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// PreToolUse Hook: Security Gate
// Validates tool calls against security policies.
// Checks Bash commands for dangerous patterns and Write/Edit
// tool calls for protected file paths.
// Must complete in <500ms.
// ============================================================

import { writeHookContext, type HookEvent } from './lib/write-hook-message.ts';

/** Registered on PreToolUse. Asserted against `.claude/settings.json` by
 *  `hook-context-delivery-drift-guard.test.ts`, so this constant cannot drift
 *  from the event the hook is actually wired to. */
const HOOK_EVENT: HookEvent = 'PreToolUse';
import { recordHookFailure } from './lib/hook-failure-signal.ts';

// Force module mode for TypeScript (no external deps needed)
export {};

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: {
    command?: string;
    file_path?: string;
    content?: string;
    new_string?: string;
  };
}

/**
 * S-3 (plan-silent-failure-remediation): SEVERITY.
 *
 * Before this, every finding here was advisory. The gate detected `curl | bash`,
 * printed "Review carefully before proceeding", and exited 0 — which, in the
 * PreToolUse protocol, means ALLOW. The command then ran. Verified by execution
 * 2026-07-13: no hook in the entire codebase contained a single non-zero exit.
 * It was a smoke detector with no battery: it named the fire and let it burn.
 *
 * But a blanket "deny everything" would be wrong and unusable — writing a `.env`
 * file or authoring Python that calls `os.system()` are things a developer does on
 * purpose. So findings are CLASSIFIED:
 *
 *   'block' — catastrophic, irreversible, or remote-code-execution. There is no
 *             legitimate reason for an agent to run these inside a session. Exit 2.
 *   'warn'  — risky but legitimate. Advisory message, exit 0, human decides.
 *
 * The severity lives WITH the pattern (one source of truth), so a new pattern
 * cannot be added without someone deciding which class it is.
 */
export type SecuritySeverity = 'block' | 'warn';

export interface SecurityFinding {
  severity: SecuritySeverity;
  message: string;
}

const DANGEROUS_BASH_PATTERNS: Array<{ pattern: RegExp; label: string; severity: SecuritySeverity }> = [
  // BLOCK — destructive and irreversible, or arbitrary remote code execution.
  { pattern: /rm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(?:\s|$)/, label: 'rm -rf /', severity: 'block' },
  { pattern: /rm\s+-[a-z]*f[a-z]*r[a-z]*\s+\/(?:\s|$)/, label: 'rm -rf /', severity: 'block' },
  { pattern: /curl\s+.*\|\s*(?:bash|sh|zsh)/, label: 'curl | bash (remote code execution)', severity: 'block' },
  { pattern: /wget\s+.*\|\s*(?:bash|sh|zsh)/, label: 'wget | bash (remote code execution)', severity: 'block' },
  { pattern: />\s*\/etc\/passwd/, label: 'write to /etc/passwd', severity: 'block' },
  { pattern: />\s*\/etc\/shadow/, label: 'write to /etc/shadow', severity: 'block' },
  { pattern: />\s*\/etc\/sudoers/, label: 'write to /etc/sudoers', severity: 'block' },
  { pattern: /dd\s+if=.*of=\/dev\/(?:sda|sdb|hda|hdb|nvme)/, label: 'dd to raw device', severity: 'block' },
  { pattern: /mkfs\s+\/dev\//, label: 'format disk device', severity: 'block' },
  { pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}/, label: 'fork bomb', severity: 'block' },
  { pattern: /eval\s+.*\$\(.*curl/, label: 'eval with remote curl', severity: 'block' },
  { pattern: /base64\s+-d\s+.*\|\s*(?:bash|sh|zsh)/, label: 'base64 decoded shell exec', severity: 'block' },

  // WARN — bad practice, but has legitimate uses (fixing a broken permission bit,
  // a throwaway container). Blocking these would make the product hostile.
  { pattern: /chmod\s+777/, label: 'chmod 777 (world-writable permissions)', severity: 'warn' },
  { pattern: /chmod\s+-R\s+777/, label: 'chmod -R 777 (world-writable permissions)', severity: 'warn' },
];

const PROTECTED_FILE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\.env$/, label: '.env file' },
  { pattern: /\.env\./, label: '.env.* file' },
  { pattern: /credentials(?:\.json)?$/, label: 'credentials file' },
  { pattern: /\.pem$/, label: '.pem certificate/key file' },
  { pattern: /\.key$/, label: '.key file' },
  { pattern: /\.p12$/, label: '.p12 keystore file' },
  { pattern: /\.pfx$/, label: '.pfx keystore file' },
  { pattern: /id_rsa$/, label: 'RSA private key' },
  { pattern: /id_ed25519$/, label: 'Ed25519 private key' },
  { pattern: /id_ecdsa$/, label: 'ECDSA private key' },
  { pattern: /\.ssh\/config$/, label: 'SSH config file' },
  { pattern: /secrets\.yaml$/, label: 'secrets.yaml file' },
  { pattern: /secrets\.yml$/, label: 'secrets.yml file' },
  { pattern: /\.netrc$/, label: '.netrc credentials file' },
  { pattern: /aws\/credentials$/, label: 'AWS credentials file' },
  { pattern: /kubeconfig$/, label: 'Kubernetes config file' },
];

function checkBashCommand(command: string): { label: string; severity: SecuritySeverity } | null {
  for (const { pattern, label, severity } of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return { label, severity };
    }
  }
  return null;
}

function checkFilePath(filePath: string): string | null {
  for (const { pattern, label } of PROTECTED_FILE_PATTERNS) {
    if (pattern.test(filePath)) {
      return label;
    }
  }
  return null;
}

const DANGEROUS_PYTHON_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\beval\s*\(/, label: 'Python eval() — arbitrary code execution' },
  { pattern: /\bexec\s*\(/, label: 'Python exec() — arbitrary code execution' },
  { pattern: /\b__import__\s*\(/, label: 'Python __import__() — dynamic import (potential code injection)' },
  { pattern: /subprocess\.call\([^)]*shell\s*=\s*True/, label: 'subprocess.call(shell=True) — shell injection risk' },
  { pattern: /subprocess\.Popen\([^)]*shell\s*=\s*True/, label: 'subprocess.Popen(shell=True) — shell injection risk' },
  { pattern: /os\.system\s*\(/, label: 'os.system() — shell injection risk' },
  { pattern: /\bf['"].*\{.*\}.*['"].*(?:execute|cursor|query)/, label: 'f-string in SQL — SQL injection risk' },
  { pattern: /['"].*%s.*['"].*%.*(?:execute|cursor|query)/, label: 'String formatting in SQL — SQL injection risk' },
];

function checkPythonContent(content: string): string | null {
  for (const { pattern, label } of DANGEROUS_PYTHON_PATTERNS) {
    if (pattern.test(content)) {
      return label;
    }
  }
  return null;
}

/**
 * P-E-019 (plan-stage-e-low-info-sweep): pure check function exported so
 * `pre-tool-use-gate.ts` can compose the security-gate + pre-delete-check
 * pair into ONE spawned node process instead of two. Original standalone
 * `main()` below remains for backward-compat (existing hook configs that
 * still invoke `security-gate` directly).
 */
export function runSecurityGateFindings(hookInput: HookInput): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const { tool_name, tool_input } = hookInput;

  // NOTE: NO try/catch here. This function is deliberately allowed to THROW.
  //
  // It used to swallow its own exceptions and `return messages` — so a check that
  // crashed produced an empty finding list, which the caller could not distinguish
  // from "this command is clean". A security check that errors is a check that did
  // NOT run, and "did not run" must never render as "passed". The caller
  // (pre-tool-use-gate) now catches and FAILS CLOSED. See S-3.

  if (tool_name === 'Bash' && tool_input.command) {
    const violation = checkBashCommand(tool_input.command);
    if (violation) {
      findings.push({
        severity: violation.severity,
        message:
          `SECURITY GATE: Dangerous command pattern detected: ${violation.label}\n` +
          `Command: ${tool_input.command.slice(0, 200)}` +
          (violation.severity === 'block'
            ? `\nBLOCKED. This pattern has no legitimate use in an agent session.`
            : `\nReview carefully before proceeding.`),
      });
    }
  }

  if ((tool_name === 'Write' || tool_name === 'Edit') && tool_input.file_path) {
    const violation = checkFilePath(tool_input.file_path);
    if (violation) {
      findings.push({
        severity: 'warn',
        message: `SECURITY GATE: Attempt to write to protected file: ${violation}\nPath: ${tool_input.file_path}\nEnsure this is intentional and no secrets will be exposed.`,
      });
    }
  }

  const pyContent = tool_input.content || tool_input.new_string;
  if ((tool_name === 'Write' || tool_name === 'Edit') && tool_input.file_path?.endsWith('.py') && pyContent) {
    const pyViolation = checkPythonContent(pyContent);
    if (pyViolation) {
      findings.push({
        severity: 'warn',
        message: `SECURITY GATE: Dangerous Python pattern detected: ${pyViolation}\nFile: ${tool_input.file_path}\nReview carefully before proceeding.`,
      });
    }
  }

  return findings;
}

/**
 * Back-compat string API (existing callers / operator-installed standalone hooks).
 * Prefer `runSecurityGateFindings` — it carries the severity that decides allow/deny.
 */
export function runSecurityGateChecks(hookInput: HookInput): string[] {
  return runSecurityGateFindings(hookInput).map((f) => f.message);
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const messages = runSecurityGateChecks(hookInput);
    for (const msg of messages) writeHookContext(HOOK_EVENT, msg);
  } catch (err) {
    // G-2 + S-3: a SECURITY hook that cannot evaluate must not permit.
    // Was: swallow -> exit 0 -> ALLOW. Now: loud + FAIL CLOSED.
    recordHookFailure('security-gate', err);
    process.stderr.write('MASSU SECURITY GATE — BLOCKED (gate could not evaluate this call)\n');
    process.exit(2);
  }
  process.exit(0);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // Timeout to prevent hanging
    setTimeout(() => resolve(data), 400);
  });
}

// Run main() only when invoked as a standalone hook (esbuild bundle entry).
// Importing this module for `runSecurityGateChecks` does NOT trigger main().
if (
  process.argv[1]?.endsWith('security-gate.js') ||
  process.argv[1]?.endsWith('security-gate')
) {
  main();
}
