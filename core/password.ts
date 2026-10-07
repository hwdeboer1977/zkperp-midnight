// SPDX-License-Identifier: Apache-2.0

/**
 * The position key root from a password (see docs/privacy.md).
 *
 * The root opens the trader's notes (core/notes.ts) and derives every
 * position's owner secret, salt and coin nonce. It must be reproducible on any
 * computer with only the wallet and something the trader knows, so:
 *
 *   saltKDF = SHA-256("zkperp/password-salt/v1" ‖ coin public key)
 *   root    = Argon2id(password, saltKDF)
 *
 * The coin public key is the wallet account's, the same one a close pays
 * (`payTo`). It is public: it adds no secrecy, only stops one precomputed
 * table from serving every trader. Another account, or the same account on
 * another network, gives another root and finds no positions.
 *
 * Anyone can download every note and test guesses offline, so the password is
 * the whole defence: Argon2id is memory-hard and slow on purpose, and the app
 * proposes a generated passphrase. A cracked password lets a thief force
 * closes, not take money: a close pays only `payTo`.
 *
 * The parameters and the salt label are part of the key. Changing any of them
 * hides every position opened before.
 */

import { argon2id } from "hash-wasm";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/** RFC 9106's second recommended setting: 64 MiB, 3 passes, 1 lane. */
export const ARGON2 = { memorySize: 64 * 1024, iterations: 3, parallelism: 1 } as const;

const SALT_LABEL = "zkperp/password-salt/v1";

/** Shortest password accepted. A generated passphrase is far stronger; see `generatePassphrase`. */
export const MIN_PASSWORD_LENGTH = 16;

/** Why `password` is refused, or null if it is acceptable. */
export function passwordProblem(password: string): string | null {
  const p = password.normalize("NFKC");
  if (p.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters, or a generated passphrase.`;
  if (new Set(p).size < 6) return "This password repeats too few characters.";
  return null;
}

/** The per-account KDF salt. */
export async function passwordSalt(coinPublicKey: Uint8Array): Promise<Uint8Array> {
  if (coinPublicKey.length !== 32) throw new Error("a coin public key is 32 bytes");
  const label = new TextEncoder().encode(SALT_LABEL);
  const input = new Uint8Array(label.length + 32);
  input.set(label, 0);
  input.set(coinPublicKey, label.length);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input as unknown as BufferSource));
}

/** The 32-byte position key root for `password` and the wallet account with `coinPublicKey`. */
export async function passwordRoot(password: string, coinPublicKey: Uint8Array): Promise<Uint8Array> {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  return argon2id({
    // NFKC, so the same password typed on another keyboard or OS gives the same bytes.
    password: password.normalize("NFKC"),
    salt: await passwordSalt(coinPublicKey),
    ...ARGON2,
    hashLength: 32,
    outputType: "binary",
  });
}

/**
 * `words` words from the BIP-39 English list, joined by "-": 11 bits each, so
 * 6 words are 66 bits. Each guess costs a 64 MiB Argon2id run, so that many
 * guesses are out of reach. Not a wallet recovery phrase, and must never be
 * used as one; the dashes make it look different.
 */
export function generatePassphrase(words = 6): string {
  const picks = globalThis.crypto.getRandomValues(new Uint16Array(words));
  // 2048 divides 65536, so the modulo is unbiased.
  return Array.from(picks, (n) => wordlist[n % wordlist.length]).join("-");
}
