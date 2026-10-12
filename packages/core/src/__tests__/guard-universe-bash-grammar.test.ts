/**
 * The vendored bash grammar loads, is content-pinned, and FAILS CLOSED.
 *
 * D-3a's resolver concludes things about references. "I could not parse" must therefore be
 * impossible to confuse with "I parsed and found nothing" — a resolver that degraded to an
 * empty set would report every tracked script as unreferenced, which is indistinguishable
 * from the real CR-71 finding it exists to produce.
 *
 * Every failure assertion below is paired with a POSITIVE CONTROL on the same code path, so
 * "it refused" and "it never ran" cannot look the same (G17/CR-72).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BASH_GRAMMAR_PROVENANCE,
  BASH_GRAMMAR_SHA256,
  BashGrammarUnavailableError,
  __resetBashGrammarCacheForTests,
  bashGrammarPath,
  bashParser,
  loadBashLanguage,
} from '../guard-universe/resolve-static-references.ts';

const scratchDirs: string[] = [];
function scratch(): string {
  // NOTE: a plain mktemp-style path can contain a dot, and a path is itself an input that can
  // select a branch — this repo has been bitten by a fixture path steering a code path before.
  const d = mkdtempSync(join(tmpdir(), 'massu-bash-grammar-'));
  scratchDirs.push(d);
  return d;
}
afterEach(() => {
  __resetBashGrammarCacheForTests();
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

describe('WASM resource lifetime — the property, not a memory threshold', () => {
  // A CI worker died with `# Fatal process out of memory: Zone` / v8::base::FatalOOM, twice,
  // because the first version of this module built a NEW Parser per call and deleted neither
  // it nor the resulting Tree. Both own allocations in the WASM module's LINEAR MEMORY, which
  // the JS garbage collector cannot reclaim. Measured over the 148-file corpus:
  //
  //                    before     50 files   100 files   148 files
  //   leaking shape    90.3MB     288.5MB    420.0MB     543.4MB   (linear, still climbing)
  //   fixed            90.3MB     192.7MB    208.5MB     208.9MB   (flat after a one-time
  //                                                                 WASM heap allocation)
  //
  // The JS heap stayed ~10MB throughout the leaking run, so `heapUsed` would have looked
  // innocent — which is why this is asserted as a STRUCTURAL property below rather than as a
  // memory bound. An absolute MB threshold is a claim about the host and fails in both
  // directions; parser identity is deterministic on every machine.

  it('bashParser() is MEMOISED — one parser, not one per call', async () => {
    const a = await bashParser();
    const b = await bashParser();
    expect(a).toBe(b);
  });

  it('an OVERRIDE is never served the memoised parser', async () => {
    // Otherwise a fixture injecting a broken grammar would silently be handed the good one
    // and its assertion would pass vacuously — the failure path would be untestable.
    const shared = await bashParser();
    const overridden = await bashParser(bashGrammarPath());
    expect(overridden).not.toBe(shared);
  });

  it('resetting the cache frees the parser and a later call still works', async () => {
    const first = await bashParser();
    __resetBashGrammarCacheForTests();
    const second = await bashParser();
    expect(second).not.toBe(first);
    expect(second.parse('echo hi')).not.toBeNull();
  });
});

describe('vendored bash grammar', () => {
  it('the vendored asset on disk matches the pin recorded in source', () => {
    const bytes = readFileSync(bashGrammarPath());
    // Denominator, not just a boolean: a zero-length read must never read as agreement.
    expect(bytes.length).toBeGreaterThan(0);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(BASH_GRAMMAR_SHA256);
    expect(BASH_GRAMMAR_PROVENANCE).toContain('tree-sitter-bash@0.25.1');
  });

  it('POSITIVE CONTROL — loads, and parses the exact indirection shape D-3a must resolve', async () => {
    const parser = await bashParser();
    const src = [
      'set -euo pipefail',
      '_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      '. "$_dir/leak-patterns-operator.sh"',
      'bash scripts/ops/other.sh --flag',
      'cat <<EOF',
      'rm -rf /this/is/a/heredoc/body/not/argv',
      'EOF',
    ].join('\n');
    const tree = parser.parse(src);
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('program');
    expect(tree!.rootNode.hasError).toBe(false);

    // THE LEXER LESSON, ASSERTED RATHER THAN TRUSTED: the `rm -rf` inside the heredoc must be
    // a heredoc BODY, never a command. A shlex pass in this repo lexed exactly this as argv.
    const types: string[] = [];
    const walk = (n: { type: string; namedChildren: unknown[] }): void => {
      types.push(n.type);
      for (const c of n.namedChildren) walk(c as { type: string; namedChildren: unknown[] });
    };
    walk(tree!.rootNode as unknown as { type: string; namedChildren: unknown[] });
    expect(types).toContain('heredoc_body');
    // and the heredoc's contents must NOT have been parsed as a command node
    const heredocNode = tree!.rootNode.descendantsOfType('heredoc_body')[0];
    expect(heredocNode?.text).toContain('rm -rf');
    expect(heredocNode?.descendantsOfType('command').length ?? 0).toBe(0);
  });

  it('MUST FIRE — a CORRUPTED grammar fails its content pin and throws', async () => {
    const dir = scratch();
    const bad = join(dir, 'tree-sitter-bash.wasm');
    copyFileSync(bashGrammarPath(), bad);
    const bytes = readFileSync(bad);
    bytes[bytes.length - 1] ^= 0xff; // one flipped bit is enough
    writeFileSync(bad, bytes);

    await expect(loadBashLanguage(bad)).rejects.toThrow(BashGrammarUnavailableError);
    await expect(loadBashLanguage(bad)).rejects.toThrow(/failed its content pin/);

    // NEGATIVE CONTROL — prove the injection is what failed, not the override path itself.
    const good = join(dir, 'good.wasm');
    copyFileSync(bashGrammarPath(), good);
    await expect(loadBashLanguage(good)).resolves.toBeTruthy();
  });

  it('MUST FIRE — a MISSING grammar throws rather than returning an empty result', async () => {
    const missing = join(scratch(), 'does-not-exist.wasm');
    await expect(loadBashLanguage(missing)).rejects.toThrow(BashGrammarUnavailableError);
    await expect(loadBashLanguage(missing)).rejects.toThrow(/could not be read/);
  });

  it('MUST FIRE — an EMPTY grammar throws (0 bytes is the classic empty-on-failure pass)', async () => {
    const dir = scratch();
    const empty = join(dir, 'empty.wasm');
    writeFileSync(empty, Buffer.alloc(0));
    await expect(loadBashLanguage(empty)).rejects.toThrow(/is empty \(0 bytes\)/);
  });

  it('a failure NEVER poisons the memoised default path', async () => {
    const dir = scratch();
    const bad = join(dir, 'bad.wasm');
    writeFileSync(bad, Buffer.from('not a wasm module'));
    await expect(loadBashLanguage(bad)).rejects.toThrow(BashGrammarUnavailableError);
    // the real grammar must still load afterwards
    await expect(loadBashLanguage()).resolves.toBeTruthy();
  });
});
