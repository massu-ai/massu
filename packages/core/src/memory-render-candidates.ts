/**
 * The renderable source rows — ONE query, shared by the session-start hook and the CLI.
 *
 * Two copies of "which memories are renderable?" is how `--dry-run` ends up showing you
 * something different from what the real render applies, which would break B-13's whole
 * contract (the printed diff MUST equal the applied diff) in the one place the operator
 * relies on it: deciding whether to turn the feature on.
 */
import type Database from 'better-sqlite3';
import type { RenderCandidate } from './memory-renderer.ts';
import { resolveMemoryFilesConfig } from './memory-files-config.ts';

/**
 * D-D (plan-memory-ingestion-decision-noise-fix): the observation types that are genuine
 * durable MEMORIES worth their own file — lessons and knowledge. The rest of the
 * `observations` table is session TELEMETRY: `file_change` (every edit), `vr_check` (every
 * verification), `pattern_compliance` (every scanner run), `feature`/`bugfix`/`refactor`
 * (every commit), `discovery` (low-value). Rendering telemetry would write
 * `vr-type-pass.md` / `tests-fail.md` / `commit-*.md` into the operator's curated corpus —
 * exactly what the WS3 dry-run caught. Importance alone is not a memory-worthiness signal
 * (a passing type-check is importance 5 telemetry); the TYPE is. Single SoT — the query
 * and its drift-guard read this one list.
 */
export const RENDERABLE_MEMORY_TYPES = [
  'decision',
  'failed_attempt',
  'incident_near_miss',
  'cr_violation',
] as const;

/**
 * Memories worth a durable file.
 *
 * `origin` is selected but NOT filtered here on purpose: the B-10 gate lives inside the
 * renderer, where it runs BEFORE any path is computed. Filtering it out here as well would
 * make that gate untestable through the real call path — the drift-guard proves `origin`
 * is refused by inserting a `team` row and asserting 0 bytes, which requires the row to
 * actually REACH the renderer.
 */
export function loadRenderCandidates(db: Database.Database): RenderCandidate[] {
  const cfg = resolveMemoryFilesConfig();

  const typePlaceholders = RENDERABLE_MEMORY_TYPES.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, title, detail, importance, COALESCE(origin, 'local') AS origin
         FROM observations
        WHERE importance >= ?
          AND COALESCE(expired_at_epoch, 0) = 0
          AND type IN (${typePlaceholders})
        ORDER BY importance DESC, created_at_epoch DESC
        LIMIT 50`
    )
    .all(cfg.renderMinImportance, ...RENDERABLE_MEMORY_TYPES) as Array<{
    id: number;
    title: string;
    detail: string | null;
    importance: number;
    origin: string;
  }>;

  return rows
    // A memory Massu ingested FROM a file is not a candidate to be written BACK to one —
    // that is the self-duplicate loop (B-07). The file already exists and is the source.
    .filter((r) => !r.title.startsWith('[memory-file]'))
    .map((r) => ({
      observationId: r.id,
      name: r.title,
      title: r.title,
      body: r.detail ?? '',
      importance: r.importance,
      origin: r.origin,
    }));
}
