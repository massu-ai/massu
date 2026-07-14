/**
 * 4B — THE RENDERER. The first time in Massu's history that it WRITES a memory file.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE BLAST RADIUS
 * ═══════════════════════════════════════════════════════════════════════════════
 * ~73 irreplaceable hand-written memory files, including the operator's standing Laws.
 * `MEMORY.md` is auto-loaded by the harness into EVERY session as trusted instructions.
 * The memory directory is git-tracked and PUSHED. Slice 3 already wrote a live API-key
 * fragment into durable memory once.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE FOUR LAWS THIS FILE MAY NOT BREAK
 * ═══════════════════════════════════════════════════════════════════════════════
 * 1. The file on disk is the human's standing assertion that the memory is LIVE.
 * 2. Massu NEVER hard-deletes a memory.
 * 3. A human edit ALWAYS beats a machine render. Massu may create/update ONLY files it
 *    can PROVE it wrote.
 * 4. Absence of evidence is not evidence of absence. A missing memory dir is a NO-OP.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE GATE ORDER IS LOAD-BEARING — every refusal costs ZERO side effects
 * ═══════════════════════════════════════════════════════════════════════════════
 * Each gate runs BEFORE anything it could make pointless. A gate that fires after a
 * path is computed, a credential minted, a snapshot taken or a backup written is a gate
 * that has already had an effect on the operator's disk.
 *
 *   1. renderEnabled            (B-12) — the default is FALSE. First statement. No I/O.
 *   2. memory dir exists        (B-17) — the MAJORITY user has none. Inert, not error.
 *   3. lock                     (B-08) — 2s then SKIP. Never blocks session start.
 *   4. tombstone ledger legible (B-04) — a deletion we cannot read is one we will undo.
 *   5. per-source: origin       (B-10) — on the SOURCE row, before any path.
 *   6. per-source: tombstoned   (B-04) — before any path.
 *   7. per-source: secret scan  (B-06) — refuse, never redact-and-write.
 *   8. per-source: path         (B-02) — contained, slugged, collision-safe.
 *   9. per-source: authorship   (B-01) — the file on disk is HUMAN unless PROVEN ours.
 *  10. fresh backup             (B-11) — freshness, not existence. Only now, if we will write.
 *  11. snapshot → write → verify(B-03/B-05) — any throw ⇒ restore + abort.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { atomicWriteFileSync } from './lib/safe-write.ts';
import { takeSnapshots, restoreSnapshots } from './rule-candidate-snapshot.ts';
import { mintAuthorship, verifyAuthorship, extractRenderMac, RENDER_MAC_KEY } from './memory-authorship.ts';
import { computeRenderPath, relPathOwnerLookup, RenderPathRefused } from './memory-render-path.ts';
import { isTombstoned, readTombstones } from './memory-tombstones.ts';
import { containsSecret } from './memory-llm.ts';
import { hasFreshBackup, takeBackup, BackupError } from './memory-backup.ts';
import {
  withMemoryIndexLock,
  readMemoryIndex,
  renderRegion,
  writeMemoryIndex,
  readRegionLines,
  RegionRefused,
  MemoryIndexLockBusy,
} from './memory-index-region.ts';
import {
  resolveMemoryFilesConfig,
  type MemoryFilesConfig,
} from './memory-files-config.ts';
import { readMemoryFileFrontmatter } from './memory-file-ingest.ts';

export interface RenderCandidate {
  observationId: number;
  name: string;
  title: string;
  body: string;
  importance: number;
  /** B-10: the SOURCE row's provenance. Anything but 'local' is refused. */
  origin: string;
}

export interface Refusal {
  name: string;
  reason: string;
  /** Never the matched text — for a secret refusal this is the PATTERN name only. */
  detail?: string;
}

export interface RenderResult {
  enabled: boolean;
  dryRun: boolean;
  written: string[];
  refusals: Refusal[];
  indexLines: string[];
  /** Bytes actually written. A dry run MUST report 0. */
  bytesWritten: number;
  skippedReason?: string;
}

const EMPTY = (reason: string): RenderResult => ({
  enabled: false,
  dryRun: false,
  written: [],
  refusals: [],
  indexLines: [],
  bytesWritten: 0,
  skippedReason: reason,
});

export interface RenderOptions {
  memoryDir: string;
  /** MEMORY.md. Massu NEVER creates it (B-17) — the applier already refuses to. */
  indexPath?: string;
  dryRun?: boolean;
  now?: number;
  home?: string;
  config?: MemoryFilesConfig;
  /** Injected for tests; defaults to the real audit writer. */
  audit?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * THE ONE CHOKEPOINT. No other module may write a memory file (drift-guarded).
 */
export function renderMemoryFiles(
  db: Database.Database,
  candidates: readonly RenderCandidate[],
  opts: RenderOptions
): RenderResult {
  // ── GATE 1 (B-12) ─────────────────────────────────────────────────────────────
  // renderEnabled defaults to FALSE and this is the FIRST statement in the function.
  // Not a preference — a law. A brand-new capability that writes into the user's memory
  // directory may never auto-enable. Zero side effects on refusal: no path resolved, no
  // credential minted, no snapshot, no backup, no I/O of any kind.
  const config = opts.config ?? resolveMemoryFilesConfig();
  if (!config.renderEnabled) {
    return EMPTY('render_disabled');
  }

  const dryRun = opts.dryRun === true;
  const now = opts.now ?? Date.now();
  const home = opts.home ?? homedir();
  const audit = opts.audit ?? (() => {});
  const { memoryDir } = opts;

  // ── GATE 2 (B-17) ─────────────────────────────────────────────────────────────
  // The MAJORITY user is a fresh `npx @massu/core` install with no memory directory at
  // all. Inert: no error, no mkdir, no write. Directory creation belongs to `massu init`,
  // never to a hook. (Law 4: absence of evidence is not evidence of absence.)
  if (!existsSync(memoryDir)) {
    return EMPTY('no_memory_dir');
  }

  // ── GATE 3 (B-08) ─────────────────────────────────────────────────────────────
  // The renderer runs in the session-start subprocess; the applier runs in the MCP
  // server. An in-process mutex cannot help. Lock unavailable ⇒ SKIP, write 0 bytes,
  // NEVER block session start, NEVER throw out of the hook.
  try {
    return withMemoryIndexLock(memoryDir, () =>
      renderLocked(db, candidates, { ...opts, dryRun, now, home, config, audit })
    );
  } catch (err) {
    if (err instanceof MemoryIndexLockBusy) {
      return EMPTY('lock_busy');
    }
    // Any other escape is still not allowed to crash session start. Refuse and log.
    audit('memory_file_render_refused', { reason: 'unexpected_error', error: String(err) });
    return EMPTY('error');
  }
}

interface LockedOpts extends RenderOptions {
  dryRun: boolean;
  now: number;
  home: string;
  config: MemoryFilesConfig;
  audit: (event: string, detail: Record<string, unknown>) => void;
}

function renderLocked(
  db: Database.Database,
  candidates: readonly RenderCandidate[],
  o: LockedOpts
): RenderResult {
  const { memoryDir, dryRun, now, home, config, audit } = o;
  const refusals: Refusal[] = [];

  // ── GATE 4 (B-04) ─────────────────────────────────────────────────────────────
  // A deletion we cannot READ is a deletion we will UNDO. If the ledger is unreadable we
  // do not know what the operator deleted, so we render nothing at all this session.
  let tombstones: ReturnType<typeof readTombstones>;
  try {
    tombstones = readTombstones(memoryDir);
  } catch {
    return EMPTY('tombstone_ledger_unreadable');
  }

  const ownerOf = relPathOwnerLookup(db);
  const planned: Array<{ c: RenderCandidate; relPath: string; absPath: string; content: string }> =
    [];

  for (const c of candidates) {
    // ── GATE 5 (B-10) — ON THE SOURCE ROW, BEFORE ANY PATH IS COMPUTED ───────────
    // The draft put `origin` on `memory_files` — the OUTPUT projection, where a row
    // exists only for a file ALREADY rendered. A memory synced from another repo
    // (Slice 5) arrives as an `observations` row with NO memory_files row, so a gate
    // reading the projection would check a row that does not exist and NEVER FIRE.
    // Unknown / NULL origin ⇒ refuse (fail-closed).
    if (c.origin !== 'local') {
      refusals.push({ name: c.name, reason: 'non_local_origin', detail: c.origin || 'unknown' });
      audit('memory_file_render_refused', { name: c.name, reason: 'non_local_origin' });
      continue;
    }

    if (c.importance < config.renderMinImportance) {
      refusals.push({ name: c.name, reason: 'below_min_importance' });
      continue;
    }

    // ── GATE 7 (B-06) — FAIL-CLOSED SECRET SCAN ─────────────────────────────────
    // Refuse; NEVER redact-and-write. The memory dir is git-tracked and pushed.
    let scan: ReturnType<typeof containsSecret>;
    try {
      scan = containsSecret(c.body);
    } catch {
      scan = { matched: true, patternName: 'SCANNER_ERROR' }; // scanner error ⇒ treat as MATCHED
    }
    if (scan.matched) {
      // The refusal names the PATTERN, never the matched text — the audit row and the
      // --dry-run output must not become new places the secret is recorded.
      refusals.push({ name: c.name, reason: 'secret_detected', detail: scan.patternName });
      audit('memory_file_render_refused', {
        name: c.name,
        reason: 'secret_detected',
        pattern: scan.patternName,
      });
      continue;
    }

    // ── GATE 8 (B-02) — the contained, slugged, collision-safe path ──────────────
    let relPath: string;
    let absPath: string;
    try {
      const p = computeRenderPath(memoryDir, c, ownerOf);
      relPath = p.relPath;
      absPath = p.absPath;
    } catch (err) {
      const reason = err instanceof RenderPathRefused ? err.reason : 'path_error';
      refusals.push({ name: c.name, reason, detail: (err as Error).message });
      audit('memory_file_render_refused', { name: c.name, reason });
      continue;
    }

    // ── GATE 6 (B-04) — tombstoned? BEFORE we write anything. ────────────────────
    if (tombstones.has(relPath.toLowerCase()) || isTombstoned(memoryDir, relPath)) {
      refusals.push({ name: c.name, reason: 'tombstoned' });
      continue;
    }

    // ── GATE 9 (B-01) — THE FILE ON DISK IS HUMAN UNLESS WE CAN PROVE IT IS OURS ──
    if (existsSync(absPath)) {
      const existing = readFileSync(absPath, 'utf8');
      const fm = readMemoryFileFrontmatter(existing);
      const storeRow = db
        .prepare(
          `SELECT massu_authored, massu_render_mac, adopted_human_at_epoch
             FROM memory_files WHERE rel_path = ? COLLATE NOCASE`
        )
        .get(relPath) as
        | { massu_authored: number; massu_render_mac: string | null; adopted_human_at_epoch: number | null }
        | undefined;

      const body = stripFrontmatter(existing);
      const ours = verifyAuthorship(body, fm, storeRow ?? null, home);
      if (!ours) {
        // A human edit ALWAYS beats a machine render. This is the single most important
        // refusal in the entire slice.
        refusals.push({ name: c.name, reason: 'human_authored' });
        audit('memory_file_render_refused', { name: c.name, rel_path: relPath, reason: 'human_authored' });
        continue;
      }

      // Idempotence (B-07): if the bytes we would write are the bytes already there,
      // write nothing. This is what makes the cycle reach a FIXED POINT, and it is keyed
      // on the CONTENT read inside the lock — never on a DB flag.
      const next = composeFile(c, home);
      if (next !== null && next === existing) continue;
    }

    const content = composeFile(c, home);
    if (content === null) {
      // No key could be established ⇒ we cannot mint a durable credential ⇒ a file we
      // write now would be classified HUMAN next session and disowned forever. Refuse.
      refusals.push({ name: c.name, reason: 'no_render_key' });
      continue;
    }

    planned.push({ c, relPath, absPath, content });
    if (planned.length >= config.renderMaxFilesPerSession) break;
  }

  // The index lines Massu would maintain, one per rendered file.
  const indexLines = buildIndexLines(db, memoryDir, planned, config);

  // ── DRY RUN (B-13) — writes ZERO BYTES. Asserted, not asserted-about. ──────────
  if (dryRun) {
    return {
      enabled: true,
      dryRun: true,
      written: planned.map((p) => p.relPath),
      refusals,
      indexLines,
      bytesWritten: 0,
    };
  }

  if (planned.length === 0 && indexLines.length === 0) {
    return { enabled: true, dryRun: false, written: [], refusals, indexLines: [], bytesWritten: 0 };
  }

  // ── GATE 10 (B-11) — a FRESH backup, taken only now that we know we will write ──
  if (!hasFreshBackup(memoryDir, home)) {
    try {
      takeBackup(memoryDir, now, home);
    } catch (err) {
      // Cannot back up ⇒ REFUSE TO RENDER. Never block session start.
      audit('memory_file_render_refused', {
        reason: 'backup_failed',
        error: err instanceof BackupError ? err.message : String(err),
      });
      return EMPTY('backup_failed');
    }
  }

  // ── GATE 11 (B-03) — the FULL snapshot/rollback harness ────────────────────────
  // NOT just `appendMemoryIndexLine` — that helper is a bare read→write with none of
  // these properties. The snapshot, the transaction, and the refuse-to-create live here.
  const indexPath = o.indexPath ?? join(memoryDir, 'MEMORY.md');
  const targets = [...planned.map((p) => p.absPath), indexPath];
  const snapshot = takeSnapshots(targets);

  let bytesWritten = 0;
  const written: string[] = [];

  try {
    db.exec('BEGIN');

    for (const p of planned) {
      atomicWriteFileSync(p.absPath, p.content);
      bytesWritten += Buffer.byteLength(p.content, 'utf8');
      written.push(p.relPath);

      // B-07 SELF-DISOWN: persist the credential in the SAME transaction as the write.
      // The renderer writes via `fs`, so the post-tool-use trigger does not fire — and
      // without this row, next session "credential unknown ⇒ the human edited it" would
      // make Massu classify its OWN render as a human edit and permanently disown it.
      //
      // B-07 SELF-DUPLICATE: RE-POINT to the existing source row; never create a second
      // `[memory-file]` observation for a memory Massu itself rendered, or the pair
      // would fight each other in dedupe.
      const mac = extractMac(p.content);
      db.prepare(
        `INSERT INTO memory_files
           (rel_path, name, raw, body, content_hash, massu_authored, massu_render_mac,
            observation_id, origin)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'local')
         ON CONFLICT(rel_path) DO UPDATE SET
           raw = excluded.raw,
           body = excluded.body,
           content_hash = excluded.content_hash,
           massu_authored = 1,
           massu_render_mac = excluded.massu_render_mac,
           observation_id = excluded.observation_id`
      ).run(
        p.relPath,
        p.c.name,
        p.content,
        stripFrontmatter(p.content),
        sha256(p.content),
        mac,
        p.c.observationId
      );

      audit('memory_file_rendered', { name: p.c.name, rel_path: p.relPath });
    }

    // ── B-05 — the MEMORY.md managed region ─────────────────────────────────────
    // NEVER create MEMORY.md (B-17). A damaged sentinel pair writes ZERO bytes and the
    // files still render — the pointer is recoverable, the prose is not.
    const pre = readMemoryIndex(indexPath);
    if (pre !== undefined && indexLines.length > 0) {
      try {
        const post = renderRegion(pre, indexLines);
        if (post !== pre) {
          writeMemoryIndex(indexPath, pre, post); // asserts the post-write invariant
          bytesWritten += Buffer.byteLength(post, 'utf8') - Buffer.byteLength(pre, 'utf8');
        }
      } catch (err) {
        if (err instanceof RegionRefused) {
          // The files are written; only the INDEX is skipped. Recoverable.
          refusals.push({ name: 'MEMORY.md', reason: err.reason, detail: err.message });
          audit('memory_file_render_refused', { name: 'MEMORY.md', reason: err.reason });
        } else {
          throw err;
        }
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the transaction may already be closed */
    }
    const restored = restoreSnapshots(snapshot);
    if (restored.errors.length > 0) {
      // A PARTIALLY-RESTORED corpus must never be written to again by this process.
      audit('memory_file_render_refused', {
        reason: 'rollback_incomplete',
        errors: restored.errors,
      });
      return {
        ...EMPTY('rollback_incomplete'),
        enabled: true,
        refusals: [
          ...refusals,
          { name: '(corpus)', reason: 'rollback_incomplete', detail: restored.errors.join('; ') },
        ],
      };
    }
    audit('memory_file_render_refused', { reason: 'write_failed', error: String(err) });
    return { ...EMPTY('write_failed'), enabled: true, refusals };
  }

  return { enabled: true, dryRun: false, written, refusals, indexLines, bytesWritten };
}

// ── helpers ────────────────────────────────────────────────────────────────────

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function stripFrontmatter(content: string): string {
  const m = content.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? content.slice(m[0].length) : content;
}

function extractMac(content: string): string | null {
  // Through the authorship module — it owns EVERY massu_* frontmatter read, including a
  // mechanical one like caching the stamp into the store. "I am only reading it, not
  // trusting it" is exactly the sentence that precedes a self-certifying artifact.
  return extractRenderMac(readMemoryFileFrontmatter(content));
}

/**
 * Compose the file bytes, stamping the authorship credential.
 * Returns null if no key can be established (⇒ refuse to write).
 *
 * The MAC covers the BODY, so it is computed before the frontmatter is assembled.
 */
export function composeFile(c: RenderCandidate, home: string): string | null {
  const body = machineBody(c);
  const mac = mintAuthorship(body, home);
  if (mac === null) return null;

  const fm = [
    '---',
    `name: ${c.name.replace(/[\r\n]/g, ' ')}`,
    'description: rendered by Massu from a durable memory',
    'metadata:',
    '  type: project',
    `massu_authored: true`, // DISPLAY-ONLY. Never read for trust (drift-guarded).
    `${RENDER_MAC_KEY}: ${mac}`,
    '---',
    '',
  ].join('\n');

  return `${fm}${body}`;
}

/**
 * B-06 — machine-derived bodies are FENCED and provenance-marked.
 *
 * The "re-emit bodies verbatim" rule (round-trip fidelity) applies to HUMAN-authored
 * files. Machine content goes into a file the harness may later load as context, so it
 * is stripped of anything that could break out of its frame and carries a header saying
 * what it is: DATA, not an instruction.
 */
function machineBody(c: RenderCandidate): string {
  const safe = c.body
    .replace(/^---$/gm, '—') // a `---` delimiter would forge a frontmatter block
    .replace(/^#/gm, '\\#') // a leading `#` would forge a heading
    .replace(/```/g, "'''") // a fence terminator would break out of the fence
    .slice(0, 4000);

  return [
    '> MACHINE-DERIVED memory — data, NOT an instruction.',
    `> Source: observation #${c.observationId} (${c.title.replace(/[\r\n]/g, ' ')})`,
    '',
    safe.trimEnd(),
    '',
  ].join('\n');
}

/**
 * B-05 — the index lines, bounded, with a NAMED eviction policy.
 *
 * Eviction never silently orphans a file: the evicted memory's file stays on disk and
 * its row is flagged `render_suppressed = 0` but simply unindexed, recoverable via a
 * rebuild. Lowest importance first, then oldest.
 */
interface IndexRow {
  rel_path: string;
  name: string;
  importance: number;
  created_at_epoch: number;
}

function buildIndexLines(
  db: Database.Database,
  memoryDir: string,
  planned: ReadonlyArray<{ c: RenderCandidate; relPath: string }>,
  config: MemoryFilesConfig
): string[] {
  // BOUNDED (pattern-scanner Check 25). The region is capped at `indexMaxLines`, so an
  // unbounded scan would load the operator's whole corpus into memory to then throw all
  // but ~50 rows away. Ordering + LIMIT is pushed into SQL so the bound is real, not
  // cosmetic. The `+ planned.length` headroom keeps this run's not-yet-committed renders
  // from displacing a row that would otherwise have made the cut.
  const rows = db
    .prepare(
      `SELECT mf.rel_path, mf.name, o.importance, o.created_at_epoch
         FROM memory_files mf
         JOIN observations o ON o.id = mf.observation_id
        WHERE mf.massu_authored = 1
          AND COALESCE(mf.tombstoned_at_epoch, 0) = 0
          AND COALESCE(mf.expired_at_epoch, 0) = 0
        ORDER BY o.importance DESC, o.created_at_epoch DESC
        LIMIT ?`
    )
    .all(config.indexMaxLines + planned.length) as IndexRow[];

  // Keyed by rel_path — IDENTITY IS THE PATH, never the `name` (F-14): a human copy of a
  // Massu file shares the same frontmatter `name`, so keying on `name` would collapse
  // two real files into one index line.
  const byPath = new Map<string, IndexRow>(rows.map((r) => [r.rel_path.toLowerCase(), r]));

  // The rows for THIS run are not committed yet (and in a dry run never will be), so
  // fold the planned renders in explicitly — otherwise `--dry-run` would print an index
  // that differs from the one the real render applies, and B-13's contract is that the
  // printed diff EQUALS the applied diff.
  for (const p of planned) {
    byPath.set(p.relPath.toLowerCase(), {
      rel_path: p.relPath,
      name: p.c.name,
      importance: p.c.importance,
      created_at_epoch: 0,
    });
  }

  const live = [...byPath.values()].filter((r) => !isTombstoned(memoryDir, r.rel_path));

  // EVICTION POLICY, NAMED (F-07): highest importance first, then newest. The tail
  // beyond the cap is evicted from the INDEX only — its file stays on disk and is
  // recoverable via a rebuild. Eviction never silently deletes a memory.
  const ranked = live.sort(
    (a, b) => b.importance - a.importance || b.created_at_epoch - a.created_at_epoch
  );

  return ranked
    .slice(0, config.indexMaxLines)
    .map((r) => `- [${oneLine(r.name)}](${r.rel_path}) — learned by Massu`);
}

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').slice(0, 120);
}
