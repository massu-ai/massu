// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { getConfig } from './config.ts';

export interface PatternRule {
  /** Glob pattern to match file paths against */
  match: string;
  /** List of rules that apply to matched files */
  rules: string[];
  /** Severity: CRITICAL rules are schema mismatches or Edge Runtime violations */
  severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  /** Pattern file to reference for details */
  patternFile?: string;
}

/**
 * Get pattern rules from config.
 * Converts the config format (pattern/rules) to the internal PatternRule format.
 */
function getPatternRules(): PatternRule[] {
  return getConfig().rules.map((r) => ({
    match: r.pattern,
    rules: r.rules,
  }));
}

/**
 * Match a file path against all pattern rules and return applicable rules.
 */
export function matchRules(filePath: string): PatternRule[] {
  const normalized = filePath.replace(/\\/g, '/');
  const rules = getPatternRules();
  return rules.filter((rule) => globMatch(normalized, rule.match));
}

/**
 * Simple glob matching for pattern rules.
 * Supports **, *, and ? wildcards.
 */
export function globMatch(filePath: string, pattern: string): boolean {
  // Convert glob to regex using placeholders to avoid replacement conflicts
  let regexStr = pattern
    .replace(/\*\*\//g, '\0GLOBSTARSLASH\0')  // **/ placeholder
    .replace(/\*\*/g, '\0GLOBSTAR\0')          // ** placeholder
    .replace(/\*/g, '\0STAR\0')                // * placeholder
    .replace(/\?/g, '\0QUESTION\0')            // ? placeholder
    .replace(/\./g, '\\.')                      // escape dots
    .replace(/\0GLOBSTARSLASH\0/g, '(?:.*/)?') // **/ = zero or more directories
    .replace(/\0GLOBSTAR\0/g, '.*')            // ** = anything
    .replace(/\0STAR\0/g, '[^/]*')             // * = non-slash chars
    .replace(/\0QUESTION\0/g, '.');            // ? = single char

  // Anchor pattern
  const regex = new RegExp(`(^|/)${regexStr}($|/)`);
  return regex.test(filePath);
}
