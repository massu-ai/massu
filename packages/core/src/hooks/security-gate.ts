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

const DANGEROUS_BASH_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /rm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(?:\s|$)/, label: 'rm -rf /' },
  { pattern: /rm\s+-[a-z]*f[a-z]*r[a-z]*\s+\/(?:\s|$)/, label: 'rm -rf /' },
  { pattern: /curl\s+.*\|\s*(?:bash|sh|zsh)/, label: 'curl | bash (remote code execution)' },
  { pattern: /wget\s+.*\|\s*(?:bash|sh|zsh)/, label: 'wget | bash (remote code execution)' },
  { pattern: /chmod\s+777/, label: 'chmod 777 (world-writable permissions)' },
  { pattern: /chmod\s+-R\s+777/, label: 'chmod -R 777 (world-writable permissions)' },
  { pattern: />\s*\/etc\/passwd/, label: 'write to /etc/passwd' },
  { pattern: />\s*\/etc\/shadow/, label: 'write to /etc/shadow' },
  { pattern: />\s*\/etc\/sudoers/, label: 'write to /etc/sudoers' },
  { pattern: /dd\s+if=.*of=\/dev\/(?:sda|sdb|hda|hdb|nvme)/, label: 'dd to raw device' },
  { pattern: /mkfs\s+\/dev\//, label: 'format disk device' },
  { pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}/, label: 'fork bomb' },
  { pattern: /eval\s+.*\$\(.*curl/, label: 'eval with remote curl' },
  { pattern: /base64\s+-d\s+.*\|\s*(?:bash|sh|zsh)/, label: 'base64 decoded shell exec' },
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

function checkBashCommand(command: string): string | null {
  for (const { pattern, label } of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return label;
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

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const { tool_name, tool_input } = hookInput;

    if (tool_name === 'Bash' && tool_input.command) {
      const violation = checkBashCommand(tool_input.command);
      if (violation) {
        process.stdout.write(JSON.stringify({
          message: `SECURITY GATE: Dangerous command pattern detected: ${violation}\nCommand: ${tool_input.command.slice(0, 200)}\nReview carefully before proceeding.`,
        }));
      }
    }

    if ((tool_name === 'Write' || tool_name === 'Edit') && tool_input.file_path) {
      const violation = checkFilePath(tool_input.file_path);
      if (violation) {
        process.stdout.write(JSON.stringify({
          message: `SECURITY GATE: Attempt to write to protected file: ${violation}\nPath: ${tool_input.file_path}\nEnsure this is intentional and no secrets will be exposed.`,
        }));
      }
    }

    // Check Python file content for dangerous patterns (Write uses content, Edit uses new_string)
    const pyContent = tool_input.content || tool_input.new_string;
    if ((tool_name === 'Write' || tool_name === 'Edit') && tool_input.file_path?.endsWith('.py') && pyContent) {
      const pyViolation = checkPythonContent(pyContent);
      if (pyViolation) {
        process.stdout.write(JSON.stringify({
          message: `SECURITY GATE: Dangerous Python pattern detected: ${pyViolation}\nFile: ${tool_input.file_path}\nReview carefully before proceeding.`,
        }));
      }
    }
  } catch {
    // Hooks must never crash
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

main();
