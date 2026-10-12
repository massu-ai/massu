// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * The Stack Capability Contract — P2 of
 * docs/plans/2026-09-20-stack-conformant-asset-rendering.md
 *
 * ONE resolver, ONE type. Every asset that needs a toolchain command asks this instead of
 * hardcoding one, so the customer's declared stack is what actually renders.
 *
 * WHY THIS EXISTS. massu detects the customer's stack correctly and writes it into
 * `massu.config.yaml` — then ships every customer the same TypeScript-shaped command set,
 * which nothing reconciles against that config. Measured at 7daa9367: 60 of 133 shipped
 * assets hardcode a TS toolchain. In a Python repo those checks run against an absent tree,
 * find nothing, and report CLEAN — the blind-gate shape, shipped to paying customers.
 *
 * THE SSOT IS `Config['verification']` — the top-level `verification:` block, keyed by
 * LANGUAGE. `framework.languages` supplies the language ROSTER and never a command:
 * `LanguageFrameworkEntrySchema` (config.ts:319) declares no `type`/`lint`/`build`/`syntax`
 * member at all, and `framework.languages.<lang>.test` is set in 0 of 13 shipped templates.
 * Resolving commands from there would return `undefined` for every key on every stack.
 *
 * FAIL CLOSED (M2). A missing REQUIRED key is a hard error naming the stack and the key —
 * never `undefined`, never `''`. An empty substitution is precisely how a check that cannot
 * run comes to report success.
 */

import type { Config } from './config.ts';

/** Bumped when the shape or the resolution rules change in a way consumers must notice. */
export const STACK_CONTRACT_VERSION = 1;

/**
 * Every stack MUST declare these for its primary language. Measured across all 13 shipped
 * templates: test 13/13, type 13/13, lint 13/13.
 */
export const REQUIRED_VERIFY_KEYS = ['test', 'type', 'lint'] as const;

/**
 * Declared only where meaningful, and the asymmetry is the point: by PRIMARY language,
 * `build` is declared by 4 of 13 and `syntax` by 9 of 13 (compiled vs interpreted stacks).
 * A shared asset referencing `{{verify.build}}` is therefore unsatisfiable on 9 of 13 —
 * which is what the P5 conformance gate exists to REFUSE, not to crash on.
 */
export const OPTIONAL_VERIFY_KEYS = ['build', 'syntax'] as const;

export type VerifyKey =
  | (typeof REQUIRED_VERIFY_KEYS)[number]
  | (typeof OPTIONAL_VERIFY_KEYS)[number];

export const ALL_VERIFY_KEYS: readonly VerifyKey[] = [
  ...REQUIRED_VERIFY_KEYS,
  ...OPTIONAL_VERIFY_KEYS,
];

export interface StackCapabilities {
  contractVersion: number;
  /** `framework.primary ?? framework.type`. Only 1 of 13 templates sets `primary`. */
  primaryLanguage: string;
  /** The declared language roster, primary first. */
  languages: string[];
  /** Resolved against the PRIMARY language. An optional key with no declaration is `undefined`. */
  verify: Record<VerifyKey, string | undefined>;
  /** Every declared language, so a multi-runtime asset can ask explicitly. */
  verifyByLang: Record<string, Partial<Record<VerifyKey, string>>>;
  /** The real schema type, reached via `Config` — never re-declared here. */
  paths: Config['paths'];
  /** What THIS stack actually declares for its primary language. */
  declared: Set<VerifyKey>;
}

/**
 * Thrown when a stack cannot satisfy the contract. Never returns a partial capability set.
 *
 * The offending stack is carried on `stackName`, NOT on `stack`: `Error.stack` is the call
 * stack, and a consumer reading a stack trace where it meant the stack identifier is a bug
 * waiting to be written.
 */
export class StackContractError extends Error {
  readonly stackName: string;
  readonly verifyKey?: VerifyKey;
  constructor(stackName: string, message: string, verifyKey?: VerifyKey) {
    super(message);
    this.name = 'StackContractError';
    this.stackName = stackName;
    this.verifyKey = verifyKey;
  }
}

function stackLabel(config: Config): string {
  const name = config.project?.name;
  if (typeof name === 'string' && name.length > 0 && name !== '{{PROJECT_NAME}}') return name;
  return config.framework?.primary ?? config.framework?.type ?? '<unnamed stack>';
}

function isVerifyKey(candidate: string): candidate is VerifyKey {
  return (ALL_VERIFY_KEYS as readonly string[]).includes(candidate);
}

/**
 * Resolve a config into its capability set.
 *
 * @throws {StackContractError} when `verification:` is absent, when the primary language
 *   declares no verification block, or when any REQUIRED key is missing for it. Failing
 *   closed here is deliberate: the alternative is an empty command string reaching an
 *   asset, which renders as a check that silently does nothing.
 */
export function resolveStackCapabilities(config: Config): StackCapabilities {
  const label = stackLabel(config);

  const primaryLanguage = config.framework?.primary ?? config.framework?.type;
  if (typeof primaryLanguage !== 'string' || primaryLanguage.length === 0) {
    throw new StackContractError(
      label,
      `${label}: cannot resolve a primary language — neither framework.primary nor framework.type is set.`,
    );
  }

  // `verification:` is `.optional()` (config.ts:373). Absent is an ERROR, not an empty map:
  // "this stack declares no commands" and "this config predates the contract" must not
  // produce the same value.
  const verification = config.verification;
  if (verification === undefined || verification === null) {
    throw new StackContractError(
      label,
      `${label}: no top-level 'verification:' block. Every stack must declare ` +
        `${REQUIRED_VERIFY_KEYS.join('/')} for its primary language (${primaryLanguage}).`,
    );
  }

  // Roster from framework.languages (the language axis), unioned with the languages that
  // actually declare commands, so a language is never dropped merely because the roster
  // omits it.
  const roster = new Set<string>([primaryLanguage]);
  for (const lang of Object.keys(config.framework?.languages ?? {})) roster.add(lang);
  for (const lang of Object.keys(verification)) roster.add(lang);

  const verifyByLang: Record<string, Partial<Record<VerifyKey, string>>> = {};
  for (const lang of roster) {
    const entry = verification[lang];
    if (!entry) continue;
    const resolved: Partial<Record<VerifyKey, string>> = {};
    for (const [candidate, value] of Object.entries(entry)) {
      // A key outside the closed vocabulary is DATA, not a command. `VerificationEntrySchema`
      // is `.passthrough()` by design and `verification_types` lets customers declare new
      // VR-* types, so an unrecognised key is ignored here rather than rejected — but it is
      // never silently promoted into `verify` either.
      if (!isVerifyKey(candidate)) continue;
      if (typeof value === 'string' && value.length > 0) resolved[candidate] = value;
    }
    if (Object.keys(resolved).length > 0) verifyByLang[lang] = resolved;
  }

  const primaryEntry = verifyByLang[primaryLanguage];
  if (primaryEntry === undefined) {
    throw new StackContractError(
      label,
      `${label}: 'verification:' declares no commands for the primary language ` +
        `'${primaryLanguage}'. Declared languages: ${Object.keys(verifyByLang).join(', ') || '(none)'}.`,
    );
  }

  for (const required of REQUIRED_VERIFY_KEYS) {
    if (primaryEntry[required] === undefined) {
      throw new StackContractError(
        label,
        `${label}: required verification key '${required}' is not declared for the primary ` +
          `language '${primaryLanguage}'. Required: ${REQUIRED_VERIFY_KEYS.join(', ')}.`,
        required,
      );
    }
  }

  // An OPTIONAL key with no declaration is `undefined` — never `''`. The distinction is
  // load-bearing: `''` renders as a command that runs nothing and exits 0.
  const verify = {} as Record<VerifyKey, string | undefined>;
  for (const declaredKey of ALL_VERIFY_KEYS) verify[declaredKey] = primaryEntry[declaredKey];

  const declared = new Set<VerifyKey>(
    ALL_VERIFY_KEYS.filter((candidate) => primaryEntry[candidate] !== undefined),
  );

  const languages = [
    primaryLanguage,
    ...[...roster].filter((lang) => lang !== primaryLanguage).sort(),
  ];

  return {
    contractVersion: STACK_CONTRACT_VERSION,
    primaryLanguage,
    languages,
    verify,
    verifyByLang,
    paths: config.paths,
    declared,
  };
}
