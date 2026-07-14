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
        const candidates = loadRenderCandidates(db);
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
