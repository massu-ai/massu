/**
 * B-13 — the `massu memory <render|restore|adopt|unrender>` entry point.
 *
 * Thin: it resolves the real paths and DB, parses flags, and delegates. All of the
 * behaviour (and all of the safety) lives in the modules it calls.
 *
 * ⛔ `render` here is DRY-RUN ONLY. The real render runs at session start, behind
 * `renderEnabled` (default false). A `massu memory render` that wrote for real would be
 * a second, un-gated write path — exactly the thing B-12's single chokepoint forbids.
 */
import { getResolvedPaths } from '../config.ts';
import { getMemoryDb } from '../memory-db.ts';
import {
  memoryAdopt,
  memoryUnrender,
  memoryRestore,
  type CliResult,
} from './memory-render-cli.ts';
import { renderMemoryFiles } from '../memory-renderer.ts';
import { loadRenderCandidates } from '../memory-render-candidates.ts';
import { resolveMemoryFilesConfig } from '../memory-files-config.ts';
import { setAdvisorDryRunOk } from '../capability-advisor.ts';

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runMemoryRenderCli(sub: string, args: string[]): Promise<CliResult> {
  const { memoryDir } = getResolvedPaths();
  const db = getMemoryDb();

  try {
    switch (sub) {
      case 'render': {
        // The contract: writes ZERO bytes and prints exactly what it WOULD apply.
        if (!hasFlag(args, '--dry-run')) {
          return {
            exitCode: 1,
            output:
              'massu memory render only supports --dry-run.\n' +
              'Massu writes memory files at session start, and only when you have turned\n' +
              'that on (memory.files.renderEnabled). Run with --dry-run to see exactly what\n' +
              'it would write, without changing anything.',
          };
        }

        const cfg = resolveMemoryFilesConfig();
        const { candidates, ledger } = loadRenderCandidates(db);
        const result = renderMemoryFiles(db, candidates, {
          memoryDir,
          dryRun: true,
          // A dry run must show what would happen WHEN ENABLED — otherwise, with the
          // default-off config, it would always print "nothing", which is useless and
          // would make the B-12 advisor un-offerable.
          config: { ...cfg, renderEnabled: true },
        });

        const lines: string[] = [];
        if (result.skippedReason === 'no_memory_dir') {
          return { exitCode: 0, output: 'No memory directory on this machine — Massu would do nothing.' };
        }

        lines.push(`Massu would write ${result.written.length} file(s):`);
        for (const f of result.written) lines.push(`  ${f}`);

        // ── THE DENOMINATOR (2026-08-09) ────────────────────────────────────────
        // `Massu would write 0 file(s)` alone is what an EMPTY corpus prints, what a
        // correctly-IDLE pipeline prints, what a pipeline that CRASHED after the query
        // prints, and what a BROKEN one prints. Four states, one string, and it is the
        // reassuring one — which on 2026-08-08 produced a high-severity incident for a
        // defect that did not exist.
        //
        // Three of the drops happen in the candidate LOADER, upstream of `refusals`, so
        // the ledger is printed FIRST and separately: a denominator taken from the
        // renderer alone would read "considered 0" and hide everything that mattered.
        lines.push('', 'Where every row went:');
        lines.push(`  candidate population (type+importance+expiry) : ${ledger.population}`);
        if (ledger.truncatedByWindow > 0) {
          lines.push(`    truncated by the row window                : ${ledger.truncatedByWindow}`);
        }
        for (const e of ledger.excluded) {
          lines.push(`    excluded: ${e.reason.padEnd(30)} : ${e.count}`);
        }
        lines.push(`    -> reached the renderer                    : ${ledger.returned}`);
        lines.push(
          `  renderer: considered ${result.considered} = written ${result.written.length}` +
            ` + refused ${result.refusals.length} + unchanged ${result.unchanged}` +
            ` + capped ${result.capped}`
        );
        // NEVER swallowed. Every reason but `no_memory_dir` used to vanish here, so a
        // busy lock and a clean idle run printed the same line.
        lines.push(`  skipped: ${result.skippedReason ?? '(none)'}`);

        if (result.indexLines.length > 0) {
          lines.push('', 'MEMORY.md — inside the massu:learned region only:');
          for (const l of result.indexLines) lines.push(`  ${l}`);
        }

        if (result.refusals.length > 0) {
          lines.push('', `${result.refusals.length} memory/memories REFUSED:`);
          for (const r of result.refusals) {
            // Names the reason and the PATTERN, never the matched text.
            lines.push(`  ${r.name}: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`);
          }
        }

        lines.push('', `Bytes written: ${result.bytesWritten} (a dry run always writes 0).`);

        // B-12/F-17: the enable offer is surfaced only AFTER a successful dry run.
        if (result.written.length > 0) setAdvisorDryRunOk('memory-render');

        return { exitCode: 0, output: lines.join('\n') };
      }

      case 'prune-noise': {
        // D-C: expire (never delete) the observation noise the two fixed ingestion bugs
        // left behind. Dry-run by DEFAULT — a corpus mutation is never implied; the
        // operator must pass --yes. CLI-only, like every memory-mutating command here.
        const { countNoise, sampleNoise, pruneNoiseObservations } = await import('../memory-prune-noise.ts');
        const apply = hasFlag(args, '--yes');
        const counts = countNoise(db);
        if (counts.total === 0) {
          return { exitCode: 0, output: 'No ingestion noise found in the memory corpus.' };
        }
        const lines: string[] = [
          `${counts.total} noise observation(s) identified:`,
          `  tool-response-decision: ${counts.toolResponseDecision}`,
          `  free-text-decision:     ${counts.freeTextDecision}`,
          `  same-instant-duplicate: ${counts.sameInstantDuplicate}`,
          '',
          'Sample (first 10):',
        ];
        for (const r of sampleNoise(db, 10)) lines.push(`  [${r.reason}] id=${r.id} ${r.type}: ${r.title.slice(0, 60)}`);
        if (apply) {
          const result = pruneNoiseObservations(db, { dryRun: false });
          lines.push('', `Expired ${result.expired} row(s) (CR-61: expired, NOT deleted; still asOf-queryable).`);
        } else {
          lines.push(
            '',
            `--dry-run (default): nothing changed. Re-run \`massu memory prune-noise --yes\` to EXPIRE ` +
              `these ${counts.total} row(s) (never deletes; still asOf-queryable).`,
          );
        }
        return { exitCode: 0, output: lines.join('\n') };
      }

      case 'restore':
        return memoryRestore(memoryDir, {
          from: flagValue(args, '--from'),
          dryRun: hasFlag(args, '--dry-run'),
        });

      case 'adopt':
        return memoryAdopt(db, memoryDir, {
          dryRun: hasFlag(args, '--dry-run'),
          confirmed: hasFlag(args, '--yes'),
          isTTY: process.stdin.isTTY === true,
        });

      case 'unrender':
        return memoryUnrender(db, memoryDir, {
          all: hasFlag(args, '--all'),
          file: flagValue(args, '--file'),
          dryRun: hasFlag(args, '--dry-run'),
        });

      default:
        return { exitCode: 1, output: `Unknown memory subcommand: ${sub}` };
    }
  } finally {
    db.close();
  }
}

// The candidate query lives in `memory-render-candidates.ts` — ONE query, shared with the
// session-start hook. A second copy here is how `--dry-run` would end up showing the
// operator something different from what the real render applies, in the one place he
// relies on it being identical: deciding whether to turn this on at all.
