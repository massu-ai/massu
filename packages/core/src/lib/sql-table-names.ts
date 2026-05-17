// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-H032 (plan-stage-c-high-batch / 1.10.7): SoT for SQL table names that
 * are prefixed with the customer's configured `toolPrefix`.
 *
 * **Bug class closed**: 20 distinct SQL table names (`massu_imports`,
 * `massu_trpc_procedures`, `massu_sentinel`, etc.) were hardcoded with the
 * `massu_` prefix in ~145 SQL string sites across 21 source files. Tool
 * names were already config-driven via `getConfig().toolPrefix` but
 * persistence wasn't — split-brain where a non-default-prefix customer
 * (e.g. `toolPrefix: 'foo'`) would have tools named `foo_*` but tables
 * still named `massu_*`. Default-prefix customers (100% of current
 * installs) see ZERO behavior change.
 *
 * **Structural fix**: every SQL string that references a prefix-scoped
 * table now goes through `t(suffix)` which returns
 * `\`${getConfig().toolPrefix}_${suffix}\``. The ESLint rule
 * `no-hardcoded-massu-tables` bans bare `'massu_X'` literals so future
 * regressions are impossible. The drift-guard test
 * `sql-table-names-source-grep.test.ts` scans the source tree and asserts
 * zero bare `massu_<table>` literals outside this module + the test files.
 *
 * **20 canonical table suffixes** (registered here as a typed const so
 * typos at callsites are caught at compile time):
 */

import { getConfig } from '../config.ts';

/**
 * The complete set of suffixes for prefix-scoped SQL tables. Keep this in
 * sync with `packages/core/src/db.ts` (CodeGraph schema) +
 * `sentinel-db.ts` (sentinel schema) + Python indexer DDL in
 * `packages/core/src/python/*.ts`.
 */
export type MassuTableSuffix =
  | 'imports'
  | 'meta'
  | 'middleware_tree'
  | 'page_deps'
  | 'py_fk_edges'
  | 'py_imports'
  | 'py_meta'
  | 'py_migrations'
  | 'py_models'
  | 'py_route_callers'
  | 'py_routes'
  | 'sentinel'
  | 'sentinel_changelog'
  | 'sentinel_components'
  | 'sentinel_deps'
  | 'sentinel_fts'
  | 'sentinel_pages'
  | 'sentinel_procedures'
  | 'trpc_call_sites'
  | 'trpc_procedures';

/**
 * Resolve a prefix-scoped table name to its concrete identifier using the
 * current `getConfig().toolPrefix`. For default-prefix installs returns
 * `massu_<suffix>` (current behavior). For custom-prefix installs returns
 * `<customPrefix>_<suffix>`.
 *
 * Use this in EVERY SQL string that references a prefix-scoped table.
 * The ESLint rule bans bare `'massu_X'` literals; the only legitimate
 * exit is this function.
 */
export function t(suffix: MassuTableSuffix): string {
  return `${getConfig().toolPrefix}_${suffix}`;
}
