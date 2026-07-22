/**
 * 4B structural drift-guards — B-12 (default off), B-13 (CLI-only, no MCP tool),
 * B-08 (one lock), B-16 (the applier's unbounded append is retired).
 *
 * These are the assertions that make the safety properties STRUCTURAL rather than a
 * matter of the next session's good intentions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_MEMORY_FILES_CONFIG } from '../memory-files-config.ts';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function allSourceFiles(dir: string = SRC, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      allSourceFiles(p, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

const safeRead = (p: string): string => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

describe('B-12 — renderEnabled defaults FALSE, structurally', () => {
  it('the shipped default is false', () => {
    expect(DEFAULT_MEMORY_FILES_CONFIG.renderEnabled).toBe(false);
  });

  it('the source literal is `renderEnabled: false` — not a variable that could drift', () => {
    const cfg = readFileSync(join(SRC, 'memory-files-config.ts'), 'utf8');
    expect(cfg).toMatch(/renderEnabled:\s*false/);
    expect(cfg).not.toMatch(/renderEnabled:\s*true/);
  });

  it('the refusal is the FIRST thing the chokepoint does — zero side effects on refusal', () => {
    const src = readFileSync(join(SRC, 'memory-renderer.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export function renderMemoryFiles'));

    const gateIdx = fn.indexOf('if (!config.renderEnabled)');
    expect(gateIdx, 'the renderEnabled gate is missing from renderMemoryFiles').toBeGreaterThan(-1);

    // Nothing with a side effect may precede it. A gate that fires AFTER a path is
    // computed, a key minted, a backup taken or a snapshot written is a gate that has
    // already touched the operator's disk.
    const before = fn.slice(0, gateIdx);
    for (const forbidden of [
      'mintAuthorship',
      'ensureRenderKey',
      'takeBackup',
      'takeSnapshots',
      'computeRenderPath',
      'atomicWriteFileSync',
      'withMemoryIndexLock',
    ]) {
      expect(
        before.includes(forbidden),
        `${forbidden} runs BEFORE the renderEnabled gate — a refusal must cost zero side effects`
      ).toBe(false);
    }
  });
});

describe('⛔ THE RENDERER IS ACTUALLY WIRED UP — a capability with zero callers is dead code', () => {
  // THE DEFECT THIS EXISTS TO PREVENT, and it was REAL:
  //
  // 4B shipped with the renderer having exactly ONE caller — the CLI's `--dry-run` path.
  // It was never wired into session-start. Every gate passed, every guard was green, the
  // whole eval was green — and `renderEnabled: true` would have done NOTHING, forever.
  // "Capability built and never switched on" is a silent-failure class in its own right,
  // and it is invisible to every test that tests the capability itself.
  //
  // No test asks "who calls this?". This one does.

  it('session-start CALLS renderMemoryFiles — without this, 4B is dead code', () => {
    const hook = readFileSync(join(SRC, 'hooks', 'session-start.ts'), 'utf8');
    expect(
      hook.includes('renderMemoryFiles'),
      'session-start.ts does not call renderMemoryFiles. The renderer is the ONLY thing ' +
        'that writes a memory file, and session start is its ONLY production caller — so ' +
        'without this call, turning renderEnabled on does nothing at all, silently, forever.'
    ).toBe(true);
  });

  it('the renderer has a caller OUTSIDE the CLI (the CLI is dry-run only)', () => {
    const callers: string[] = [];
    for (const file of allSourceFiles()) {
      const rel = relative(SRC, file);
      if (rel === 'memory-renderer.ts') continue; // the definition
      const src = safeRead(file);
      if (/\brenderMemoryFiles\s*\(/.test(src)) callers.push(rel);
    }
    // The CLI can only ever dry-run. A production caller must exist too.
    const nonCli = callers.filter((c) => !c.startsWith('commands'));
    expect(
      nonCli.length,
      `renderMemoryFiles has no production caller (found only: ${callers.join(', ') || 'none'}). ` +
        `A capability nothing invokes is dead code that passes every test.`
    ).toBeGreaterThan(0);
  });

  it('ONE candidate query, shared by the hook and the CLI', () => {
    // Two copies of "which memories are renderable?" is how `--dry-run` shows the operator
    // something different from what the real render applies — in the one place he relies
    // on them being identical: deciding whether to enable this at all.
    const cli = readFileSync(join(SRC, 'commands', 'memory-render-cli-entry.ts'), 'utf8');
    const hook = readFileSync(join(SRC, 'hooks', 'session-start.ts'), 'utf8');
    expect(cli).toContain('loadRenderCandidates');
    expect(hook).toContain('loadRenderCandidates');
    // Neither may hand-roll the query.
    expect(cli).not.toMatch(/FROM\s+observations/i);
  });
});

describe('B-12 — ONE writer to the memory directory', () => {
  it('no module other than the renderer + the applier writes into the memory dir', () => {
    // PRECISION MATTERS HERE. A coarse "file mentions memoryDir AND calls writeFileSync"
    // rule was tried first and produced three FALSE POSITIVES, all verified at source:
    // `hooks/classify-failure.ts`, `hooks/fix-detector.ts` and `hooks/post-tool-use.ts`
    // name `memoryDir` only inside an EXCLUSION check (`if (path.includes(memoryDir))
    // skip`) and their writeFileSync calls target unrelated cache/log/marker files.
    // Flagging those would train the next reader to ignore this guard.
    //
    // So: trace the WRITE TARGET. Find identifiers assigned from an expression mentioning
    // memoryDir, then flag writes to those identifiers.
    const ALLOWED = new Map<string, string>([
      ['memory-renderer.ts', 'THE chokepoint'],
      ['rule-candidate-applier.ts', 'the second writer, migrated onto the same convention (B-16)'],
      [join('lib', 'safe-write.ts'), 'the write primitive itself'],
      ['memory-index-region.ts', 'the MEMORY.md region writer, called by both'],
      ['memory-backup.ts', 'writes to ~/.massu/memory-backups — OUTSIDE the memory dir'],
      [join('commands', 'memory-render-cli.ts'), 'unrender/adopt, via the same primitives'],
      // knowledge-tools.ts writes `corrections.md` — the A-09-unified corrections LOG.
      // It is NOT a rendered memory: it carries no authorship credential because Massu
      // never re-renders or overwrites it as a memory; it is an append-structured log the
      // reader (session-start) parses. Constrained by the assertion below to that ONE file.
      ['knowledge-tools.ts', 'corrections.md only — asserted below'],
      // `massu init` OWNS directory + MEMORY.md creation. That is B-17's design, not a
      // leak: "directory creation is owned by massu init, NEVER by a hook." Verified at
      // source — init.ts:1377 writes MEMORY.md only when it does not already exist (a
      // scaffold), and the renderer/applier never create it. Scope asserted below.
      [join('commands', 'init.ts'), 'the MEMORY.md scaffold, create-if-absent only'],
    ]);

    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const rel = relative(SRC, file);
      if (ALLOWED.has(rel)) continue;
      const src = safeRead(file);

      // Identifiers whose VALUE is derived from the memory dir.
      const derived = new Set<string>();
      for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]*memoryDir[^;\n]*)/g)) {
        // An exclusion check (`x.includes(memoryDir)`) yields a boolean, not a path.
        if (/\.(includes|startsWith|endsWith|test)\s*\(/.test(m[2])) continue;
        derived.add(m[1]);
      }
      derived.add('memoryDir');

      for (const m of src.matchAll(/(writeFileSync|renameSync|atomicWriteFileSync)\s*\(\s*([^,)]+)/g)) {
        const target = m[2];
        for (const id of derived) {
          if (new RegExp(`\\b${id}\\b`).test(target)) {
            offenders.push(`${rel}: ${m[1]}(${target.trim()})`);
          }
        }
      }
    }

    expect(
      offenders,
      `A module outside the renderer/applier writes into the memory directory. There is ` +
        `ONE chokepoint (renderMemoryFiles) and it is gated by renderEnabled (default ` +
        `false). A third writer is how two Massu subsystems end up with two incompatible ` +
        `conventions.\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('knowledge-tools writes ONLY corrections.md into the memory dir', () => {
    // The one allow-listed exception, held to its exact scope. If it ever learns to write
    // a *memory* file, it becomes a fourth writer with no authorship credential — and
    // every file it wrote would be permanently human-owned (the exact B-16 defect).
    const src = readFileSync(join(SRC, 'knowledge-tools.ts'), 'utf8');
    const writes = [...src.matchAll(/writeFileSync\s*\(\s*(\w+)/g)].map((m) => m[1]);
    for (const target of writes) {
      const assigned = src.match(new RegExp(`(?:const|let)\\s+${target}\\s*=\\s*([^;\\n]+)`));
      if (assigned && /memoryDir/.test(assigned[1])) {
        expect(
          assigned[1],
          `knowledge-tools.ts writes ${target} into the memory dir, and it is not corrections.md`
        ).toMatch(/corrections\.md/);
      }
    }
  });

  it('massu init only SCAFFOLDS MEMORY.md — it never overwrites an existing one', () => {
    // The other allow-listed exception, held to its scope. `init` is the ONLY thing
    // permitted to create the memory dir and MEMORY.md (B-17). If it ever overwrote an
    // existing MEMORY.md it would destroy 20KB of the operator's hand-curated prose on a
    // re-init — a catastrophe with none of the renderer's guards in front of it.
    const src = readFileSync(join(SRC, 'commands', 'init.ts'), 'utf8');
    const i = src.indexOf('writeFileSync(memoryMdPath');
    expect(i, 'init.ts no longer writes MEMORY.md — update this guard').toBeGreaterThan(-1);

    // The write must sit behind an existence check.
    const preceding = src.slice(Math.max(0, i - 800), i);
    expect(
      /if\s*\(\s*!existsSync\(memoryMdPath\)/.test(preceding),
      'init.ts writes MEMORY.md WITHOUT a !existsSync guard — a re-init would destroy it'
    ).toBe(true);
  });

  it('ANTI-VACUITY: the memory-dir-writer rule fires on a real third writer', () => {
    const probe = `
      const memoryDir = getResolvedPaths().memoryDir;
      const target = join(memoryDir, 'feedback_sneaky.md');
      writeFileSync(target, body);
    `;
    const derived = new Set<string>(['memoryDir']);
    for (const m of probe.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]*memoryDir[^;\n]*)/g)) {
      if (/\.(includes|startsWith|endsWith|test)\s*\(/.test(m[2])) continue;
      derived.add(m[1]);
    }
    const hits = [...probe.matchAll(/(writeFileSync|renameSync|atomicWriteFileSync)\s*\(\s*([^,)]+)/g)]
      .filter((m) => [...derived].some((id) => new RegExp(`\\b${id}\\b`).test(m[2])));
    expect(hits.length, 'the guard no longer detects a new memory-dir writer').toBeGreaterThan(0);

    // ...and does NOT fire on the exclusion-check shape (the 3 verified false positives).
    const exclusion = `
      const memoryDir = config.autoLearning?.memoryDir ?? 'memory';
      if (relPath.includes(memoryDir) || relPath.includes('MEMORY.md')) return;
      writeFileSync(dedupeMarker, '1');
    `;
    const d2 = new Set<string>(['memoryDir']);
    const falseHits = [
      ...exclusion.matchAll(/(writeFileSync|renameSync|atomicWriteFileSync)\s*\(\s*([^,)]+)/g),
    ].filter((m) => [...d2].some((id) => new RegExp(`\\b${id}\\b`).test(m[2])));
    expect(falseHits.length, 'the guard is over-broad — it flags an exclusion check').toBe(0);
  });
});

describe('B-13 — the memory-write commands are CLI-ONLY. There is NO MCP tool.', () => {
  it('none of render/restore/adopt/unrender appears in tools.ts', () => {
    // Every one of these writes to — or authorises writing to — the operator's
    // irreplaceable memory. An MCP tool is MODEL-CALLABLE, and the model is precisely the
    // actor this slice exists to constrain. This is a DECISION, not an oversight.
    const tools = readFileSync(join(SRC, 'tools.ts'), 'utf8');
    for (const name of [
      'memory_render',
      'memory_restore',
      'memory_adopt',
      'memory_unrender',
      // D-C (plan-memory-ingestion-decision-noise-fix): prune-noise MUTATES the corpus
      // (bulk EXPIRE) — same "never model-callable" rationale. It routes through the same
      // CLI entry; a future MCP `memory_prune_noise` tool must trip this guard.
      'memory_prune_noise',
    ]) {
      expect(
        tools.includes(name),
        `${name} appears in tools.ts — these commands must never be model-callable`
      ).toBe(false);
    }
  });

  it('the renderer is never invoked from an MCP tool handler', () => {
    const tools = readFileSync(join(SRC, 'tools.ts'), 'utf8');
    expect(tools).not.toContain('renderMemoryFiles');
  });
});

describe('B-08 — ONE lock implementation', () => {
  it('no lock is implemented outside lib/fileLock.ts', () => {
    // The draft proposed a bespoke O_EXCL lockfile. `lib/fileLock.ts`'s own module doc
    // states there is NO parallel lock implementation in this codebase per CR-46/Rule 0 —
    // it already provides proper-lockfile, staleMs, the retry loop, the PID sidecar, and
    // ELOCKED/EBUSY normalisation (the Windows half of F-25).
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const rel = relative(SRC, file);
      if (rel === join('lib', 'fileLock.ts')) continue;
      const src = safeRead(file);
      if (/require\(['"]proper-lockfile|from ['"]proper-lockfile/.test(src)) offenders.push(rel);
      // A hand-rolled O_EXCL lockfile.
      if (/openSync\([^)]*O_EXCL/.test(src)) offenders.push(`${rel} (O_EXCL lockfile)`);
    }
    expect(offenders, `A second lock implementation exists.\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the memory-index lock NEVER blocks session start (blockMs <= 2000)', () => {
    const src = readFileSync(join(SRC, 'memory-index-region.ts'), 'utf8');
    const m = src.match(/LOCK_BLOCK_MS\s*=\s*(\d+)/);
    expect(m, 'LOCK_BLOCK_MS is not declared').toBeTruthy();
    // The 30s default is unacceptable at session start.
    expect(Number(m![1])).toBeLessThanOrEqual(2000);
  });

  it('a busy lock SKIPS the render — it never throws out of the hook', () => {
    const src = readFileSync(join(SRC, 'memory-renderer.ts'), 'utf8');
    expect(src).toContain('MemoryIndexLockBusy');
    expect(src).toMatch(/lock_busy/);
  });
});

describe('B-16 — the applier joins the renderer’s convention', () => {
  it('the applier STAMPS its file with a credential (or it is human forever)', () => {
    const src = readFileSync(join(SRC, 'rule-candidate-applier.ts'), 'utf8');
    // Without this, every applier-written file is classified HUMAN post-B-01 and the
    // renderer can never maintain it: two Massu subsystems, two conventions.
    expect(src).toContain('mintAuthorship');
    expect(src).toContain('RENDER_MAC_KEY');
  });

  it('the applier writes its memory file ATOMICALLY', () => {
    const src = readFileSync(join(SRC, 'rule-candidate-applier.ts'), 'utf8');
    const fn = src.slice(src.indexOf('function writeCorrectionsMd'));
    const body = fn.slice(0, fn.indexOf('\nfunction '));
    expect(body).toContain('atomicWriteFileSync');
  });

  it('appendMemoryIndexLine has NO caller that writes outside the managed region', () => {
    // Its unbounded EOF append is retired as a write path. MEMORY.md is loaded into every
    // turn of every session; an unbounded index is a permanent, compounding context tax,
    // and B-05's bound would otherwise bound only half of it.
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const rel = relative(SRC, file);
      const src = safeRead(file);
      // The definition itself is allowed to exist (it survives as the line formatter's
      // hardened contract); a CALL to it is not.
      const calls = src.match(/(?<!export function )\bappendMemoryIndexLine\s*\(/g) ?? [];
      if (calls.length > 0) offenders.push(`${rel} (${calls.length} call(s))`);
    }
    expect(
      offenders,
      `appendMemoryIndexLine is still being CALLED. Use writeIndexLineInRegion — the ` +
        `unbounded EOF append is retired (B-16).\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
