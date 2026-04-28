// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu config refresh` — re-run detection, diff against current config, apply
 * or print-only (--dry-run).
 *
 * Merge semantics:
 *   - Detector-owned keys (framework, paths.source, verification, detection) are REFRESHED.
 *   - User-authored keys (rules, domains, canonical_paths, accessScopes,
 *     knownMismatches, dbAccessPattern, analytics, governance, security, team,
 *     regression, cloud, conventions, autoLearning, verification_types,
 *     python) are PRESERVED verbatim from the existing config.
 *
 * Flags:
 *   --dry-run    Emit the diff to stdout, exit 0, never write.
 *   (none)       Interactive: show diff, prompt for confirmation via @clack/prompts.
 *                When stdin is not a TTY, behaves as --dry-run with a note.
 *
 * Exit codes:
 *   0  success (applied, or dry-run completed)
 *   1  missing massu.config.yaml (run `massu init`)
 *   2  unparseable massu.config.yaml
 */

import { existsSync, readFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { runDetection } from '../detect/index.ts';
import { computeFingerprint } from '../detect/drift.ts';
import type { AnyConfig } from '../detect/migrate.ts';
import { copyUnknownKeys, preserveNestedSubkeys } from '../detect/passthrough.ts';
import { buildConfigFromDetection, renderConfigYaml, writeConfigAtomic } from './init.ts';
import { installAll } from './install-commands.ts';
import { resetConfig } from '../config.ts';
import { withInstallLock } from '../lib/installLock.ts';

const PRESERVED_FIELDS = [
  'rules',
  'domains',
  'canonical_paths',
  'verification_types',
  'accessScopes',
  'knownMismatches',
  'dbAccessPattern',
  'analytics',
  'governance',
  'security',
  'team',
  'regression',
  'cloud',
  'conventions',
  'autoLearning',
  'python',
  'toolPrefix',
] as const;

export interface ConfigRefreshOptions {
  dryRun?: boolean;
  cwd?: string;
  silent?: boolean;
  /**
   * Plan #2 P4-001: when true, skip the post-refresh `installAll` call so
   * `.claude/commands/` is NOT re-templated. Used by tests to keep file I/O
   * hermetic, and by users who want config-only refresh behavior.
   */
  skipCommands?: boolean;
  /**
   * Plan 3a Phase 6: when true, bypass BOTH the non-TTY bail and the
   * `@clack/prompts` confirm gate. The watcher daemon and `--yes` CLI flag
   * use this to auto-apply detected changes. Combined with
   * `skipCommands: true`, it lets the watcher delegate `installAll` to its
   * own outer call (single install, single lock acquire — see iter-3 G3-A9).
   */
  autoYes?: boolean;
}

export interface ConfigRefreshResult {
  exitCode: 0 | 1 | 2;
  applied: boolean;
  dryRun: boolean;
  diff: DiffLine[];
  message?: string;
}

export interface DiffLine {
  kind: 'add' | 'remove' | 'change' | 'same';
  path: string;
  before?: unknown;
  after?: unknown;
}

function flatten(obj: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj === null || obj === undefined) {
    out[prefix || '<root>'] = obj;
    return out;
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    out[prefix || '<root>'] = obj;
    return out;
  }
  const rec = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(rec)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v, p));
    } else {
      out[p] = v;
    }
  }
  return out;
}

export function computeDiff(before: AnyConfig, after: AnyConfig): DiffLine[] {
  const b = flatten(before);
  const a = flatten(after);
  const keys = new Set<string>([...Object.keys(b), ...Object.keys(a)]);
  const sorted = [...keys].sort();
  const lines: DiffLine[] = [];
  for (const k of sorted) {
    const bVal = b[k];
    const aVal = a[k];
    const bHas = k in b;
    const aHas = k in a;
    if (bHas && !aHas) {
      lines.push({ kind: 'remove', path: k, before: bVal });
    } else if (!bHas && aHas) {
      lines.push({ kind: 'add', path: k, after: aVal });
    } else if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
      lines.push({ kind: 'change', path: k, before: bVal, after: aVal });
    }
  }
  return lines;
}

export function mergeRefresh(existing: AnyConfig, refreshed: AnyConfig): AnyConfig {
  // P1-008: Start from detector output (fresh framework, paths.source, verification, detection).
  const out: AnyConfig = { ...refreshed };

  // Restore user-authored top-level sections verbatim.
  for (const field of PRESERVED_FIELDS) {
    if (existing[field] !== undefined) {
      out[field] = existing[field];
    }
  }

  // Restore toolPrefix from existing (never let detector-defaulted 'massu' overwrite a custom prefix).
  if (typeof existing.toolPrefix === 'string' && existing.toolPrefix !== '') {
    out.toolPrefix = existing.toolPrefix;
  }

  // For detector-owned blocks (framework, paths, project), preserve any user subkey the detector didn't emit.
  for (const block of ['framework', 'paths', 'project'] as const) {
    const existingBlock = existing[block];
    const outBlock = out[block];
    if (
      existingBlock && typeof existingBlock === 'object' && !Array.isArray(existingBlock) &&
      outBlock && typeof outBlock === 'object' && !Array.isArray(outBlock)
    ) {
      preserveNestedSubkeys(existingBlock, outBlock as Record<string, unknown>);
    }
  }

  // Restore user-set project.root (detector at init.ts:418 always writes 'auto'; user value wins).
  // Separated from the block loop above for readability (A-004 architecture-review follow-up).
  const existingProject = existing.project;
  const outProject = out.project;
  if (
    existingProject && typeof existingProject === 'object' && !Array.isArray(existingProject) &&
    outProject && typeof outProject === 'object' && !Array.isArray(outProject)
  ) {
    const userRoot = (existingProject as Record<string, unknown>).root;
    if (typeof userRoot === 'string' && userRoot !== '') {
      (outProject as Record<string, unknown>).root = userRoot;
    }
  }

  // paths.aliases is a 2-level-nested user block. Detector always writes
  // { '@': <source-dir> }; user-authored alias map must survive. Spread user
  // over detector so user keys win for any overlap AND user-only keys survive.
  // (P5-002 discovery — hedge's paths.aliases['@'] was being overwritten.)
  const existingPaths = existing.paths;
  const outPaths = out.paths;
  if (
    existingPaths && typeof existingPaths === 'object' && !Array.isArray(existingPaths) &&
    outPaths && typeof outPaths === 'object' && !Array.isArray(outPaths)
  ) {
    const existingAliases = (existingPaths as Record<string, unknown>).aliases;
    const outAliases = (outPaths as Record<string, unknown>).aliases;
    if (
      existingAliases && typeof existingAliases === 'object' && !Array.isArray(existingAliases) &&
      outAliases && typeof outAliases === 'object' && !Array.isArray(outAliases)
    ) {
      (outPaths as Record<string, unknown>).aliases = {
        ...(outAliases as Record<string, unknown>),
        ...(existingAliases as Record<string, unknown>),
      };
    } else if (existingAliases && typeof existingAliases === 'object' && !Array.isArray(existingAliases)) {
      (outPaths as Record<string, unknown>).aliases = existingAliases;
    }
  }

  // verification is the other 2-level-nested detector-owned block. Semantics
  // mirror migrate.ts:132-138 buildVerificationBlock: user's custom language
  // sections (e.g., hedge's `gateway`, `ios`, `runtime`, `web`) survive
  // wholesale; user's command overrides on shared languages (e.g., `python`)
  // win over detector defaults. (P5-002 discovery — hedge was losing 15
  // verification command entries across 4 custom language sections plus
  // having 4 python commands overwritten with detector defaults.)
  const existingVer = existing.verification;
  const outVer = out.verification;
  if (
    existingVer && typeof existingVer === 'object' && !Array.isArray(existingVer) &&
    outVer && typeof outVer === 'object' && !Array.isArray(outVer)
  ) {
    const eVer = existingVer as Record<string, unknown>;
    const oVer = outVer as Record<string, unknown>;
    for (const lang of Object.keys(eVer)) {
      const userLang = eVer[lang];
      if (userLang === undefined) continue;
      if (!(lang in oVer)) {
        // User-custom language (no detector counterpart) → preserve wholesale.
        oVer[lang] = userLang;
      } else if (
        userLang && typeof userLang === 'object' && !Array.isArray(userLang) &&
        oVer[lang] && typeof oVer[lang] === 'object' && !Array.isArray(oVer[lang])
      ) {
        // Shared language → user commands win over detector defaults (spread).
        oVer[lang] = {
          ...(oVer[lang] as Record<string, unknown>),
          ...(userLang as Record<string, unknown>),
        };
      }
    }
  }

  // Preserve top-level user keys not handled above (mirrors P1-001 passthrough for upgrade).
  const handledTopLevel = new Set<string>([
    'schema_version', 'project', 'framework', 'paths', 'toolPrefix', 'verification', 'detection',
    ...PRESERVED_FIELDS,
  ]);
  copyUnknownKeys(existing, out, handledTopLevel);

  return out;
}

function renderDiff(diff: DiffLine[]): string {
  if (diff.length === 0) return '(no changes)\n';
  const lines: string[] = [];
  for (const d of diff) {
    if (d.kind === 'add') lines.push(`+ ${d.path}: ${JSON.stringify(d.after)}`);
    else if (d.kind === 'remove') lines.push(`- ${d.path}: ${JSON.stringify(d.before)}`);
    else if (d.kind === 'change') {
      lines.push(`~ ${d.path}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`);
    }
  }
  return lines.join('\n') + '\n';
}

export async function runConfigRefresh(opts: ConfigRefreshOptions = {}): Promise<ConfigRefreshResult> {
  const cwd = opts.cwd ?? process.cwd();
  const configPath = resolve(cwd, 'massu.config.yaml');
  const log = opts.silent ? () => {} : (s: string) => process.stdout.write(s);

  if (!existsSync(configPath)) {
    const message = 'massu.config.yaml not found. Run: npx massu init';
    if (!opts.silent) process.stderr.write(message + '\n');
    return { exitCode: 1, applied: false, dryRun: !!opts.dryRun, diff: [], message };
  }

  let existing: AnyConfig;
  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(content);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('config is not a YAML object');
    }
    existing = parsed as AnyConfig;
  } catch (err) {
    const message = `Failed to parse massu.config.yaml: ${err instanceof Error ? err.message : String(err)}`;
    if (!opts.silent) process.stderr.write(message + '\n');
    return { exitCode: 2, applied: false, dryRun: !!opts.dryRun, diff: [], message };
  }

  const detection = await runDetection(cwd);
  const refreshed = buildConfigFromDetection({
    projectRoot: cwd,
    detection,
    projectName: typeof (existing.project as Record<string, unknown> | undefined)?.name === 'string'
      ? (existing.project as Record<string, unknown>).name as string
      : undefined,
  });
  // buildConfigFromDetection already stamps detection.fingerprint. Double-check.
  if (!(refreshed.detection as Record<string, unknown> | undefined)?.fingerprint) {
    refreshed.detection = { fingerprint: computeFingerprint(detection) };
  }

  const merged = mergeRefresh(existing, refreshed);
  const diff = computeDiff(existing, merged);

  if (opts.dryRun) {
    log('Config diff (dry-run; no changes written):\n');
    log(renderDiff(diff));
    return { exitCode: 0, applied: false, dryRun: true, diff };
  }

  if (diff.length === 0) {
    log('No changes needed — config is already up to date.\n');
    return { exitCode: 0, applied: false, dryRun: false, diff };
  }

  // Plan 3a Phase 6: when autoYes=true, skip BOTH the non-TTY bail and the
  // confirm gate so the watcher (daemon stdin is detached) and the
  // `--yes`/-y CLI flag actually apply changes.
  if (!opts.autoYes) {
    // Interactive prompt; fall back to dry-run semantics when not a TTY.
    if (!process.stdin.isTTY) {
      log('Config diff (non-interactive; pass --dry-run to suppress this note or run interactively to apply):\n');
      log(renderDiff(diff));
      return {
        exitCode: 0,
        applied: false,
        dryRun: false,
        diff,
        message: 'non-interactive shell; no changes written',
      };
    }

    log('Config diff:\n');
    log(renderDiff(diff));
    const { confirm } = await import('@clack/prompts');
    const apply = await confirm({ message: 'Apply these changes to massu.config.yaml?' });
    if (apply !== true) {
      log('Aborted; no changes written.\n');
      return { exitCode: 0, applied: false, dryRun: false, diff, message: 'aborted by user' };
    }
  } else {
    log('Config diff (auto-applying via --yes / watcher):\n');
    log(renderDiff(diff));
  }

  const yamlContent = renderConfigYaml(merged);
  const writeRes = writeConfigAtomic(configPath, yamlContent);
  if (!writeRes.validated) {
    const message = `Failed to write config: ${writeRes.error}`;
    if (!opts.silent) process.stderr.write(message + '\n');
    return { exitCode: 2, applied: false, dryRun: false, diff, message };
  }
  log('Config refreshed.\n');

  // Plan #2 P4-001: re-template `.claude/commands/` against the freshly
  // written config so newly-detected stack changes get the right scaffolds.
  // P4-003 (auto-delete half): if a stack is now declared and the empty-init
  // placeholder still exists, remove it.
  if (!opts.skipCommands) {
    log('Will also re-template command files; pass --skip-commands to opt out.\n');
    // Reset cached config so installAll reads the freshly-written YAML.
    resetConfig();
    try {
      const installResult = withInstallLock(cwd, () => installAll(cwd));
      const total =
        installResult.totalInstalled +
        installResult.totalUpdated +
        installResult.totalSkipped +
        installResult.totalKept;
      log(`Re-templated ${total} command files (${installResult.totalInstalled} new, ${installResult.totalUpdated} updated).\n`);

      // Auto-delete the empty-init placeholder if at least one stack-specific
      // command was resolved this run (i.e., a non-zero install/update count).
      const stackResolved =
        installResult.totalInstalled > 0 || installResult.totalUpdated > 0;
      if (stackResolved) {
        const placeholderPath = resolve(installResult.claudeDir, 'commands', '_massu-needs-stack.md');
        if (existsSync(placeholderPath)) {
          try {
            rmSync(placeholderPath, { force: true });
            log('Removed _massu-needs-stack.md (stack now declared).\n');
          } catch {
            // Best-effort: never block refresh on placeholder cleanup.
          }
        }
      }
    } catch (err) {
      // Don't fail the whole refresh if re-template breaks; the YAML was already written.
      // InstallLockBusyError.message already follows plan §243 format —
      // `installAll already running (PID=X) — try again in <N>s` — so we
      // surface it verbatim rather than re-wrapping.
      const msg = err instanceof Error ? err.message : String(err);
      if (!opts.silent) process.stderr.write(`Warning: re-template failed: ${msg}\n`);
    }
  }

  return { exitCode: 0, applied: true, dryRun: false, diff };
}
