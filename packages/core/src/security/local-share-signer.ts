// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * local-share-signer.ts — the FIRST signer in the Massu client (Living Memory
 * Slice 5, A-06).
 *
 * Until now the client only ever VERIFIED signatures (every server-signed
 * envelope was signed elsewhere). The local cross-repo transport needs the
 * operator's own machine to SIGN the memories it exports, so a repo on the same
 * machine can verify they were not tampered with in transit (a synced folder, a
 * backup restore, another tool).
 *
 * The keypair is per-MACHINE (the local transport moves memory between repos on
 * ONE machine that share `~/.massu`), stored at `~/.massu/keys/local-share.key`
 * (0600, PKCS8 PEM) + `local-share.pub` (0644, SPKI PEM), the SAME user-level,
 * outside-every-repo home as `~/.massu/credentials` (CR-59) and
 * `~/.massu/advisor-state.json`. It is generated LAZILY on the first export only
 * — a dormant install (sharing never enabled) generates NO key.
 *
 * The signer serializes BYTE-IDENTICALLY to what {@link verifyEd25519SignedEnvelope}
 * reconstructs — it reuses {@link canonicalizeSharedMemoryEnvelope}, whose formula
 * is fixed by the verifier core. The A-06 round-trip test proves it by verifying a
 * freshly-signed envelope through the REAL verifier (not a hand-rolled check).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'crypto';
import {
  canonicalizeSharedMemoryEnvelope,
  SHARED_MEMORY_SIGNATURE_PAYLOAD_KEYS,
  type SharedMemoryEnvelope,
  type UnsignedSharedMemoryEnvelope,
} from '../shared-memory-envelope.ts';

/** `~/.massu/keys` — the directory the local-share keypair lives in. */
export function localShareKeyDir(home: string = homedir()): string {
  return join(home, '.massu', 'keys');
}
/** `~/.massu/keys/local-share.key` — the PKCS8 PEM private key (0600). */
export function localSharePrivKeyPath(home: string = homedir()): string {
  return join(localShareKeyDir(home), 'local-share.key');
}
/** `~/.massu/keys/local-share.pub` — the SPKI PEM public key (0644). */
export function localSharePubKeyPath(home: string = homedir()): string {
  return join(localShareKeyDir(home), 'local-share.pub');
}

/** SPKI DER prefix for Ed25519 (12-byte OID prefix + 32-byte raw key = 44-byte SPKI). */
const SPKI_ED25519_PREFIX_LEN = 12;

/**
 * Generate the local-share keypair if it does not yet exist. Idempotent: an
 * existing key is left untouched (NEVER regenerated — regeneration would silently
 * break every prior signature and the TOFU pin). Called lazily from
 * {@link signSharedMemoryEnvelope}; a dormant install never calls it.
 */
export function ensureLocalShareKeypair(home: string = homedir()): void {
  const privPath = localSharePrivKeyPath(home);
  if (existsSync(privPath)) return;

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const pubPem = publicKey.export({ format: 'pem', type: 'spki' }) as string;

  // 0700 dir + 0600 priv: a private key readable by other users is a defect, not a
  // nit. mkdir mode is umask-masked, so chmod after write (mirrors credentials.ts).
  mkdirSync(localShareKeyDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(privPath, privPem, { mode: 0o600 });
  chmodSync(privPath, 0o600);
  writeFileSync(localSharePubKeyPath(home), pubPem, { mode: 0o644 });
}

/**
 * The raw 32-byte Ed25519 public key bytes, read from the on-disk pub PEM. Throws
 * if the keypair does not exist (the caller is a verify/sign path that must have a
 * key). Reused by the verifier (A-07) so both sides read the SAME artifact.
 */
export function readLocalSharePublicKeyRaw(home: string = homedir()): Uint8Array {
  const pubPem = readFileSync(localSharePubKeyPath(home), 'utf-8');
  const der = createPublicKey(pubPem).export({ format: 'der', type: 'spki' }) as Buffer;
  // The trailing 32 bytes of the 44-byte SPKI DER are the raw key.
  return Uint8Array.from(der.subarray(SPKI_ED25519_PREFIX_LEN));
}

/** Hex sha256 fingerprint of the raw local-share public key bytes. */
export function localSharePubkeyFingerprint(home: string = homedir()): string {
  return createHash('sha256').update(Buffer.from(readLocalSharePublicKeyRaw(home))).digest('hex');
}

/**
 * Sign a shared-memory envelope body with the machine-local key. Generates the
 * keypair lazily on the first call. The returned envelope is the body plus the
 * `_signature*` quartet; it verifies through {@link verifyLocalShareEnvelope} /
 * the generic {@link verifyEd25519SignedEnvelope} unchanged.
 */
export function signSharedMemoryEnvelope(
  body: UnsignedSharedMemoryEnvelope,
  home: string = homedir(),
): SharedMemoryEnvelope {
  ensureLocalShareKeypair(home);

  const privPem = readFileSync(localSharePrivKeyPath(home), 'utf-8');
  const privKey = createPrivateKey(privPem);
  const canonical = canonicalizeSharedMemoryEnvelope(body);
  const signature = cryptoSign(null, Buffer.from(canonical, 'utf-8'), privKey).toString('base64');

  return {
    ...body,
    _signature: signature,
    _signature_alg: 'ed25519',
    _signature_payload_keys: SHARED_MEMORY_SIGNATURE_PAYLOAD_KEYS,
    _signature_pubkey_fingerprint: localSharePubkeyFingerprint(home),
  };
}
