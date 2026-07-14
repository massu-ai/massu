/**
 * B-13 / B-15 / B-18 — the 4B CLI surface.
 *
 * ⛔ THESE ARE CLI-ONLY. THERE IS NO MCP TOOL, AND THAT IS THE DECISION, NOT AN OVERSIGHT.
 *
 * Every one of these commands writes to — or authorises writing to — the operator's
 * irreplaceable memory. Exposing them as MCP tools would make them MODEL-CALLABLE, and
 * the model is precisely the actor this entire slice exists to constrain. A drift-guard
 * asserts none of these names ever appears in `tools.ts`. (CR-11 does not apply: it
 * governs MCP tools, and these are deliberately not.)
 *
 *   massu memory render --dry-run   B-13 — writes 0 bytes, prints exactly what it WOULD do
 *   massu memory restore [--from]   B-11 — byte-identical corpus restoration
 *   massu memory adopt [--dry-run]  B-15 — the operator-gated ceremony; NEVER automatic
 *   massu memory unrender [--all]   B-18 — the 4B rollback
 */
import { readdirSync, readFileSync, existsSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type Database from 'better-sqlite3';
import { verifyAuthorship, renderKeyExists, extractRenderMac } from '../memory-authorship.ts';
import { readMemoryFileFrontmatter } from '../memory-file-ingest.ts';
import { stripFrontmatter } from '../memory-renderer.ts';
import { tombstone } from '../memory-tombstones.ts';
import { restoreBackup, listBackups } from '../memory-backup.ts';
import {
  readMemoryIndex,
  renderRegion,
  writeMemoryIndex,
  RegionRefused,
} from '../memory-index-region.ts';

export interface CliResult {
  exitCode: number;
  output: string;
}

/** Every `*.md` in the memory dir (never the tombstone ledger — it is not a memory). */
function memoryFiles(memoryDir: string): string[] {
  if (!existsSync(memoryDir)) return [];
  return readdirSync(memoryDir).filter((f) => {
    if (!f.endsWith('.md')) return false;
    if (f === 'MEMORY.md') return false; // the index is not a memory
    try {
      return statSync(join(memoryDir, f)).isFile();
    } catch {
      return false;
    }
  });
}

/** Files whose credential verifies — i.e. files Massu can PROVE it wrote. */
export function massuAuthoredFiles(
  db: Database.Database,
  memoryDir: string,
  home: string = homedir()
): string[] {
  const out: string[] = [];
  for (const f of memoryFiles(memoryDir)) {
    let content: string;
    try {
      content = readFileSync(join(memoryDir, f), 'utf8');
    } catch {
      continue;
    }
    const row = db
      .prepare(
        `SELECT massu_authored, massu_render_mac, adopted_human_at_epoch
           FROM memory_files WHERE rel_path = ? COLLATE NOCASE`
      )
      .get(f) as
      | { massu_authored: number; massu_render_mac: string | null; adopted_human_at_epoch: number | null }
      | undefined;

    if (verifyAuthorship(stripFrontmatter(content), readMemoryFileFrontmatter(content), row ?? null, home)) {
      out.push(f);
    }
  }
  return out;
}

/**
 * B-15 — RE-ADOPTION: the operator-gated ceremony that unfreezes a Massu file.
 *
 * The "frozen file" cell: the file exists, its credential verifies, but the STORE ROW IS
 * ABSENT (a fresh clone, a second machine, a DB reset). Backfill sets massu_authored=0
 * unconditionally, fail-closed fires, and Massu can never maintain its own file again —
 * and may mint a SECOND file for the same memory.
 *
 * ⛔ NEVER AUTOMATIC. NEVER IN A HOOK. NEVER IN AN MCP TOOL. Unadopted files remain
 * HUMAN — the safe default, forever. Adoption is the only thing that clears
 * `adopted_human_at_epoch` (B-01's stickiness).
 */
export function memoryAdopt(
  db: Database.Database,
  memoryDir: string,
  opts: { dryRun?: boolean; confirmed?: boolean; isTTY?: boolean; home?: string; now?: number } = {}
): CliResult {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const lines: string[] = [];

  if (!renderKeyExists(home)) {
    return {
      exitCode: 1,
      output:
        'This machine has no render key (~/.massu/render-key), so no file can be proven to be ' +
        "Massu's. Every memory file is treated as yours — which is the safe direction. " +
        'Nothing was changed.',
    };
  }

  // A candidate is a file whose credential VERIFIES but which has no store row.
  const candidates: string[] = [];
  for (const f of memoryFiles(memoryDir)) {
    const row = db.prepare(`SELECT id FROM memory_files WHERE rel_path = ? COLLATE NOCASE`).get(f);
    if (row) continue; // already known to the store — not frozen
    const content = readFileSync(join(memoryDir, f), 'utf8');
    if (verifyAuthorship(stripFrontmatter(content), readMemoryFileFrontmatter(content), null, home)) {
      candidates.push(f);
    }
  }

  if (candidates.length === 0) {
    return { exitCode: 0, output: 'Nothing to adopt: no Massu-written file is missing from the store.' };
  }

  lines.push(`${candidates.length} file(s) were written by Massu but are missing from its store:`);
  for (const f of candidates) lines.push(`  ${f}`);
  lines.push('');
  lines.push('Adopting them lets Massu keep them up to date. Leaving them alone is safe —');
  lines.push('they stay yours and Massu will never touch them.');

  if (opts.dryRun) {
    lines.push('', '--dry-run: nothing was changed.');
    return { exitCode: 0, output: lines.join('\n') };
  }

  // No TTY / non-interactive ⇒ REFUSE. Adoption is never implied by piping.
  if (opts.isTTY === false || !opts.confirmed) {
    lines.push('', 'Refusing to adopt without explicit confirmation. Re-run with confirmation.');
    return { exitCode: 1, output: lines.join('\n') };
  }

  const insert = db.prepare(
    `INSERT INTO memory_files (rel_path, name, raw, body, content_hash, massu_authored,
                               massu_render_mac, adopted_human_at_epoch, origin)
     VALUES (?, ?, ?, ?, ?, 1, ?, NULL, 'local')
     ON CONFLICT(rel_path) DO UPDATE SET massu_authored = 1, adopted_human_at_epoch = NULL`
  );

  db.exec('BEGIN');
  try {
    for (const f of candidates) {
      const content = readFileSync(join(memoryDir, f), 'utf8');
      const fm = readMemoryFileFrontmatter(content);
      insert.run(
        f,
        typeof fm?.name === 'string' ? fm.name : f.replace(/\.md$/, ''),
        content,
        stripFrontmatter(content),
        '',
        // Via the authorship module — it owns every massu_* frontmatter read, even a
        // mechanical one. Trust was already decided above by verifyAuthorship.
        extractRenderMac(fm)
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return { exitCode: 1, output: `Adoption failed, nothing changed: ${(err as Error).message}` };
  }

  lines.push('', `Adopted ${candidates.length} file(s). Massu will maintain them from now on.`);
  void now;
  return { exitCode: 0, output: lines.join('\n') };
}

/**
 * B-18 — `massu memory unrender`: the 4B rollback.
 *
 * Deletes ONLY files whose credential verifies — i.e. only files Massu can PROVE it
 * wrote. A file it cannot prove it wrote is SKIPPED AND LISTED. `unrender` never deletes
 * a file it cannot prove it authored, and it never touches a human or adopted file.
 *
 * It tombstones each one, so re-enabling the renderer does NOT bring them back — which
 * is only possible at all because deletions are durable (OD-2).
 */
export function memoryUnrender(
  db: Database.Database,
  memoryDir: string,
  opts: { all?: boolean; file?: string; dryRun?: boolean; home?: string; now?: number } = {}
): CliResult {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const lines: string[] = [];

  const ours = massuAuthoredFiles(db, memoryDir, home);
  const targets = opts.file ? ours.filter((f) => f === opts.file) : opts.all ? ours : [];

  const skipped = memoryFiles(memoryDir).filter((f) => !ours.includes(f));

  if (opts.file && targets.length === 0) {
    return {
      exitCode: 1,
      output:
        `Refusing to unrender "${opts.file}": Massu cannot prove it wrote that file, ` +
        `so it is yours. Nothing was changed.`,
    };
  }

  lines.push(`${targets.length} file(s) written by Massu would be removed:`);
  for (const f of targets) lines.push(`  ${f}`);
  if (skipped.length > 0) {
    lines.push('', `${skipped.length} file(s) SKIPPED — Massu cannot prove it wrote them:`);
    for (const f of skipped) lines.push(`  ${f}`);
  }

  if (opts.dryRun) {
    lines.push('', '--dry-run: nothing was changed.');
    return { exitCode: 0, output: lines.join('\n') };
  }

  for (const f of targets) {
    // Tombstone FIRST, then delete: if we crash between the two, the file is still there
    // and still tombstoned (so it is not re-rendered), which is recoverable. The reverse
    // order could delete a file with no record that we meant to.
    tombstone(memoryDir, f, 'unrendered', now);
    try {
      rmSync(join(memoryDir, f));
    } catch {
      /* already gone */
    }
    db.prepare(`UPDATE memory_files SET tombstoned_at_epoch = ? WHERE rel_path = ? COLLATE NOCASE`).run(
      now,
      f
    );
  }

  // Clear the managed region, leaving the sentinels and every byte outside them intact.
  const indexPath = join(memoryDir, 'MEMORY.md');
  const pre = readMemoryIndex(indexPath);
  if (pre !== undefined) {
    try {
      const post = renderRegion(pre, []);
      if (post !== pre) writeMemoryIndex(indexPath, pre, post);
    } catch (err) {
      if (!(err instanceof RegionRefused)) throw err;
      lines.push('', `MEMORY.md left untouched (${(err as RegionRefused).reason}).`);
    }
  }

  lines.push('', `Removed ${targets.length} file(s). They will not be re-created.`);
  return { exitCode: 0, output: lines.join('\n') };
}

/** B-11 — `massu memory restore`. */
export function memoryRestore(
  memoryDir: string,
  opts: { from?: string; dryRun?: boolean; home?: string } = {}
): CliResult {
  const home = opts.home ?? homedir();
  const backups = listBackups(home);
  if (backups.length === 0) {
    return { exitCode: 1, output: 'No backups exist yet. Nothing to restore.' };
  }

  try {
    const r = restoreBackup(memoryDir, { ...opts, home });
    const lines = [
      r.dryRun
        ? `--dry-run: would restore ${r.wouldRestore.length} file(s) from ${r.stamp}. Nothing changed.`
        : `Restored ${r.filesRestored} file(s) from ${r.stamp}.`,
    ];
    for (const f of r.wouldRestore) lines.push(`  ${f}`);
    if (r.presentButNotInBackup.length > 0) {
      lines.push('', 'These files exist now but are NOT in the backup. Massu left them alone:');
      for (const f of r.presentButNotInBackup) lines.push(`  ${f}`);
    }
    return { exitCode: 0, output: lines.join('\n') };
  } catch (err) {
    return { exitCode: 1, output: `Restore failed, nothing changed: ${(err as Error).message}` };
  }
}
