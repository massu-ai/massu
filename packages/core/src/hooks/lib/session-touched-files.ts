// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * WHICH FILES DID *THIS* SESSION TOUCH?
 *
 * A working tree is shared. On a machine where several assistant sessions hold the same
 * repository at once, "there are uncommitted changes" says nothing about WHO made them —
 * and a reminder that fires on someone else's edits cannot be discharged by the session it
 * blocks. Its only exits are to fabricate the artifact, to commit work that is not yours,
 * or to loop.
 *
 * So the question a Stop-time reminder must ask is never "did something change?" but "did
 * *I* change it?", and the answer has to come from an ACTOR-BEARING signal. Two exist and
 * both are already in hand:
 *
 *   1. `transcript_path` — the session's own tool-call log. Every `Edit`/`Write`/
 *      `NotebookEdit` records the file it wrote.
 *   2. the per-session fix-flag file, which the per-edit detector writes under this
 *      session's id.
 *
 * **`null` is not the empty set.** `null` means *could not attribute* (no readable
 * transcript, no flag file); an empty set means *attributed, and this session touched
 * nothing*. Collapsing those two is the blind-gate failure, and here they must drive
 * opposite behaviour — see the caller.
 */

import { readFileSync, existsSync, realpathSync } from 'fs';
import { relative, isAbsolute, resolve } from 'path';

/** Tool calls that write a file, and the input key naming it. */
const FILE_WRITING_TOOLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Edit: ['file_path'],
  Write: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path', 'file_path'],
});

/**
 * Canonicalise a directory, tolerating one that does not exist.
 *
 * Load-bearing on macOS, where the temp root is `/var/...` symlinked to `/private/var/...`.
 * A transcript records the path the tool was CALLED with while the project root arrives
 * already resolved, so comparing them literally makes every path look like it sits outside
 * the repository — and the caller reads that as "this session touched nothing". A silent
 * empty set from a spelling difference is the blind-gate failure in miniature.
 */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Normalise to a repo-relative POSIX path, or null when it is outside the repo. */
function toRepoRelative(root: string, filePath: string): string | null {
  if (typeof filePath !== 'string' || filePath === '') return null;
  const absRaw = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  const canonicalRoot = canonical(root);
  // Canonicalise the DIRECTORY, not the file: the file may have been deleted since the
  // tool call that named it, and a deleted path is still a path this session touched.
  const abs = resolve(canonical(resolve(absRaw, '..')), absRaw.split('/').pop() ?? '');
  const rel = relative(canonicalRoot, abs).split('\\').join('/');
  if (rel === '' || rel.startsWith('../')) return null;
  return rel;
}

/**
 * Repo-relative paths written by tool calls recorded in a session transcript.
 *
 * A malformed line is skipped rather than fatal — a transcript is append-only and its last
 * line can be a partial write. An unreadable transcript returns `null`, never `[]`.
 */
export function transcriptTouchedFiles(root: string, transcriptPath: string): Set<string> | null {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }

  const out = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn final line is expected, not an error
    }
    const message = (entry as { message?: { content?: unknown } }).message;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
      if (b.type !== 'tool_use') continue;
      const keys = b.name ? FILE_WRITING_TOOLS[b.name] : undefined;
      if (!keys || !b.input) continue;
      for (const key of keys) {
        const rel = toRepoRelative(root, b.input[key] as string);
        if (rel) out.add(rel);
      }
    }
  }
  return out;
}

/** Repo-relative paths recorded in this session's per-edit fix-flag file. */
export function flagFileTouchedFiles(root: string, flagPath: string): Set<string> | null {
  if (!existsSync(flagPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(flagPath, 'utf-8');
  } catch {
    return null;
  }
  const out = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rel = toRepoRelative(root, (JSON.parse(line) as { file?: string }).file ?? '');
      if (rel) out.add(rel);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * The union of every actor-bearing source, or `null` when none could be read.
 *
 * KNOWN AND DELIBERATE GAP, stated rather than papered over: a file edited through a shell
 * command (a heredoc, a script) appears in no `Edit`/`Write` tool call, so it is invisible
 * here. The consequence is UNDER-detection — a real fix of that shape goes unmentioned —
 * and that is the direction this reminder must fail in. Over-detection blocks a session on
 * work it cannot claim; under-detection costs one un-nagged fix, and the per-edit detector
 * still covers the ordinary case.
 */
export function sessionTouchedFiles(opts: {
  root: string;
  transcriptPath?: string;
  flagPath?: string;
}): Set<string> | null {
  const sources: Array<Set<string> | null> = [];
  if (opts.transcriptPath) sources.push(transcriptTouchedFiles(opts.root, opts.transcriptPath));
  if (opts.flagPath) sources.push(flagFileTouchedFiles(opts.root, opts.flagPath));

  const readable = sources.filter((s): s is Set<string> => s !== null);
  if (readable.length === 0) return null; // could not attribute — NOT "touched nothing"

  const union = new Set<string>();
  for (const s of readable) for (const f of s) union.add(f);
  return union;
}
