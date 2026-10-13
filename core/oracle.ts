// SPDX-License-Identifier: Apache-2.0

/**
 * The oracle's signers: three Jubjub key pairs, any two of which set the
 * price. Each signs a Chainlink round off-chain (Schnorr, as the contract's
 * `verifySignature` checks it), and whoever holds two signatures submits
 * them with `setPrice`. See "Oracle" in contracts/zkperp.compact.
 *
 * Messages and challenges come from the contract build's own pure circuits
 * (`priceMessage`, `rotationMessage`, `signatureChallenge`): they use
 * transientHash, which may change between compiler versions.
 */

import { createHash } from "crypto";
import { activeNetwork } from "./network.js";
import { JUBJUB_ORDER, randomScalar, scalarFrom } from "./liquidatorNote.js";

export const SIGNER_SLOTS = [0, 1, 2] as const;

export interface JubjubPoint {
  x: bigint;
  y: bigint;
}

/** The contract's `Signature` struct. */
export interface Signature {
  nonce: JubjubPoint;
  s: bigint;
  challengeLo: bigint;
  challengeHi: bigint;
}

/** One Chainlink round, as the contract's `setPrice` takes it. */
export interface PriceReport {
  round: bigint;
  price: bigint;
  updatedAt: bigint;
}

/** A signer's signature on a report, by slot. */
export interface SlotSignature {
  slot: number;
  signature: Signature;
}

const LOW_128 = (1n << 128n) - 1n;
const bytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

/**
 * Signer `slot`'s secret scalar: ORACLE_SIGNER_<slot+1>_<NETWORK> or
 * ORACLE_SIGNER_<slot+1> (hex), or one derived from the dev seed. On a public
 * network, give each its own secret.
 */
export function oracleSecret(devSeed: string, slot: number): bigint {
  const base = `ORACLE_SIGNER_${slot + 1}`;
  const explicit = (process.env[`${base}_${activeNetwork().key.toUpperCase()}`] ?? process.env[base])?.trim();
  const raw = explicit
    ? Buffer.from(explicit.replace(/^0x/, "").padStart(128, "0"), "hex")
    : createHash("sha512").update(`zkperp-oracle-${slot + 1}:${devSeed}`).digest();
  return scalarFrom(raw);
}

/** All three signers' secrets, by slot. Only the devnet scripts hold all three. */
export const oracleSecrets = (devSeed: string): bigint[] => SIGNER_SLOTS.map((slot) => oracleSecret(devSeed, slot));

/** The three public keys the contract is deployed with. */
export const signerKeys = (pc: any, secrets: bigint[]): JubjubPoint[] => secrets.map((x) => pc.signerPublicKey(x));

/** Schnorr: s·G == R + c·P, with c the low 128 bits of the challenge hash. */
export function sign(pc: any, secret: bigint, message: bigint): Signature {
  const key = pc.signerPublicKey(secret);
  const k = randomScalar();
  const nonce = pc.signerPublicKey(k);
  const h: bigint = pc.signatureChallenge(nonce, key, message);
  const challengeLo = h & LOW_128;
  return { nonce, s: (k + challengeLo * secret) % JUBJUB_ORDER, challengeLo, challengeHi: h >> 128n };
}

/** The message signers sign for `report` on the zkperp contract at `market` (hex address). */
export const priceMessage = (pc: any, market: string, r: PriceReport): bigint =>
  pc.priceMessage(bytes(market), r.round, r.price, r.updatedAt);

export const signPrice = (pc: any, market: string, report: PriceReport, secret: bigint): Signature =>
  sign(pc, secret, priceMessage(pc, market, report));

/** The message that puts `key` in `slot` at rotation number `epoch`. */
export const rotationMessage = (pc: any, market: string, epoch: bigint, slot: number, key: JubjubPoint): bigint =>
  pc.rotationMessage(bytes(market), epoch, BigInt(slot), key);

/** Two signatures in the order `setPrice` and `rotateSigner` take them: (first, second, a, b). */
export function quorum(sigs: SlotSignature[]): [bigint, bigint, Signature, Signature] {
  const two = [...new Map(sigs.map((x) => [x.slot, x])).values()].sort((p, q) => p.slot - q.slot).slice(0, 2);
  if (two.length < 2) throw new Error("a quorum needs signatures from two different signers");
  return [BigInt(two[0].slot), BigInt(two[1].slot), two[0].signature, two[1].signature];
}

/** setPrice's arguments for `report`, signed by the signers whose secrets are given (by slot). */
export function signedPriceArgs(pc: any, market: string, report: PriceReport, secrets: Map<number, bigint> | bigint[]) {
  const entries = secrets instanceof Map ? [...secrets] : secrets.map((x, slot) => [slot, x] as [number, bigint]);
  const sigs = entries.slice(0, 2).map(([slot, x]) => ({ slot, signature: signPrice(pc, market, report, x) }));
  return [report.round, report.price, report.updatedAt, ...quorum(sigs)] as const;
}

/** JSON-safe form of a signature, for relayers to exchange. */
export const signatureToJson = (s: Signature) => ({
  nonce: { x: s.nonce.x.toString(), y: s.nonce.y.toString() },
  s: s.s.toString(),
  challengeLo: s.challengeLo.toString(),
  challengeHi: s.challengeHi.toString(),
});

export const signatureFromJson = (j: any): Signature => ({
  nonce: { x: BigInt(j.nonce.x), y: BigInt(j.nonce.y) },
  s: BigInt(j.s),
  challengeLo: BigInt(j.challengeLo),
  challengeHi: BigInt(j.challengeHi),
});
