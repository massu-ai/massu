// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * SSOT for MCP permission seeding, verification, and drift detection.
 *
 * Public surface:
 *   MASSU_PERMISSION_ENTRIES     — canonical glob entries (currently ['mcp__massu__*'])
 *   LAUNCH_FLAG_REQUIRED_MODES   — defaultMode values that require launch flag
 *                                   per https://code.claude.com/docs/en/permission-modes
 *                                   (cannot be activated from settings file alone)
 *   findMissingEntries           — pure SSOT helper used by writer + verifier
 *   detectInvalidDefaultMode     — checks settings.permissions.defaultMode against
 *                                   LAUNCH_FLAG_REQUIRED_MODES
 *   readGlobalSettings           — reads ~/.claude/settings.json safely
 *   mergedPermissionState        — pure merge function: allow ∪ canonical;
 *                                   defaultMode = local override OR global OR omit;
 *                                   deny/ask preserved from local
 *   installPermissions           — read-merge-atomic-write-assert pipeline
 *   verifyPermissions            — read-only canonical-entry check
 *   checkPermissionsDrift        — extended diagnostic (4 drift kinds)
 *   InstallPermissionsAssertionError — fail-loud post-write assertion type
 *
 * v3 fix: writes the FULL merged permissions block (not just .allow), eliminating
 * the merge-replacement trap empirically observed 2026-05-14 where a project-local
 * `permissions` object that omits defaultMode silently strips the global value.
 * See docs/plans/2026-05-14-1.8.0-mcp-permission-seeding.md §0.5 for evidence
 * (F15+F16+F17) and the docs gap at code.claude.com/docs/en/permissions.
 *
 * Manifest convention: synthetic non-file entries use prefix `__settings__/`.
 * This module uses `__settings__/permissions` as the manifest key for the
 * full merged permissions block hash (3-hash kept-because-edited pattern).
 */

import { createHash } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { getConfig } from './config.ts';
import type { Manifest } from './commands/install-commands.ts';
import {
  readSettingsAtPath,
  readSettingsLocal,
  writeSettingsLocalAtomic,
} from './lib/settings-local.ts';

// ============================================================
// SSOT constants
// ============================================================

/**
 * Canonical MCP allowlist entries seeded by massu into project-local
 * `.claude/settings.local.json`. Currently a single glob covering all
 * `mcp__massu__<tool>` invocations (73+ tools as of 1.7.0). Future
 * additions require an ADR + explicit operator approval per CLAUDE.md
 * `### Default Permissions` policy.
 *
 * Format validated against https://code.claude.com/docs/en/permissions § MCP:
 * "`mcp__puppeteer__*` wildcard syntax that also matches all tools from the
 * `puppeteer` server".
 */
export const MASSU_PERMISSION_ENTRIES = ['mcp__massu__*'] as const;

/**
 * `defaultMode` values that CANNOT be activated from a settings file alone;
 * each requires a corresponding `--permission-mode <mode>` (or equivalent)
 * launch flag per https://code.claude.com/docs/en/permission-modes.
 *
 * Values OK from settings: `default`, `acceptEdits`, `plan`.
 * Values requiring launch flag: included in this constant.
 *
 * Used by detectInvalidDefaultMode + checkPermissionsDrift.
 */
export const LAUNCH_FLAG_REQUIRED_MODES = ['bypassPermissions', 'auto', 'dontAsk'] as const;

// ============================================================
// Type surface
// ============================================================

export type DriftKind =
  | 'missing-allow'
  | 'invalid-default-mode'
  | 'unknown-key'
  | 'strips-global-defaultmode';

export interface DriftItem {
  kind: DriftKind;
  detail: string;
  remediation: string;
}

export interface MergedPermissions {
  allow: string[];
  defaultMode?: string;
  deny?: string[];
  ask?: string[];
}

export class InstallPermissionsAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallPermissionsAssertionError';
  }
}

// ============================================================
// Pure helpers
// ============================================================

/** Deterministic JSON serialization with sorted keys. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) return '';
    return JSON.stringify(k) + ':' + canonicalJson(v);
  }).filter((s) => s !== '');
  return '{' + parts.join(',') + '}';
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

export function findMissingEntries(allow: readonly string[]): string[] {
  const allowSet = new Set(allow);
  return MASSU_PERMISSION_ENTRIES.filter((entry) => !allowSet.has(entry));
}

export function detectInvalidDefaultMode(
  settings: Record<string, unknown>,
): { invalid: boolean; mode?: string; reason?: string } {
  const permissions = settings.permissions as { defaultMode?: unknown } | undefined;
  const mode = permissions?.defaultMode;
  if (typeof mode !== 'string') {
    return { invalid: false };
  }
  if ((LAUNCH_FLAG_REQUIRED_MODES as readonly string[]).includes(mode)) {
    return {
      invalid: true,
      mode,
      reason:
        `defaultMode "${mode}" requires --permission-mode launch flag per ` +
        `https://code.claude.com/docs/en/permission-modes — settings-file value alone is inert. ` +
        `Remediation: launch with --permission-mode ${mode} OR change defaultMode to one of {default, acceptEdits, plan}.`,
    };
  }
  return { invalid: false };
}

/**
 * Read user-global ~/.claude/settings.json safely. Returns {} on any failure
 * (missing, corrupt, permission denied). Honors $HOME via os.homedir().
 */
export function readGlobalSettings(): Record<string, unknown> {
  return readSettingsAtPath(join(homedir(), '.claude', 'settings.json'));
}

/**
 * Pure merge function. Computes the target `permissions` block for the
 * project-local settings.local.json.
 *
 * Rules:
 *   - allow: dedupe(local.allow ∪ canonical), preserving local order; canonical
 *     entries that are not already present are appended at the end
 *   - defaultMode: local override wins (user choice respected); else global
 *     value is propagated; else key is OMITTED entirely (no key in output object,
 *     not `undefined` — verified by PERM-DRIFT-15)
 *   - deny: preserved from local verbatim (or omitted if local has none)
 *   - ask: preserved from local verbatim (or omitted if local has none)
 */
export function mergedPermissionState(
  global: Record<string, unknown>,
  local: Record<string, unknown>,
  canonical: readonly string[],
): MergedPermissions {
  const globalPerm = (global.permissions as Record<string, unknown> | undefined) ?? {};
  const localPerm = (local.permissions as Record<string, unknown> | undefined) ?? {};

  const localAllow = Array.isArray(localPerm.allow)
    ? (localPerm.allow as unknown[]).filter((e): e is string => typeof e === 'string')
    : [];
  const allowSet = new Set(localAllow);
  const allow = [...localAllow];
  for (const entry of canonical) {
    if (!allowSet.has(entry)) {
      allow.push(entry);
      allowSet.add(entry);
    }
  }

  const result: MergedPermissions = { allow };

  // defaultMode resolution
  if (typeof localPerm.defaultMode === 'string') {
    result.defaultMode = localPerm.defaultMode;
  } else if (typeof globalPerm.defaultMode === 'string') {
    result.defaultMode = globalPerm.defaultMode;
  }
  // Else: key OMITTED (not undefined, not present at all)

  if (Array.isArray(localPerm.deny)) {
    result.deny = (localPerm.deny as unknown[]).filter((e): e is string => typeof e === 'string');
  }
  if (Array.isArray(localPerm.ask)) {
    result.ask = (localPerm.ask as unknown[]).filter((e): e is string => typeof e === 'string');
  }

  return result;
}

// ============================================================
// installPermissions (read-merge-atomic-write-assert pipeline)
// ============================================================

const MANIFEST_KEY_PERMISSIONS = '__settings__/permissions';

function resolveClaudeDir(claudeDir: string): string {
  return claudeDir;
}

function hashOfPermissions(perm: Record<string, unknown> | MergedPermissions): string {
  return sha256Hex(canonicalJson(perm));
}

/**
 * Install the canonical massu permission entries plus any propagated
 * defaultMode from global settings. Mirrors the install-commands.ts 3-hash
 * kept-because-edited pattern for operator-edit preservation.
 *
 * Cases (mirrors install-commands.ts:syncDirectory file-write logic):
 *   1. existing == expected           → skipped:1 (idempotent)
 *   2. no last-installed hash         → first install, write merged → installed:1
 *   3. existing == last-installed     → operator did not edit; reapply merge → installed:1
 *   4. existing != last-installed     → operator edited after last install → kept:1 (preserve)
 *
 * Post-write: re-reads disk and asserts the merged state survived. If a
 * defaultMode was decided (from local or global) but is absent on disk,
 * throws `InstallPermissionsAssertionError`.
 */
export function installPermissions(
  claudeDir: string,
  manifest: Manifest,
  opts: { silent?: boolean; global?: Record<string, unknown> } = {},
): { installed: number; kept: number; skipped: number } {
  const resolvedDir = resolveClaudeDir(claudeDir);
  const global = opts.global ?? readGlobalSettings();
  const local = readSettingsLocal(resolvedDir);

  const merged = mergedPermissionState(global, local, MASSU_PERMISSION_ENTRIES);
  const expectedHash = hashOfPermissions(merged);

  const existingPerm = (local.permissions as Record<string, unknown> | undefined) ?? undefined;
  const existingHash = existingPerm ? hashOfPermissions(existingPerm) : undefined;
  const lastInstalledHash = manifest.entries[MANIFEST_KEY_PERMISSIONS];

  // Case 1: already in sync
  if (existingHash === expectedHash) {
    manifest.entries[MANIFEST_KEY_PERMISSIONS] = expectedHash;
    if (!opts.silent) {
      process.stderr.write(
        `  Permissions: already in sync (allow: ${merged.allow.length} entries; defaultMode: ${merged.defaultMode ?? 'omitted'}).\n`,
      );
    }
    return { installed: 0, kept: 0, skipped: 1 };
  }

  // Case 4: operator edited after last install — preserve
  if (lastInstalledHash !== undefined && existingHash !== lastInstalledHash) {
    if (!opts.silent) {
      process.stderr.write(
        `  Permissions: operator-edited since last install — preserving. ` +
          `Use \`npx massu permissions check-drift\` to inspect.\n`,
      );
    }
    return { installed: 0, kept: 1, skipped: 0 };
  }

  // Case 2/3: write merged
  const nextSettings: Record<string, unknown> = { ...local, permissions: merged };
  writeSettingsLocalAtomic(resolvedDir, nextSettings);
  manifest.entries[MANIFEST_KEY_PERMISSIONS] = expectedHash;

  // Post-write fail-loud assertion: re-read, confirm defaultMode propagation
  const onDisk = readSettingsLocal(resolvedDir);
  const onDiskPerm = (onDisk.permissions as Record<string, unknown> | undefined) ?? {};
  if (merged.defaultMode !== undefined) {
    const diskDefaultMode = onDiskPerm.defaultMode;
    if (diskDefaultMode !== merged.defaultMode) {
      throw new InstallPermissionsAssertionError(
        `Post-write assertion failed: expected permissions.defaultMode="${merged.defaultMode}" on disk, ` +
          `got ${JSON.stringify(diskDefaultMode)}. This indicates a filesystem race or write failure.`,
      );
    }
  }
  const diskAllow = Array.isArray(onDiskPerm.allow) ? (onDiskPerm.allow as unknown[]) : [];
  for (const entry of MASSU_PERMISSION_ENTRIES) {
    if (!diskAllow.includes(entry)) {
      throw new InstallPermissionsAssertionError(
        `Post-write assertion failed: canonical entry "${entry}" missing from permissions.allow on disk.`,
      );
    }
  }

  if (!opts.silent) {
    process.stderr.write(
      `  Wrote merged permissions block to .claude/settings.local.json ` +
        `(allow: ${merged.allow.length} entries; defaultMode: ${merged.defaultMode ?? 'omitted'}).\n`,
    );
  }
  return { installed: 1, kept: 0, skipped: 0 };
}

// ============================================================
// verifyPermissions (read-only)
// ============================================================

export function verifyPermissions(claudeDir: string): {
  missing: string[];
  allowList: readonly string[];
} {
  const local = readSettingsLocal(claudeDir);
  const permissions = (local.permissions as { allow?: unknown[] } | undefined) ?? {};
  const allow = Array.isArray(permissions.allow)
    ? (permissions.allow as unknown[]).filter((e): e is string => typeof e === 'string')
    : [];
  return {
    missing: findMissingEntries(allow),
    allowList: allow,
  };
}

// ============================================================
// checkPermissionsDrift (extended diagnostic)
// ============================================================

/**
 * Known-bad top-level setting keys that look like permission settings but
 * are NOT documented at code.claude.com/docs/en/settings. Reports as
 * `drift[unknown-key]`. Conservative list: only flags strings that are
 * clearly typo-equivalents of documented keys or that have been observed
 * in the wild causing confusion.
 */
const KNOWN_UNKNOWN_KEYS = new Set<string>([
  // From operator's observed ~/.claude/settings.json: top-level key that is
  // NOT in the docs (looks like a typo/wishful-thinking of skipDangerousModePermissionPrompt).
  'skipAutoPermissionPrompt',
]);

export function checkPermissionsDrift(
  claudeDir: string,
  opts: { global?: Record<string, unknown> } = {},
): { driftItems: DriftItem[] } {
  const global = opts.global ?? readGlobalSettings();
  const local = readSettingsLocal(claudeDir);
  const items: DriftItem[] = [];

  // (a) missing-allow
  const localPerm = (local.permissions as Record<string, unknown> | undefined) ?? {};
  const allow = Array.isArray(localPerm.allow)
    ? (localPerm.allow as unknown[]).filter((e): e is string => typeof e === 'string')
    : [];
  const missing = findMissingEntries(allow);
  for (const entry of missing) {
    items.push({
      kind: 'missing-allow',
      detail: `Canonical massu allowlist entry missing from permissions.allow: "${entry}"`,
      remediation: 'Run `npx massu permissions install` to seed.',
    });
  }

  // (b) invalid-default-mode
  const invalidMode = detectInvalidDefaultMode(local);
  if (invalidMode.invalid && invalidMode.mode) {
    items.push({
      kind: 'invalid-default-mode',
      detail: `defaultMode "${invalidMode.mode}" requires --permission-mode launch flag per code.claude.com/docs/en/permission-modes — settings-file value alone is inert.`,
      remediation:
        `Launch with --permission-mode ${invalidMode.mode} OR change defaultMode to one of {default, acceptEdits, plan}.`,
    });
  }

  // (c) strips-global-defaultmode (v3 — the F15+F16 trap)
  const globalPerm = (global.permissions as { defaultMode?: unknown } | undefined) ?? {};
  const localHasPermissions =
    local.permissions !== undefined && local.permissions !== null && typeof local.permissions === 'object';
  const localHasDefaultMode = typeof (localPerm as { defaultMode?: unknown }).defaultMode === 'string';
  const globalHasDefaultMode = typeof globalPerm.defaultMode === 'string';
  if (localHasPermissions && !localHasDefaultMode && globalHasDefaultMode) {
    items.push({
      kind: 'strips-global-defaultmode',
      detail:
        `Project-local permissions object omits defaultMode while global ~/.claude/settings.json has ` +
        `defaultMode="${globalPerm.defaultMode as string}". Per empirical observation (2026-05-14) the ` +
        `merge unit is the entire permissions object, so the global defaultMode is silently stripped.`,
      remediation:
        'Run `npx massu permissions install` to write the full merged permissions block (auto-propagates global defaultMode).',
    });
  }

  // (d) unknown-key (top-level only)
  for (const key of Object.keys(local)) {
    if (KNOWN_UNKNOWN_KEYS.has(key)) {
      items.push({
        kind: 'unknown-key',
        detail: `Top-level settings key "${key}" is not documented at code.claude.com/docs/en/settings — silently ignored by Claude Code.`,
        remediation: `Remove or replace with a documented key (e.g. skipDangerousModePermissionPrompt).`,
      });
    }
  }

  return { driftItems: items };
}

// Suppress unused-import warning: getConfig is imported for future use (e.g.,
// resolving config.conventions.claudeDirName from a higher-level caller).
void getConfig;
