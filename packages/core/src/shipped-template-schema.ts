// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { z } from 'zod';
import { RawConfigSchema, VerificationEntrySchema } from './config.ts';

// ============================================================
// SHIPPED-TEMPLATE SCHEMA (P3.3, plan-2026-09-20-stack-conformant-asset-rendering)
// ============================================================

/**
 * A STRICTER schema, applied ONLY to the stack templates massu itself ships.
 *
 * WHY A SECOND SCHEMA RATHER THAN TIGHTENING `RawConfigSchema`.
 * One schema validates two populations that must be held to different standards:
 *
 *   massu's 13 shipped templates — massu controls them. A missing verification key is a
 *     massu BUG and must be impossible to ship.
 *   a CUSTOMER's massu.config.yaml — massu does not control it. A missing key is a
 *     situation to REPORT, never a reason to refuse to run.
 *
 * Tightening `RawConfigSchema` would hit both. Config validation throws on a parse
 * failure and 74 non-test source files call `getConfig()`, so one missing key would cost
 * a customer every massu command — including the `doctor` that would have diagnosed it.
 * That is a brick, and a brick gets bypassed (CR-72). The identical mistake one layer
 * down — letting the capability resolver throw out of `buildTemplateVars` — turned 12
 * tests red, built from faithful copies of four real consumer repos.
 *
 * Version skew is not a risk here, and that is precisely what makes strictness safe:
 * templates ship INSIDE the package, so a template and this schema always travel together.
 *
 * The customer-side half of the requirement is served where it belongs: the runtime
 * capability contract reports an unsatisfied stack as first-class data instead of
 * crashing, and per-asset conformance refuses the individual assets that need what is
 * missing.
 */
const REQUIRED_TEMPLATE_VERIFY_KEYS = ['test', 'type', 'lint'] as const;

export const ShippedTemplateConfigSchema = RawConfigSchema.extend({
  // Optional for a customer; MANDATORY for anything massu ships.
  verification: z.record(z.string(), VerificationEntrySchema),
}).superRefine((cfg, ctx) => {
  const framework = cfg.framework as { primary?: string; type?: string } | undefined;
  const primary = framework?.primary ?? framework?.type;
  if (typeof primary !== 'string' || primary.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['framework', 'primary'],
      message:
        'a shipped template must resolve a primary language (framework.primary or framework.type)',
    });
    return;
  }
  const primaryEntry = (cfg.verification as Record<string, Record<string, unknown>> | undefined)?.[primary];
  if (primaryEntry === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['verification', primary],
      message: `a shipped template must declare verification commands for its primary language '${primary}'`,
    });
    return;
  }
  for (const required of REQUIRED_TEMPLATE_VERIFY_KEYS) {
    const value = primaryEntry[required];
    // An EMPTY STRING is absence, not a declaration: it renders as a command that runs
    // nothing and exits 0 — a check that reports success because it could not run.
    if (typeof value !== 'string' || value.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verification', primary, required],
        message: `a shipped template must declare a non-empty '${required}' command for '${primary}'`,
      });
    }
  }
});

/**
 * Outcome of validating one shipped template. Never a bare boolean: the caller must be
 * able to say WHICH stack failed and WHY without re-deriving it.
 */
export interface ShippedTemplateValidation {
  ok: boolean;
  stack: string;
  /** Human-readable issues, each already prefixed with the offending stack and path. */
  issues: string[];
}

/**
 * Validate one shipped template. `stack` is the template directory name, carried through
 * so the message names the offender instead of leaving the caller to guess.
 */
export function validateShippedTemplate(raw: unknown, stack: string): ShippedTemplateValidation {
  const result = ShippedTemplateConfigSchema.safeParse(raw);
  if (result.success) return { ok: true, stack, issues: [] };
  return {
    ok: false,
    stack,
    issues: result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${stack}: ${path}: ${issue.message}`;
    }),
  };
}
