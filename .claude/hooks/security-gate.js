#!/usr/bin/env node
import{createRequire as __cr}from"module";const require=__cr(import.meta.url);

// src/hooks/security-gate.ts
var DANGEROUS_BASH_PATTERNS = [
  { pattern: /rm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(?:\s|$)/, label: "rm -rf /" },
  { pattern: /rm\s+-[a-z]*f[a-z]*r[a-z]*\s+\/(?:\s|$)/, label: "rm -rf /" },
  { pattern: /curl\s+.*\|\s*(?:bash|sh|zsh)/, label: "curl | bash (remote code execution)" },
  { pattern: /wget\s+.*\|\s*(?:bash|sh|zsh)/, label: "wget | bash (remote code execution)" },
  { pattern: /chmod\s+777/, label: "chmod 777 (world-writable permissions)" },
  { pattern: /chmod\s+-R\s+777/, label: "chmod -R 777 (world-writable permissions)" },
  { pattern: />\s*\/etc\/passwd/, label: "write to /etc/passwd" },
  { pattern: />\s*\/etc\/shadow/, label: "write to /etc/shadow" },
  { pattern: />\s*\/etc\/sudoers/, label: "write to /etc/sudoers" },
  { pattern: /dd\s+if=.*of=\/dev\/(?:sda|sdb|hda|hdb|nvme)/, label: "dd to raw device" },
  { pattern: /mkfs\s+\/dev\//, label: "format disk device" },
  { pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}/, label: "fork bomb" },
  { pattern: /eval\s+.*\$\(.*curl/, label: "eval with remote curl" },
  { pattern: /base64\s+-d\s+.*\|\s*(?:bash|sh|zsh)/, label: "base64 decoded shell exec" }
];
var PROTECTED_FILE_PATTERNS = [
  { pattern: /\.env$/, label: ".env file" },
  { pattern: /\.env\./, label: ".env.* file" },
  { pattern: /credentials(?:\.json)?$/, label: "credentials file" },
  { pattern: /\.pem$/, label: ".pem certificate/key file" },
  { pattern: /\.key$/, label: ".key file" },
  { pattern: /\.p12$/, label: ".p12 keystore file" },
  { pattern: /\.pfx$/, label: ".pfx keystore file" },
  { pattern: /id_rsa$/, label: "RSA private key" },
  { pattern: /id_ed25519$/, label: "Ed25519 private key" },
  { pattern: /id_ecdsa$/, label: "ECDSA private key" },
  { pattern: /\.ssh\/config$/, label: "SSH config file" },
  { pattern: /secrets\.yaml$/, label: "secrets.yaml file" },
  { pattern: /secrets\.yml$/, label: "secrets.yml file" },
  { pattern: /\.netrc$/, label: ".netrc credentials file" },
  { pattern: /aws\/credentials$/, label: "AWS credentials file" },
  { pattern: /kubeconfig$/, label: "Kubernetes config file" }
];
function checkBashCommand(command) {
  for (const { pattern, label } of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return label;
    }
  }
  return null;
}
function checkFilePath(filePath) {
  for (const { pattern, label } of PROTECTED_FILE_PATTERNS) {
    if (pattern.test(filePath)) {
      return label;
    }
  }
  return null;
}
async function main() {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input);
    const { tool_name, tool_input } = hookInput;
    if (tool_name === "Bash" && tool_input.command) {
      const violation = checkBashCommand(tool_input.command);
      if (violation) {
        process.stdout.write(JSON.stringify({
          message: `SECURITY GATE: Dangerous command pattern detected: ${violation}
Command: ${tool_input.command.slice(0, 200)}
Review carefully before proceeding.`
        }));
      }
    }
    if ((tool_name === "Write" || tool_name === "Edit") && tool_input.file_path) {
      const violation = checkFilePath(tool_input.file_path);
      if (violation) {
        process.stdout.write(JSON.stringify({
          message: `SECURITY GATE: Attempt to write to protected file: ${violation}
Path: ${tool_input.file_path}
Ensure this is intentional and no secrets will be exposed.`
        }));
      }
    }
  } catch {
  }
  process.exit(0);
}
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 400);
  });
}
main();
