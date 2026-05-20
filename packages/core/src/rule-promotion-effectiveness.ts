// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-D-004: CR-53 effectiveness check.
// Dual-channel observability — exported helper consumed by both the
// drift-guard vitest test and the /massu-learning-audit Section 6
// report. See `__tests__/rule-promotion-effectiveness.test.ts` for the
// drift-guard cases.

import { readFileSync, existsSync } from 'fs';
import type Database from 'better-sqlite3';

export interface KnownLimitation {
  promptHash: string;
  reason: string;
}

export interface AuditViolation {
  auditLogId: number;
  promptHash: string;
  filePath: string | null;
  recurrenceCount: number;
  timestamp: string;
}

export interface FailureLogViolation {
  rawLine: string;
  timestamp?: string;
  error?: string;
}

export interface EvaluateCr53Inputs {
  db: Database.Database;
  failureLogPath: string;
  knownLimitations: KnownLimitation[];
}

export interface EvaluateCr53Result {
  ok: boolean;
  auditViolations: AuditViolation[];
  failureLogViolations: FailureLogViolation[];
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Evaluate CR-53 invariant. Returns `ok=false` if either:
 *   (a) any `rule_promoted` audit_log row older than 7 days has
 *       `recurrence_count > 0` AND its prompt_hash is NOT in
 *       `knownLimitations`, OR
 *   (b) the failure-log file exists AND contains entries with a
 *       timestamp within the last 7 days.
 *
 * Channel (b) is intentionally NOT silenced by knownLimitations —
 * failure-log entries represent unknown CR-53 increment failures
 * that need investigation, not a documented rule limitation.
 */
export function evaluateCr53Effectiveness(inputs: EvaluateCr53Inputs): EvaluateCr53Result {
  const { db, failureLogPath, knownLimitations } = inputs;
  const allowlist = new Set(knownLimitations.map(k => k.promptHash));

  const auditRows = db.prepare(`
    SELECT id, file_path, metadata, timestamp
    FROM audit_log
    WHERE event_type = 'rule_promoted'
      AND timestamp < datetime('now', '-7 days')
      AND json_extract(metadata, '$.recurrence_count') > 0
    LIMIT 10000
  `).all() as Array<{ id: number; file_path: string | null; metadata: string; timestamp: string }>;

  const auditViolations: AuditViolation[] = [];
  for (const row of auditRows) {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(row.metadata) as Record<string, unknown>; } catch { /* malformed metadata still surfaces */ }
    const promptHash = String(meta.prompt_hash ?? '');
    if (allowlist.has(promptHash)) continue;
    const recurrenceCount = Number(meta.recurrence_count ?? 0);
    auditViolations.push({
      auditLogId: row.id,
      promptHash,
      filePath: row.file_path,
      recurrenceCount,
      timestamp: row.timestamp,
    });
  }

  const failureLogViolations: FailureLogViolation[] = [];
  if (existsSync(failureLogPath)) {
    try {
      const raw = readFileSync(failureLogPath, 'utf-8');
      const cutoff = Date.now() - SEVEN_DAYS_MS;
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: Record<string, unknown>;
        try { entry = JSON.parse(trimmed) as Record<string, unknown>; }
        catch {
          // Malformed line: surface it as a violation rather than silently
          // dropping (better to report a corrupt log than to soft-pass).
          failureLogViolations.push({ rawLine: trimmed, error: 'malformed JSON' });
          continue;
        }
        const ts = String(entry.timestamp ?? '');
        if (!ts) {
          failureLogViolations.push({ rawLine: trimmed, error: 'missing timestamp' });
          continue;
        }
        const parsed = Date.parse(ts);
        if (Number.isNaN(parsed)) {
          failureLogViolations.push({ rawLine: trimmed, error: `invalid timestamp ${ts}` });
          continue;
        }
        if (parsed >= cutoff) {
          failureLogViolations.push({
            rawLine: trimmed,
            timestamp: ts,
            error: entry.error ? String(entry.error) : undefined,
          });
        }
      }
    } catch {
      // Best-effort — failure to read the file does not count as a violation
    }
  }

  return {
    ok: auditViolations.length === 0 && failureLogViolations.length === 0,
    auditViolations,
    failureLogViolations,
  };
}

export function parseKnownLimitations(envVar: string | undefined): KnownLimitation[] {
  if (!envVar) return [];
  try {
    const parsed = JSON.parse(envVar) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: KnownLimitation[] = [];
    for (const item of parsed) {
      if (item && typeof item === 'object' && 'promptHash' in item && 'reason' in item) {
        const promptHash = String((item as { promptHash: unknown }).promptHash);
        const reason = String((item as { reason: unknown }).reason);
        if (promptHash) out.push({ promptHash, reason });
      }
    }
    return out;
  } catch {
    return [];
  }
}
