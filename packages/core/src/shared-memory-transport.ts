// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * shared-memory-transport.ts — the cross-repo transport SEAM (Living Memory
 * Slice 5, B-03).
 *
 * `SharedMemoryTransport` is the ONE interface both the export half (B-02, which
 * `publish`es) and the import half (B-04, which `fetchSince`s) speak to. The
 * verify → pending → accept half (`shared-memory-sync.ts`) takes a transport as a
 * PARAMETER and imports no concrete transport and no `fetch` — a drift-guard
 * asserts it (the same HARD-INVARIANT posture as `team-rule-sync.ts`). That keeps
 * the trust-critical half transport-agnostic: the local, zero-network path and the
 * (future, Stage 5D) cloud path run the exact same verify/accept code.
 *
 * `LocalFsTransport` is the ONLY shipped implementation — Free, zero-network,
 * zero-LLM. It reads/writes `~/.massu/shared/`, OUTSIDE every repo. It owns the
 * B-09 write-safety obligations: atomic temp+fsync+rename, realpath containment,
 * a strict `/^[0-9a-f-]{36}$/` gate before a `repo_id` becomes a path component,
 * and mode 0600 on every file it writes. A `CloudTeamTransport` (Stage 5D) is a
 * second implementation of THIS interface — a new file, not a redesign.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { assertContainedIn, atomicWriteFileSync } from './lib/safe-write.ts';
import type { SharedMemoryEnvelope } from './shared-memory-envelope.ts';

/**
 * The transport seam. `publish` sends a signed envelope outward; `fetchSince`
 * returns the origin repo's envelopes with `seq` strictly greater than
 * `sinceSeq`, in ascending `seq` order (the import cursor / idempotency, H2).
 * Neither method verifies — verification is the sync half's job, so a transport
 * can never silently become trusted.
 */
export interface SharedMemoryTransport {
  publish(env: SharedMemoryEnvelope): Promise<void>;
  fetchSince(originRepoId: string, sinceSeq: number): Promise<SharedMemoryEnvelope[]>;
}

/** A `repo_id` may become a path component ONLY if it matches this (B-09/H5). */
export const REPO_ID_PATH_RE = /^[0-9a-f-]{36}$/;
/** A content hash may become a filename ONLY if it is 64 hex chars. */
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

/** `~/.massu/shared` — the inbox/outbox root, outside every repo. */
export function sharedRootDir(home: string = homedir()): string {
  return join(home, '.massu', 'shared');
}
/** `~/.massu/shared/outbox/<repo_id>` — one origin repo's envelope directory. */
export function outboxDirFor(originRepoId: string, home: string = homedir()): string {
  if (!REPO_ID_PATH_RE.test(originRepoId)) {
    throw new Error(`refusing to use an unvalidated repo_id as a path component: ${originRepoId}`);
  }
  // realpath-contained under the shared root (symlink-aware). allowNested: the
  // repo_id is a directory level beneath `outbox/`.
  const rel = join('outbox', originRepoId);
  return assertContainedIn(sharedRootDir(home), rel, { allowNested: true });
}

/** The deterministic content hash used as an envelope's filename stem. */
export function envelopeContentHash(env: SharedMemoryEnvelope): string {
  return createHash('sha256').update(JSON.stringify(env), 'utf-8').digest('hex');
}

/**
 * The local filesystem transport — the default, Free, zero-network implementation.
 * On one machine the "outbox" of repo A and the "inbox" of repo B are the same
 * physical directory (`~/.massu/shared/outbox/<A>/`), so `publish` and `fetchSince`
 * touch the same tree keyed by origin `repo_id`.
 */
export class LocalFsTransport implements SharedMemoryTransport {
  constructor(private readonly home: string = homedir()) {}

  async publish(env: SharedMemoryEnvelope): Promise<void> {
    const dir = outboxDirFor(env.origin_repo_id, this.home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const hash = envelopeContentHash(env);
    // hash is our own sha256, but validate defensively — the filename is built
    // from it and containment is only as good as the component it checks.
    if (!CONTENT_HASH_RE.test(hash)) {
      throw new Error(`refusing to write an envelope with a malformed content hash: ${hash}`);
    }
    // Filename carries the SEQ (zero-padded) as a prefix so fetchSince can lexically
    // skip already-consumed envelopes WITHOUT reading/parsing them (else every sweep
    // re-parses the whole outbox). `<0000000000000017>-<hash>.json`.
    const dest = assertContainedIn(dir, `${seqPrefix(env.seq)}-${hash}.json`, { allowNested: false });
    atomicWriteFileSync(dest, JSON.stringify(env, null, 2));
    // atomicWriteFileSync preserves an EXISTING file's mode but a NEW file inherits
    // the umask default (0644-ish). The outbox names the operator's repos and their
    // shared decisions — it is 0600, full stop (B-09).
    chmodSync(dest, 0o600);
  }

  async fetchSince(originRepoId: string, sinceSeq: number): Promise<SharedMemoryEnvelope[]> {
    if (!REPO_ID_PATH_RE.test(originRepoId)) return []; // never touch an unvalidated path
    let dir: string;
    try {
      dir = outboxDirFor(originRepoId, this.home);
    } catch {
      return [];
    }
    if (!existsSync(dir)) return [];

    const out: SharedMemoryEnvelope[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      // SKIP-BY-NAME: parse the seq prefix and skip <= cursor without opening the file.
      const seqFromName = parseSeqPrefix(name);
      if (seqFromName !== null && seqFromName <= sinceSeq) continue;
      let env: SharedMemoryEnvelope;
      try {
        // Each file is contained by construction; re-assert before read anyway.
        const p = assertContainedIn(dir, name, { allowNested: false });
        env = JSON.parse(readFileSync(p, 'utf-8')) as SharedMemoryEnvelope;
      } catch {
        continue; // a malformed/escaping file is skipped, never fatal (fail-open)
      }
      if (typeof env?.seq === 'number' && env.seq > sinceSeq) out.push(env);
    }
    // Ascending seq so the import cursor advances monotonically over the batch.
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}

/** Zero-pad a seq to a fixed width so filenames sort lexically by seq. */
function seqPrefix(seq: number): string {
  const s = Number.isInteger(seq) && seq >= 0 ? seq : 0;
  return String(s).padStart(16, '0');
}
/** Parse the leading `<16-digit seq>-` from an outbox filename, or null if absent. */
function parseSeqPrefix(name: string): number | null {
  const m = name.match(/^(\d{1,16})-/);
  return m ? Number(m[1]) : null;
}
