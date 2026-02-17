// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { resolve, normalize } from 'path';

// ============================================================
// Shared Security Utilities
// ============================================================

/**
 * Ensure a resolved file path stays within the project root.
 * Prevents path traversal attacks via `../../etc/passwd` style inputs.
 *
 * @returns The resolved absolute path if safe
 * @throws Error if the path escapes the project root
 */
export function ensureWithinRoot(filePath: string, projectRoot: string): string {
  const resolvedRoot = resolve(projectRoot);
  const resolvedPath = resolve(resolvedRoot, filePath);
  const normalizedPath = normalize(resolvedPath);
  const normalizedRoot = normalize(resolvedRoot);

  if (!normalizedPath.startsWith(normalizedRoot + '/') && normalizedPath !== normalizedRoot) {
    throw new Error(`Path traversal blocked: "${filePath}" resolves outside project root`);
  }

  return normalizedPath;
}

/**
 * Escape regex special characters in a string.
 * Use when building RegExp from user/config-provided strings.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate that a regex pattern is safe to compile.
 * Rejects patterns likely to cause catastrophic backtracking (ReDoS).
 *
 * Checks:
 * 1. Pattern length limit (prevents memory exhaustion)
 * 2. Nested quantifiers (e.g., `(a+)+`, `(a*)*`, `(a+)*`)
 * 3. Tries compilation with a timeout guard
 *
 * @returns The compiled RegExp if safe, or null if rejected
 */
export function safeRegex(pattern: string, flags?: string): RegExp | null {
  // Length guard
  if (pattern.length > 500) return null;

  // Detect nested quantifiers - the primary cause of ReDoS
  // Matches patterns like (X+)+, (X*)+, (X+)*, (X{n,})+, etc.
  if (/(\([^)]*[+*}][^)]*\))[+*{]/.test(pattern)) return null;

  // Detect alternation with overlapping repetition: (a|a)+
  // This is harder to detect perfectly, so we use a conservative heuristic
  if (/\([^)]*\|[^)]*\)[+*]{1,2}/.test(pattern) && pattern.length > 100) return null;

  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Convert a glob pattern to a safe regex.
 * Unlike naive star-replacement, this escapes all other special chars
 * first and uses non-greedy matching to prevent backtracking.
 */
export function globToSafeRegex(glob: string): RegExp {
  // Escape everything except * and **
  const escaped = glob
    .split('**')
    .map(segment =>
      segment
        .split('*')
        .map(part => escapeRegex(part))
        .join('[^/]*')
    )
    .join('.*');

  return new RegExp(`^${escaped}$`);
}

/**
 * Redact sensitive patterns from text before storage.
 * Replaces URLs, email addresses, API keys, tokens, and file paths
 * with redaction placeholders.
 */
export function redactSensitiveContent(text: string): string {
  return text
    // API keys / tokens (sk-..., ghp_..., xoxb-..., etc.)
    .replace(/\b(sk-|ghp_|gho_|xoxb-|xoxp-|AKIA)[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_KEY]')
    // Bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, 'Bearer [REDACTED_TOKEN]')
    // Connection strings with passwords (must run BEFORE email to avoid partial match)
    .replace(/:\/\/[^:]+:[^@\s]+@/g, '://[REDACTED_CREDENTIALS]@')
    // URLs with auth tokens in query params
    .replace(/(https?:\/\/[^\s]+[?&](?:token|key|secret|password|auth)=)[^\s&]*/gi, '$1[REDACTED]')
    // Email addresses
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    // Absolute file paths (preserve relative)
    .replace(/(?:\/Users\/|\/home\/|C:\\Users\\)[^\s"'`]+/g, '[REDACTED_PATH]');
}

/** Minimum severity weight floors to prevent disabling security scoring via config. */
export const MINIMUM_SEVERITY_WEIGHTS: Record<string, number> = {
  critical: 10,
  high: 5,
  medium: 2,
  low: 1,
};

/**
 * Merge config severity weights with minimum floors.
 * Prevents configs from zeroing out severity weights to disable scoring.
 */
export function enforceSeverityFloors(
  configWeights: Record<string, number>,
  defaults: Record<string, number>
): Record<string, number> {
  const result: Record<string, number> = { ...defaults };

  for (const [severity, configValue] of Object.entries(configWeights)) {
    const floor = MINIMUM_SEVERITY_WEIGHTS[severity] ?? 1;
    result[severity] = Math.max(configValue, floor);
  }

  return result;
}
