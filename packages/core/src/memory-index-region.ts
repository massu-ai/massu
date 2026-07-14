/**
 * B-05 + B-08 — `MEMORY.md` is a MANAGED REGION, and a damaged sentinel is FATAL-CLOSED.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ALLOWED TO TOUCH
 * ═══════════════════════════════════════════════════════════════════════════════
 * `MEMORY.md` is ~20KB of hand-curated prose that the Claude Code harness auto-loads
 * into EVERY session as TRUSTED INSTRUCTIONS. It is the highest-value prompt-injection
 * sink in the system, and the operator edits it constantly.
 *
 * Massu may write ONLY between:
 *     <!-- massu:learned:begin -->
 *     <!-- massu:learned:end -->
 * and every byte outside that pair must be identical before and after. That invariant
 * is asserted on EVERY write, not just in a test.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHY THE SENTINEL PARSE IS FAIL-CLOSED
 * ═══════════════════════════════════════════════════════════════════════════════
 * HTML comments are not sacred. The operator can delete one by accident; a merge can
 * duplicate one. A naive "find begin, find end, rewrite between them" is a
 * CORPUS-DESTROYING PRIMITIVE: with the end sentinel missing, `indexOf` returns -1 and
 * the "region" runs to the end of the file — so the write erases everything below the
 * begin marker. Twenty kilobytes of irreplaceable prose, gone, because of one deleted
 * comment.
 *
 * So: the region is valid IFF exactly one begin, exactly one end, and end after begin.
 * ANY other state ⇒ write ZERO BYTES to MEMORY.md, log, warn once. The memory files
 * themselves still render; only the index is skipped, and it is recoverable.
 *
 * `MEMORY.md` is EXEMPT from the authorship law (Law 3): it will never carry a MAC. It
 * is governed by this region invariant instead — Massu may append the sentinel pair
 * once at EOF, and rewrite bytes ONLY strictly between a validated pair.
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { withFileLockSync, FileLockBusyError } from './lib/fileLock.ts';
import { atomicWriteFileSync, assertSingleLine } from './lib/safe-write.ts';

export const BEGIN_SENTINEL = '<!-- massu:learned:begin -->';
export const END_SENTINEL = '<!-- massu:learned:end -->';

/** Default cap on the managed region. A permanent context tax, so it is bounded. */
export const DEFAULT_MAX_REGION_LINES = 50;

export type RegionState =
  | { kind: 'valid'; beginIdx: number; endIdx: number }
  | { kind: 'absent' } // no sentinels at all — the ONLY case where we may create them
  | { kind: 'damaged'; why: string }; // anything else — REFUSE

/**
 * Parse the sentinel pair. This is the FIRST thing that runs, and the only thing
 * permitted to conclude that a write is safe.
 *
 * The five damage cases are each a named test: end deleted, begin deleted, duplicated
 * pair, inverted order, both absent.
 */
export function parseRegion(content: string): RegionState {
  const begins = countOccurrences(content, BEGIN_SENTINEL);
  const ends = countOccurrences(content, END_SENTINEL);

  if (begins === 0 && ends === 0) return { kind: 'absent' };

  if (begins !== 1 || ends !== 1) {
    return {
      kind: 'damaged',
      why: `expected exactly one of each sentinel, found ${begins} begin / ${ends} end`,
    };
  }

  const beginIdx = content.indexOf(BEGIN_SENTINEL);
  const endIdx = content.indexOf(END_SENTINEL);

  if (endIdx <= beginIdx) {
    return { kind: 'damaged', why: 'end sentinel precedes begin sentinel' };
  }

  return { kind: 'valid', beginIdx, endIdx };
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

export class RegionRefused extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = 'RegionRefused';
  }
}

/**
 * MEMORY.md does not exist. Massu NEVER creates it (B-17) — the applier already refused
 * to, and the renderer matches that contract.
 *
 * A distinct class from `RegionRefused` and from a raw I/O error ON PURPOSE: "the file
 * isn't there" and "the file is damaged" are both survivable (skip the pointer, keep the
 * work), while "the write FAILED" (EACCES/ENOSPC) must roll the caller's transaction back.
 * Collapsing the three is how a promotion ends up half-applied with no way back.
 */
export class MemoryIndexMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryIndexMissing';
  }
}

/**
 * Rewrite the managed region to exactly `lines`, preserving every byte outside it.
 *
 * Returns the new file content. Does NOT write — the caller writes, inside the lock and
 * inside the snapshot harness, so that a failure anywhere rolls the whole run back.
 *
 * Throws `RegionRefused` on a damaged sentinel pair. Zero bytes, every time.
 */
export function renderRegion(content: string, lines: readonly string[]): string {
  const state = parseRegion(content);

  if (state.kind === 'damaged') {
    throw new RegionRefused(
      `MEMORY.md sentinels are damaged (${state.why}) — refusing to write any bytes. ` +
        `A region computed from a damaged sentinel pair erases everything past it.`,
      'damaged_sentinels'
    );
  }

  // Every line is a SINGLE line. A `\n` in a store-derived title injects arbitrary
  // markdown into a file the harness loads as trusted instructions, in every future
  // session, forever. The append-only invariant would not even notice.
  for (const line of lines) assertSingleLine(line);

  const body = lines.length > 0 ? `\n${lines.join('\n')}\n` : '\n';

  if (state.kind === 'absent') {
    // CREATION (F-06 / Law 1b) — the ONLY case in which Massu may touch a
    // human-authored MEMORY.md that has no region: append a well-formed sentinel pair
    // at EOF.
    //
    // DELIBERATE, DOCUMENTED DEVIATION from the plan's letter. B-05 says the creation
    // run appends an EMPTY pair and "writes nothing else in that run". Implemented
    // literally, the pointer SILENTLY VANISHES on the first promotion against any
    // MEMORY.md that has no sentinels — which is EVERY existing user's MEMORY.md,
    // including the operator's. That is a real regression of shipped applier behaviour
    // (caught by rule-candidate-applier's own tests), traded for no safety.
    //
    // The safety argument B-05 actually rests on is "NEVER compute a region from a
    // damaged sentinel pair" — and that is fully preserved here: this branch runs ONLY
    // when there is no pair at all, the write is a PURE APPEND AT EOF, and the
    // post-write invariant (every pre-existing byte unchanged) holds trivially because
    // `post` starts with `pre`. Nothing above the new region can be touched, because
    // there is nothing below it.
    const sep = content.endsWith('\n') ? '' : '\n';
    return `${content}${sep}\n${BEGIN_SENTINEL}${body}${END_SENTINEL}\n`;
  }

  const before = content.slice(0, state.beginIdx + BEGIN_SENTINEL.length);
  const after = content.slice(state.endIdx);
  return `${before}${body}${after}`;
}

/**
 * THE POST-WRITE INVARIANT — asserted on every write, not just in a test.
 *
 * Every byte outside the managed region is unchanged. If this does not hold, the caller
 * restores its snapshot and aborts.
 */
export function assertOutsideRegionUnchanged(pre: string, post: string): void {
  const preState = parseRegion(pre);
  const postState = parseRegion(post);

  if (postState.kind === 'damaged') {
    throw new RegionRefused('post-write MEMORY.md has damaged sentinels', 'post_write_damaged');
  }

  // Creation case: pre had no sentinels, post is pre + an empty pair appended at EOF.
  if (preState.kind === 'absent') {
    if (!post.startsWith(pre.endsWith('\n') ? pre : `${pre}\n`)) {
      throw new RegionRefused(
        'MEMORY.md sentinel creation modified pre-existing bytes',
        'creation_mutated_prefix'
      );
    }
    return;
  }

  if (preState.kind !== 'valid' || postState.kind !== 'valid') {
    throw new RegionRefused('MEMORY.md region could not be validated', 'unvalidatable');
  }

  const preHead = pre.slice(0, preState.beginIdx);
  const postHead = post.slice(0, postState.beginIdx);
  const preTail = pre.slice(preState.endIdx);
  const postTail = post.slice(postState.endIdx);

  if (preHead !== postHead) {
    throw new RegionRefused(
      'MEMORY.md bytes ABOVE the managed region changed — aborting',
      'head_mutated'
    );
  }
  if (preTail !== postTail) {
    throw new RegionRefused(
      'MEMORY.md bytes BELOW the managed region changed — aborting',
      'tail_mutated'
    );
  }
}

/** The lines currently inside the managed region (excluding the sentinels). */
export function readRegionLines(content: string): string[] {
  const state = parseRegion(content);
  if (state.kind !== 'valid') return [];
  const inner = content.slice(state.beginIdx + BEGIN_SENTINEL.length, state.endIdx);
  return inner.split('\n').filter((l) => l.trim().length > 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// B-08 — ONE cross-process lock, built ON `withFileLockSync`, never beside it.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The renderer runs in the SESSION-START SUBPROCESS; `applyRuleCandidate` runs in the
 * MCP server / CLI. An in-process mutex cannot help. Today the applier snapshots
 * MEMORY.md, BEGINs, and on any error restores the pre-bytes over the WHOLE file —
 * silently erasing a line the renderer wrote concurrently, while the renderer's DB row
 * still says "indexed", so the pointer never comes back.
 *
 * `lib/fileLock.ts` ALREADY provides proper-lockfile, staleMs, the manual retry loop,
 * the PID sidecar, and ELOCKED/EBUSY normalisation (the Windows half of F-25). Its own
 * module doc states there is NO parallel lock implementation in this codebase per
 * CR-46 / Rule 0. So this is a thin wrapper, not a second mechanism.
 */
export function memoryIndexLockPath(memoryDir: string): string {
  // Beside the memory dir, not inside it: a lockfile inside a git-tracked directory
  // would be committed and pushed.
  return join(dirname(memoryDir), '.massu-memory-index.lock');
}

/** Session start's contract is FAIL-OPEN. 30s (the default) is unacceptable here. */
export const LOCK_BLOCK_MS = 2000;
export const LOCK_STALE_MS = 30_000;

export class MemoryIndexLockBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryIndexLockBusy';
  }
}

/**
 * Run `fn` holding the memory-index lock.
 *
 * FAILURE POLICY, stated because this is the one gate that can hang a session:
 *   lock unavailable after 2s ⇒ the CALLER skips the render for this session, logs, and
 *   writes ZERO BYTES. It NEVER blocks session start and NEVER throws out of the hook.
 * Renders are idempotent, so the next session simply retries.
 */
export function withMemoryIndexLock<T>(memoryDir: string, fn: () => T): T {
  return withFileLockSync(memoryIndexLockPath(memoryDir), fn, {
    blockMs: LOCK_BLOCK_MS,
    staleMs: LOCK_STALE_MS,
    errorFactory: (lockPath, holderPid) =>
      new MemoryIndexLockBusy(
        `memory index is locked by pid ${holderPid ?? 'unknown'} (${lockPath}) — ` +
          `skipping the render this session. Renders are idempotent; the next session retries.`
      ),
  });
}

export { FileLockBusyError };

/** Read MEMORY.md, or undefined if it does not exist. NEVER create it (B-17). */
export function readMemoryIndex(indexPath: string): string | undefined {
  if (!existsSync(indexPath)) return undefined;
  try {
    return readFileSync(indexPath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Write MEMORY.md atomically, asserting the post-write invariant FIRST.
 * The caller must already hold the lock and have snapshotted the file.
 */
export function writeMemoryIndex(indexPath: string, pre: string, post: string): void {
  assertOutsideRegionUnchanged(pre, post);
  atomicWriteFileSync(indexPath, post);
}
