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

/** The row window this loader reads. Named so the ledger can report the truncation. */
const CANDIDATE_WINDOW = 50;

/** The one post-window exclusion reason. A new one MUST be added to this vocabulary. */
export const EXCLUSION_MEMORY_FILE_REINGEST = 'memory_file_reingest';

/**
 * WHY EVERY DROP IS COUNTED (2026-08-09).
 *
 * This loader used to return a bare array, so the three places it discards rows — the SQL
 * predicate, the `LIMIT`, and the `[memory-file]` filter — were invisible to every caller.
 * The renderer's `refusals` array cannot see them: they happen upstream of it. So
 * `--dry-run` printed `Massu would write 0 file(s)` and no refusals, which is exactly what
 * it prints for an empty corpus, for a crash after the query, and for a genuine break.
 *
 * That cost a HIGH-SEVERITY INCIDENT FOR A DEFECT THAT DID NOT EXIST: on 2026-08-08 the
 * pipeline was correct — all 59 matching rows were `[memory-file]` re-ingestions, properly
 * excluded — and the missing denominator made eighteen days of correct behaviour
 * indistinguishable from a dead capability.
 *
 * The ledger is returned, not logged, so a caller cannot forget to ask for it.
 */
export interface CandidateLedger {
  /** Rows matching type+importance+expiry with NO limit applied — the true population. */
  population: number;
  /** Rows the window actually returned. */
  windowed: number;
  /** population - windowed. Non-zero means the window HID rows. */
  truncatedByWindow: number;
  /** Post-window exclusions, by reason. Never a bare count. */
  excluded: Array<{ reason: string; count: number }>;
  /** What the renderer will actually see. */
  returned: number;
}

export interface CandidateLoad {
  candidates: RenderCandidate[];
  ledger: CandidateLedger;
}

/** Thrown when the ledger does not account for every row in the population. */
export class CandidateAccountingLeak extends Error {}

/**
 * Memories worth a durable file, WITH a full account of everything dropped on the way.
 *
 * `origin` is selected but NOT filtered here on purpose: the B-10 gate lives inside the
 * renderer, where it runs BEFORE any path is computed. Filtering it out here as well would
 * make that gate untestable through the real call path — the drift-guard proves `origin`
 * is refused by inserting a `team` row and asserting 0 bytes, which requires the row to
 * actually REACH the renderer.
 *
 * ⛔ There is deliberately NO sibling `loadRenderCandidatesWithLedger()`. Two functions
 * answering "which memories are renderable?" is precisely how `--dry-run` would come to
 * show something different from what the real render applies — see this file's header.
 */
export function loadRenderCandidates(db: Database.Database): CandidateLoad {
  const cfg = resolveMemoryFilesConfig();

  const typePlaceholders = RENDERABLE_MEMORY_TYPES.map(() => '?').join(', ');
  const WHERE =
    `WHERE importance >= ?
       AND COALESCE(expired_at_epoch, 0) = 0
       AND type IN (${typePlaceholders})`;

  // THE DENOMINATOR. One extra COUNT over the SAME predicate — the only way
  // `truncatedByWindow` can be measured rather than inferred (M1).
  const { population } = db
    .prepare(`SELECT COUNT(*) AS population FROM observations ${WHERE}`)
    .get(cfg.renderMinImportance, ...RENDERABLE_MEMORY_TYPES) as { population: number };

  const rows = db
    .prepare(
      `SELECT id, title, detail, importance, COALESCE(origin, 'local') AS origin
         FROM observations
         ${WHERE}
        ORDER BY importance DESC, created_at_epoch DESC
        LIMIT ${CANDIDATE_WINDOW}`
    )
    .all(cfg.renderMinImportance, ...RENDERABLE_MEMORY_TYPES) as Array<{
    id: number;
    title: string;
    detail: string | null;
    importance: number;
    origin: string;
  }>;

  // A memory Massu ingested FROM a file is not a candidate to be written BACK to one —
  // that is the self-duplicate loop (B-07). The file already exists and is the source.
  const reingest = rows.filter((r) => r.title.startsWith('[memory-file]'));
  const kept = rows.filter((r) => !r.title.startsWith('[memory-file]'));

  const excluded = reingest.length
    ? [{ reason: EXCLUSION_MEMORY_FILE_REINGEST, count: reingest.length }]
    : [];

  const ledger: CandidateLedger = {
    population,
    windowed: rows.length,
    truncatedByWindow: Math.max(0, population - rows.length),
    excluded,
    returned: kept.length,
  };

  // CONSERVATION. Every row in the population lands in exactly one bucket. This holds by
  // construction today; it is asserted so that a SEVENTH drop site added later breaks the
  // build instead of the observability (the whole point of the invariant over a printout).
  const accounted =
    ledger.returned + ledger.truncatedByWindow + excluded.reduce((n, e) => n + e.count, 0);
  if (accounted !== population) {
    throw new CandidateAccountingLeak(
      `candidate ledger does not balance: population=${population} but accounted=${accounted} ` +
        `(returned=${ledger.returned} truncated=${ledger.truncatedByWindow} ` +
        `excluded=${JSON.stringify(excluded)}). A row was dropped without a bucket.`
    );
  }

  return {
    ledger,
    candidates: kept.map((r) => ({
      observationId: r.id,
      name: r.title,
      title: r.title,
      body: r.detail ?? '',
      importance: r.importance,
      origin: r.origin,
    })),
  };
}
