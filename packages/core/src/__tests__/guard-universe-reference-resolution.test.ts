/**
 * D-3a reference extraction: one fixture per detection path, each demanded to FIRE, plus the
 * controls that must stay silent.
 *
 * The standing counterexample is `scripts/lib/leak-patterns.sh` → `leak-patterns-operator.sh`.
 * A first search in this repo reported that file as having NO caller, which looks exactly like
 * the CR-71 finding this resolver exists to surface. It was wrong on three counts: the search
 * excluded the directory the caller lives in, the path is built by BASH_SOURCE indirection so
 * no literal path exists to match, and it is sourced one level BELOW the entry point. If this
 * resolver ever reports it unreferenced, the resolver is RED no matter what else it gets right.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { referencesFrom } from '../guard-universe/resolve-static-references.ts';

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');

const dirs: string[] = [];
function fixture(contents: string, name = 'f.sh'): { root: string; rel: string } {
  const root = mkdtempSync(join(tmpdir(), 'massu-refres-'));
  dirs.push(root);
  writeFileSync(join(root, name), contents);
  return { root, rel: name };
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('the standing counterexample', () => {
  it('resolves leak-patterns.sh -> leak-patterns-operator.sh through two-step indirection', async () => {
    const refs = await referencesFrom('scripts/lib/leak-patterns.sh', REPO_ROOT);
    const hit = refs.find((r) => r.to === 'scripts/lib/leak-patterns-operator.sh');
    expect(hit, `resolver reported no edge to leak-patterns-operator.sh; got ${JSON.stringify(refs)}`).toBeDefined();
    expect(hit!.kind).toBe('source');
    expect(hit!.via).toBe('indirection');
    // The INVOCATION is line 82; the path is BUILT on line 81. Both are asserted, because the
    // retro that found this cited 81 — a line that invokes nothing — and citing only 82 would
    // discard the evidence that made the reference invisible to a line-anchored grep.
    expect(hit!.line).toBe(82);
    expect(hit!.constructedAtLine).toBe(81);
  });

  it('REGRESSION — the command NAME is never reported as its own argument', async () => {
    // `childForFieldName('name')` and `namedChildren` return distinct wrapper objects for the
    // same node, so filtering arguments by object identity silently kept the command name and
    // every `source "$x"` resolved to the word `source`. Filter by node TYPE.
    const refs = await referencesFrom('scripts/lib/leak-patterns.sh', REPO_ROOT);
    expect(refs.map((r) => r.unresolved)).not.toContain('source');
    expect(refs.every((r) => r.to !== 'source')).toBe(true);
  });
});

describe('detection paths — each must FIRE', () => {
  it('a LITERAL exec reference resolves', async () => {
    const { root, rel } = fixture('bash scripts/ops/other.sh --flag\n');
    const refs = await referencesFrom(rel, root);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ to: 'scripts/ops/other.sh', kind: 'exec', via: 'literal' });
  });

  it('a DIRECT execution of a .sh path resolves', async () => {
    const { root, rel } = fixture('./scripts/ops/direct.sh\n');
    const refs = await referencesFrom(rel, root);
    expect(refs.map((r) => r.to)).toContain('scripts/ops/direct.sh');
    expect(refs[0]!.kind).toBe('exec');
  });

  it('the `.` builtin is treated as source, not ignored', async () => {
    const { root, rel } = fixture('. ./lib/helper.sh\n');
    const refs = await referencesFrom(rel, root);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ to: 'lib/helper.sh', kind: 'source' });
  });

  it('single-step indirection through $SCRIPT_DIR resolves', async () => {
    const { root, rel } = fixture(
      'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nsource "$SCRIPT_DIR/sibling.sh"\n'
    );
    const refs = await referencesFrom(rel, root);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ to: 'sibling.sh', kind: 'source', via: 'indirection' });
    expect(refs[0]!.constructedAtLine).toBe(1);
    expect(refs[0]!.line).toBe(2);
  });

  it('a reference inside a CASE statement resolves — the construct that broke the grammar', async () => {
    // The first vendored grammar (the tree-sitter-wasms@0.1.13 repackage, ABI 14) could not
    // parse `case` AT ALL under web-tree-sitter ~0.25.10: emscripten's lazy dynamic-linking
    // stub threw `TypeError: resolved is not a function` from inside Parser.parse. 47 of 148
    // tracked *.sh files contain a `case`, so shipping that grammar would have made a third of
    // the corpus unparseable. This fixture is the reason a grammar swap can never regress it.
    const { root, rel } = fixture(
      'case "${CTX:-}" in\n  internal) source ./lib/internal.sh ;;\n  *) bash scripts/other.sh ;;\nesac\n'
    );
    const refs = await referencesFrom(rel, root);
    const targets = refs.map((r) => r.to);
    expect(targets).toContain('lib/internal.sh');
    expect(targets).toContain('scripts/other.sh');
  });

  it('EVERY tracked *.sh in this repo parses — the population, not a sample', async () => {
    // THE MECHANISM THIS FILE OWES. A grammar was once certified by these fixtures plus one
    // real file that happened to contain no `case`, and it could not parse 47 of 148 tracked
    // shell files (31%). Every individual check was sound; the POPULATION was wrong. A
    // positive control assembled from examples tests the examples — the only control that can
    // certify a parser for a corpus is the corpus.
    const tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '--', '*.sh'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);

    // M1: assert the denominator. "scanned 0, threw 0" must never read as health.
    expect(tracked.length, 'git ls-files returned no shell files — the check could not look').toBeGreaterThan(100);

    const failures: string[] = [];
    let parsed = 0;
    for (const f of tracked) {
      try {
        await referencesFrom(f, REPO_ROOT);
        parsed += 1;
      } catch (err) {
        failures.push(`${f}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
    }
    // Totals and details must agree, or a counted-but-unprinted failure is hiding.
    expect(parsed + failures.length).toBe(tracked.length);
    expect(failures, `parser failed on ${failures.length} of ${tracked.length} tracked shell files:\n${failures.join('\n')}`).toEqual([]);
  }, 120_000);

  it('an UNRESOLVABLE path is REPORTED, never dropped', async () => {
    const { root, rel } = fixture('source "$SOME_UNKNOWN_DIR/mystery.sh"\n');
    const refs = await referencesFrom(rel, root);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.to).toBeNull();
    // A silently discarded reference is a zero nobody can audit.
    expect(refs[0]!.unresolved).toContain('mystery.sh');
  });
});

describe('the heredoc GENERATOR rule — a body redirected into a file is code', () => {
  // Every one of these was found by pointing the resolver at scripts/install-hooks.sh, not by
  // reading it. Before the rule, that file resolved 0 references while generating three real
  // invocations; the first draft of the rule then produced a CONFIDENTLY WRONG path and a
  // FABRICATED reference before these fixtures pinned each part.

  it('MUST FIRE — a body redirected into a file is attributed to the GENERATED path', async () => {
    const { root, rel } = fixture('cat > gen/hook.sh <<EOF\nbash scripts/inner.sh\nEOF\n');
    const refs = await referencesFrom(rel, root);
    const hit = refs.find((r) => r.to === 'scripts/inner.sh');
    expect(hit, `expected an edge to scripts/inner.sh; got ${JSON.stringify(refs)}`).toBeDefined();
    // Attributed to the generated file, NOT to the generator.
    expect(hit!.from).toBe('gen/hook.sh');
  });

  it('SILENT CONTROL — an UNREDIRECTED heredoc body is still excluded', async () => {
    // This is the general rule the generator case must not weaken.
    const { root, rel } = fixture('cat <<EOF\nbash scripts/not-a-reference.sh\nEOF\n');
    const refs = await referencesFrom(rel, root);
    expect(refs.map((r) => r.to)).not.toContain('scripts/not-a-reference.sh');
  });

  it('MUST FIRE — `cat >>` bodies targeting one path are CONCATENATED, so bindings cross them', async () => {
    // `>>` appends: four heredocs writing one file produce ONE file. The real installer binds
    // REPO_ROOT and BATTERY in one append and invokes "$BATTERY" in a later one; parsing the
    // units separately reported UNRESOLVED for a path the generated file resolves fine.
    const { root, rel } = fixture(
      'cat > out.sh <<EOF\nTARGET="scripts/late.sh"\nEOF\ncat >> out.sh <<EOF\nbash "\\$TARGET"\nEOF\n'
    );
    const refs = await referencesFrom(rel, root);
    const hit = refs.find((r) => r.to === 'scripts/late.sh');
    expect(hit, `binding did not cross the append boundary; got ${JSON.stringify(refs)}`).toBeDefined();
    expect(hit!.from).toBe('out.sh');
    expect(hit!.via).toBe('indirection');
  });

  it('MUST FIRE — an UNQUOTED delimiter unescapes \\$ so it is a variable, not a literal path', async () => {
    // `<<EOF` expands, so `\$X` in the generator becomes `$X` in the generated file. Reading the
    // raw body made `\$X` a literal WORD, which the resolver reported as a RESOLVED path — a
    // reference to a file that does not exist. Unresolvable is the honest answer here.
    const { root, rel } = fixture('cat > out.sh <<EOF\nbash "\\$UNBOUND_PATH"\nEOF\n');
    const refs = await referencesFrom(rel, root);
    const fabricated = refs.filter((r) => r.to !== null && /\\\$/.test(r.to));
    expect(fabricated, `a fabricated path survived: ${JSON.stringify(fabricated)}`).toEqual([]);
    expect(refs.some((r) => r.to === null && /UNBOUND_PATH/.test(r.unresolved ?? ''))).toBe(true);
  });

  it('SILENT CONTROL — a QUOTED delimiter is literal and is NOT unescaped', async () => {
    const { root, rel } = fixture("cat > out.sh <<'EOF'\nbash \"\\$KEPT\"\nEOF\n");
    const refs = await referencesFrom(rel, root);
    // The body is literal, so nothing resolves to a real path; it must not be silently dropped.
    expect(refs.every((r) => r.to === null || !r.to.includes('KEPT'))).toBe(true);
  });
});

describe('invocation verbs and path idioms', () => {
  it('MUST FIRE — `exec <path>` is an invocation', async () => {
    const { root, rel } = fixture('exec ./scripts/delegate.sh "$@"\n');
    const refs = await referencesFrom(rel, root);
    expect(refs.map((r) => r.to)).toContain('scripts/delegate.sh');
  });

  it('SILENT CONTROL — `exec` used only for file descriptors resolves nothing', async () => {
    const { root, rel } = fixture('exec 3>&1\n');
    const refs = await referencesFrom(rel, root);
    expect(refs.filter((r) => r.to !== null)).toEqual([]);
  });

  it('MUST FIRE — the repo-root idiom `$(git rev-parse --show-toplevel)` resolves', async () => {
    const { root, rel } = fixture('exec "$(git rev-parse --show-toplevel)/scripts/guard.sh" "$@"\n');
    const refs = await referencesFrom(rel, root);
    expect(refs.map((r) => r.to)).toContain('scripts/guard.sh');
  });

  it('MUST FIRE — a `/..` suffix inside the script-dir idiom is HONOURED, not discarded', async () => {
    // The real bug: `$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)` is the script's PARENT.
    // Substituting the script dir for the whole expansion resolved HOOKS_DIR one level too
    // deep and produced the confidently wrong path `scripts/.git/hooks/pre-push`. A wrong path
    // is worse than an unresolved one, because it is reported as resolved.
    const { root } = fixture('placeholder\n');
    writeFileSync(join(root, 'sub'), '');
    rmSync(join(root, 'sub'));
    const sub = join(root, 'nested');
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, 'g.sh'),
      'ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"\nsource "$ROOT/top.sh"\n'
    );
    const refs = await referencesFrom('nested/g.sh', root);
    const hit = refs.find((r) => r.to !== null);
    expect(hit, `nothing resolved; got ${JSON.stringify(refs)}`).toBeDefined();
    // The parent of nested/ is the repo root, so the target is top.sh — NOT nested/top.sh.
    expect(hit!.to).toBe('top.sh');
  });
});

describe('controls that must stay SILENT — this is why it is a parser and not a grep', () => {
  it('a COMMENTED reference yields nothing', async () => {
    const { root, rel } = fixture('# source scripts/ops/commented.sh\n# bash scripts/x.sh\n');
    expect(await referencesFrom(rel, root)).toHaveLength(0);
  });

  it('a reference inside a HEREDOC BODY yields nothing', async () => {
    const { root, rel } = fixture('cat <<EOF\nsource scripts/ops/in-heredoc.sh\nEOF\n');
    const refs = await referencesFrom(rel, root);
    expect(refs.map((r) => r.to)).not.toContain('scripts/ops/in-heredoc.sh');
  });

  it('a path OUTSIDE the repo root resolves to null rather than escaping', async () => {
    const { root, rel } = fixture('source /etc/elsewhere.sh\n');
    const refs = await referencesFrom(rel, root);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.to).toBeNull();
  });
});

describe('fail-closed', () => {
  it('an unreadable file THROWS rather than returning no references', async () => {
    const { root } = fixture('true\n');
    await expect(referencesFrom('absent.sh', root)).rejects.toThrow(/unreadable input is an ERROR/);
  });
});
