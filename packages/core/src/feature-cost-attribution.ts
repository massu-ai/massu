// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Attribute a session's REAL cost to the registered features whose files it touched.
 *
 * `massu_cost_feature` read `feature_costs`, which nothing ever wrote, so it always said "no
 * data". Now each session's priced cost (cost-reprice.ts) is ALLOCATED: every file touch a tool
 * call recorded (`tool_call_details.files_involved`) is one unit; a file that belongs to k
 * registered features (sentinel components) gives each 1/k of its unit; touches of files that
 * belong to no feature go to UNATTRIBUTED_FEATURE, so the rows always sum to the session's cost.
 *
 * This is an ALLOCATION by activity, not a measurement of what each feature consumed: a
 * response's tokens are not tagged with the files it was about. Published tools attribute per
 * commit or by request tags; none does it by files (searched 2026-11-09), so the method is ours
 * and the tool says so in its output. Operator decision 2026-11-09.
 */
import { isAbsolute, relative, resolve } from 'path';
import type Database from 'better-sqlite3';
import { getFeaturesByFile } from './sentinel-db.ts';

export const UNATTRIBUTED_FEATURE = '(no registered feature)';

export interface FeatureAllocation {
  featureKey: string;
  share: number;
  tokens: number;
  costUsd: number;
}

/**
 * Distinct files one session may touch before allocation refuses to guess. A real session
 * touches tens to hundreds; reaching this means the rows are not what they claim to be, and a
 * cost spread over a truncated file list would be a wrong answer that looks right.
 */
export const MAX_SESSION_FILES = 20_000;

/**
 * Touch counts per project-relative file for one session. Counted in SQL, one row per
 * DISTINCT file, so the read is bounded by what the session touched rather than by how many
 * tool calls it made. Throws past MAX_SESSION_FILES instead of truncating.
 */
export function sessionFileTouches(memDb: Database.Database, sessionId: string, projectRoot: string): Map<string, number> {
  const rows = memDb.prepare(
    `SELECT j.value AS file, COUNT(*) AS n
       FROM tool_call_details t, json_each(t.files_involved) j
      WHERE t.session_id = ? AND json_valid(t.files_involved)
        AND json_type(t.files_involved) = 'array' AND j.type = 'text' AND j.value <> ''
      GROUP BY j.value
      LIMIT ?`,
  ).all(sessionId, MAX_SESSION_FILES + 1) as Array<{ file: string; n: number }>;
  if (rows.length > MAX_SESSION_FILES) {
    throw new Error(`session ${sessionId} touched more than ${MAX_SESSION_FILES} distinct files; not allocating a truncated list`);
  }
  const touches = new Map<string, number>();
  for (const { file, n } of rows) {
    const abs = isAbsolute(file) ? file : resolve(projectRoot, file);
    const rel = relative(projectRoot, abs);
    // Outside the project (e.g. a memory file under ~/.claude) is still activity in the
    // session, so it counts toward the total — under UNATTRIBUTED, never toward a feature.
    const key = rel.startsWith('..') || isAbsolute(rel) ? abs : rel;
    touches.set(key, (touches.get(key) ?? 0) + Number(n));
  }
  return touches;
}

export function allocateSessionCost(
  touches: Map<string, number>,
  featuresOf: (file: string) => string[],
  totals: { tokens: number; costUsd: number },
): FeatureAllocation[] {
  const units = new Map<string, number>();
  let all = 0;
  for (const [file, n] of touches) {
    all += n;
    const features = [...new Set(featuresOf(file))];
    if (features.length === 0) {
      units.set(UNATTRIBUTED_FEATURE, (units.get(UNATTRIBUTED_FEATURE) ?? 0) + n);
    } else {
      for (const k of features) units.set(k, (units.get(k) ?? 0) + n / features.length);
    }
  }
  if (all === 0) return [{ featureKey: UNATTRIBUTED_FEATURE, share: 1, tokens: totals.tokens, costUsd: totals.costUsd }];
  return [...units].map(([featureKey, u]) => ({
    featureKey,
    share: u / all,
    tokens: Math.round((totals.tokens * u) / all),
    costUsd: (totals.costUsd * u) / all,
  })).sort((a, b) => b.costUsd - a.costUsd || a.featureKey.localeCompare(b.featureKey));
}

/**
 * Rewrite `feature_costs` for one session from its current cost row. Derived rows, so they are
 * replaced wholesale; a session whose cost is unknown gets none (its cost cannot be split).
 */
export function attributeSessionCost(
  memDb: Database.Database,
  dataDb: Database.Database,
  sessionId: string,
  projectRoot: string,
): FeatureAllocation[] {
  const cost = memDb.prepare(
    `SELECT total_tokens, estimated_cost_usd, cost_status FROM session_costs WHERE session_id = ?`,
  ).get(sessionId) as { total_tokens: number; estimated_cost_usd: number; cost_status: string } | undefined;
  const replace = memDb.transaction((rows: FeatureAllocation[]) => {
    memDb.prepare('DELETE FROM feature_costs WHERE session_id = ?').run(sessionId);
    const ins = memDb.prepare(
      'INSERT INTO feature_costs (feature_key, session_id, tokens_used, estimated_cost_usd) VALUES (?, ?, ?, ?)',
    );
    for (const r of rows) ins.run(r.featureKey, sessionId, r.tokens, r.costUsd);
  });
  if (!cost || cost.cost_status === 'unknown') {
    replace([]);
    return [];
  }
  const touches = sessionFileTouches(memDb, sessionId, projectRoot);
  const featuresOf = (file: string): string[] => {
    const keys = getFeaturesByFile(dataDb, file).map((f) => f.feature_key);
    if (!isAbsolute(file)) keys.push(...getFeaturesByFile(dataDb, resolve(projectRoot, file)).map((f) => f.feature_key));
    return keys;
  };
  const rows = allocateSessionCost(touches, featuresOf, { tokens: cost.total_tokens, costUsd: cost.estimated_cost_usd });
  replace(rows);
  return rows;
}
