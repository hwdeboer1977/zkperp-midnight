// SPDX-License-Identifier: Apache-2.0

/**
 * Limit orders: an open that waits for its price (see "Limit orders" in
 * contracts/zkperp.compact). The keeper's note for each, and how a fill
 * becomes a position. Browser and Node alike.
 *
 * The note uses the liquidator note's format (`sealLiquidatorNote`): ten field
 * elements masked under an ECDH secret with the liquidator key. The trader
 * seals it, outside the circuit, as for trigger orders; a false note only
 * stops the trader's own order from filling.
 *
 * Plaintext layout, as `liquidatorPlaintext` but for elements 6 and 7:
 *
 *   0 owner
 *   1 collateralNonce, 2 salt          whole: both below the field size
 *   3, 4 payTo                         16-byte halves, little-endian
 *   5 size | collateral << 64
 *   6 openFee | price << 64
 *   7 isLong | LIMIT_TAG << 64 | expiry << 128
 *                                      the tag tells a limit note from garbage
 *   8, 9 payToEnc                      halves
 */

import { decodeLiquidatorPlaintext } from "./liquidatorNote.js";

/** "zklimit", as a field element. */
export const LIMIT_TAG = 0x7a6b6c696d6974n;

export interface LimitOrder {
  owner: bigint;
  isLong: boolean;
  size: bigint;
  /** Net of the opening fee; the coin holds collateral + openFee. */
  collateral: bigint;
  openFee: bigint;
  /** A long fills at or below it, a short at or above. */
  price: bigint;
  /** Seconds since the epoch after which it no longer fills; 0n for never. */
  expiry: bigint;
  collateralNonce: Uint8Array;
  salt: Uint8Array;
  payTo: { bytes: Uint8Array };
  payToEnc: Uint8Array;
}

/** Whether `order` fills at mark price `mark`, as `executeLimitOrder` tests it. */
export const limitReached = (order: { isLong: boolean; price: bigint }, mark: bigint) =>
  order.isLong ? mark <= order.price : mark >= order.price;

/** Whether `order` has expired at `now` (seconds), as `executeLimitOrder` tests it with the fill's open time. */
export const limitExpired = (order: { expiry: bigint }, now: bigint) => order.expiry !== 0n && now >= order.expiry;

const toField = (b: Uint8Array) => {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
};

export function limitPlaintext(o: LimitOrder): bigint[] {
  const shift = 1n << 64n;
  return [
    o.owner,
    toField(o.collateralNonce),
    toField(o.salt),
    toField(o.payTo.bytes.slice(0, 16)),
    toField(o.payTo.bytes.slice(16, 32)),
    o.size + o.collateral * shift,
    o.openFee + o.price * shift,
    (o.isLong ? 1n : 0n) + LIMIT_TAG * shift + o.expiry * shift * shift,
    toField(o.payToEnc.slice(0, 16)),
    toField(o.payToEnc.slice(16, 32)),
  ];
}

/** Decodes an opened limit note; throws on anything that is not one. */
export function decodeLimitPlaintext(m: readonly bigint[]): LimitOrder {
  const mask = (1n << 64n) - 1n;
  if (m.length !== 10 || ((m[7]! >> 64n) & mask) !== LIMIT_TAG) throw new Error("not a limit note");
  const long = m[7]! & mask;
  const expiry = m[7]! >> 128n;
  if (long > 1n || expiry > mask) throw new Error("not a limit note");
  // The rest packs as a position's would, with the price where its entry
  // price goes; element 7 rebuilt as an open time of zero and the direction.
  const asPosition = decodeLiquidatorPlaintext([...m.slice(0, 7), long << 64n, m[8]!, m[9]!]);
  const p = asPosition.position;
  return {
    owner: p.owner,
    isLong: p.isLong,
    size: p.size,
    collateral: p.collateral,
    openFee: p.openFee,
    price: p.entryPrice,
    expiry,
    collateralNonce: p.collateralNonce,
    salt: p.salt,
    payTo: p.payTo,
    payToEnc: asPosition.payToEnc,
  };
}

/** The contract's pure circuits this module uses. */
interface Pure {
  sealLiquidatorNote(m: bigint[], key: { x: bigint; y: bigint }, ephemeral: bigint): any;
  openLiquidatorNote(note: any, secret: bigint): bigint[];
}

/** The keeper's note for `order`, sealed to the liquidator key. */
export function sealLimitNote(pure: Pure, liquidatorKey: { x: bigint; y: bigint }, order: LimitOrder, ephemeral: bigint) {
  return pure.sealLiquidatorNote(limitPlaintext(order), liquidatorKey, ephemeral);
}

/** The keeper's side: a limit note opened with the liquidator secret. */
export function openLimitNote(pure: Pure, note: any, secret: bigint): LimitOrder {
  return decodeLimitPlaintext(pure.openLiquidatorNote(note, secret));
}

/** The position a fill opens: the order's fields at the fill's entry price and open time. */
export function filledPosition(o: LimitOrder, fill: { entryPrice: bigint; openTime: bigint }) {
  return {
    owner: o.owner,
    isLong: o.isLong,
    size: o.size,
    collateral: o.collateral,
    openFee: o.openFee,
    entryPrice: fill.entryPrice,
    openTime: fill.openTime,
    collateralNonce: o.collateralNonce,
    salt: o.salt,
    payTo: o.payTo,
  };
}
