// SPDX-License-Identifier: Apache-2.0

/**
 * Position notes: each opening, encrypted, on chain (the contract's `notes`).
 *
 * A position can only be closed with every field of its opening, and none of
 * them is recoverable from the chain. A local record alone ties the position to
 * one browser. A note puts the opening on chain, sealed under a key the trader
 * can reproduce anywhere, so any device that has the key can find and close it.
 *
 * The key root is 32 secret bytes; in the browser, a passkey's PRF output (see
 * frontend/src/lib/positionKey.ts). From it, via HKDF:
 *
 *   · the note key (AES-256-GCM), which seals the note;
 *   · the secrets key (HMAC-SHA256), which turns a per-position random seed
 *     into the owner secret, the salt and the collateral coin's nonce.
 *
 * So a note carries the 32-byte seed rather than the three secrets, and fits in
 * 128 bytes. It is bound to its contract by the AES-GCM associated data: a note
 * copied to another deployment does not decrypt.
 *
 * Whoever holds the key root can close every position opened under it, and
 * a close pays whichever key the closer names. It is the owner secret of all of
 * them at once, and must be guarded as such.
 *
 * Layout. Note: iv (12) ‖ ciphertext (100) ‖ tag (16) = 128 bytes.
 * Plaintext: version (1) ‖ seed (32) ‖ isLong (1) ‖ size, collateral, openFee,
 * entryPrice, openTime (8 each, big-endian) ‖ zero padding to 100. Every note
 * has the same length, so a note says nothing about the position.
 *
 * WebCrypto only, so this runs unchanged in the browser and in Node ≥ 20.
 */

export const NOTE_BYTES = 128;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PLAIN_BYTES = NOTE_BYTES - IV_BYTES - TAG_BYTES;
const VERSION = 1;

const subtle = globalThis.crypto.subtle;
const text = (s: string) => new TextEncoder().encode(s);
const buf = (b: Uint8Array) => b as unknown as BufferSource;

/** The fields of a position that a note must restore; the rest derive from `seed`. */
export interface NoteOpening {
  seed: Uint8Array;
  isLong: boolean;
  size: bigint;
  collateral: bigint;
  openFee: bigint;
  entryPrice: bigint;
  openTime: bigint;
}

export interface PositionSecrets {
  ownerSecret: Uint8Array;
  salt: Uint8Array;
  collateralNonce: Uint8Array;
}

export interface PositionKey {
  note: CryptoKey;
  secrets: CryptoKey;
}

/** The working keys under a 32-byte root. */
export async function positionKey(root: Uint8Array): Promise<PositionKey> {
  if (root.length !== 32) throw new Error("a position key root is 32 bytes");
  const base = await subtle.importKey("raw", buf(root), "HKDF", false, ["deriveKey"]);
  const hkdf = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: text(info) });
  const [note, secrets] = await Promise.all([
    subtle.deriveKey(hkdf("zkperp/note-key/v1"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    subtle.deriveKey(hkdf("zkperp/secrets-key/v1"), base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]),
  ]);
  return { note, secrets };
}

/** The owner secret, salt and collateral nonce of the position with `seed`. */
export async function secretsOf(key: PositionKey, seed: Uint8Array): Promise<PositionSecrets> {
  const derive = async (label: string) => {
    const input = new Uint8Array([...text(label), ...seed]);
    return new Uint8Array(await subtle.sign("HMAC", key.secrets, buf(input)));
  };
  const [ownerSecret, salt, collateralNonce] = await Promise.all([
    derive("zkperp/owner/v1:"),
    derive("zkperp/salt/v1:"),
    derive("zkperp/collateral-nonce/v1:"),
  ]);
  return { ownerSecret, salt, collateralNonce };
}

/** Seals `o` for the contract at `contractAddress` (32 bytes). */
export async function sealNote(key: PositionKey, contractAddress: Uint8Array, o: NoteOpening): Promise<Uint8Array> {
  if (o.seed.length !== 32) throw new Error("a note seed is 32 bytes");
  const plain = new Uint8Array(PLAIN_BYTES);
  const view = new DataView(plain.buffer);
  plain[0] = VERSION;
  plain.set(o.seed, 1);
  plain[33] = o.isLong ? 1 : 0;
  [o.size, o.collateral, o.openFee, o.entryPrice, o.openTime].forEach((v, i) => view.setBigUint64(34 + 8 * i, v));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv, additionalData: buf(contractAddress) }, key.note, buf(plain))
  );
  const note = new Uint8Array(NOTE_BYTES);
  note.set(iv, 0);
  note.set(sealed, IV_BYTES);
  return note;
}

/** Opens a note, or returns null if it was not sealed under `key` for this contract. */
export async function openNote(key: PositionKey, contractAddress: Uint8Array, note: Uint8Array): Promise<NoteOpening | null> {
  if (note.length !== NOTE_BYTES) return null;
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await subtle.decrypt(
        { name: "AES-GCM", iv: buf(note.slice(0, IV_BYTES)), additionalData: buf(contractAddress) },
        key.note,
        buf(note.slice(IV_BYTES))
      )
    );
  } catch {
    return null;
  }
  if (plain[0] !== VERSION) return null;
  const view = new DataView(plain.buffer);
  const [size, collateral, openFee, entryPrice, openTime] = [0, 1, 2, 3, 4].map((i) => view.getBigUint64(34 + 8 * i));
  return { seed: plain.slice(1, 33), isLong: plain[33] === 1, size, collateral, openFee, entryPrice, openTime };
}
