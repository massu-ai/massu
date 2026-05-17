// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-H033 (plan-stage-c-high-batch / 1.10.8): adapter-pattern tool gating.
 *
 * **Bug class closed**: `tools.ts:102,206,260` (pre-1.10.8) did direct
 * `config.framework.router === 'trpc'` / `config.framework.orm === 'prisma'`
 * comparisons. The adapter pattern exists for repo-detection (Plan 3c —
 * `@massu/adapter-*` packages provide `matches(signals)` + `introspect()`)
 * but does NOT extend to tool-definition gating. Result: adding a new
 * adapter (e.g. `@massu/adapter-fastify`) can't activate or de-activate
 * tools — its tool surface is invisible to the dispatcher until tools.ts
 * is hand-edited.
 *
 * **Structural fix**: every tool-gating decision now goes through this
 * module's `supportsRouter(name)` / `supportsOrm(name)` helpers. The
 * helpers consult BOTH the legacy top-level `framework.router/.orm`
 * field AND the per-language v2 schema `framework.languages.<lang>.router/.orm`
 * entries. Future framework adapters can register support via the
 * registration hooks (deferred to plan-adapter-tool-registration when
 * the first cross-adapter tool ships).
 *
 * **Drift-guard**: `__tests__/framework-supports-no-direct-comparison.test.ts`
 * scans `packages/core/src/**` and asserts zero `config.framework.router ===`
 * or `config.framework.orm ===` literal comparisons outside this module
 * itself.
 *
 * For default installs:
 *   - tRPC repo (router='trpc'): supportsRouter('trpc') → true (preserves
 *     current behavior — trpc_map tool gated on)
 *   - Prisma repo (orm='prisma'): supportsOrm('prisma') → true (schema tool on)
 *   - Custom adapter with router='fastify': supportsRouter('fastify') → true
 *     once the adapter's per-language entry sets framework.languages.typescript.router
 *     OR the legacy field — single check at the gate.
 */

import { getConfig } from '../config.ts';

interface LanguageEntry {
  router?: string;
  orm?: string;
}

function getAllRouterValues(): string[] {
  const config = getConfig();
  const values: string[] = [];
  if (config.framework.router) values.push(config.framework.router);
  const langs = config.framework.languages as Record<string, LanguageEntry> | undefined;
  if (langs) {
    for (const entry of Object.values(langs)) {
      if (entry?.router) values.push(entry.router);
    }
  }
  return values;
}

function getAllOrmValues(): string[] {
  const config = getConfig();
  const values: string[] = [];
  if (config.framework.orm) values.push(config.framework.orm);
  const langs = config.framework.languages as Record<string, LanguageEntry> | undefined;
  if (langs) {
    for (const entry of Object.values(langs)) {
      if (entry?.orm) values.push(entry.orm);
    }
  }
  return values;
}

/**
 * Returns true if any detected language in the config declares this router.
 * Used to gate tool definitions (e.g. trpc_map only when supportsRouter('trpc')).
 */
export function supportsRouter(name: string): boolean {
  return getAllRouterValues().includes(name);
}

/**
 * Returns true if any detected language in the config declares this ORM.
 * Used to gate tool definitions (e.g. schema only when supportsOrm('prisma')).
 */
export function supportsOrm(name: string): boolean {
  return getAllOrmValues().includes(name);
}
