// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * local-share-verifier.ts — verify a locally-signed cross-repo memory envelope
 * with a NON-VACUOUS trusted-key check (Living Memory Slice 5, A-07 / defect D4).
 *
 * The generic verifier core self-checks the key it verifies against a
 * `knownFingerprints` allowlist (ed25519-envelope-verifier.ts:90). For the SERVER
 * envelopes that allowlist is a BUILT-IN constant. A machine-local key has no
 * built-in fingerprint — and handing the key its OWN fingerprint as its own
 * allowlist makes the check compare a value to itself: VACUOUS. A key swap would
 * then verify happily.
 *
 * THE FIX: the trusted fingerprint is pinned in a DIFFERENT artifact than the key
 * (a TOFU pin in the repo's `memory_meta`, mirrored in `~/.massu/repos.json`) and
 * is passed in here as `pinnedFingerprint`. This module NEVER derives the allowlist
 * from the pubkey it is verifying. So:
 *   - normal:   current key fingerprint === pinned  → self-check passes → verify sig
 *   - key swap: current key fingerprint !== pinned  → self-check FAILS  → hard drop,
 *               until a human explicitly re-pins (`massu memory trust`). Never auto-repin.
 *
 * HONEST LIMIT (documented, not hidden): a process running AS the operator can
 * rewrite BOTH the key file AND the memory_meta pin — a local signature is not a
 * boundary against a compromised local account (that account can already edit the
 * store directly). What the signature buys: tamper-evidence for the transit
 * artifact, a provenance binding, and ONE verify code path shared with the cloud
 * transport, so the local path can never rot into a weaker parallel mechanism.
 */

import { homedir } from 'os';
import {
  verifyEd25519SignedEnvelope,
  type Ed25519VerificationResult,
  type Ed25519VerifierKey,
} from './ed25519-envelope-verifier.ts';
import {
  localSharePubkeyFingerprint,
  readLocalSharePublicKeyRaw,
} from './local-share-signer.ts';
import type { SharedMemoryEnvelope } from '../shared-memory-envelope.ts';

/**
 * Verify a shared-memory envelope against the machine-local key, with the trusted
 * fingerprint supplied from a DIFFERENT artifact than the key (`pinnedFingerprint`
 * — the TOFU pin from `memory_meta`, read by the caller). Returns the generic
 * tagged union; the caller (the import path, B-04) hard-drops on anything but
 * `{ kind: 'valid' }` (no transition mode).
 *
 * @param pinnedFingerprint hex sha256 of the pubkey trusted-on-first-use for this
 *   origin repo. MUST come from `memory_meta`/`repos.json`, NEVER from the pubkey
 *   this function reads — that is the anti-vacuity invariant the A-07 drift-guard
 *   asserts at source level.
 */
export function verifyLocalShareEnvelope(
  envelope: SharedMemoryEnvelope,
  pinnedFingerprint: string,
  home: string = homedir(),
): Ed25519VerificationResult {
  let key: Ed25519VerifierKey;
  try {
    const pubkeyBytes = readLocalSharePublicKeyRaw(home);
    key = {
      pubkeyBytes,
      // The fingerprint of the key we are ABOUT to verify with (the on-disk key).
      fingerprintHex: localSharePubkeyFingerprint(home),
      // The trusted set comes from the PIN — a different artifact than the key.
      // If the on-disk key was swapped, fingerprintHex ∉ this set → the core's
      // self-check fails → hard drop. This Set is deliberately NOT built from
      // `fingerprintHex`/`pubkeyBytes` (that would be vacuous — defect D4).
      knownFingerprints: new Set<string>([pinnedFingerprint]),
      keyLabel: 'local-share',
    };
  } catch (err) {
    // No key on disk (or unreadable) → cannot verify → drop. Never throws to the
    // caller; the import path stays fail-open.
    return {
      kind: 'error',
      reason: `local-share pubkey unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return verifyEd25519SignedEnvelope(key, envelope);
}
