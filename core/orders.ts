// SPDX-License-Identifier: Apache-2.0

/**
 * Trigger orders (stop loss, take profit): the keeper's note for each, and how
 * the trader derives them. Browser and Node alike.
 *
 * An order's note uses the liquidator note's format (`sealLiquidatorNote` in
 * contracts/zkperp.compact): ten field elements, each masked with a hash of an
 * ECDH secret between an ephemeral scalar and the liquidator key. Unlike the
 * position's liquidator note, the trader seals it, outside the circuit; a
 * false note only stops the trader's own order from firing.
 *
 * Plaintext layout:
 *
 *   0 ORDER_TAG       tells an order note from garbage under another key
 *   1 positionSalt    the keeper finds the position by its salt
 *   2 price           the trigger level, 6 decimals
 *   3 above           1 fires at or above the price, 0 at or below
 *   4 orderSalt       below the field size, so it fits whole
 *   5–9               zero
 *
 * The order's salt and the note's ephemeral scalar are derived from the
 * position's owner secret, its salt and the order's index, so the trader can
 * find their orders again on another device: rebuild the ephemeral point,
 * look for it among the notes, and unmask with e·L, as the keeper does with
 * l·(e·G).
 */

import { belowField, scalarFrom } from "./liquidatorNote.js";

/** "zkorder", as a field element. */
export const ORDER_TAG = 0x7a6b6f72646572n;

/** How many orders per position the trader looks for when recovering. */
export const MAX_ORDERS_PER_POSITION = 8;

export interface TriggerOrder {
  /** `positionCommitment` of the position it closes. */
  position: Uint8Array;
  price: bigint;
  /** Fires at or above `price` if true, at or below if false. */
  above: boolean;
  salt: Uint8Array;
}

/** What a decrypted order note says. */
export interface OrderView {
  positionSalt: Uint8Array;
  price: bigint;
  above: boolean;
  salt: Uint8Array;
}

/** A long's stop loss and a short's take profit fire below; the others above. */
export const firesAbove = (isLong: boolean, kind: "stopLoss" | "takeProfit") => (kind === "stopLoss" ? !isLong : isLong);

/** Whether `order` has fired at mark price `mark`, as `executeOrder` tests it. */
export const orderReached = (order: { price: bigint; above: boolean }, mark: bigint) =>
  order.above ? mark >= order.price : mark <= order.price;

const toField = (b: Uint8Array) => {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
};

function toBytes32(f: bigint): Uint8Array {
  if (f < 0n || f >> 256n !== 0n) throw new Error("not an order note");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((f >> BigInt(8 * i)) & 0xffn);
  return out;
}

export function orderPlaintext(positionSalt: Uint8Array, order: TriggerOrder): bigint[] {
  return [ORDER_TAG, toField(positionSalt), order.price, order.above ? 1n : 0n, toField(order.salt), 0n, 0n, 0n, 0n, 0n];
}

/** Decodes an opened order note; throws on anything that is not one, such as a note under another key. */
export function decodeOrderPlaintext(m: readonly bigint[]): OrderView {
  if (m.length !== 10 || m[0] !== ORDER_TAG) throw new Error("not an order note");
  if (m[3]! > 1n || m[2]! >> 64n !== 0n || m.slice(5).some((x) => x !== 0n)) throw new Error("not an order note");
  return { positionSalt: toBytes32(m[1]!), price: m[2]!, above: m[3] === 1n, salt: toBytes32(m[4]!) };
}

async function sha512(...parts: Uint8Array[]): Promise<Uint8Array> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-512", all));
}

const label = (s: string) => new TextEncoder().encode(s);
const u32 = (n: number) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);

/** Order number `index` of a position: its salt and its note's ephemeral scalar. */
export async function deriveOrder(
  ownerSecret: Uint8Array,
  positionSalt: Uint8Array,
  index: number
): Promise<{ salt: Uint8Array; ephemeral: bigint }> {
  const salt = belowField((await sha512(label("zkperp:order:salt:v1"), ownerSecret, positionSalt, u32(index))).slice(0, 32));
  const ephemeral = scalarFrom(await sha512(label("zkperp:order:ephemeral:v1"), ownerSecret, positionSalt, u32(index)));
  return { salt, ephemeral };
}

/** The contract's pure circuits this module uses. */
interface Pure {
  liquidatorPublicKey(secret: bigint): { x: bigint; y: bigint };
  liquidatorShared(point: { x: bigint; y: bigint }, scalar: bigint): bigint;
  liquidatorMask(shared: bigint, i: bigint): bigint;
  sealLiquidatorNote(m: bigint[], key: { x: bigint; y: bigint }, ephemeral: bigint): any;
  openLiquidatorNote(note: any, secret: bigint): bigint[];
}

/** The note to place with `order`, sealed to the liquidator key. */
export function sealOrderNote(pure: Pure, liquidatorKey: { x: bigint; y: bigint }, positionSalt: Uint8Array, order: TriggerOrder, ephemeral: bigint) {
  return pure.sealLiquidatorNote(orderPlaintext(positionSalt, order), liquidatorKey, ephemeral);
}

/** The keeper's side: an order note opened with the liquidator secret. */
export function openOrderNote(pure: Pure, note: any, secret: bigint): OrderView {
  return decodeOrderPlaintext(pure.openLiquidatorNote(note, secret));
}

/**
 * The trader's side: the note in `notes` sealed with `ephemeral`, opened with
 * the shared secret e·L. Null when no note was sealed with it.
 */
export function findOwnOrderNote(
  pure: Pure,
  notes: Iterable<any>,
  liquidatorKey: { x: bigint; y: bigint },
  ephemeral: bigint
): OrderView | null {
  const point = pure.liquidatorPublicKey(ephemeral);
  for (const note of notes) {
    if (note.ephemeral.x !== point.x || note.ephemeral.y !== point.y) continue;
    const k = pure.liquidatorShared(liquidatorKey, ephemeral);
    const fields: bigint[] = note.fields;
    try {
      return decodeOrderPlaintext(fields.map((c: bigint, i: number) => fieldSub(c, pure.liquidatorMask(k, BigInt(i)))));
    } catch {
      return null;
    }
  }
  return null;
}

/** The scalar field's modulus (BLS12-381's), for unmasking outside the circuit. */
const FIELD = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;
const fieldSub = (a: bigint, b: bigint) => (((a - b) % FIELD) + FIELD) % FIELD;
