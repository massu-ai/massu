// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// Moved out of hooks/fix-detector.ts on 2026-11-09: classify-failure imported it from there,
// which bundled fix-detector's main() into classify-failure.js, where isDirectInvocation()
// is TRUE (import.meta.url === argv[1] inside a bundle), so fix-detector ran too.

/**
 * Path patterns whose files are pipeline OUTPUT, not subjects of bug-fix classification.
 * Exported so the drift-guard binds to this source of truth and executes these exact
 * patterns — a test that re-implements its subject drifts into agreeing with its bugs.
 */
export const TEST_OR_FIXTURE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(__tests__|__fixtures__|tests?|fixtures?|spec)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)(test_[^/]+|[^/]+_test)\.py$/,
];

export function isTestOrFixturePath(filePath: string): boolean {
  return TEST_OR_FIXTURE_PATH_PATTERNS.some((re) => re.test(filePath));
}
