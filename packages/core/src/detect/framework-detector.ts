// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Framework Detector (P1-002)
 * ============================
 *
 * Takes `PackageManifest[]` from P1-001 and infers each language's web
 * framework, test framework, ORM, and UI library by matching declared
 * dependencies against an inline `DETECTION_RULES` table.
 *
 * The `DETECTION_RULES` table ships as built-ins. Users may ADD extra entries
 * via `massu.config.yaml` under `detection.rules[<language>][<framework>]`
 * (see P2-008). With `detection.disable_builtin: true`, user entries replace
 * built-ins entirely.
 *
 * Usage:
 * ```ts
 * import { detectFrameworks } from './detect/framework-detector.ts';
 * const map = detectFrameworks(manifests, config.detection);
 * map.python // => { framework: 'fastapi', test_framework: 'pytest', orm: 'sqlalchemy', ... }
 * ```
 */

import type { PackageManifest, SupportedLanguage } from './package-detector.ts';

export interface FrameworkInfo {
  /** Inferred framework name (e.g., 'fastapi', 'next', 'actix-web'). */
  framework: string | null;
  /** Framework version if declared in manifest. */
  version: string | null;
  /** Inferred test framework (e.g., 'pytest', 'vitest', 'cargo'). */
  test_framework: string | null;
  /** Inferred ORM. */
  orm: string | null;
  /** Inferred UI library (for TS/JS). */
  ui_library: string | null;
  /** Inferred router (for TS/JS — trpc/graphql/express/fastify). */
  router: string | null;
}

export type FrameworkMap = Partial<Record<SupportedLanguage, FrameworkInfo>>;

type RuleKind = 'framework' | 'test_framework' | 'orm' | 'ui_library' | 'router';

interface DetectionRule {
  language: SupportedLanguage;
  kind: RuleKind;
  /** Lowercase dependency keyword to search (exact match on dep name). */
  keyword: string;
  /** Value set in FrameworkInfo when matched. */
  value: string;
  /** Higher wins; defaults to 0. */
  priority?: number;
}

/**
 * Built-in detection rules. Exported so users (and tests) can inspect.
 * User overrides/additions come from `config.detection.rules`.
 */
export const DETECTION_RULES: DetectionRule[] = [
  // Python frameworks
  { language: 'python', kind: 'framework', keyword: 'fastapi', value: 'fastapi', priority: 10 },
  { language: 'python', kind: 'framework', keyword: 'flask', value: 'flask', priority: 9 },
  { language: 'python', kind: 'framework', keyword: 'django', value: 'django', priority: 9 },
  { language: 'python', kind: 'framework', keyword: 'aiohttp', value: 'aiohttp', priority: 8 },
  { language: 'python', kind: 'framework', keyword: 'sanic', value: 'sanic', priority: 8 },
  { language: 'python', kind: 'framework', keyword: 'starlette', value: 'starlette', priority: 7 },
  // Python test
  { language: 'python', kind: 'test_framework', keyword: 'pytest', value: 'pytest', priority: 10 },
  { language: 'python', kind: 'test_framework', keyword: 'pytest-asyncio', value: 'pytest', priority: 9 },
  // Python ORM
  { language: 'python', kind: 'orm', keyword: 'sqlalchemy', value: 'sqlalchemy', priority: 10 },
  { language: 'python', kind: 'orm', keyword: 'django-orm', value: 'django-orm', priority: 9 },
  { language: 'python', kind: 'orm', keyword: 'peewee', value: 'peewee', priority: 8 },
  { language: 'python', kind: 'orm', keyword: 'tortoise-orm', value: 'tortoise-orm', priority: 8 },

  // TypeScript / JavaScript frameworks
  { language: 'typescript', kind: 'framework', keyword: 'next', value: 'next', priority: 10 },
  { language: 'typescript', kind: 'framework', keyword: '@nestjs/core', value: 'nestjs', priority: 10 },
  { language: 'typescript', kind: 'framework', keyword: 'fastify', value: 'fastify', priority: 9 },
  { language: 'typescript', kind: 'framework', keyword: 'express', value: 'express', priority: 9 },
  { language: 'typescript', kind: 'framework', keyword: 'hono', value: 'hono', priority: 9 },
  { language: 'typescript', kind: 'framework', keyword: '@sveltejs/kit', value: 'sveltekit', priority: 10 },
  { language: 'typescript', kind: 'framework', keyword: 'nuxt', value: 'nuxt', priority: 10 },
  { language: 'typescript', kind: 'framework', keyword: '@angular/core', value: 'angular', priority: 10 },
  { language: 'typescript', kind: 'framework', keyword: 'react', value: 'react', priority: 5 },
  { language: 'typescript', kind: 'framework', keyword: 'vue', value: 'vue', priority: 5 },
  // Mirror for javascript
  { language: 'javascript', kind: 'framework', keyword: 'next', value: 'next', priority: 10 },
  { language: 'javascript', kind: 'framework', keyword: 'express', value: 'express', priority: 9 },
  { language: 'javascript', kind: 'framework', keyword: 'fastify', value: 'fastify', priority: 9 },
  { language: 'javascript', kind: 'framework', keyword: 'react', value: 'react', priority: 5 },
  // TS/JS test
  { language: 'typescript', kind: 'test_framework', keyword: 'vitest', value: 'vitest', priority: 10 },
  { language: 'typescript', kind: 'test_framework', keyword: 'jest', value: 'jest', priority: 9 },
  { language: 'typescript', kind: 'test_framework', keyword: 'mocha', value: 'mocha', priority: 8 },
  { language: 'typescript', kind: 'test_framework', keyword: '@playwright/test', value: 'playwright', priority: 7 },
  { language: 'javascript', kind: 'test_framework', keyword: 'vitest', value: 'vitest', priority: 10 },
  { language: 'javascript', kind: 'test_framework', keyword: 'jest', value: 'jest', priority: 9 },
  { language: 'javascript', kind: 'test_framework', keyword: 'mocha', value: 'mocha', priority: 8 },
  // TS/JS ORM
  { language: 'typescript', kind: 'orm', keyword: '@prisma/client', value: 'prisma', priority: 10 },
  { language: 'typescript', kind: 'orm', keyword: 'prisma', value: 'prisma', priority: 9 },
  { language: 'typescript', kind: 'orm', keyword: 'drizzle-orm', value: 'drizzle', priority: 10 },
  { language: 'typescript', kind: 'orm', keyword: 'typeorm', value: 'typeorm', priority: 9 },
  { language: 'typescript', kind: 'orm', keyword: 'mongoose', value: 'mongoose', priority: 9 },
  { language: 'typescript', kind: 'orm', keyword: 'sequelize', value: 'sequelize', priority: 8 },
  { language: 'javascript', kind: 'orm', keyword: '@prisma/client', value: 'prisma', priority: 10 },
  { language: 'javascript', kind: 'orm', keyword: 'mongoose', value: 'mongoose', priority: 9 },
  // TS/JS UI
  { language: 'typescript', kind: 'ui_library', keyword: 'next', value: 'next', priority: 9 },
  { language: 'typescript', kind: 'ui_library', keyword: 'react', value: 'react', priority: 8 },
  { language: 'typescript', kind: 'ui_library', keyword: 'vue', value: 'vue', priority: 8 },
  { language: 'typescript', kind: 'ui_library', keyword: '@sveltejs/kit', value: 'svelte', priority: 9 },
  { language: 'javascript', kind: 'ui_library', keyword: 'react', value: 'react', priority: 8 },
  // TS/JS router
  { language: 'typescript', kind: 'router', keyword: '@trpc/server', value: 'trpc', priority: 10 },
  { language: 'typescript', kind: 'router', keyword: '@apollo/server', value: 'graphql', priority: 9 },
  { language: 'typescript', kind: 'router', keyword: 'graphql', value: 'graphql', priority: 8 },
  { language: 'typescript', kind: 'router', keyword: 'express', value: 'express', priority: 7 },
  { language: 'typescript', kind: 'router', keyword: 'fastify', value: 'fastify', priority: 7 },
  { language: 'typescript', kind: 'router', keyword: 'hono', value: 'hono', priority: 7 },

  // Rust
  { language: 'rust', kind: 'framework', keyword: 'actix-web', value: 'actix-web', priority: 10 },
  { language: 'rust', kind: 'framework', keyword: 'axum', value: 'axum', priority: 10 },
  { language: 'rust', kind: 'framework', keyword: 'rocket', value: 'rocket', priority: 10 },
  { language: 'rust', kind: 'framework', keyword: 'warp', value: 'warp', priority: 9 },
  { language: 'rust', kind: 'framework', keyword: 'tokio', value: 'tokio', priority: 5 },
  { language: 'rust', kind: 'test_framework', keyword: 'cargo', value: 'cargo', priority: 1 },
  { language: 'rust', kind: 'orm', keyword: 'diesel', value: 'diesel', priority: 10 },
  { language: 'rust', kind: 'orm', keyword: 'sqlx', value: 'sqlx', priority: 10 },
  { language: 'rust', kind: 'orm', keyword: 'sea-orm', value: 'sea-orm', priority: 10 },

  // Go
  { language: 'go', kind: 'framework', keyword: 'github.com/gin-gonic/gin', value: 'gin', priority: 10 },
  { language: 'go', kind: 'framework', keyword: 'github.com/labstack/echo', value: 'echo', priority: 10 },
  { language: 'go', kind: 'framework', keyword: 'github.com/gofiber/fiber', value: 'fiber', priority: 10 },
  { language: 'go', kind: 'framework', keyword: 'github.com/go-chi/chi', value: 'chi', priority: 9 },
  { language: 'go', kind: 'test_framework', keyword: 'github.com/stretchr/testify', value: 'testify', priority: 8 },
  { language: 'go', kind: 'orm', keyword: 'gorm.io/gorm', value: 'gorm', priority: 10 },

  // Swift (SPM dependency names, best-effort)
  { language: 'swift', kind: 'framework', keyword: 'vapor', value: 'vapor', priority: 10 },
  { language: 'swift', kind: 'framework', keyword: 'swift-nio', value: 'swift-nio', priority: 7 },
  { language: 'swift', kind: 'test_framework', keyword: 'xctest', value: 'xctest', priority: 5 },

  // Java
  { language: 'java', kind: 'framework', keyword: 'spring-boot-starter', value: 'spring-boot', priority: 10 },
  { language: 'java', kind: 'framework', keyword: 'spring-boot-starter-web', value: 'spring-boot', priority: 10 },
  { language: 'java', kind: 'test_framework', keyword: 'junit', value: 'junit', priority: 10 },
  { language: 'java', kind: 'test_framework', keyword: 'junit-jupiter', value: 'junit', priority: 10 },

  // Ruby
  { language: 'ruby', kind: 'framework', keyword: 'rails', value: 'rails', priority: 10 },
  { language: 'ruby', kind: 'framework', keyword: 'sinatra', value: 'sinatra', priority: 9 },
  { language: 'ruby', kind: 'test_framework', keyword: 'rspec', value: 'rspec', priority: 10 },
  { language: 'ruby', kind: 'orm', keyword: 'activerecord', value: 'activerecord', priority: 10 },
];

/**
 * User-supplied detection overrides, matching the P2-008 schema shape:
 *   detection.rules[language][framework] = { signals: string[], priority?: number }
 */
export interface UserDetectionRules {
  rules?: Record<
    string,
    Record<string, { signals: string[]; priority?: number }>
  >;
  disable_builtin?: boolean;
}

/**
 * Find the highest-priority rule for a given (language, kind) by scanning
 * dep list case-insensitively.
 */
function matchRule(
  rules: DetectionRule[],
  language: SupportedLanguage,
  kind: RuleKind,
  deps: Set<string>
): { value: string; priority: number } | null {
  let best: { value: string; priority: number } | null = null;
  for (const r of rules) {
    if (r.language !== language) continue;
    if (r.kind !== kind) continue;
    if (!deps.has(r.keyword.toLowerCase())) continue;
    const pr = r.priority ?? 0;
    if (!best || pr > best.priority) {
      best = { value: r.value, priority: pr };
    }
  }
  return best;
}

/**
 * Match user-supplied framework rules (signals) against dep list.
 * Each signal string is treated as a dep keyword (case-insensitive exact match
 * on the dep name). If any signal matches, the framework is a candidate.
 */
function matchUserFrameworkRules(
  userRules: UserDetectionRules['rules'] | undefined,
  language: string,
  deps: Set<string>
): { framework: string; priority: number } | null {
  if (!userRules) return null;
  const byLang = userRules[language];
  if (!byLang) return null;
  let best: { framework: string; priority: number } | null = null;
  for (const [framework, entry] of Object.entries(byLang)) {
    const signals = entry.signals ?? [];
    const priority = entry.priority ?? 100; // user rules outrank built-ins by default
    for (const sig of signals) {
      if (deps.has(sig.toLowerCase())) {
        if (!best || priority > best.priority) {
          best = { framework, priority };
        }
        break;
      }
    }
  }
  return best;
}

/**
 * Detect frameworks/test-frameworks/ORMs per language.
 *
 * @param manifests - output of P1-001 detectPackageManifests
 * @param userDetection - optional massu.config.yaml `detection` block
 */
export function detectFrameworks(
  manifests: PackageManifest[],
  userDetection?: UserDetectionRules
): FrameworkMap {
  // Merge deps across all manifests of the same language (monorepo aggregate).
  const byLang = new Map<SupportedLanguage, { deps: Set<string>; versionOf: Map<string, string> }>();
  for (const m of manifests) {
    const entry = byLang.get(m.language) ?? {
      deps: new Set<string>(),
      versionOf: new Map<string, string>(),
    };
    for (const d of m.dependencies) entry.deps.add(d.toLowerCase());
    for (const d of m.devDependencies) entry.deps.add(d.toLowerCase());
    byLang.set(m.language, entry);
  }

  const rules: DetectionRule[] = userDetection?.disable_builtin
    ? []
    : [...DETECTION_RULES];

  const out: FrameworkMap = {};
  for (const [language, { deps }] of byLang.entries()) {
    const fw = matchRule(rules, language, 'framework', deps);
    const userFw = matchUserFrameworkRules(
      userDetection?.rules,
      language,
      deps
    );
    // Pick user rule when it has higher effective priority.
    let frameworkValue: string | null = null;
    if (userFw && (!fw || userFw.priority > fw.priority)) {
      frameworkValue = userFw.framework;
    } else if (fw) {
      frameworkValue = fw.value;
    }
    const info: FrameworkInfo = {
      framework: frameworkValue,
      version: null,
      test_framework:
        matchRule(rules, language, 'test_framework', deps)?.value ?? null,
      orm: matchRule(rules, language, 'orm', deps)?.value ?? null,
      ui_library:
        matchRule(rules, language, 'ui_library', deps)?.value ?? null,
      router: matchRule(rules, language, 'router', deps)?.value ?? null,
    };
    out[language] = info;
  }

  return out;
}
