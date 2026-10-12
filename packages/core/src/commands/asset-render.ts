// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Asset RENDERING — the bytes a bundled asset becomes for this consumer.
 *
 * ⛔ WHY THIS MODULE EXISTS, measured 2026-09-21.
 *
 * `install-commands.ts:688` prints this to a user whose local copy of an asset has changed:
 *
 *     To diff:  diff <target> <(npx massu show-template <base>)
 *
 * The left-hand side is what the installer WROTE — rendered. The right-hand side was the raw
 * bundled file — `show-template` read it off disk and printed it. **43 of the 67 shipped
 * commands carry 305 `{{…}}` tokens**, so for two thirds of the catalogue that command
 * reported hundreds of edits on a file nobody had touched. The feature whose entire job is
 * "did I change this?" answered yes, always, and looked like it was working.
 *
 * Fragments would have been the 306th token, which is how this was found: P4.3b's item said
 * "`show-template` must resolve fragments too". It was undersized for its own goal — the
 * divergence was never about fragments, it was about there being TWO derivations of "the
 * resolved asset" and only one of them rendering.
 *
 * So there is now exactly one: `renderResolvedAsset`. The installer calls it per file;
 * `show-template` calls it once. A future render stage added here reaches both by
 * construction, and `asset-render-parity.test.ts` proves the property over the whole shipped
 * population rather than trusting that it stays true.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getConfig } from '../config.ts';
import type { Config } from '../config.ts';
import { renderTemplate, MissingVariableError, TemplateParseError } from './template-engine.ts';
import { makeFragmentResolver, type FragmentStats } from './fragments.ts';
import { pickVariant, variantFilename } from './asset-resolution.ts';
import {
  resolveStackCapabilities,
  StackContractError,
  STACK_CONTRACT_VERSION,
} from '../stack-capabilities.ts';
import type { StackCapabilities, VerifyKey } from '../stack-capabilities.ts';

/**
 * What `stack` carries when the config cannot satisfy the contract. A distinct shape, not a
 * half-filled StackCapabilities: 'this stack declares no commands' and 'this stack declares
 * these commands' must never be the same value with different contents.
 */
interface UnsatisfiedStack {
  contractVersion: number;
  satisfied: false;
  reason: string;
  stackName: string;
  unsatisfiedKey?: VerifyKey;
}

/**
 * Build the variable scope passed to the templating engine.
 * See spec §"Variable scope passed to the engine" for the contract.
 */
export function buildTemplateVars(): Record<string, unknown> {
  const config = getConfig();
  // P2.3 (plan-2026-09-20-stack-conformant-asset-rendering): the Stack Capability Contract.
  // Assets reference `{{verify.test}}` / `{{verify.type}}` instead of hardcoding a
  // toolchain, so what renders is the customer's DECLARED stack.
  //
  // WHY THIS CATCHES, HAVING FIRST BEEN WRITTEN NOT TO.
  // `resolveStackCapabilities` fails closed — correct for the resolver. Letting that throw
  // from HERE is a different question, and the answer is measured: a StackContractError is
  // not a MissingVariableError, so the render path at :508 does NOT catch it and :515
  // re-throws, ABORTING THE WHOLE INSTALL. Every customer whose `massu.config.yaml`
  // predates the `verification:` block would get a hard failure and no assets at all —
  // a brick, and a brick gets bypassed (CR-72). Twelve tests across two files, built from
  // faithful copies of four real consumer repos, went red on exactly that.
  //
  // Nor may it silently omit: after P4 migrates the assets, `{{verify.test}}` would raise
  // MissingVariableError, and the message a customer sees — "Template variable not found:
  // verify.test" — names the symptom and hides the cause.
  //
  // So the contract's ABSENCE is made first-class instead: `stack` is always present and
  // carries `satisfied` plus the resolver's own message, one stderr line states the real
  // cause at install time, and per-asset adjudication (OK / REFUSED / FOREIGN_LAYOUT) is
  // P5's job, which is where this plan puts it.
  let stack: StackCapabilities | UnsatisfiedStack;
  let verifyVars: Record<string, unknown>;
  try {
    const caps = resolveStackCapabilities(config);
    stack = caps;
    verifyVars = { verify: caps.verify, verifyByLang: caps.verifyByLang };
  } catch (err) {
    if (!(err instanceof StackContractError)) throw err;
    stack = {
      contractVersion: STACK_CONTRACT_VERSION,
      satisfied: false,
      reason: err.message,
      stackName: err.stackName,
      unsatisfiedKey: err.verifyKey,
    };
    // Loud and attributable, once per install — never a silent omission (M1/M2).
    process.stderr.write(
      `massu: stack capability contract UNSATISFIED — ${err.message}\n` +
        `massu:   assets that need a verification command will be reported by ` +
        `\`massu doctor\`; add a \`verification:\` block to massu.config.yaml to resolve them.\n`,
    );
    verifyVars = {};
  }

  return {
    framework: config.framework,
    paths: config.paths,
    detected: config.detected ?? {},
    config,
    /**
     * Present only when the contract is satisfied. Absent is deliberate: an asset that
     * needs a command it cannot get must fail ITS OWN file loudly rather than render an
     * empty string, which is a check that runs nothing and exits 0.
     */
    ...verifyVars,
    /** Always present, satisfied or not, so a consumer can ask WHICH state it is in. */
    stack,
    // P-H006 (plan-stage-c-high-batch): RESERVED CLAUDE CODE PLACEHOLDER.
    // Claude Code reads `{{ARGUMENTS}}` as a runtime placeholder inside
    // slash-command files. The Massu template engine has no native concept
    // of reserved literals; we model the placeholder as a variable whose
    // value IS the literal `{{ARGUMENTS}}` string. Because the engine never
    // re-renders output, this passes through verbatim. Closes the bug class
    // where `/massu-article-review`, `/massu-autoresearch`, etc. silently
    // failed to install because the engine threw MissingVariableError on
    // their {{ARGUMENTS}} usage.
    ARGUMENTS: '{{ARGUMENTS}}',
  };
}

/**
 * Everything needed to turn a bundled asset into the bytes a consumer receives.
 *
 * Built ONCE per command invocation, never per file: `buildTemplateVars` resolves the stack
 * capability contract and emits one stderr line when it is unsatisfied. Per-file construction
 * would repeat that warning once per asset, and a warning printed 67 times is a warning
 * nobody reads.
 */
export interface RenderInputs {
  vars: Record<string, unknown>;
  /**
   * Optional: absent means `{{> name}}` degrades to its diagnostic rather than resolving.
   * `rule-candidate-applier` renders through an engine with no fragment support, and that
   * must keep working — a fragment token in a learned rule may not explode (D5).
   */
  resolveFragment?: (name: string) => string | null;
}

export interface RenderContext extends RenderInputs {
  resolveFragment: (name: string) => string | null;
  /** Mutated by `resolveFragment`; read after a run to report what resolved. */
  fragments: FragmentStats;
}

export function makeRenderContext(framework: Config['framework']): RenderContext {
  const fragments: FragmentStats = { resolved: 0, defaulted: 0, missing: 0 };
  return {
    vars: buildTemplateVars(),
    resolveFragment: makeFragmentResolver(framework, fragments),
    fragments,
  };
}

/**
 * What a render attempt produced.
 *
 * ⛔ THREE OUTCOMES, NOT TWO. `miss` (this stack selects no file) and `error` (a file was
 * selected and would not render) are different facts with different remedies, and collapsing
 * them into "no output" is the shape that hid the original bug: the installer's catch turned
 * a render failure into `stats.skipped++` and exit 0, which is indistinguishable from an asset
 * that was never meant to install here.
 */
export type RenderedAsset =
  | { kind: 'ok'; sourcePath: string; sourceFilename: string; content: string }
  | { kind: 'miss' }
  | { kind: 'error'; sourcePath: string; message: string };

/**
 * Resolve `baseName` against `sourceDir` for this stack and render it.
 *
 * The ONE place that answers "what does this consumer receive for this asset". Both
 * `syncDirectory` (per file, during install) and `show-template` (once, for a diff) go
 * through here, so the two can no longer disagree.
 */
export function renderResolvedAsset(
  baseName: string,
  sourceDir: string,
  framework: Config['framework'],
  ctx: RenderInputs,
): RenderedAsset {
  const choice = pickVariant(baseName, sourceDir, framework);
  const sourceFilename = variantFilename(baseName, choice);
  if (sourceFilename === null) return { kind: 'miss' };
  return renderAssetFile(resolve(sourceDir, sourceFilename), sourceFilename, ctx);
}

/**
 * Render a source file whose path is already known.
 *
 * Split out because the installer walks NESTED asset directories too, where the filename is
 * the directory entry itself and variant resolution does not apply. Those files still have to
 * render through the same code as every other one — a nested asset that silently skipped the
 * engine would be the same class of divergence one level down.
 */
export function renderAssetFile(
  sourcePath: string,
  sourceFilename: string,
  ctx: RenderInputs,
): RenderedAsset {
  let rawContent: string;
  try {
    rawContent = readFileSync(sourcePath, 'utf-8');
  } catch (err) {
    // Selected but unreadable is an ERROR, never an empty render (M2). A race between the
    // existence probe and the read, a directory where a file belongs, a permissions problem —
    // all of them must name themselves rather than produce zero bytes.
    return {
      kind: 'error',
      sourcePath,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    return {
      kind: 'ok',
      sourcePath,
      sourceFilename,
      content: renderTemplate(rawContent, ctx.vars, { resolveFragment: ctx.resolveFragment }),
    };
  } catch (err) {
    if (err instanceof MissingVariableError || err instanceof TemplateParseError) {
      return { kind: 'error', sourcePath, message: err.message };
    }
    // Anything else is a bug in the engine, not a bad asset. Let it out.
    throw err;
  }
}
