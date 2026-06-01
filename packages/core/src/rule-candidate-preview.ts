// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PA3-005 (plan-2026-06-01-team-shared-promotion-phase-3, Stream A): the
 * RENDER-ONLY preview for a hardened (executable-destination) team promotion.
 *
 * Operator decision 2026-06-01: a teammate's `pattern-scanner` bash / a
 * `custom-destination` file-write is RENDERED and shown for two-operator review
 * but is NEVER EXECUTED on the receiving seat. The S5 injection/escape BLOCK is
 * resolved by elimination — there is no sandbox to escape. This module is PURE
 * string/IO-on-the-sidecar only and MUST NOT import `child_process` (the PA3-006
 * drift-guard asserts this); it never spawns, never execs, never touches the real
 * pattern-scanner / repo path.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { RuleDestination } from './rule-candidate-applier.ts';
import type { ReviewAttestation } from './rule-candidate-hardened.ts';

/** A render-only preview: the exact text that WOULD apply + non-executing risk notes. */
export interface HardenedPreview {
  destination: RuleDestination;
  /** The verbatim text that would be applied (bash for pattern-scanner; the body
   *  for custom-destination) — DISPLAYED, never run. */
  rendered: string;
  /** Non-executing, string-level risk findings for the two operators to weigh. */
  riskFindings: string[];
}

/**
 * High-signal risk tokens surfaced (NOT auto-rejected) for human review. This is
 * a static, non-executing string scan — advisory context only.
 */
const RISK_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\brm\s+-[a-z]*r[a-z]*f?\b|\brm\s+-[a-z]*f[a-z]*r\b/i, label: 'rm -rf (recursive/forced delete)' },
  { re: /\|\s*(sh|bash|zsh|dash)\b/i, label: 'pipe-to-shell (| sh)' },
  { re: /\b(curl|wget|nc|ncat|telnet|ssh|scp)\b/i, label: 'network tool (curl/wget/nc/ssh/...)' },
  { re: /\beval\b/i, label: 'eval' },
  { re: /\$\([^)]*\)|`[^`]*`/, label: 'command substitution $(...) / backticks' },
  { re: />\s*(\/|~|\$HOME|\.\.)/i, label: 'redirect to absolute / home / parent path' },
  { re: /\bsudo\b/i, label: 'sudo (privilege escalation)' },
  { re: /\b(chmod|chown)\b/i, label: 'permission change (chmod/chown)' },
  { re: /\bdd\b\s|\bmkfs\b|\b:\(\)\s*\{/i, label: 'destructive/forkbomb pattern' },
  { re: /\b(base64|xxd)\b.*\|/i, label: 'encoded payload piped' },
];

/**
 * Build a render-only preview of a hardened promotion's body. PURE — no exec, no
 * spawn. `rendered` is shown verbatim to the two operators; `riskFindings` lists
 * the static risk tokens matched (advisory).
 */
export function renderHardenedPreview(
  destination: RuleDestination,
  body: string,
): HardenedPreview {
  const rendered = String(body ?? '');
  const riskFindings = RISK_PATTERNS.filter((p) => p.re.test(rendered)).map((p) => p.label);
  return { destination, rendered, riskFindings };
}

/** Error thrown when an attestation fails the structural shape check. */
export class InvalidReviewAttestationError extends Error {
  constructor(issue: string) {
    super(`invalid review attestation: ${issue}`);
    this.name = 'InvalidReviewAttestationError';
  }
}

/**
 * Validate the shape of a {@link ReviewAttestation} (the receiving seat's
 * two-operator + render-only ack). Returns the validated attestation or throws.
 * Mirrors the applier's apply-gate checks so a malformed ack is rejected at
 * record time, not just apply time.
 */
export function validateReviewAttestation(att: unknown): ReviewAttestation {
  if (!att || typeof att !== 'object') {
    throw new InvalidReviewAttestationError('must be an object');
  }
  const a = att as Record<string, unknown>;
  if (typeof a.second_operator_id !== 'string' || a.second_operator_id.length === 0) {
    throw new InvalidReviewAttestationError('second_operator_id must be a non-empty string');
  }
  const ack = a.dry_run_ack as Record<string, unknown> | undefined;
  if (!ack || typeof ack !== 'object' || ack.ack !== true || typeof ack.ran_at !== 'string') {
    throw new InvalidReviewAttestationError('dry_run_ack must be { ran_at: string, ack: true }');
  }
  return {
    second_operator_id: a.second_operator_id,
    dry_run_ack: {
      ran_at: ack.ran_at as string,
      ...(typeof ack.exit_code === 'number' ? { exit_code: ack.exit_code } : {}),
      ack: true,
    },
  };
}

/**
 * Record the receiver's review attestation onto a hardened-pending candidate
 * sidecar's `provenance.review_attestation` (the `/massu-rule review` step). The
 * applier's hardened apply-gate (PA3-004) then permits the apply. Validates the
 * attestation shape AND that the second operator differs from the promoter before
 * writing. NO exec — pure sidecar read/modify/write.
 */
export function recordHardenedReviewAttestation(
  sidecarPath: string,
  attestation: unknown,
): void {
  if (!existsSync(sidecarPath)) {
    throw new Error(`candidate sidecar not found: ${sidecarPath}`);
  }
  const validated = validateReviewAttestation(attestation);
  const raw = readFileSync(sidecarPath, 'utf-8');
  const sidecar = JSON.parse(raw) as Record<string, unknown>;
  const prov = sidecar.provenance as Record<string, unknown> | undefined;
  if (!prov || prov.origin !== 'team' || prov.hardened !== true) {
    throw new Error('sidecar is not a hardened team-origin candidate — refusing to attach an attestation');
  }
  if (validated.second_operator_id === prov.promoted_by) {
    throw new InvalidReviewAttestationError(
      'second_operator_id equals the promoter — two-operator review requires a distinct operator',
    );
  }
  prov.review_attestation = validated;
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf-8');
}
