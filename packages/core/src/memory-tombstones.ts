/**
 * B-04 / OD-2 — the operator can actually delete a Massu file.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHY THE LEDGER IS A FILE AND NOT A DATABASE COLUMN
 * ═══════════════════════════════════════════════════════════════════════════════
 * Two rules fire on the same cell:
 *   "file gone ⇒ expire the row"                              (the ingest arm)
 *   "renderable memory + no file + Massu-authored ⇒ render"   (the render arm)
 * So a file the operator deletes is RE-CREATED next session, forever, unless
 * something durably records "he meant it".
 *
 * A DB-only tombstone does not survive the thing most likely to be thrown away — the
 * database. `.massu/*.db` is gitignored; the memory files are NOT. A fresh clone, a
 * second machine, or `rm -rf .massu` loses the tombstone but keeps the corpus — and at
 * that moment the render arm sees "a renderable memory with no file" and re-creates
 * every memory the operator ever deleted. On every machine. Forever.
 *
 * A DELETION YOU HAVE TO REPEAT IS NOT A DELETION.
 *
 * So the ledger lives INSIDE the corpus it governs (`<memory-dir>/.massu-tombstones.jsonl`),
 * where it is git-tracked and travels with the files: the two halves are lost and
 * restored together. `memory_files.tombstoned_at_epoch` is a CACHE of this file. The
 * LEDGER WINS on conflict.
 *
 * It is non-`.md` BY CONSTRUCTION, so ingest and reconcile skip it (both filter
 * `f.endsWith('.md')`) — it can never be mistaken for a memory.
 *
 * It is append-only and human-readable/editable on purpose: deleting a line is how the
 * operator says "actually, render that again".
 */
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';

export const TOMBSTONE_LEDGER = '.massu-tombstones.jsonl';

export interface TombstoneEntry {
  /** IDENTITY is the rel_path (F-14). NEVER the frontmatter `name`, which is not unique. */
  rel_path: string;
  tombstoned_at_epoch: number;
  reason: string;
}

export function tombstoneLedgerPath(memoryDir: string): string {
  return join(memoryDir, TOMBSTONE_LEDGER);
}

/**
 * Every tombstoned rel_path. Absent ledger ⇒ empty set (a missing ledger is "nothing
 * has been deleted", never an error).
 *
 * A corrupt LINE is skipped, not fatal: one bad line must not resurrect every deleted
 * memory in the corpus. A corrupt line is the one failure mode where being permissive
 * is safe — we lose at most the knowledge of one deletion, and the operator can re-delete.
 * Being strict here would mean a single stray byte un-deletes everything.
 */
export function readTombstones(memoryDir: string): Map<string, TombstoneEntry> {
  const out = new Map<string, TombstoneEntry>();
  const p = tombstoneLedgerPath(memoryDir);
  if (!existsSync(p)) return out;

  let raw: string;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return out;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as TombstoneEntry;
      if (typeof e?.rel_path === 'string' && e.rel_path.length > 0) {
        // Case-insensitive: macOS and Windows fold case — `Foo.md` and `foo.md` are ONE
        // file, and a tombstone on one must suppress the other.
        out.set(e.rel_path.toLowerCase(), e);
      }
    } catch {
      continue; // a malformed line loses ONE deletion, never all of them
    }
  }
  return out;
}

/** Is this exact path tombstoned? Checked BEFORE any path is computed or file written. */
export function isTombstoned(memoryDir: string, relPath: string): boolean {
  return readTombstones(memoryDir).has(relPath.toLowerCase());
}

export class TombstoneWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TombstoneWriteError';
  }
}

/**
 * Record a deletion durably.
 *
 * Append-only: we never rewrite the ledger, so a crash mid-write can lose at most the
 * line being appended — it can never corrupt the deletions already recorded.
 *
 * THROWS if it cannot write. The caller's contract (B-04) is: a deletion we cannot
 * record is a deletion we will UNDO, so the renderer must refuse to render anything
 * this session rather than proceed with an unrecordable tombstone.
 */
export function tombstone(
  memoryDir: string,
  relPath: string,
  reason: string,
  nowEpoch: number
): void {
  const entry: TombstoneEntry = {
    rel_path: relPath,
    tombstoned_at_epoch: nowEpoch,
    reason,
  };
  try {
    appendFileSync(tombstoneLedgerPath(memoryDir), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    throw new TombstoneWriteError(
      `cannot record the deletion of ${relPath}: ${(err as Error).message}`
    );
  }
}

/**
 * Remove a tombstone — the ONLY way a tombstoned memory renders again.
 *
 * Deliberately NOT implemented as a "delete the line" API. The ledger is append-only
 * and human-editable; un-deleting is the operator opening the file and removing a line.
 * Giving Massu a programmatic un-tombstone would hand it the exact capability the
 * ledger exists to deny it.
 *
 * Exported as documentation of that decision, and to give the CLI something honest to
 * print.
 */
export function untombstoneInstructions(memoryDir: string, relPath: string): string {
  return (
    `To let Massu render "${relPath}" again, delete its line from:\n` +
    `  ${tombstoneLedgerPath(memoryDir)}\n` +
    `Massu will not do this for you — un-deleting is yours alone.`
  );
}
