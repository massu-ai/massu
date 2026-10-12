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
import { isDirectInvocation } from './lib/is-direct-invocation.ts';

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

/**
 * Does this token NAME A SECRET FILE?
 *
 * ── Occurrence #2 of a class whose memory said a recurrence earns a gate ──────────
 *
 * The judgement used to live as two shell one-liners in `.claude/settings.json`, each
 * matching an extension pattern against the WHOLE Bash command text. That predicate is
 * not the property: it asks "do these characters appear anywhere" when it means "does
 * this command name a file whose name says it holds secrets".
 *
 *   2026-08-12  the pattern had no end anchor, so the key extension matched inside
 *               `Object.keys(` and ordinary commands were refused three times in one
 *               session. Fixed by appending an end anchor — at ONE of the two inline
 *               sites. The staged-file matcher still carries the unanchored form.
 *   2026-09-22  the anchored form still refuses a command mentioning the Node process
 *               environment object, because the dotenv extension followed by a dot
 *               satisfies it. An end anchor does not help when the character after the
 *               extension is legitimately a dot.
 *
 * Both are the same shape: a SUBSTRING test standing in for a PATH test. So test the
 * path — the token's BASENAME — against the one protected list this file already owns.
 * A property access can never match, by construction rather than by an exception list.
 *
 * Template dotenv files are permitted by NAME here, which retires the `sed` pre-pass the
 * inline matchers used to rewrite them out of the command before matching.
 */
const SECRET_BASENAME_EXTENSIONS = ['pem', 'key', 'p12', 'pfx', 'secret'];
const DOTENV_TEMPLATE_SUFFIXES = ['example', 'template', 'sample', 'defaults', 'dist'];
const SECRET_EXACT_BASENAMES = [
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  '.netrc',
  'kubeconfig',
  'credentials.json',
  'secrets.yaml',
  'secrets.yml',
];

/**
 * A bare `credentials` file is only meaningful WITH a directory — the same lesson the
 * dotenv rule above encodes. Path-qualifying it is strictly better than an exact
 * basename: it covers every `<dir>/credentials` (aws, gcloud, anything) instead of the
 * one vendor path that used to be special-cased, and it cannot fire on the bare word.
 *
 * It also keeps `api-key-resolution-drift-guard` honest rather than working around it.
 * That guard forbids a quoted `credentials` segment literal outside `credentials.ts`,
 * because assembling the user credentials path is that module's job alone. This is a
 * path SUFFIX, not a segment the code assembles, and importing the credential reader
 * into a security hook to borrow the name would be a worse dependency than the literal.
 */
const CREDENTIALS_PATH_SUFFIX = '/credentials';

const DOTENV = '.env';

/** A token carrying code punctuation is a program fragment, not a path argument. */
function looksLikeCode(token: string): boolean {
  return /[()[\]{};=`$<>|&*?!"']/.test(token) || /\s/.test(token);
}

export function namesSecretFile(token: string): string | null {
  if (!token || looksLikeCode(token)) return null;
  const clean = token.replace(/[,:.]+$/, '');
  if (!clean) return null;
  const base = clean.split('/').pop() ?? '';
  if (!base) return null;

  if (SECRET_EXACT_BASENAMES.includes(base)) return base;
  if (clean.endsWith('.ssh/config')) return 'SSH config file';
  if (clean.endsWith(CREDENTIALS_PATH_SUFFIX)) return 'credentials file';

  // dotenv: the component must BE the dotenv file, not merely end in those letters.
  if (base === DOTENV) return `${DOTENV} file`;
  if (base.startsWith(`${DOTENV}.`)) {
    const suffix = base.slice(DOTENV.length + 1);
    return DOTENV_TEMPLATE_SUFFIXES.includes(suffix) ? null : `${base} file`;
  }
  if (base.endsWith(DOTENV) && clean.includes('/')) return `${base} file`;

  for (const ext of SECRET_BASENAME_EXTENSIONS) {
    if (base.endsWith(`.${ext}`)) return `${base} file`;
  }
  return null;
}

/**
 * Split a shell command into tokens the way a shell would, to find PATH ARGUMENTS.
 * Quoting is what matters: a quoted program must stay ONE token so its contents are
 * never read as argv — that is what turned prose inside a heredoc into a blocked
 * command on 2026-09-22.
 */
function shellTokens(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Every secret file a Bash command names, by token. Empty when it names none. */
export function secretFilesInCommand(command: string): string[] {
  const hits: string[] = [];
  for (const token of shellTokens(command)) {
    const label = namesSecretFile(token);
    if (label) hits.push(label);
  }
  return hits;
}

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

/**
 * WHERE A PATTERN IS ALLOWED TO MATCH. Added 2026-08-19.
 *
 * ⛔ EVERY PATTERN USED TO MATCH THE RAW TEXT, SO THE GATE READ PROSE AS CODE. Measured in
 * one session: it fired three times, and all three were a comment describing `os.system(...)`
 * or a TEST FIXTURE holding it as a string. None was an `os.system` call. This is the same
 * class as massu's `a-scanner-that-reads-prose-as-code` (twice) and the G29 census predicate
 * that read a wrapped `description` field as a git invocation — a detector must be scoped to
 * what it may judge, and the axis is WHERE THE MATCH LANDS, never the file type.
 *
 *   'code' — the pattern names a CALL, so a mention inside a comment or a string is prose.
 *            Matched against text whose comments are removed and whose string BODIES are
 *            emptied. A real call survives that untouched: `os.system(cmd)` has its name
 *            outside any quotes; only the mention of it disappears.
 *   'raw'  — the pattern is ABOUT string content and must see it. Both SQL rules are this:
 *            `f"...{x}..." ... execute` is a finding precisely because of what is inside the
 *            quotes, so scoping them to 'code' would silently delete them (CR-74 — the fix
 *            must land at the right sites, and blanket-applying it here is a NEW defect).
 */
type PythonPatternScope = 'code' | 'raw';

const DANGEROUS_PYTHON_PATTERNS: Array<{ pattern: RegExp; label: string; scope: PythonPatternScope }> = [
  { pattern: /\beval\s*\(/, label: 'Python eval() — arbitrary code execution', scope: 'code' },
  { pattern: /\bexec\s*\(/, label: 'Python exec() — arbitrary code execution', scope: 'code' },
  { pattern: /\b__import__\s*\(/, label: 'Python __import__() — dynamic import (potential code injection)', scope: 'code' },
  { pattern: /subprocess\.call\([^)]*shell\s*=\s*True/, label: 'subprocess.call(shell=True) — shell injection risk', scope: 'code' },
  { pattern: /subprocess\.Popen\([^)]*shell\s*=\s*True/, label: 'subprocess.Popen(shell=True) — shell injection risk', scope: 'code' },
  { pattern: /os\.system\s*\(/, label: 'os.system() — shell injection risk', scope: 'code' },
  { pattern: /\bf['"].*\{.*\}.*['"].*(?:execute|cursor|query)/, label: 'f-string in SQL — SQL injection risk', scope: 'raw' },
  { pattern: /['"].*%s.*['"].*%.*(?:execute|cursor|query)/, label: 'String formatting in SQL — SQL injection risk', scope: 'raw' },
];

/**
 * Remove Python comments and EMPTY string bodies, keeping every other byte in place.
 *
 * Returns `null` when the input ends inside an unterminated string or the scan cannot be
 * trusted. THAT RETURN IS THE WHOLE SAFETY ARGUMENT: this gate sees `new_string`, an EDIT
 * FRAGMENT, which routinely starts or ends mid-construct. A fragment beginning inside a
 * string would make the lexer read real code as string body and DELETE a genuine finding —
 * a false negative, which is the one direction a security check may never move in. So an
 * untrusted scan falls back to the raw text: noisier, never blinder.
 */
export function stripPythonCommentsAndStringBodies(src: string): string | null {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === '#') {
      // Comment: drop to end of line, keeping the newline so line structure survives.
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const triple = src.startsWith(ch.repeat(3), i);
      const delim = triple ? ch.repeat(3) : ch;
      out += delim;
      i += delim.length;
      let closed = false;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }        // escape: skip the escaped char
        if (src.startsWith(delim, i)) { out += delim; i += delim.length; closed = true; break; }
        // A single-quoted string cannot span a newline; an unterminated one means the
        // fragment is not self-contained and the whole scan is untrustworthy.
        if (!triple && src[i] === '\n') break;
        i++;
      }
      if (!closed) return null;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

function checkPythonContent(content: string): string | null {
  // Computed ONCE, and `null` means "could not be trusted" — never an empty string, which
  // would match nothing and silently clear every 'code' pattern (THE BLIND-GATE LAW).
  const stripped = stripPythonCommentsAndStringBodies(content);
  for (const { pattern, label, scope } of DANGEROUS_PYTHON_PATTERNS) {
    const subject = scope === 'raw' || stripped === null ? content : stripped;
    if (pattern.test(subject)) {
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
    // Secret files a command NAMES. This concern used to live as two shell one-liners in
    // `.claude/settings.json`, judging the command TEXT rather than its path arguments;
    // both are deleted in favour of this, so there is one predicate and one list (Rule
    // 25). The inline copies had already drifted apart — the end-anchor repair of
    // 2026-08-12 landed on one of the two.
    const secretFiles = secretFilesInCommand(tool_input.command);
    if (secretFiles.length > 0) {
      findings.push({
        severity: 'block',
        message:
          `SECURITY GATE: command names a secret file: ${secretFiles.join(', ')}\n` +
          `Command: ${tool_input.command.slice(0, 200)}\n` +
          `BLOCKED. If this file is a template or fixture, name it with a template ` +
          `suffix (.example/.template/.sample) rather than weakening this check.`,
      });
    }

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

// Run main() only when this file IS the process entry point. Written bare,
// `main()` at module scope means IMPORTING this module RUNS the hook: it reads
// stdin, does its work, and exits the host process.
if (isDirectInvocation(import.meta.url)) {
  main();
}
