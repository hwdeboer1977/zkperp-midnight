// SPDX-License-Identifier: Apache-2.0

/**
 * Limit orders from the browser: placing, finding and cancelling them.
 *
 * Placing one posts its collateral coin now and commits to the position it
 * will open (contracts/zkperp.compact, "Limit orders"). Its fields go on chain
 * twice: sealed to the keeper (core/limits.ts), who fills it once the mark
 * price reaches the limit, and in a note under the position key, as a
 * position's opening does (core/notes.ts, `kind: "limit"`). Its secrets derive
 * from that note's seed, so this browser keeps no record of its own:
 * `findLimitOrders` rebuilds every order from the ledger, here or on any
 * device with the key. Once filled, recover.ts turns the same note into the
 * position, which then closes and takes orders like any other.
 *
 * Nothing is written before submitting, unlike an open: if the placement
 * fails, the coin never left the wallet; if it lands, its note is on chain.
 */

import { useEffect, useState } from "react";
import { circuitNow, openFeeOf } from "@core/math";
import { limitExpired, limitReached, sealLimitNote, type LimitOrder } from "@core/limits";
import { randomScalar } from "@core/liquidatorNote";
import { openNote, sealNote, secretsOf, type NoteOpening, type PositionKey } from "@core/notes";
import { bytes, hex, keyBytes, random32 } from "./bytes";
import { loadConfig } from "./config";
import { contractModule } from "./contracts";
import { useNow } from "./hooks";
import type { ContractHandle } from "./providers";
import { watchLimits } from "./notices";
import { collateralIndex, ledgerOf, walletCoinKey } from "./trading";

export interface OwnLimit {
  /** hex of the note: the order's identity in this browser. */
  id: string;
  status: "waiting" | "filled" | "cancelled";
  isLong: boolean;
  size: bigint;
  /** Net of the opening fee; the coin holds collateral + openFee. */
  collateral: bigint;
  openFee: bigint;
  price: bigint;
  /** Seconds since the epoch after which it no longer fills; 0n for never. */
  expiry: bigint;
  /** Seconds since the epoch. */
  placedAt: bigint;
  ownerSecret: Uint8Array;
  salt: Uint8Array;
  collateralNonce: Uint8Array;
  /** Once filled: what the position opened at. */
  fill?: { entryPrice: bigint; openTime: bigint };
}

/** Notes already opened under a key, so a ledger poll only decrypts new ones. */
const opened = new WeakMap<PositionKey, Map<string, NoteOpening | null>>();

/**
 * Every limit order placed under `key` on `contractAddress`, newest first. A
 * note decrypts to an order only if this key sealed it; the same call wrote
 * its commitment, so the order exists.
 */
export async function findLimitOrders(module: { pureCircuits: any }, ledger: any, key: PositionKey, contractAddress: string): Promise<OwnLimit[]> {
  const contract = bytes(contractAddress);
  const cache = opened.get(key) ?? new Map<string, NoteOpening | null>();
  opened.set(key, cache);
  const out: OwnLimit[] = [];
  for (const note of ledger.notes as Iterable<Uint8Array>) {
    const id = hex(note);
    if (!cache.has(id)) cache.set(id, await openNote(key, contract, note));
    const o = cache.get(id);
    if (!o || o.kind !== "limit") continue;
    const s = await secretsOf(key, o.seed);
    const nullifier = module.pureCircuits.limitNullifier(s.salt);
    const fill = ledger.limitFills.member(nullifier) ? ledger.limitFills.lookup(nullifier) : undefined;
    out.push({
      id,
      status: fill ? "filled" : ledger.limitDone.member(nullifier) ? "cancelled" : "waiting",
      isLong: o.isLong,
      size: o.size,
      collateral: o.collateral,
      openFee: o.openFee,
      price: o.entryPrice,
      expiry: o.expiry ?? 0n,
      placedAt: o.openTime,
      ownerSecret: s.ownerSecret,
      salt: s.salt,
      collateralNonce: s.collateralNonce,
      fill: fill && { entryPrice: fill.entryPrice, openTime: fill.openTime },
    });
  }
  return out.sort((a, b) => Number(b.placedAt - a.placedAt));
}

/** The circuit's `LimitOrder` for `o`, paying the wallet behind `perp`. */
function limitOf(perp: ContractHandle, o: Pick<OwnLimit, "ownerSecret" | "isLong" | "size" | "collateral" | "openFee" | "price" | "expiry" | "collateralNonce" | "salt">): LimitOrder {
  return {
    owner: perp.module.pureCircuits.ownerKey(o.ownerSecret),
    isLong: o.isLong,
    size: o.size,
    collateral: o.collateral,
    openFee: o.openFee,
    price: o.price,
    expiry: o.expiry,
    collateralNonce: o.collateralNonce,
    salt: o.salt,
    payTo: { bytes: bytes(walletCoinKey(perp)) },
    payToEnc: keyBytes(String(perp.providers.walletProvider.getEncryptionPublicKey())),
  };
}

/**
 * Places a limit order posting a coin of `coinValue`: a long that opens once
 * the mark price is at or below `price`, a short at or above. The opening fee
 * comes out of the coin when it fills, as for an open. Past `expiry` (seconds
 * since the epoch; 0n for never) it no longer fills, and waits to be cancelled.
 */
export async function placeLimitOrder(
  perp: ContractHandle,
  key: PositionKey,
  coinValue: bigint,
  size: bigint,
  isLong: boolean,
  price: bigint,
  expiry: bigint
): Promise<string> {
  const config = await loadConfig();
  const ledger = await ledgerOf(perp);
  const openFee = openFeeOf(size, BigInt(ledger.openFeeBps));
  const collateral = coinValue - openFee;
  const seed = random32();
  const s = await secretsOf(key, seed);
  const order = limitOf(perp, { ...s, isLong, size, collateral, openFee, price, expiry });
  const note = await sealNote(key, bytes(perp.address), { kind: "limit", seed, isLong, size, collateral, openFee, entryPrice: price, openTime: circuitNow(), expiry });
  const tx: any = await perp.deployed.callTx.placeLimitOrder(
    { nonce: order.collateralNonce, color: bytes(config.usdcToken), value: coinValue },
    size,
    isLong,
    openFee,
    price,
    expiry,
    s.ownerSecret,
    order.salt,
    order.payToEnc,
    note,
    // A fresh scalar per order: the keeper note's ephemeral key.
    sealLimitNote(perp.module.pureCircuits, ledger.liquidator, order, randomScalar())
  );
  return tx.public.txHash;
}

/** Cancels a waiting order; its whole coin, fee included, goes back to the wallet that placed it. */
export async function cancelLimitOrder(perp: ContractHandle, o: OwnLimit): Promise<string> {
  if (o.status !== "waiting") throw new Error(`this order is ${o.status}`);
  const config = await loadConfig();
  const order = limitOf(perp, o);
  const ledger = await ledgerOf(perp);
  const path = ledger.limitOrders.findPathForLeaf(perp.module.pureCircuits.limitCommitment(order));
  if (!path) throw new Error("This order was placed from another wallet account; connect that one to cancel it.");
  const coin = { nonce: o.collateralNonce, color: bytes(config.usdcToken), value: o.collateral + o.openFee };
  const mt_index = await collateralIndex(perp, coin);
  const tx: any = await perp.deployed.callTx.cancelLimitOrder(order, o.ownerSecret, path, { ...coin, mt_index });
  return tx.public.txHash;
}

/**
 * Whether `price` is a sensible limit for a new order at mark price `mark`.
 * An error refuses it; a warning only informs.
 */
export function checkLimit(isLong: boolean, price: bigint | undefined, mark: bigint): { error?: string; warning?: string } {
  if (!price || price <= 0n) return { error: "Enter a limit price." };
  if (limitReached({ isLong, price }, mark)) {
    return {
      warning: `The price is already ${isLong ? "at or below" : "at or above"} this limit: the keeper fills it on its next look, at the price then, like a market order.`,
    };
  }
  return {};
}

/** Whether `o` waits but can no longer fill: past its expiry at `now` (seconds). */
export const isExpired = (o: OwnLimit, now: number | bigint) => o.status === "waiting" && limitExpired(o, BigInt(now));

/** How long a new order stays open, in the ticket. */
export const EXPIRIES = [
  { label: "Until cancelled", seconds: 0 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86_400 },
  { label: "1 week", seconds: 7 * 86_400 },
] as const;

/** The limit orders under `key`, rebuilt whenever the ledger's notes or fills change. Null until read. */
export function useLimitOrders(key: PositionKey | null, ledger: any, contractAddress: string | undefined): OwnLimit[] | null {
  const [orders, setOrders] = useState<OwnLimit[] | null>(null);
  const version = ledger && key && contractAddress ? `${contractAddress}:${ledger.notes.size()}:${ledger.limitDone.size()}` : "";
  // Forget another key's orders at once; keep showing these while re-reading.
  useEffect(() => setOrders(null), [key, contractAddress]);
  useEffect(() => {
    if (!version) return;
    let live = true;
    void contractModule("zkperp")
      .then((module) => findLimitOrders(module, ledger, key!, contractAddress!))
      .then((o) => live && setOrders(o), () => live && setOrders(null));
    return () => {
      live = false;
    };
    // Only when orders change, not on every ledger poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, key]);
  // Fills come with the ledger; an expiry only with the clock.
  const now = useNow(15_000);
  useEffect(() => void (orders && watchLimits(orders, now)), [orders, now]);
  return orders;
}
